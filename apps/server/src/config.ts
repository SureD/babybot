import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type KimiPermission = 'auto' | 'manual' | 'yolo';
export type AgentBackendName = 'pi' | 'kimi-code';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly projectsDir: string;
  readonly settingsPath: string;
  readonly pathOverrides: {
    readonly dataDir: boolean;
    readonly projectsDir: boolean;
    readonly piAgentDir: boolean;
  };
  readonly webDistDir: string;
  readonly agentBackend?: AgentBackendName;
  readonly pi?: {
    readonly agentDir?: string;
    readonly model?: string;
  };
  readonly web?: {
    readonly tavilyApiKey?: string;
  };
  readonly kimi: {
    readonly sdkPath?: string;
    readonly homeDir?: string;
    readonly model?: string;
    readonly permission: KimiPermission;
  };
}

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
export interface StoredAppSettings {
  readonly projectsDir?: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = configuredPath(
    environment['BABYBOT_DATA_DIR'],
    '.babybot',
    '.babybot',
  );
  const settingsPath = configuredPath(
    environment['BABYBOT_SETTINGS_PATH'],
    join(dataDir, 'settings.json'),
  );
  const storedSettings = readStoredAppSettings(settingsPath);
  const projectsDir = configuredPath(
    configuredValue(environment['BABYBOT_PROJECTS_DIR']) ?? storedSettings.projectsDir,
    join(homedir(), 'Babybot'),
  );
  const rawPermission = environment['KIMI_CODE_PERMISSION'] ?? 'auto';
  if (!isKimiPermission(rawPermission)) {
    throw new Error('KIMI_CODE_PERMISSION must be auto, manual, or yolo.');
  }

  return {
    host: environment['BABYBOT_HOST'] ?? '127.0.0.1',
    port: parsePort(environment['BABYBOT_PORT']),
    dataDir,
    projectsDir,
    settingsPath,
    pathOverrides: {
      dataDir: hasPathOverride(environment['BABYBOT_DATA_DIR'], '.babybot'),
      projectsDir: hasPathOverride(environment['BABYBOT_PROJECTS_DIR']),
      piAgentDir: hasPathOverride(environment['BABYBOT_PI_HOME'], '.babybot/pi'),
    },
    webDistDir: resolve(repositoryRoot, 'apps/web/dist'),
    agentBackend: parseAgentBackend(environment['BABYBOT_AGENT_BACKEND']),
    pi: {
      agentDir: configuredPath(
        environment['BABYBOT_PI_HOME'],
        join(dataDir, 'pi'),
        '.babybot/pi',
      ),
      ...(environment['BABYBOT_PI_MODEL'] === undefined ||
      environment['BABYBOT_PI_MODEL'].trim() === ''
        ? {}
        : { model: environment['BABYBOT_PI_MODEL'] }),
    },
    web:
      environment['BABYBOT_TAVILY_API_KEY'] === undefined ||
      environment['BABYBOT_TAVILY_API_KEY'].trim() === ''
        ? {}
        : { tavilyApiKey: environment['BABYBOT_TAVILY_API_KEY'] },
    kimi: {
      ...(environment['KIMI_CODE_SDK_PATH'] === undefined ||
      environment['KIMI_CODE_SDK_PATH'].trim() === ''
        ? {}
        : { sdkPath: resolve(repositoryRoot, environment['KIMI_CODE_SDK_PATH']) }),
      ...(environment['KIMI_CODE_HOME'] === undefined ||
      environment['KIMI_CODE_HOME'].trim() === ''
        ? {}
        : { homeDir: resolve(repositoryRoot, environment['KIMI_CODE_HOME']) }),
      ...(environment['KIMI_CODE_MODEL'] === undefined ||
      environment['KIMI_CODE_MODEL'].trim() === ''
        ? {}
        : { model: environment['KIMI_CODE_MODEL'] }),
      permission: rawPermission,
    },
  };
}

export function readStoredAppSettings(settingsPath: string): StoredAppSettings {
  if (!existsSync(settingsPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      readonly projectsDir?: unknown;
      readonly babybotHome?: unknown;
    };
    if (typeof parsed.projectsDir === 'string' && parsed.projectsDir.trim() !== '') {
      return { projectsDir: parsed.projectsDir };
    }
    return typeof parsed.babybotHome === 'string' && parsed.babybotHome.trim() !== ''
      ? { projectsDir: join(parsed.babybotHome, 'projects') }
      : {};
  } catch {
    return {};
  }
}

export function resolveInteractivePath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error('Path cannot be empty.');
  }
  const expanded = expandHome(trimmed);
  if (!expanded.startsWith('/')) {
    throw new Error('Use an absolute path or a path starting with ~/.');
  }
  return resolve(expanded);
}

export function deriveAppPaths(
  projectsDir: string,
  overrides?: {
    readonly dataDir?: string;
    readonly piAgentDir?: string;
  },
): {
  readonly projectsDir: string;
  readonly dataDir: string;
  readonly piAgentDir: string;
} {
  const dataDir = overrides?.dataDir ?? configuredPath(undefined, '.babybot', '.babybot');
  return {
    projectsDir,
    dataDir,
    piAgentDir: overrides?.piAgentDir ?? join(dataDir, 'pi'),
  };
}

function configuredPath(
  value: string | undefined,
  fallback: string,
  legacyDefault?: string,
): string {
  const trimmed = value?.trim();
  if (
    trimmed === undefined ||
    trimmed === '' ||
    (legacyDefault !== undefined && trimmed === legacyDefault)
  ) {
    return resolve(repositoryRoot, fallback);
  }
  return resolve(repositoryRoot, expandHome(trimmed));
}

function configuredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === '' ? undefined : trimmed;
}

function hasPathOverride(value: string | undefined, legacyDefault?: string): boolean {
  const trimmed = value?.trim();
  return trimmed !== undefined &&
    trimmed !== '' &&
    (legacyDefault === undefined || trimmed !== legacyDefault);
}

function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return join(homedir(), path.slice(2));
  return path;
}

function parseAgentBackend(value: string | undefined): AgentBackendName {
  if (value === undefined || value === '' || value === 'pi') return 'pi';
  if (value === 'kimi-code') return value;
  throw new Error('BABYBOT_AGENT_BACKEND must be pi or kimi-code.');
}

function parsePort(value: string | undefined): number {
  if (value === undefined) {
    return 8787;
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('BABYBOT_PORT must be an integer between 1 and 65535.');
  }
  return port;
}

function isKimiPermission(value: string): value is KimiPermission {
  return value === 'auto' || value === 'manual' || value === 'yolo';
}
