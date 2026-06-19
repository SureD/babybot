import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Task } from '@babybot/contracts';
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
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 8787,
      dataDir: directory,
      webDistDir: join(directory, 'missing-web-dist'),
      kimi: {
        permission: 'auto',
      },
    };
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

  it('exposes incremental agent trace and detailed token usage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const config: ServerConfig = {
      host: '127.0.0.1',
      port: 8787,
      dataDir: directory,
      webDistDir: join(directory, 'missing-web-dist'),
      kimi: {
        permission: 'auto',
      },
    };
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
          event: { type: 'message.delta', turnId: 1, text: 'done' },
        }),
        expect.objectContaining({
          sequence: 3,
          event: { type: 'run.completed', turnId: 1, reason: 'completed' },
        }),
      ]);
    } finally {
      await app.close();
    }
  });

  it('exposes model setup without returning the API key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-server-'));
    temporaryDirectories.push(directory);
    const backend = createSetupBackend();
    const app = await createApp({
      config: {
        host: '127.0.0.1',
        port: 8787,
        dataDir: directory,
        webDistDir: join(directory, 'missing-web-dist'),
        kimi: { permission: 'auto' },
      },
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
  };
}

function createTracingBackend(): AgentBackend {
  const session: AgentSession = {
    id: 'trace-session',
    async *run() {
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
          cacheRead: 8,
          cacheCreation: 0,
        },
        model: 'test-model',
        contextTokens: 120,
        maxContextTokens: 1_000,
        contextUsage: 0.12,
      };
    },
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
    async configure() {
      throw new Error('Unexpected setup.');
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
