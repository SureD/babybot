import { randomUUID } from 'node:crypto';

import type {
  AgentEvent as RuntimeAgentEvent,
  AgentSession,
  ContextSnapshot,
  TokenUsage,
  Turn,
} from '@babybot/agent';
import type {
  AgentEvent,
  AgentTraceEvent,
  AgentUsage,
  ExecutionRoute,
  Task,
  TraceValue,
} from '@babybot/contracts';

import type {
  RuntimeDependencies,
  SubmitTaskRequest,
  TraceRepository,
} from './ports';

export class TaskOrchestrator {
  private readonly activeSessions = new Map<string, AgentSession>();

  constructor(private readonly dependencies: RuntimeDependencies) {}

  list(projectId: string): Promise<readonly Task[]> {
    return this.dependencies.tasks.listTasks(projectId);
  }

  get(taskId: string): Promise<Task | undefined> {
    return this.dependencies.tasks.getTask(taskId);
  }

  trace(taskId: string, afterSequence = 0): Promise<readonly AgentTraceEvent[]> {
    return this.dependencies.traces.listTrace(taskId, afterSequence);
  }

  async start(request: SubmitTaskRequest): Promise<Task> {
    const task = await this.createTask(request);
    void this.execute(task).catch(() => {});
    return task;
  }

  async submit(request: SubmitTaskRequest): Promise<Task> {
    return this.execute(await this.createTask(request));
  }

  async cancel(taskId: string): Promise<boolean> {
    const session = this.activeSessions.get(taskId);
    if (session === undefined) {
      return false;
    }
    await session.cancel();
    return true;
  }

  private async createTask(request: SubmitTaskRequest): Promise<Task> {
    const project = await this.dependencies.projects.getProject(request.projectId);
    if (project === undefined) {
      throw new Error(`Project "${request.projectId}" was not found.`);
    }

    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(),
      projectId: request.projectId,
      input: request.input,
      preference: request.preference,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    await this.dependencies.tasks.saveTask(task);
    this.dependencies.events.taskUpdated(task);
    return task;
  }

