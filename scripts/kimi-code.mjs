import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const kimiCodeRoot = resolve(
  repositoryRoot,
  process.env['KIMI_CODE_REPO'] ?? '../Dev/kimi-code',
);
const [command, ...extraArguments] = process.argv.slice(2);

if (!existsSync(resolve(kimiCodeRoot, 'package.json'))) {
  fail(
    `kimi-code repository was not found at ${kimiCodeRoot}. Set KIMI_CODE_REPO to override it.`,
  );
}

const commands = {
  install: ['install'],
  build: ['--filter', '@moonshot-ai/kimi-code-sdk', 'build'],
  test: ['exec', 'vitest', 'run', '--project', 'kimi-sdk'],
  typecheck: ['--filter', '@moonshot-ai/kimi-code-sdk', 'typecheck'],
};

if (command === undefined || !(command in commands)) {
  fail('Usage: node scripts/kimi-code.mjs <install|build|test|typecheck> [arguments]');
}

const argumentsForPnpm = [...commands[command], ...extraArguments];
const child = spawn('npx', ['--yes', 'pnpm@10.33.0', ...argumentsForPnpm], {
  cwd: kimiCodeRoot,
  stdio: 'inherit',
  env: process.env,
});

child.once('error', (error) => fail(error.message));
child.once('exit', (code, signal) => {
  if (signal !== null) {
    fail(`kimi-code command stopped with signal ${signal}.`);
  }
  process.exitCode = code ?? 1;
});

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

