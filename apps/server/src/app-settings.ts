import { execFile } from 'node:child_process';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import type {
  AppSettings,
  AppSettingsPaths,
  ChooseDirectoryInput,
  DirectoryListing,
  DirectorySelection,
  DirectoryShortcut,
  UpdateAppSettingsInput,
} from '@babybot/contracts';

import {
  deriveAppPaths,
  readStoredAppSettings,
  resolveInteractivePath,
  type ServerConfig,
} from './config';

const execFileAsync = promisify(execFile);

export function getAppSettings(config: ServerConfig): AppSettings {
  const current = currentPaths(config);
  const stored = readStoredAppSettings(config.settingsPath);
  const pending = pendingPaths(config, stored.projectsDir);
  return {
    current,
    ...(pending === undefined ? {} : { pending }),
    settingsPath: config.settingsPath,
    restartRequired: pending !== undefined && !samePaths(current, pending),
    environmentOverrides: config.pathOverrides,
  };
}

export async function chooseSettingsDirectory(
  config: ServerConfig,
  input: ChooseDirectoryInput,
): Promise<DirectorySelection> {
  if (process.platform !== 'darwin') {
    throw new Error('Finder folder selection is only available on macOS.');
  }

  const defaultPath = await pickerDefaultPath(input.defaultPath ?? config.projectsDir);
  try {
    const { stdout } = await execFileAsync('osascript', [
      '-e',
      `set defaultFolder to POSIX file ${appleScriptString(defaultPath)}`,
      '-e',
      'set selectedFolder to choose folder with prompt "Choose Babybot project folder" default location defaultFolder',
      '-e',
      'POSIX path of selectedFolder',
    ]);
    const path = resolveInteractivePath(String(stdout));
    const details = await stat(path);
    if (!details.isDirectory()) {
      throw new Error('Selected path is not a directory.');
    }
    return { canceled: false, path };
  } catch (error) {
    if (isAppleScriptCancel(error)) {
      return { canceled: true };
    }
    throw new Error(appleScriptErrorMessage(error));
  }
}

export async function listSettingsDirectories(
  config: ServerConfig,
  inputPath: string | undefined,
): Promise<DirectoryListing> {
  const path = inputPath === undefined || inputPath.trim() === ''
    ? homedir()
    : resolveInteractivePath(inputPath);
  const details = await stat(path);
  if (!details.isDirectory()) {
    throw new Error('Path is not a directory.');
  }
  const entries = await readdir(path, { withFileTypes: true });
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      path: join(path, entry.name),
    }))
    .sort((left, right) => directorySortKey(left.name).localeCompare(
      directorySortKey(right.name),
    ));
  const parent = dirname(path);
  return {
    path,
    ...(parent === path ? {} : { parent }),
    entries: directories,
    shortcuts: await directoryShortcuts(config),
  };
}

export async function saveAppSettings(
  config: ServerConfig,
  input: UpdateAppSettingsInput,
): Promise<AppSettings> {
  if (config.pathOverrides.projectsDir) {
    throw new Error('BABYBOT_PROJECTS_DIR is set in the environment. Remove it before changing the workspace from the UI.');
  }

  const projectsDir = resolveInteractivePath(input.projectsDir);
  await mkdir(dirname(config.settingsPath), { recursive: true, mode: 0o700 });
  await writeFile(
    config.settingsPath,
    `${JSON.stringify({ projectsDir }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  return getAppSettings(config);
}

async function pickerDefaultPath(path: string): Promise<string> {
  let candidate: string;
  try {
    candidate = resolveInteractivePath(path);
  } catch {
    candidate = homedir();
  }

  while (true) {
    try {
      const details = await stat(candidate);
      if (details.isDirectory()) return candidate;
    } catch {
      // Try the nearest existing parent.
    }
    const parent = dirname(candidate);
    if (parent === candidate) return homedir();
    candidate = parent;
  }
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function isAppleScriptCancel(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.message.includes('User canceled') ||
    appleScriptErrorMessage(error).includes('User canceled');
}

function appleScriptErrorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function currentPaths(config: ServerConfig): AppSettingsPaths {
  return {
    projectsDir: config.projectsDir,
    dataDir: config.dataDir,
    ...(config.pi?.agentDir === undefined ? {} : { piAgentDir: config.pi.agentDir }),
  };
}

async function directoryShortcuts(
  config: ServerConfig,
): Promise<readonly DirectoryShortcut[]> {
  const pending = getAppSettings(config).pending;
  const candidates: readonly DirectoryShortcut[] = [
    { kind: 'home', name: 'Home', path: homedir() },
    { kind: 'documents', name: 'Documents', path: join(homedir(), 'Documents') },
    { kind: 'desktop', name: 'Desktop', path: join(homedir(), 'Desktop') },
    { kind: 'downloads', name: 'Downloads', path: join(homedir(), 'Downloads') },
    { kind: 'current', name: 'Current workspace', path: config.projectsDir },
    ...(pending === undefined
      ? []
      : [{
          kind: 'pending' as const,
          name: 'Pending workspace',
          path: pending.projectsDir,
        }]),
  ];
  const unique = new Map(candidates.map((candidate) => [candidate.path, candidate]));
  const existing = await Promise.all(
    [...unique.values()].map(async (candidate) =>
      (await directoryExists(candidate.path)) ? candidate : undefined),
  );
  return existing.filter((candidate): candidate is DirectoryShortcut =>
    candidate !== undefined);
}

function directorySortKey(name: string): string {
  return `${name.startsWith('.') ? '1' : '0'}:${name.toLocaleLowerCase()}`;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function pendingPaths(
  config: ServerConfig,
  projectsDir: string | undefined,
): AppSettingsPaths | undefined {
  if (projectsDir === undefined || config.pathOverrides.projectsDir) {
    return undefined;
  }
  const normalizedProjectsDir = resolveInteractivePath(projectsDir);
  return deriveAppPaths(normalizedProjectsDir, {
    dataDir: config.dataDir,
    ...(config.pi?.agentDir !== undefined
      ? { piAgentDir: config.pi.agentDir }
      : {}),
  });
}

function samePaths(left: AppSettingsPaths, right: AppSettingsPaths): boolean {
  return left.projectsDir === right.projectsDir &&
    left.dataDir === right.dataDir &&
    left.piAgentDir === right.piAgentDir;
}
