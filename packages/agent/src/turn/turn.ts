import type { BackendEvent } from '../backend/interface';
import type { TokenUsage, TurnInput } from '../content';
import { AgentRuntimeError, isAgentError } from '../errors';
import type { AgentEvent } from '../observer/interface';
import type {
  ToolCall,
  ToolDefinition,
  ToolSnapshot,
} from '../tools/interface';
import type { Turn, TurnResult, TurnStartInput, TurnStatus } from './interface';

export class AgentTurn implements Turn {
  readonly id: string;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<TurnResult>;

  private readonly abortController = new AbortController();
  private readonly eventQueue = new AsyncEventQueue<AgentEvent>();
  private readonly unsubscribe: () => void;
  private currentStatus: TurnStatus = 'running';
  private cancellationReason: string | undefined;
  private snapshot: ToolSnapshot | undefined;
  private readonly toolCalls = new Map<string, ToolCall>();
  private readonly permissionDecisions = new Map<string, 'allow' | 'deny'>();
  private readonly authorizedHostedCalls = new Map<string, ToolCall>();

  constructor(private readonly options: TurnStartInput) {
    this.id = options.id;
    this.events = this.eventQueue;
    this.unsubscribe = options.observer.subscribe((event) => {
      if ('turnId' in event && event.turnId === this.id) this.eventQueue.push(event);
    });
    this.result = this.execute();
  }

  get status(): TurnStatus {
    return this.currentStatus;
  }

  async steer(input: TurnInput): Promise<void> {
    this.assertRunning('steer');
    await this.options.backend.steer(input);
  }

  async cancel(reason?: string): Promise<void> {
    if (this.currentStatus !== 'running' || this.abortController.signal.aborted) return;
    this.cancellationReason = reason;
    this.abortController.abort(
      new AgentRuntimeError('turn.cancelled', reason ?? 'Turn was cancelled.'),
    );
    try {
      await this.options.backend.abort();
    } catch {
      // The run loop owns the terminal state. A backend may already be stopped.
    }
  }

  private async execute(): Promise<TurnResult> {
    try {
      const contextSnapshot = await this.options.context.snapshot();
      this.snapshot = this.options.tools.snapshot(this.options.toolFilter);
      const injections = await this.options.prompter.render({
        mode: this.options.mode,
        context: contextSnapshot,
        tools: this.snapshot,
        input: this.options.input,
      });
      const prepared = await this.options.context.prepare(
        this.options.input,
        injections,
      );
      if (prepared.revision !== contextSnapshot.revision) {
        throw new AgentRuntimeError(
          'context.failed',
          'Context changed while the Turn was being prepared.',
          {
            details: {
              snapshotRevision: contextSnapshot.revision,
              preparedRevision: prepared.revision,
            },
          },
        );
      }
      await this.options.observer.record({
        type: 'turn.started',
        turnId: this.id,
        mode: this.options.mode,
        contextRevision: prepared.revision,
        toolRevision: this.snapshot.revision,
      });

      this.abortController.signal.throwIfAborted();
      const result = await this.consumeBackend(
        this.options.backend.run({
          turnId: this.id,
          context: prepared,
          tools: this.snapshot,
          hooks: {
            authorize: (request, signal) => this.authorize(request.call, signal),
            invoke: (call, signal) => this.invoke(call, signal),
          },
        }),
      );
      if (this.abortController.signal.aborted) {
        throw this.abortController.signal.reason;
      }
      this.currentStatus = 'completed';
      await this.options.observer.record({
        type: 'turn.completed',
        turnId: this.id,
        finishReason: result.finishReason,
        ...(result.usage === undefined ? {} : { usage: result.usage }),
      });
      return result;
    } catch (cause) {
      if (this.abortController.signal.aborted) {
        this.currentStatus = 'cancelled';
        const error = new AgentRuntimeError(
          'turn.cancelled',
          this.cancellationReason ?? 'Turn was cancelled.',
          { cause },
        );
        await this.recordCancellation();
        throw error;
      }
      this.currentStatus = 'failed';
      const error = isAgentError(cause)
        ? cause
        : new AgentRuntimeError('backend.failed', errorMessage(cause), { cause });
      await this.options.observer.record({
        type: 'turn.failed',
        turnId: this.id,
        error: error.message,
      });
      throw error;
    } finally {
      this.unsubscribe();
      this.eventQueue.close();
      this.options.onSettled?.();
    }
  }

  private async consumeBackend(
    events: AsyncIterable<BackendEvent>,
  ): Promise<TurnResult> {
    let result: TurnResult | undefined;
    let stepUsage: TokenUsage | undefined;

    for await (const event of events) {
      this.abortController.signal.throwIfAborted();
      if (event.type === 'completed') {
        const finalUsage = event.usage ?? stepUsage;
        result = {
          output: event.output,
          finishReason: event.finishReason,
          ...(finalUsage === undefined ? {} : { usage: finalUsage }),
        };
        break;
      }
      if (event.type === 'failed') {
        throw new AgentRuntimeError('backend.failed', event.error);
      }
      if (event.type === 'step.completed' && event.usage !== undefined) {
        stepUsage = addUsage(stepUsage, event.usage);
      }
      await this.publishBackendEvent(event);
    }

    if (result === undefined) {
      throw new AgentRuntimeError(
        'backend.failed',
        'Backend event stream ended without a completed event.',
      );
    }
    return result;
  }

