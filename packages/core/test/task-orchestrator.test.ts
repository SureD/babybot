import { describe, expect, it } from 'vitest';

import type { AgentTraceEvent, Project, Task } from '@babybot/contracts';

import {
  TaskOrchestrator,
  type AgentSession,
  type RuntimeDependencies,
} from '../src';

function createFixture() {
  const project: Project = {
    id: 'project-1',
    name: 'Test project',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const tasks = new Map<string, Task>();
  const traces: AgentTraceEvent[] = [];
  const publishedTraces: AgentTraceEvent[] = [];
  const publishedTasks: Task[] = [];
  let sessionId: string | undefined;
  const runInputs: Array<{ readonly text: string }> = [];
  const createdProjects: string[] = [];
  const resumedProjects: string[] = [];
  const resumedSessions: string[] = [];
  const agentSession: AgentSession = {
    id: 'session-1',
    mode: 'default',
    async prompt(input) {
      runInputs.push(input);
      const turnId = 'session-1:1';
      return {
        id: turnId,
        status: 'completed',
        events: runtimeEvents(turnId),
        result: Promise.resolve({
          output: 'done',
          finishReason: 'completed',
          usage: {
            input: 10,
            output: 2,
            cacheRead: 4,
            cacheCreation: 0,
          },
        }),
        async steer() {},
        async cancel() {},
      };
    },
    async setMode() {},
    registerTool() {},
    replaceTool() {},
    unregisterTool() {
      return false;
    },
    async contextSnapshot() {
      return {
        revision: 1,
        entries: [],
        usage: {
          input: 10,
          output: 2,
          cacheRead: 4,
          cacheCreation: 0,
        },
      };
    },
    async compact() {},
    subscribe() {
      return () => {};
    },
    async cancel() {},
    async close() {},
  };

  const dependencies: RuntimeDependencies = {
    projects: {
      async listProjects() {
        return [project];
      },
      async getProject(id) {
        return id === project.id ? project : undefined;
      },
      async saveProject() {},
    },
    tasks: {
      async listTasks() {
        return [...tasks.values()];
      },
      async getTask(id) {
        return tasks.get(id);
      },
      async saveTask(task) {
        tasks.set(task.id, task);
      },
    },
    agentSessions: {
      async getSession() {
        return sessionId;
      },
      async saveSession(_projectId, _backend, nextSessionId) {
        sessionId = nextSessionId;
      },
      async clearSessions() {
        sessionId = undefined;
      },
    },
    traces: {
      async appendTrace(event) {
        traces.push(event);
      },
      async listTrace(taskId, afterSequence = 0) {
        return traces.filter(
          (event) =>
            event.taskId === taskId && event.sequence > afterSequence,
        );
      },
    },
    events: {
      taskUpdated(task) {
        publishedTasks.push(task);
      },
      traceAppended(_projectId, trace) {
        publishedTraces.push(trace);
      },
    },
    workspaces: {
      async ensure() {
        return '/tmp/project-1';
      },
    },
    capabilities: {
      async find() {
        return undefined;
      },
      async run() {
        throw new Error('Unexpected capability execution.');
      },
    },
    agentBackend: {
      name: 'test-coding',
      capabilities: {
        streaming: true,
        sessionResume: true,
        cancellation: true,
        tokenUsage: true,
        tracing: true,
      },
      async isAvailable() {
        return true;
      },
      async getSetupStatus() {
        return {
          backendAvailable: true,
          configured: true,
          provider: 'deepseek',
          model: 'test-model',
          hasApiKey: true,
          modelLockedByEnvironment: false,
        };
      },
      async discoverModels() {
        return [];
      },
      async configure() {
        throw new Error('Unexpected setup.');
      },
      async testChat() {
        throw new Error('Unexpected chat test.');
      },
      async createSession(input) {
        createdProjects.push(input.projectName);
        return agentSession;
      },
      async resumeSession(input) {
        resumedSessions.push(input.sessionId);
        resumedProjects.push(input.projectName);
        return agentSession;
      },
      async close() {},
    },
  };

  return {
    orchestrator: new TaskOrchestrator(dependencies),
    runInputs,
    createdProjects,
    resumedProjects,
    resumedSessions,
    traces,
    publishedTraces,
    publishedTasks,
  };
}

describe('TaskOrchestrator', () => {
  it('uses the coding backend and records token usage', async () => {
    const fixture = createFixture();

    const task = await fixture.orchestrator.submit({
      projectId: 'project-1',
      input: 'Build a formatter.',
      preference: 'auto',
    });

    expect(task).toMatchObject({
      status: 'completed',
      route: 'coding',
      result: 'done',
      tokenUsage: { input: 10, output: 2, cacheRead: 4, cacheCreation: 0 },
    });
    expect(fixture.traces.map((trace) => trace.event.type)).toEqual([
      'run.started',
      'message.delta',
      'run.completed',
    ]);
    expect(fixture.publishedTraces).toEqual(fixture.traces);
    expect(fixture.publishedTasks.map((published) => published.status)).toEqual([
      'pending',
      'running',
      'completed',
    ]);
    await expect(fixture.orchestrator.trace(task.id, 1)).resolves.toEqual([
      expect.objectContaining({ sequence: 2 }),
      expect.objectContaining({ sequence: 3 }),
    ]);
  });

  it('reuses the persisted coding session for later tasks', async () => {
    const fixture = createFixture();

    await fixture.orchestrator.submit({
      projectId: 'project-1',
      input: 'First task',
      preference: 'coding',
    });
    await fixture.orchestrator.submit({
      projectId: 'project-1',
      input: 'Second task',
      preference: 'coding',
    });

    expect(fixture.runInputs).toEqual([
      { text: 'First task' },
      { text: 'Second task' },
    ]);
    expect(fixture.createdProjects).toEqual(['Test project']);
    expect(fixture.resumedProjects).toEqual(['Test project']);
    expect(fixture.resumedSessions).toEqual(['session-1']);
  });
});

async function* runtimeEvents(turnId: string) {
  const common = {
    sessionId: 'session-1',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  yield {
    ...common,
    type: 'turn.started' as const,
    turnId,
    mode: 'default' as const,
    contextRevision: 1,
    toolRevision: 0,
    sequence: 1,
  };
  yield {
    ...common,
    type: 'message.delta' as const,
    turnId,
    text: 'done',
  };
  yield {
    ...common,
    type: 'turn.completed' as const,
    turnId,
    finishReason: 'completed',
    sequence: 2,
  };
}
