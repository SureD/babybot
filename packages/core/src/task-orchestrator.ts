import { randomUUID } from 'node:crypto';

import type {
  AgentTraceEvent,
  AgentUsage,
  ExecutionRoute,
  Task,
} from '@babybot/contracts';

import type {
  AgentSession,
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
      const output = await consumeAgentRun(
        session,
        task.input,
        task.id,
        task.projectId,
        this.dependencies.traces,
        this.dependencies.events,
      );
      return this.completeAgentTask(task, output, await session.getUsage());
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

async function consumeAgentRun(
  session: AgentSession,
  prompt: string,
  taskId: string,
  projectId: string,
  traces: TraceRepository,
  events: RuntimeDependencies['events'],
): Promise<string> {
  const output: string[] = [];
  let failure: string | undefined;
  let sequence = 0;

  for await (const event of session.run({ prompt })) {
    sequence += 1;
    const trace = {
      taskId,
      sessionId: session.id,
      sequence,
      timestamp: new Date().toISOString(),
      event,
    };
    await traces.appendTrace(trace);
    events.traceAppended(projectId, trace);
    if (event.type === 'message.delta') {
      output.push(event.text);
    } else if (event.type === 'run.failed') {
      failure = event.error;
    }
  }

  if (failure !== undefined) {
    throw new Error(failure);
  }
  return output.join('').trim();
}
