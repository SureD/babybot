import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  AgentTraceEvent,
  AgentUsage,
  Project,
  Task,
  TokenUsage,
} from '@babybot/contracts';
import type {
  AgentSessionRepository,
  ProjectRepository,
  ProjectWorkspace,
  TaskRepository,
  TraceRepository,
} from '@babybot/core';

interface ProjectRow {
  readonly id: string;
  readonly name: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TaskRow {
  readonly id: string;
  readonly project_id: string;
  readonly input: string;
  readonly preference: Task['preference'];
  readonly route: Task['route'] | null;
  readonly status: Task['status'];
  readonly result: string | null;
  readonly error: string | null;
  readonly token_usage: string | null;
  readonly usage: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface TraceRow {
  readonly task_id: string;
  readonly session_id: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: string;
}

export class SqliteStorage
  implements ProjectRepository, TaskRepository, AgentSessionRepository, TraceRepository
{
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.migrate();
  }

  async listProjects(): Promise<readonly Project[]> {
    const rows = this.database
      .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
      .all() as unknown as ProjectRow[];
    return rows.map(mapProject);
  }

  async getProject(id: string): Promise<Project | undefined> {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row === undefined ? undefined : mapProject(row);
  }

  async saveProject(project: Project): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO projects (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           updated_at = excluded.updated_at`,
      )
      .run(
        project.id,
        project.name,
        project.createdAt,
        project.updatedAt,
      );
  }

  async listTasks(projectId: string): Promise<readonly Task[]> {
    const rows = this.database
      .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC')
      .all(projectId) as unknown as TaskRow[];
    return rows.map(mapTask);
  }

  async getTask(id: string): Promise<Task | undefined> {
    const row = this.database
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .get(id) as TaskRow | undefined;
    return row === undefined ? undefined : mapTask(row);
  }

  async appendTrace(trace: AgentTraceEvent): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO agent_trace (
           task_id, session_id, sequence, timestamp, event
         ) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        trace.taskId,
        trace.sessionId,
        trace.sequence,
        trace.timestamp,
        JSON.stringify(trace.event),
      );
  }

  async listTrace(
    taskId: string,
    afterSequence = 0,
  ): Promise<readonly AgentTraceEvent[]> {
    const rows = this.database
      .prepare(
        `SELECT * FROM agent_trace
         WHERE task_id = ? AND sequence > ?
         ORDER BY sequence`,
      )
      .all(taskId, afterSequence) as unknown as TraceRow[];
    return rows.map((row) => ({
      taskId: row.task_id,
      sessionId: row.session_id,
      sequence: row.sequence,
      timestamp: row.timestamp,
      event: JSON.parse(row.event) as AgentTraceEvent['event'],
    }));
  }

  async getSession(projectId: string, backend: string): Promise<string | undefined> {
    const row = this.database
      .prepare(
        'SELECT session_id FROM agent_sessions WHERE project_id = ? AND backend = ?',
      )
      .get(projectId, backend) as { readonly session_id: string } | undefined;
    return row?.session_id;
  }

  async clearSessions(backend: string): Promise<void> {
    this.database
      .prepare('DELETE FROM agent_sessions WHERE backend = ?')
      .run(backend);
  }

  close(): void {
    this.database.close();
  }

  async saveTask(task: Task): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO tasks (
           id, project_id, input, preference, route, status, result, error,
           token_usage, usage, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           route = excluded.route,
           status = excluded.status,
           result = excluded.result,
           error = excluded.error,
           token_usage = excluded.token_usage,
           usage = excluded.usage,
           updated_at = excluded.updated_at`,
      )
      .run(
        task.id,
        task.projectId,
        task.input,
        task.preference,
        task.route ?? null,
        task.status,
        task.result ?? null,
        task.error ?? null,
        task.tokenUsage === undefined ? null : JSON.stringify(task.tokenUsage),
        task.usage === undefined ? null : JSON.stringify(task.usage),
        task.createdAt,
        task.updatedAt,
      );
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        input TEXT NOT NULL,
        preference TEXT NOT NULL,
        route TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        token_usage TEXT,
        usage TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_sessions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        backend TEXT NOT NULL,
        session_id TEXT NOT NULL,
        PRIMARY KEY (project_id, backend)
      );

      CREATE TABLE IF NOT EXISTS agent_trace (
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        timestamp TEXT NOT NULL,
        event TEXT NOT NULL,
        PRIMARY KEY (task_id, sequence)
      );

      CREATE INDEX IF NOT EXISTS agent_trace_task_timestamp
        ON agent_trace(task_id, timestamp);
    `);
    this.ensureColumn('tasks', 'usage', 'TEXT');
  }

  async saveSession(projectId: string, backend: string, sessionId: string): Promise<void> {
    this.database
      .prepare(
        `INSERT INTO agent_sessions (project_id, backend, session_id)
         VALUES (?, ?, ?)
         ON CONFLICT(project_id, backend) DO UPDATE SET
           session_id = excluded.session_id`,
      )
      .run(projectId, backend, sessionId);
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      readonly name: string;
    }>;
    if (!columns.some((item) => item.name === column)) {
      this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
}

export class FileProjectWorkspace implements ProjectWorkspace {
  constructor(private readonly projectsDirectory: string) {}

  async ensure(projectId: string): Promise<string> {
    const path = join(this.projectsDirectory, projectId, 'workspace');
    await mkdir(path, { recursive: true });
    return path;
  }
}

function mapProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectId: row.project_id,
    input: row.input,
    preference: row.preference,
    ...(row.route === null ? {} : { route: row.route }),
    status: row.status,
    ...(row.result === null ? {} : { result: row.result }),
    ...(row.error === null ? {} : { error: row.error }),
    ...(row.token_usage === null
      ? {}
      : { tokenUsage: JSON.parse(row.token_usage) as TokenUsage }),
    ...(row.usage === null ? {} : { usage: JSON.parse(row.usage) as AgentUsage }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
