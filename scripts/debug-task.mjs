import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = configuredPath(
  process.env['BABYBOT_DATA_DIR'],
  '.babybot',
  '.babybot',
);
const databasePath = resolve(dataDirectory, 'babybot.sqlite');
const arguments_ = process.argv.slice(2);
const json = arguments_.includes('--json');
const taskId = arguments_.find((argument) => argument !== '--json');

if (!existsSync(databasePath)) {
  fail(`Babybot database was not found at ${databasePath}.`);
}

const database = new DatabaseSync(databasePath, { readOnly: true });

try {
  if (taskId === undefined) {
    printRecentTasks();
  } else {
    printTask(taskId);
  }
} finally {
  database.close();
}

function printRecentTasks() {
  const tasks = database
    .prepare(
      `SELECT id, project_id, status, route, input, updated_at
       FROM tasks
       ORDER BY updated_at DESC
       LIMIT 20`,
    )
    .all();

  if (json) {
    writeJson(tasks);
    return;
  }
  if (tasks.length === 0) {
    process.stdout.write('No tasks found.\n');
    return;
  }
  for (const task of tasks) {
    process.stdout.write(
      [
        task.id,
        task.status,
        task.route ?? '-',
        task.updated_at,
        truncate(task.input, 80),
      ].join('  ') + '\n',
    );
  }
}

function printTask(id) {
  const task = database
    .prepare('SELECT * FROM tasks WHERE id = ?')
    .get(id);
  if (task === undefined) {
    fail(`Task ${id} was not found.`);
  }

  const sessions = database
    .prepare(
      `SELECT backend, session_id
       FROM agent_sessions
       WHERE project_id = ?`,
    )
    .all(task.project_id);
  const trace = database
    .prepare(
      `SELECT sequence, timestamp, session_id, event
       FROM agent_trace
       WHERE task_id = ?
       ORDER BY sequence`,
    )
    .all(id)
    .map((row) => ({
      ...row,
      event: JSON.parse(row.event),
    }));

  const result = {
    task: {
      ...task,
      token_usage: parseJson(task.token_usage),
      usage: parseJson(task.usage),
    },
    sessions,
    trace,
  };
  if (json) {
    writeJson(result);
    return;
  }

  process.stdout.write(`Task: ${task.id}\n`);
  process.stdout.write(`Project: ${task.project_id}\n`);
  process.stdout.write(`Status: ${task.status} (${task.route ?? task.preference})\n`);
  process.stdout.write(`Input: ${task.input}\n`);
  if (task.error !== null) process.stdout.write(`Error: ${task.error}\n`);
  if (task.token_usage !== null) {
    process.stdout.write(`Token usage: ${task.token_usage}\n`);
  }
  for (const session of sessions) {
    process.stdout.write(`Session: ${session.backend}/${session.session_id}\n`);
  }
  process.stdout.write('\nTrace:\n');
  if (trace.length === 0) {
    process.stdout.write('  No agent events recorded.\n');
    return;
  }
  for (const item of trace) {
    process.stdout.write(
      `${String(item.sequence).padStart(4, '0')} ${item.timestamp} ${formatEvent(item.event)}\n`,
    );
  }
}

function formatEvent(event) {
  const details = { ...event };
  delete details.type;
  return `${event.type} ${truncate(JSON.stringify(details), 500)}`.trimEnd();
}

function parseJson(value) {
  return value === null ? undefined : JSON.parse(value);
}

function truncate(value, limit) {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function configuredPath(value, fallback, legacyDefault) {
  const trimmed = value?.trim();
  if (
    trimmed === undefined ||
    trimmed === '' ||
    (legacyDefault !== undefined && trimmed === legacyDefault)
  ) {
    return resolve(fallback);
  }
  return resolve(repositoryRoot, expandHome(trimmed));
}

function expandHome(path) {
  if (path === '~') return process.env.HOME ?? path;
  if (path.startsWith('~/')) return join(process.env.HOME ?? '', path.slice(2));
  return path;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
