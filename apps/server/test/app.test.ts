import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProjectStreamEvent, Task } from '@babybot/contracts';
import type { AgentBackend, AgentSession } from '@babybot/core';
import { UnavailableAgentBackend } from '@babybot/kimi-code-backend';

import { createApp } from '../src/app';
import type { ServerConfig } from '../src/config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('Babybot HTTP API', () => {
  it('creates a project and records a failed task when no backend is configured', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const projectsDir = join(directory, 'user-projects');
    const config = testConfig(directory, projectsDir);
    const app = await createApp({
      config,
      agentBackend: new UnavailableAgentBackend(),
      logger: false,
    });

    try {
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Life admin' },
      });
      expect(projectResponse.statusCode).toBe(201);
      const project = projectResponse.json<{ id: string; name: string }>();
      const workspace = await stat(join(projectsDir, project.id, 'workspace'));
      expect(workspace.isDirectory()).toBe(true);
      await expect(
        stat(join(directory, 'projects', project.id, 'workspace')),
      ).rejects.toMatchObject({ code: 'ENOENT' });

      const taskResponse = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks`,
        payload: { input: 'Organize receipts', preference: 'auto' },
      });
      expect(taskResponse.statusCode).toBe(202);
      expect(taskResponse.json()).toMatchObject({
        projectId: project.id,
        status: 'pending',
      });
      const task = await waitForTask(app, taskResponse.json<Task>().id, 'failed');
      expect(task.error).toContain('No agent backend is configured');

      const listResponse = await app.inject({
        method: 'GET',
        url: '/api/projects',
      });
      expect(listResponse.json()).toEqual([
        expect.objectContaining({ id: project.id, name: 'Life admin' }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('saves workspace settings for the next server start', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const config = testConfig(directory);
    const app = await createApp({
      config,
      agentBackend: new UnavailableAgentBackend(),
      logger: false,
    });

    try {
      const settingsResponse = await app.inject({
        method: 'GET',
        url: '/api/settings',
      });
      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json()).toMatchObject({
        current: {
          dataDir: directory,
          projectsDir: join(directory, 'projects-root'),
          piAgentDir: join(directory, 'pi'),
        },
        restartRequired: false,
      });

      const nextProjectsDir = join(directory, 'next-projects');
      const saveResponse = await app.inject({
        method: 'POST',
        url: '/api/settings',
        payload: { projectsDir: nextProjectsDir },
      });
      expect(saveResponse.statusCode).toBe(200);
      expect(saveResponse.json()).toMatchObject({
        current: {
          projectsDir: join(directory, 'projects-root'),
        },
        pending: {
          dataDir: directory,
          projectsDir: nextProjectsDir,
          piAgentDir: join(directory, 'pi'),
        },
        restartRequired: true,
      });
      await expect(stat(nextProjectsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await app.close();
    }
  });

  it('lists local folders for the workspace picker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const config = testConfig(directory);
    await mkdir(join(directory, 'selectable', 'child'), { recursive: true });
    await writeFile(join(directory, 'selectable', 'file.txt'), 'not a folder');
    const app = await createApp({
      config,
      agentBackend: new UnavailableAgentBackend(),
      logger: false,
    });

    try {
      const response = await app.inject({
        method: 'GET',
        url: `/api/settings/directories?path=${encodeURIComponent(join(directory, 'selectable'))}`,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        path: join(directory, 'selectable'),
        parent: directory,
        entries: [{ name: 'child', path: join(directory, 'selectable', 'child') }],
      });
      expect(response.body).not.toContain('file.txt');
    } finally {
      await app.close();
    }
  });

  it('exposes incremental agent trace and detailed token usage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const config = testConfig(directory);
    const app = await createApp({
      config,
      agentBackend: createTracingBackend(),
      logger: false,
    });

    try {
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Trace test' },
      });
      const project = projectResponse.json<{ id: string }>();
      const taskResponse = await app.inject({
        method: 'POST',
        url: `/api/projects/${project.id}/tasks`,
        payload: { input: 'Inspect execution', preference: 'coding' },
      });
      expect(taskResponse.statusCode).toBe(202);

      const task = await waitForTask(
        app,
        taskResponse.json<Task>().id,
        'completed',
      );
      expect(task).toMatchObject({
        result: 'done',
        tokenUsage: {
          input: 10,
          output: 2,
          cacheRead: 8,
          cacheCreation: 0,
        },
        usage: {
          model: 'test-model',
          contextTokens: 120,
          maxContextTokens: 1_000,
        },
      });

      const traceResponse = await app.inject({
        method: 'GET',
        url: `/api/tasks/${task.id}/trace?after=1`,
      });
      expect(traceResponse.statusCode).toBe(200);
      expect(traceResponse.json()).toEqual([
        expect.objectContaining({
          sequence: 2,
          event: {
            type: 'message.delta',
            turnId: 'trace-session:1',
            text: 'done',
          },
        }),
        expect.objectContaining({
          sequence: 3,
          event: {
            type: 'run.completed',
            turnId: 'trace-session:1',
            reason: 'completed',
          },
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('streams task and trace updates over server-sent events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const app = await createApp({
      config: testConfig(directory),
      agentBackend: createTracingBackend(),
      logger: false,
    });

    try {
      const projectResponse = await app.inject({
        method: 'POST',
        url: '/api/projects',
        payload: { name: 'Stream test' },
      });
      const project = projectResponse.json<{ id: string }>();
      await app.listen({ host: '127.0.0.1', port: 0 });
      const address = app.server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected the test server to listen on a TCP port.');
      }

      const streamResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/projects/${project.id}/events`,
      );
      expect(streamResponse.status).toBe(200);
      expect(streamResponse.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      const eventsPromise = readProjectEvents(streamResponse, (events) =>
        events.some(
          (event) =>
            event.type === 'task.updated' && event.task.status === 'completed',
        ),
      );

      const taskResponse = await fetch(
        `http://127.0.0.1:${address.port}/api/projects/${project.id}/tasks`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ input: 'Stream execution', preference: 'coding' }),
        },
      );
      expect(taskResponse.status).toBe(202);

      const events = await eventsPromise;
      expect(
        events
          .filter((event) => event.type === 'task.updated')
          .map((event) => event.task.status),
      ).toEqual(['pending', 'running', 'completed']);
      expect(
        events
          .filter((event) => event.type === 'trace.appended')
          .map((event) => event.trace.event.type),
      ).toEqual(['run.started', 'message.delta', 'run.completed']);
    } finally {
      await app.close();
    }
  });

  it('exposes model setup without returning the API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const backend = createSetupBackend();
    const app = await createApp({
      config: testConfig(directory),
      agentBackend: backend,
      logger: false,
    });

    try {
      const modelsResponse = await app.inject({
        method: 'POST',
        url: '/api/setup/models',
        payload: { provider: 'openrouter', apiKey: 'secret-key' },
      });
      expect(modelsResponse.statusCode).toBe(200);
      expect(modelsResponse.json()).toEqual([
        {
          id: 'vendor/model',
          name: 'Vendor Model',
          contextTokens: 128_000,
          supportsThinking: false,
          isFree: false,
        },
      ]);

      const catalogResponse = await app.inject({
        method: 'GET',
        url: '/api/setup/models?provider=openrouter',
      });
      expect(catalogResponse.statusCode).toBe(200);
      expect(catalogResponse.body).not.toContain('secret-key');
      expect(catalogResponse.json()).toEqual({
        provider: 'openrouter',
        models: modelsResponse.json(),
        updatedAt: expect.any(String),
      });

      const setupResponse = await app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: {
          provider: 'openrouter',
          apiKey: 'secret-key',
          model: 'vendor/model',
        },
      });
      expect(setupResponse.statusCode).toBe(200);
      expect(setupResponse.body).not.toContain('secret-key');
      expect(setupResponse.json()).toEqual({
        backendAvailable: true,
        configured: true,
        provider: 'openrouter',
        model: 'vendor/model',
        hasApiKey: true,
        modelLockedByEnvironment: false,
      });

      const keyResponse = await app.inject({
        method: 'POST',
        url: '/api/setup/api-key',
        payload: {
          provider: 'openrouter',
          apiKey: 'secret-key',
        },
      });
      expect(keyResponse.statusCode).toBe(200);
      expect(keyResponse.body).not.toContain('secret-key');
      expect(keyResponse.json()).toEqual({
        backendAvailable: true,
        configured: false,
        provider: 'openrouter',
        hasApiKey: true,
        modelLockedByEnvironment: false,
      });

      const chatTestResponse = await app.inject({
        method: 'POST',
        url: '/api/setup/test-chat',
        payload: {
          provider: 'openrouter',
          apiKey: 'secret-key',
          model: 'vendor/model',
        },
      });
      expect(chatTestResponse.statusCode).toBe(200);
      expect(chatTestResponse.body).not.toContain('secret-key');
      expect(chatTestResponse.json()).toEqual({
        ok: true,
        provider: 'openrouter',
        statusCode: 200,
        requestedModel: 'vendor/model',
        responseModel: 'vendor/model',
        content: 'OK',
        requestId: 'request-1',
        latencyMs: 12,
      });


      const emptyCatalogResponse = await app.inject({
        method: 'GET',
        url: '/api/setup/models?provider=deepseek',
      });
      expect(emptyCatalogResponse.json()).toEqual({
        provider: 'deepseek',
        models: [],
      });
    } finally {
      await app.close();
    }
  });
});

