import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export type KimiPermission = 'auto' | 'manual' | 'yolo';
export type AgentBackendName = 'pi' | 'kimi-code';

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly webDistDir: string;
  readonly agentBackend?: AgentBackendName;
  readonly pi?: {
    readonly agentDir?: string;
    readonly model?: string;
  };
  readonly kimi: {
    readonly sdkPath?: string;
    readonly homeDir?: string;
    readonly model?: string;
    readonly permission: KimiPermission;
  };
}

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ServerConfig {
  const dataDir = resolve(repositoryRoot, environment['BABYBOT_DATA_DIR'] ?? '.babybot');
  const rawPermission = environment['KIMI_CODE_PERMISSION'] ?? 'auto';
  if (!isKimiPermission(rawPermission)) {
    throw new Error('KIMI_CODE_PERMISSION must be auto, manual, or yolo.');
  }

  return {
    host: environment['BABYBOT_HOST'] ?? '127.0.0.1',
    port: parsePort(environment['BABYBOT_PORT']),
    dataDir,
    webDistDir: resolve(repositoryRoot, 'apps/web/dist'),
    agentBackend: parseAgentBackend(environment['BABYBOT_AGENT_BACKEND']),
    pi: {
      agentDir: resolve(
        repositoryRoot,
        environment['BABYBOT_PI_HOME'] ?? joinRelative(dataDir, 'pi'),
      ),
      ...(environment['BABYBOT_PI_MODEL'] === undefined ||
      environment['BABYBOT_PI_MODEL'].trim() === ''
        ? {}
        : { model: environment['BABYBOT_PI_MODEL'] }),
    },
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

function joinRelative(parent: string, child: string): string {
  return resolve(parent, child);
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