  private async execute(task: Task): Promise<Task> {
    try {
      task = await this.update(task, { status: 'running' });
      const project = await this.dependencies.projects.getProject(task.projectId);
      if (project === undefined) {
        throw new Error(`Project "${task.projectId}" was not found.`);
      }
      const capability =
        task.preference === 'coding'
          ? undefined
          : await this.dependencies.capabilities.find(task.projectId, task.input);

      if (capability !== undefined) {
        const result = await this.dependencies.capabilities.run(
          capability,
          task.projectId,
          task.input,
        );
        return this.complete(task, 'capability', result.output, result.tokenUsage);
      }

      if (task.preference === 'capability') {
        throw new Error('No matching capability is available.');
      }

      if (!(await this.dependencies.agentBackend.isAvailable())) {
        throw new Error('No agent backend is configured. Check the Babybot backend setup.');
      }

      const workDir = await this.dependencies.workspaces.ensure(task.projectId);
      const sessionId = await this.dependencies.agentSessions.getSession(
        task.projectId,
        this.dependencies.agentBackend.name,
      );
      const session =
        sessionId === undefined
          ? await this.dependencies.agentBackend.createSession({
              projectId: task.projectId,
              projectName: project.name,
              workDir,
            })
          : await this.dependencies.agentBackend.resumeSession({
              projectId: task.projectId,
              projectName: project.name,
              workDir,
              sessionId,
            });
      await this.dependencies.agentSessions.saveSession(
        task.projectId,
        this.dependencies.agentBackend.name,
        session.id,
      );
      this.activeSessions.set(task.id, session);
      const turn = await session.prompt({ text: task.input });
      const eventConsumption = consumeAgentTurn(
        turn,
        session.id,
        task.id,
        task.projectId,
        this.dependencies.traces,
        this.dependencies.events,
      );
      let result;
      try {
        result = await turn.result;
      } finally {
        await eventConsumption;
      }
      const context = await session.contextSnapshot();
      return this.completeAgentTask(
        task,
        result.output,
        agentUsage(result.usage, context),
      );
    } catch (error) {
      return this.update(task, {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.activeSessions.delete(task.id);
    }
  }

  private complete(
    task: Task,
    route: ExecutionRoute,
    result: string,
    tokenUsage: Task['tokenUsage'],
  ): Promise<Task> {
    return this.update(task, {
      route,
      status: 'completed',
      result,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
    });
  }

  private completeAgentTask(
    task: Task,
    result: string,
    usage: AgentUsage | undefined,
  ): Promise<Task> {
    return this.update(task, {
      route: 'coding',
      status: 'completed',
      result,
      ...(usage?.total === undefined ? {} : { tokenUsage: usage.total }),
      ...(usage === undefined ? {} : { usage }),
    });
  }

  private async update(task: Task, patch: Partial<Task>): Promise<Task> {
    const updated: Task = {
      ...task,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.dependencies.tasks.saveTask(updated);
    this.dependencies.events.taskUpdated(updated);
    return updated;
  }
}

async function consumeAgentTurn(
  turn: Turn,
  sessionId: string,
  taskId: string,
  projectId: string,
  traces: TraceRepository,
  events: RuntimeDependencies['events'],
): Promise<void> {
  let sequence = 0;

  for await (const event of turn.events) {
    sequence += 1;
    const trace = {
      taskId,
      sessionId,
      sequence,
      timestamp: event.timestamp,
      event: toTraceEvent(event),
    };
    await traces.appendTrace(trace);
    events.traceAppended(projectId, trace);
  }
}

function agentUsage(
  currentTurn: TokenUsage | undefined,
  context: ContextSnapshot,
): AgentUsage | undefined {
  if (
    currentTurn === undefined &&
    context.usage === undefined &&
    context.contextTokens === undefined &&
    context.contextWindow === undefined &&
    context.model === undefined
  ) {
    return undefined;
  }
  return {
    ...(currentTurn === undefined ? {} : { currentTurn }),
    ...(context.usage === undefined ? {} : { total: context.usage }),
    ...(context.model === undefined ? {} : { model: context.model }),
    ...(context.contextTokens === undefined
      ? {}
      : { contextTokens: context.contextTokens }),
    ...(context.contextWindow === undefined
      ? {}
      : { maxContextTokens: context.contextWindow }),
    ...(context.contextTokens === undefined || context.contextWindow === undefined
      ? {}
      : { contextUsage: context.contextTokens / context.contextWindow }),
  };
}

function toTraceEvent(event: RuntimeAgentEvent): AgentEvent {
  switch (event.type) {
    case 'turn.started':
      return { type: 'run.started', turnId: event.turnId };
    case 'turn.completed':
      return {
        type: 'run.completed',
        turnId: event.turnId,
        reason: event.finishReason,
      };
    case 'turn.failed':
      return { type: 'run.failed', turnId: event.turnId, error: event.error };
    case 'turn.cancelled':
      return {
        type: 'run.failed',
        turnId: event.turnId,
        code: 'turn.cancelled',
        error: event.reason ?? 'Turn was cancelled.',
      };
    case 'step.started':
      return {
        type: event.type,
        turnId: event.turnId,
        step: event.step,
      };
    case 'step.completed':
      return {
        type: event.type,
        turnId: event.turnId,
        step: event.step,
        ...(event.usage === undefined ? {} : { usage: event.usage }),
      };
    case 'message.delta':
    case 'thinking.delta':
      return { type: event.type, turnId: event.turnId, text: event.text };
    case 'tool.started':
      return {
        type: event.type,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        arguments: toTraceValue(event.arguments),
      };
    case 'tool.progress':
      return {
        type: event.type,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        kind: 'output',
        text: event.text,
      };
    case 'tool.completed':
      return {
        type: event.type,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        name: event.name,
        output: event.output,
        isError: event.isError,
      };
    case 'permission.decided':
      return {
        type: 'runtime.event',
        name: event.type,
        data: {
          turnId: event.turnId,
          toolCallId: event.toolCallId,
          decision: event.decision,
          policy: event.policy,
          reason: event.reason,
          asked: event.asked,
        },
      };
    case 'context.compacted':
      return {
        type: 'compaction.completed',
        trigger: 'manual',
        compactedCount: event.revision,
      };
    case 'warning':
      return {
        type: event.type,
        message: event.message,
      };
    default:
      return assertNever(event);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unexpected agent event: ${JSON.stringify(value)}`);
}

function toTraceValue(value: unknown): TraceValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toTraceValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toTraceValue(item)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'symbol';
  if (typeof value === 'function') return value.name || 'function';
  return null;
}
