import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { Project, Task } from '@babybot/contracts';

import { SqliteStorage } from '../src';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('SqliteStorage', () => {
  it('persists projects, tasks, and coding sessions', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-storage-'));
    temporaryDirectories.push(directory);
    const storage = new SqliteStorage(join(directory, 'babybot.sqlite'));
    const project: Project = {
      id: 'project-1',
      name: 'Persistent project',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const task: Task = {
      id: 'task-1',
      projectId: project.id,
      input: 'Persist me',
      preference: 'auto',
      route: 'coding',
      status: 'completed',
      result: 'saved',
      usage: {
        model: 'fake-model',
        contextTokens: 1200,
        maxContextTokens: 32000,
        contextUsage: 0.0375,
        total: {
          input: 7,
          output: 3,
          cacheRead: 5,
          cacheCreation: 1,
        },
      },
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };

    await storage.saveProject(project);
    await storage.saveTask(task);
    await storage.saveSession(project.id, 'kimi-code', 'session-1');
    await storage.appendTrace({
      taskId: task.id,
      sessionId: 'session-1',
      sequence: 1,
      timestamp: project.createdAt,
      event: {
        type: 'tool.started',
        turnId: 2,
        toolCallId: 'tool-1',
        name: 'Read',
        arguments: { path: 'README.md' },
      },
    });
    await storage.saveModelCatalog({
      provider: 'openrouter',
      models: [{
        id: 'vendor/model:free',
        name: 'Vendor Model',
        contextTokens: 128_000,
        supportsThinking: false,
        isFree: true,
      }],
      updatedAt: project.createdAt,
    });

    expect(await storage.listProjects()).toEqual([project]);
    expect(await storage.listTasks(project.id)).toEqual([task]);
    expect(await storage.getSession(project.id, 'kimi-code')).toBe('session-1');
    expect(await storage.listTrace(task.id)).toEqual([
      {
        taskId: task.id,
        sessionId: 'session-1',
        sequence: 1,
        timestamp: project.createdAt,
        event: {
          type: 'tool.started',
          turnId: 2,
          toolCallId: 'tool-1',
          name: 'Read',
          arguments: { path: 'README.md' },
        },
      },
    ]);
    expect(await storage.getModelCatalog('openrouter')).toEqual({
      provider: 'openrouter',
      models: [{
        id: 'vendor/model:free',
        name: 'Vendor Model',
        contextTokens: 128_000,
        supportsThinking: false,
        isFree: true,
      }],
      updatedAt: project.createdAt,
    });
    await storage.clearSessions('kimi-code');
    expect(await storage.getSession(project.id, 'kimi-code')).toBeUndefined();
    storage.close();
  });

  it('restores a saved model catalog after reopening the database', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-storage-'));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, 'babybot.sqlite');
    const storage = new SqliteStorage(databasePath);
    const catalog = {
      provider: 'openrouter' as const,
      models: [{
        id: 'vendor/coder:free',
        name: 'Vendor Coder',
        contextTokens: 64_000,
        supportsThinking: true,
        isFree: true,
      }],
      updatedAt: '2026-06-19T08:00:00.000Z',
    };

    await storage.saveModelCatalog(catalog);
    storage.close();

    const reopened = new SqliteStorage(databasePath);
    expect(await reopened.getModelCatalog('openrouter')).toEqual(catalog);
    reopened.close();
  });
});
