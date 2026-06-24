import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';

import { LocalCapabilityRuntime } from '@babybot/capability-runtime';
import {
  chooseDirectoryInputSchema,
  createProjectInputSchema,
  createTaskInputSchema,
  configureModelInputSchema,
  directChatTestInputSchema,
  discoverModelsInputSchema,
  modelProviderSchema,
  saveApiKeyInputSchema,
  updateAppSettingsInputSchema,
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
import { PiAgentBackend } from '@babybot/pi-backend';
import { FileProjectWorkspace, SqliteStorage } from '@babybot/storage';
import {
  ProjectToolRuntime,
  TavilyWebSearchProvider,
} from '@babybot/tool-runtime';

import type { ServerConfig } from './config';
import {
  chooseSettingsDirectory,
  getAppSettings,
  listSettingsDirectories,
  saveAppSettings,
} from './app-settings';
import { ProjectEventHub } from './project-events';

export interface CreateAppOptions {
  readonly config: ServerConfig;
  readonly agentBackend?: AgentBackend;
  readonly logger?: boolean;
}

export async function createApp(options: CreateAppOptions): Promise<FastifyInstance> {
  await mkdir(options.config.dataDir, { recursive: true });

  const app = Fastify({ logger: options.logger ?? true });
  const storage = new SqliteStorage(join(options.config.dataDir, 'babybot.sqlite'));
  const workspaces = new FileProjectWorkspace(options.config.projectsDir);
  const toolRuntime = new ProjectToolRuntime(
    options.config.web?.tavilyApiKey === undefined
      ? {}
      : {
          webSearchProvider: new TavilyWebSearchProvider({
            apiKey: options.config.web.tavilyApiKey,
          }),
        },
  );
  const agentBackend =
    options.agentBackend ?? createAgentBackend(options.config, toolRuntime);
  const projectService = new ProjectService(storage, workspaces);
  const projectEvents = new ProjectEventHub();
  const taskOrchestrator = new TaskOrchestrator({
    projects: storage,
    tasks: storage,
    agentSessions: storage,
    traces: storage,
    events: {
      taskUpdated(task) {
        projectEvents.publish(task.projectId, { type: 'task.updated', task });
      },
      traceAppended(projectId, trace) {
        projectEvents.publish(projectId, { type: 'trace.appended', trace });
      },
    },
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

  app.get('/api/settings', () => getAppSettings(options.config));

  app.get('/api/settings/directories', async (request, reply) => {
    const query = request.query as { readonly path?: unknown };
    if (query.path !== undefined && typeof query.path !== 'string') {
      return reply.code(400).send({ error: 'path must be a string.' });
    }
    try {
      return await listSettingsDirectories(options.config, query.path);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/settings/choose-directory', async (request, reply) => {
    const parsed = chooseDirectoryInputSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid directory input.',
      });
    }
    try {
      return await chooseSettingsDirectory(options.config, parsed.data);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/settings', async (request, reply) => {
    const parsed = updateAppSettingsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid settings input.',
      });
    }
    try {
      return await saveAppSettings(options.config, parsed.data);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post('/api/setup/api-key', async (request, reply) => {
    const parsed = saveApiKeyInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid API key input.',
      });
    }
    try {
      return await agentBackend.saveApiKey(parsed.data);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.get('/api/setup/models', async (request, reply) => {
    const query = request.query as { readonly provider?: unknown };
    const parsed = modelProviderSchema.safeParse(query.provider);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'A valid provider is required.' });
    }
    return (
      (await storage.getModelCatalog(parsed.data)) ?? {
        provider: parsed.data,
        models: [],
      }
    );
  });

  app.post('/api/setup/models', async (request, reply) => {
    const parsed = discoverModelsInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid setup input.',
      });
    }
    try {
      const models = await agentBackend.discoverModels(parsed.data);
      await storage.saveModelCatalog({
        provider: parsed.data.provider,
        models,
        updatedAt: new Date().toISOString(),
      });
      return models;
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

  app.post('/api/setup/test-chat', async (request, reply) => {
    const parsed = directChatTestInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: parsed.error.issues[0]?.message ?? 'Invalid chat test input.',
      });
    }
    try {
      return await agentBackend.testChat(parsed.data);
    } catch (error) {
      return reply.code(502).send({
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

  app.get<{ Params: { projectId: string } }>(
    '/api/projects/:projectId/events',
    async (request, reply) => {
      if ((await projectService.get(request.params.projectId)) === undefined) {
        return reply.code(404).send({ error: 'Project not found.' });
      }

      reply.hijack();
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      const unsubscribe = projectEvents.subscribe(
        request.params.projectId,
        (event) => {
          reply.raw.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        },
      );
      reply.raw.write('event: ready\ndata: {}\n\n');
      const heartbeat = setInterval(() => {
        reply.raw.write(': heartbeat\n\n');
      }, 15_000);
      request.raw.once('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    },
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

function createAgentBackend(
  config: ServerConfig,
  toolRuntime: ProjectToolRuntime,
): AgentBackend {
  if ((config.agentBackend ?? 'pi') === 'pi') {
    return new PiAgentBackend({
      agentDir: config.pi?.agentDir ?? join(config.dataDir, 'pi'),
      toolRuntime,
      ...(config.pi?.model === undefined ? {} : { model: config.pi.model }),
    });
  }
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
