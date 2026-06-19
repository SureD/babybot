import { describe, expect, it } from 'vitest';

import type { AgentTraceEvent, Project, Task } from '@babybot/contracts';

import {
  TaskOrchestrator,
  type AgentRunInput,
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
  let sessionId: string | undefined;
  const runInputs: AgentRunInput[] = [];
  const resumedSessions: string[] = [];
  const agentSession: AgentSession = {
    id: 'session-1',
    async *run(input) {
      runInputs.push(input);
      yield { type: 'run.started', turnId: 1 };
      yield { type: 'message.delta', turnId: 1, text: 'done' };
      yield { type: 'run.completed', turnId: 1, reason: 'completed' };
    },
    async cancel() {},
    async getUsage() {
      return {
        total: {
          input: 10,
          output: 2,
          cacheRead: 4,
          cacheCreation: 0,
        },
      };
    },
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
      async createSession() {
        return agentSession;
      },
      async resumeSession(input) {
        resumedSessions.push(input.sessionId);
        return agentSession;
      },
      async close() {},
    },
  };

  return {
    orchestrator: new TaskOrchestrator(dependencies),
    runInputs,
    resumedSessions,
    traces,
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
      { prompt: 'First task' },
      { prompt: 'Second task' },
    ]);
    expect(fixture.resumedSessions).toEqual(['session-1']);
  });
});
