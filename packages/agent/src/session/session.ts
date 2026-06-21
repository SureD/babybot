import type { BackendSession } from '../backend/interface';
import type { AgentMode, TurnInput } from '../content';
import type { Context, ContextSnapshot } from '../context/interface';
import { AgentRuntimeError } from '../errors';
import type { AgentEventListener, Observer } from '../observer/interface';
import type { Permission } from '../permission/interface';
import type { Prompter } from '../prompter/interface';
import type { AgentSession } from './interface';
import type { ToolFilter, ToolRegistration, Tools } from '../tools/interface';
import type { Turn, TurnFactory } from '../turn/interface';

export interface AgentSessionDependencies {
  readonly backend: BackendSession;
  readonly context: Context;
  readonly tools: Tools;
  readonly observer: Observer;
  readonly prompter: Prompter;
  readonly permission: Permission;
  readonly createTurn: TurnFactory;
  readonly initialMode?: AgentMode;
}

export class AgentSessionImpl implements AgentSession {
  readonly id: string;

  private currentMode: AgentMode;
  private activeTurn: Turn | undefined;
  private turnSequence = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private maintenance: Promise<void> | undefined;

  constructor(private readonly dependencies: AgentSessionDependencies) {
    this.id = dependencies.backend.id;
    this.currentMode = dependencies.initialMode ?? 'default';
  }

  get mode(): AgentMode {
    return this.currentMode;
  }

  async prompt(input: TurnInput): Promise<Turn> {
    this.assertAvailable();
    const turnId = `${this.id}:${String(++this.turnSequence)}`;
    let turn: Turn;
    turn = this.dependencies.createTurn({
      id: turnId,
      sessionId: this.id,
      mode: this.currentMode,
      input: Object.freeze({ ...input }),
      context: this.dependencies.context,
      tools: this.dependencies.tools,
      toolFilter: modeToolFilter(this.currentMode),
      observer: this.dependencies.observer,
      prompter: this.dependencies.prompter,
      permission: this.dependencies.permission,
      backend: this.dependencies.backend,
      onSettled: () => {
        if (this.activeTurn === turn) this.activeTurn = undefined;
      },
    });
    this.activeTurn = turn;
    return turn;
  }

  async setMode(mode: AgentMode): Promise<void> {
    this.assertAvailable();
    if (!isAgentMode(mode)) throw new TypeError(`Unknown agent mode: ${String(mode)}.`);
    this.currentMode = mode;
  }

  registerTool(tool: ToolRegistration): void {
    this.assertAvailable();
    this.dependencies.tools.register(tool);
  }

  replaceTool(tool: ToolRegistration): void {
    this.assertAvailable();
    this.dependencies.tools.replace(tool);
  }

  unregisterTool(name: string): boolean {
    this.assertAvailable();
    return this.dependencies.tools.unregister(name);
  }

  async contextSnapshot(): Promise<ContextSnapshot> {
    this.assertOpen();
    return this.dependencies.context.snapshot();
  }

  async compact(instruction?: string): Promise<void> {
    this.assertAvailable();
    const operation = this.compactContext(instruction);
    this.maintenance = operation;
    try {
      await operation;
    } finally {
      if (this.maintenance === operation) this.maintenance = undefined;
    }
  }

  subscribe(listener: AgentEventListener): () => void {
    this.assertOpen();
    return this.dependencies.observer.subscribe(listener);
  }

  async cancel(reason?: string): Promise<void> {
    this.assertOpen();
    await this.activeTurn?.cancel(reason);
  }

  async close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeResources();
    return this.closePromise;
  }

  private async closeResources(): Promise<void> {
    try {
      await this.maintenance;
    } catch {
      // The initiating operation reports its own failure; close still releases resources.
    }
    const turn = this.activeTurn;
    if (turn !== undefined) {
      await turn.cancel('Session closed.');
      try {
        await turn.result;
      } catch {
        // Cancellation is the expected terminal result while closing.
      }
    }
    await this.dependencies.backend.close();
  }

  private assertAvailable(): void {
    this.assertOpen();
    if (this.activeTurn !== undefined || this.maintenance !== undefined) {
      throw new AgentRuntimeError(
        'session.busy',
        `Session ${this.id} is busy.`,
        {
          details: {
            sessionId: this.id,
            operation: this.activeTurn === undefined ? 'compact' : 'turn',
            ...(this.activeTurn === undefined
              ? {}
              : { turnId: this.activeTurn.id }),
          },
        },
      );
    }
  }

  private async compactContext(instruction?: string): Promise<void> {
    await this.dependencies.context.compact(instruction);
    const snapshot = await this.dependencies.context.snapshot();
    await this.dependencies.observer.record({
      type: 'context.compacted',
      revision: snapshot.revision,
    });
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new AgentRuntimeError(
        'session.closed',
        `Session ${this.id} is closed.`,
        { details: { sessionId: this.id } },
      );
    }
  }
}

function modeToolFilter(mode: AgentMode): ToolFilter | undefined {
  return mode === 'plan' ? (tool) => tool.readOnly : undefined;
}

function isAgentMode(value: string): value is AgentMode {
  return value === 'default' || value === 'plan' || value === 'build';
}
