import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { LocalCapabilityRuntime } from '@babybot/capability-runtime';
import {
  createProjectInputSchema,
  createTaskInputSchema,
  configureModelInputSchema,
  discoverModelsInputSchema,
  type ApiError,
  type HealthResponse,
} from '@babybot/contracts';
import {
  ProjectService,
  TaskOrchestrator,
  type AgentBackend,
} from '@babybot/core';
import {
  KimiCodeAgentBackend,
  UnavailableAgentBackend,
} from '@babybot/kimi-code-backend';
import { FileProjectWorkspace, SqliteStorage } from '@babybot/storage';

import type { ServerConfig } from './config';

export interface CreateAppOptions {
  readonly config: ServerConfig;
  readonly agentBackend?: AgentBackend;
  readonly logger?: boolean;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  await mkdir(options.config.dataDir, { recursive: true });

  const app = Fastify({ logger: options.logger ?? true });
  const storage = new SqliteStorage(join(options.config.dataDir, 'babybot.sqlite'));
  const workspaces = new FileProjectWorkspace(join(options.config.dataDir, 'projects'));
  const agentBackend = options.agentBackend ?? createAgentBackend(options.config);
  const projectService = new ProjectService(storage, workspaces);
  const taskOrchestrator = new TaskOrchestrator({
    projects: storage,
    tasks: storage,
    agentSessions: storage,
    traces: storage,
    workspaces,
    capabilities: new LocalCapabilityRuntime(),
    agentBackend,
  });

  app.addHook('onClose', async () => {
    await agentBackend.close();
    storage.close();
  });

  app.get<{ Reply: HealthResponse }>('/api/health', async () => ({
    status: 'ok',
    agentBackend: {
      name: agentBackend.name,
      available: await agentBackend.isAvailable(),
      capabilities: agentBackend.capabilities,
    },
  }));

  app.get('/api/setup', () => agentBackend.getSetupStatus());

  app.post('/api/setup/models', async (request, reply) => {
    const parsed = discoverModelsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid setup input.',
      });
    }
    try {
      return await agentBackend.discoverModels(parsed.data);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/setup', async (request, reply) => {
    const parsed = configureModelInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid setup input.',
      });
    }
    try {
      const status = await agentBackend.configure(parsed.data);
      await storage.clearSessions(agentBackend.name);
      return status;
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/projects', () => projectService.list());

  app.post<{ Reply: Awaited<ReturnType<ProjectService['create']>> | ApiError }>(
    '/api/projects',
    async (request, reply) => {
      const parsed = createProjectInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' });
      }
      return reply.code(201).send(await projectService.create(parsed.data.name));
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId',
    async (request, reply) => {
      const project = await projectService.get(request.params.projectId);
      if (project === undefined) {
        return reply.code(404).send({ error: 'Project not found.' });
      }
      return project;
    },
  );

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tasks',
    (request) => taskOrchestrator.list(request.params.projectId),
  );

  app.get<{ Params: { taskId: string } }>('/api/tasks/:taskId', async (request, reply) => {
    const task = await taskOrchestrator.get(request.params.taskId);
    if (task === undefined) {
      return reply.code(404).send({ error: 'Task not found.' });
    }
    return task;
  });

  app.get<{ Params: { taskId: string }; Querystring: { after?: string } }>(
    '/api/tasks/:taskId/trace',
    (request, reply) => {
      const afterSequence = Number(request.query.after ?? '0');
      if (!Number.isInteger(afterSequence) || afterSequence < 0) {
        return reply.code(400).send({ error: 'after must be a non-negative integer.' });
      }
      return taskOrchestrator.trace(request.params.taskId, afterSequence);
    },
  );

  app.post<{ Params: { taskId: string } }>(
    '/api/tasks/:taskId/cancel',
    async (request, reply) => {
      if (!(await taskOrchestrator.cancel(request.params.taskId))) {
        return reply.code(409).send({ error: 'Task is not currently running.' });
      }
      return reply.code(202).send({ status: 'cancelling' });
    },
  );

  app.post<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/tasks',
    async (request, reply) => {
      const parsed = createTaskInputSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid input.' });
      }

      try {
        const task = await taskOrchestrator.start({
          projectId: request.params.projectId,
          input: parsed.data.input,
          preference: parsed.data.preference,
        });
        return reply.code(202).send(task);
      } catch (error) {
        return reply.code(404).send({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );

  if (existsSync(options.config.webDistDir)) {
    await app.register(fastifyStatic, {
      root: options.config.webDistDir,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'API endpoint not found.' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

function createAgentBackend(config: ServerConfig): AgentBackend {
  if (config.kimi.sdkPath === undefined) {
    return new UnavailableAgentBackend();
  }
  return new KimiCodeAgentBackend({
    sdkPath: config.kimi.sdkPath,
    ...(config.kimi.homeDir === undefined ? {} : { homeDir: config.kimi.homeDir }),
    ...(config.kimi.model === undefined ? {} : { model: config.kimi.model }),
    permission: config.kimi.permission,
  });
}