  private async publishBackendEvent(event: BackendEvent): Promise<void> {
    switch (event.type) {
      case 'step.started':
        await this.options.observer.record({
          type: event.type,
          turnId: this.id,
          step: event.step,
        });
        break;
      case 'step.completed':
        await this.options.observer.record({
          type: event.type,
          turnId: this.id,
          step: event.step,
          ...(event.usage === undefined ? {} : { usage: event.usage }),
        });
        break;
      case 'message.delta':
      case 'thinking.delta':
        this.options.observer.emit({
          type: event.type,
          turnId: this.id,
          text: event.text,
        });
        break;
      case 'tool.started':
        this.toolCalls.set(event.call.id, event.call);
        await this.options.observer.record({
          type: event.type,
          turnId: this.id,
          toolCallId: event.call.id,
          name: event.call.name,
          arguments: event.call.arguments,
        });
        break;
      case 'tool.progress':
        this.options.observer.emit({
          type: event.type,
          turnId: this.id,
          toolCallId: event.toolCallId,
          text: event.text,
        });
        break;
      case 'tool.completed': {
        const call = this.toolCalls.get(event.toolCallId);
        if (call === undefined || !this.permissionDecisions.has(event.toolCallId)) {
          throw new AgentRuntimeError(
            'backend.failed',
            `Backend completed tool call ${event.toolCallId} without permission evaluation.`,
          );
        }
        await this.options.observer.record({
          type: event.type,
          turnId: this.id,
          toolCallId: event.toolCallId,
          name: call.name,
          output: event.result.content,
          isError: event.result.isError,
        });
        break;
      }
      case 'warning':
        await this.options.observer.record({
          type: event.type,
          turnId: this.id,
          message: event.message,
        });
        break;
      case 'completed':
      case 'failed':
        break;
      default:
        assertNever(event);
    }
  }

  private async authorize(call: ToolCall, signal: AbortSignal) {
    const tool = this.findSnapshotTool(call.name);
    this.toolCalls.set(call.id, call);
    const decision = await this.options.permission.evaluate({
      mode: this.options.mode,
      tool,
      call,
    }, signal);
    this.permissionDecisions.set(call.id, decision.decision);
    if (decision.decision === 'allow') this.authorizedHostedCalls.set(call.id, call);
    await this.options.observer.record({
      type: 'permission.decided',
      turnId: this.id,
      toolCallId: call.id,
      decision: decision.decision,
      policy: decision.policy,
      reason: decision.reason,
      asked: decision.asked,
    });
    return decision;
  }

  private async invoke(call: ToolCall, signal: AbortSignal) {
    const tool = this.findSnapshotTool(call.name);
    if (tool.execution !== 'hosted') {
      throw new AgentRuntimeError(
        'tool.not_found',
        `Backend tool ${call.name} cannot be invoked by the hosted tool hook.`,
        { details: { name: call.name } },
      );
    }
    const authorized = this.authorizedHostedCalls.get(call.id);
    if (authorized === undefined ||
        authorized.name !== call.name ||
        !deepEqual(authorized.arguments, call.arguments)) {
      throw new AgentRuntimeError(
        'permission.denied',
        `Tool ${call.name} was not allowed with these arguments before execution.`,
        { details: { name: call.name, toolCallId: call.id } },
      );
    }
    this.authorizedHostedCalls.delete(call.id);
    return this.options.tools.invoke(call, {
      sessionId: this.options.sessionId,
      turnId: this.id,
      signal,
    });
  }

  private findSnapshotTool(name: string): ToolDefinition {
    const tool = this.snapshot?.tools.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      throw new AgentRuntimeError(
        'tool.not_found',
        `Tool ${name} is not present in this Turn's tool snapshot.`,
        { details: { name } },
      );
    }
    return tool;
  }

  private async recordCancellation(): Promise<void> {
    await this.options.observer.record({
      type: 'turn.cancelled',
      turnId: this.id,
      ...(this.cancellationReason === undefined
        ? {}
        : { reason: this.cancellationReason }),
    });
  }

  private assertRunning(operation: string): void {
    if (this.currentStatus !== 'running') {
      throw new AgentRuntimeError(
        'turn.invalid_state',
        `Cannot ${operation} a Turn in ${this.currentStatus} state.`,
        { details: { operation, status: this.currentStatus } },
      );
    }
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiting: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) return;
    const resolve = this.waiting.shift();
    if (resolve === undefined) this.values.push(value);
    else resolve({ value, done: false });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.waiting.splice(0)) {
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.waiting.push(resolve));
      },
    };
  }
}

function addUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheCreation: (current?.cacheCreation ?? 0) + next.cacheCreation,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length &&
      left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isObject(left) && isObject(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && deepEqual(left[key], right[key]));
  }
  return false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unexpected backend event: ${JSON.stringify(value)}`);
}