function testConfig(
  dataDir: string,
  projectsDir = join(dataDir, 'projects-root'),
): ServerConfig {
  return {
    host: '127.0.0.1',
    port: 8787,
    dataDir,
    projectsDir,
    settingsPath: join(dataDir, 'settings.json'),
    pathOverrides: {
      dataDir: false,
      projectsDir: false,
      piAgentDir: false,
    },
    webDistDir: join(dataDir, 'missing-web-dist'),
    pi: { agentDir: join(dataDir, 'pi') },
    kimi: { permission: 'auto' },
  };
}

function createSetupBackend(): AgentBackend {
  return {
    ...createTracingBackend(),
    async discoverModels(input) {
      expect(input.apiKey).toBe('secret-key');
      return [{
        id: 'vendor/model',
        name: 'Vendor Model',
        contextTokens: 128_000,
        supportsThinking: false,
        isFree: false,
      }];
    },
    async saveApiKey(input) {
      expect(input.apiKey).toBe('secret-key');
      return {
        backendAvailable: true,
        configured: false,
        provider: input.provider,
        hasApiKey: true,
        modelLockedByEnvironment: false,
      };
    },
    async configure(input) {
      expect(input.apiKey).toBe('secret-key');
      return {
        backendAvailable: true,
        configured: true,
        provider: input.provider,
        model: input.model,
        hasApiKey: true,
        modelLockedByEnvironment: false,
      };
    },
    async testChat(input) {
      return {
        ok: true,
        provider: input.provider,
        statusCode: 200,
        requestedModel: input.model,
        responseModel: input.model,
        content: 'OK',
        requestId: 'request-1',
        latencyMs: 12,
      };
    },
  };
}

