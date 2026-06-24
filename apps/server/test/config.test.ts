import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('loadConfig', () => {
  it('keeps app state local and puts projects under the configured folder', () => {
    const config = loadConfig({
      BABYBOT_PROJECTS_DIR: '/tmp/Babybot',
    });

    expect(config.dataDir).toBe(join(process.cwd(), '.babybot'));
    expect(config.projectsDir).toBe('/tmp/Babybot');
    expect(config.pi?.agentDir).toBe(join(process.cwd(), '.babybot/pi'));
  });

  it('keeps project workspaces configurable separately from app state', () => {
    const config = loadConfig({
      BABYBOT_DATA_DIR: '/tmp/babybot-state',
      BABYBOT_PROJECTS_DIR: '/tmp/babybot-projects',
      BABYBOT_PI_HOME: '/tmp/babybot-pi',
    });

    expect(config.dataDir).toBe('/tmp/babybot-state');
    expect(config.projectsDir).toBe('/tmp/babybot-projects');
    expect(config.pi?.agentDir).toBe('/tmp/babybot-pi');
    expect(config.pathOverrides).toEqual({
      dataDir: true,
      projectsDir: true,
      piAgentDir: true,
    });
  });

  it('keeps legacy repository-local state defaults while projects use the user folder', () => {
    const config = loadConfig({
      BABYBOT_DATA_DIR: '.babybot',
      BABYBOT_PI_HOME: '.babybot/pi',
    });

    expect(config.dataDir).toBe(join(process.cwd(), '.babybot'));
    expect(config.projectsDir).toBe(join(homedir(), 'Babybot'));
    expect(config.pi?.agentDir).toBe(join(process.cwd(), '.babybot/pi'));
    expect(config.pathOverrides.dataDir).toBe(false);
    expect(config.pathOverrides.piAgentDir).toBe(false);
  });

  it('loads the projects directory from the saved settings file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-config-'));
    temporaryDirectories.push(directory);
    const settingsPath = join(directory, 'settings.json');
    await writeFile(
      settingsPath,
      `${JSON.stringify({ projectsDir: join(directory, 'saved-projects') })}\n`,
    );

    const config = loadConfig({
      BABYBOT_SETTINGS_PATH: settingsPath,
    });

    expect(config.dataDir).toBe(join(process.cwd(), '.babybot'));
    expect(config.projectsDir).toBe(join(directory, 'saved-projects'));
  });

  it('loads optional Tavily web search credentials', () => {
    const config = loadConfig({
      BABYBOT_TAVILY_API_KEY: 'test-tavily-key',
    });

    expect(config.web).toEqual({ tavilyApiKey: 'test-tavily-key' });
  });

  it('does not configure web search for an empty key', () => {
    const config = loadConfig({
      BABYBOT_TAVILY_API_KEY: '  ',
    });

    expect(config.web).toEqual({});
  });
});