function createTracingBackend(): AgentBackend {
  const session: AgentSession = {
    id: 'trace-session',
    mode: 'default',
    async prompt() {
      return {
        id: 'trace-session:1',
        status: 'completed',
        events: tracingEvents(),
        result: Promise.resolve({
          output: 'done',
          finishReason: 'completed',
          usage: {
            input: 10,
            output: 2,
            cacheRead: 8,
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
          cacheRead: 8,
          cacheCreation: 0,
        },
        model: 'test-model',
        contextTokens: 120,
        contextWindow: 1_000,
      };
    },
    async compact() {},
    subscribe() {
      return () => {};
    },
    async cancel() {},
    async close() {},
  };
  return {
    name: 'test-agent',
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
    async saveApiKey() {
      throw new Error('Unexpected API key save.');
    },
    async configure() {
      throw new Error('Unexpected setup.');
    },
    async testChat() {
      throw new Error('Unexpected chat test.');
    },
    async createSession() {
      return session;
    },
    async resumeSession() {
      return session;
    },
    async close() {},
  };
}

async function* tracingEvents() {
  const common = {
    sessionId: 'trace-session',
    timestamp: '2026-01-01T00:00:00.000Z',
  };
  yield {
    ...common,
    type: 'turn.started' as const,
    turnId: 'trace-session:1',
    mode: 'default' as const,
    contextRevision: 1,
    toolRevision: 0,
    sequence: 1,
  };
  yield {
    ...common,
    type: 'message.delta' as const,
    turnId: 'trace-session:1',
    text: 'done',
  };
  yield {
    ...common,
    type: 'turn.completed' as const,
    turnId: 'trace-session:1',
    finishReason: 'completed',
    sequence: 2,
  };
}

async function waitForTask(
  app: Awaited<ReturnType<typeof createApp>>,
  taskId: string,
  status: Task['status'],
): Promise<Task> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const response = await app.inject({
      method: 'GET',
      url: `/api/tasks/${taskId}`,
    });
    const task = response.json<Task>();
    if (task.status === status) return task;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Task ${taskId} did not reach ${status}.`);
}

async function readProjectEvents(
  response: Response,
  complete: (events: readonly ProjectStreamEvent[]) => boolean,
): Promise<readonly ProjectStreamEvent[]> {
  if (response.body === null) throw new Error('Expected an SSE response body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const events: ProjectStreamEvent[] = [];
  let buffered = '';
  const timeout = setTimeout(() => void reader.cancel(), 2_000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) throw new Error('SSE stream ended before the expected event.');
      buffered += decoder.decode(value, { stream: true });
      const blocks = buffered.split('\n\n');
      buffered = blocks.pop() ?? '';
      for (const block of blocks) {
        const data = block
          .split('\n')
          .find((line) => line.startsWith('data: '))
          ?.slice('data: '.length);
        if (data === undefined || data === '{}') continue;
        events.push(JSON.parse(data) as ProjectStreamEvent);
        if (complete(events)) {
          await reader.cancel();
          return events;
        }
      }
    }
  } finally {
    clearTimeout(timeout);
  }
}
