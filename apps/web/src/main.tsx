import {
  StrictMode,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  AgentTraceEvent,
  AgentUsage,
  ExecutionPreference,
  HealthResponse,
  ModelProvider,
  Project,
  SetupModel,
  SetupStatus,
  Task,
} from '@babybot/contracts';

import { api } from './api';
import './styles.css';

function App() {
  const [health, setHealth] = useState<HealthResponse>();
  const [setupStatus, setSetupStatus] = useState<SetupStatus>();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project>();
  const [tasks, setTasks] = useState<readonly Task[]>([]);
  const [traces, setTraces] = useState<
    Readonly<Record<string, readonly AgentTraceEvent[]>>
  >({});
  const [projectName, setProjectName] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [preference, setPreference] = useState<ExecutionPreference>('auto');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showSetup, setShowSetup] = useState(false);
  const traceCursors = useRef<Record<string, number>>({});
  const loadedTerminalTraces = useRef(new Set<string>());
  const refreshing = useRef(false);
  const activeProjectId = useRef<string | undefined>(undefined);

  useEffect(() => {
    void Promise.all([api.health(), api.setupStatus(), api.listProjects()])
      .then(([nextHealth, nextSetupStatus, nextProjects]) => {
        setHealth(nextHealth);
        setSetupStatus(nextSetupStatus);
        setProjects(nextProjects);
        if (nextSetupStatus.configured) {
          setSelectedProject(nextProjects[0]);
        }
      })
      .catch(showError);
  }, []);

  useEffect(() => {
    if (selectedProject === undefined) {
      setTasks([]);
      setTraces({});
      traceCursors.current = {};
      loadedTerminalTraces.current.clear();
      activeProjectId.current = undefined;
      return;
    }
    const projectId = selectedProject.id;
    activeProjectId.current = projectId;
    setTasks([]);
    setTraces({});
    traceCursors.current = {};
    loadedTerminalTraces.current.clear();
    void refreshProject(projectId);
    const interval = window.setInterval(() => {
      void refreshProject(projectId);
    }, 1_000);
    return () => window.clearInterval(interval);
  }, [selectedProject]);

  async function refreshProject(projectId: string) {
    if (refreshing.current) return;
    refreshing.current = true;
    try {
      const nextTasks = await api.listTasks(projectId);
      if (activeProjectId.current !== projectId) return;
      setTasks(nextTasks);
      const traceEntries = await Promise.all(
        nextTasks
          .filter(
            (task) =>
              task.preference !== 'capability' &&
              (!loadedTerminalTraces.current.has(task.id) ||
                task.status === 'pending' ||
                task.status === 'running'),
          )
          .map(async (task) => {
            const afterSequence = traceCursors.current[task.id] ?? 0;
            return [
              task.id,
              await api.getTrace(task.id, afterSequence),
            ] as const;
          }),
      );
      if (activeProjectId.current !== projectId) return;
      setTraces((current) => {
        const next = { ...current };
        for (const [taskId, events] of traceEntries) {
          if (events.length > 0) {
            next[taskId] = [...(next[taskId] ?? []), ...events];
            traceCursors.current[taskId] =
              events.at(-1)?.sequence ?? traceCursors.current[taskId] ?? 0;
          }
          const task = nextTasks.find((candidate) => candidate.id === taskId);
          if (task?.status === 'completed' || task?.status === 'failed') {
            loadedTerminalTraces.current.add(taskId);
          }
        }
        return next;
      });
    } catch (caught) {
      showError(caught);
    } finally {
      refreshing.current = false;
    }
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (projectName.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const project = await api.createProject({ name: projectName });
      setProjects((current) => [project, ...current]);
      setSelectedProject(project);
      setProjectName('');
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (selectedProject === undefined || taskInput.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await api.createTask(selectedProject.id, {
        input: taskInput,
        preference,
      });
      setTasks((current) => [task, ...current]);
      setTraces((current) => ({ ...current, [task.id]: [] }));
      traceCursors.current[task.id] = 0;
      loadedTerminalTraces.current.delete(task.id);
      setTaskInput('');
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function cancelTask(taskId: string) {
    try {
      await api.cancelTask(taskId);
    } catch (caught) {
      showError(caught);
    }
  }

  function showError(caught: unknown) {
    setError(caught instanceof Error ? caught.message : String(caught));
  }

  if (setupStatus === undefined) {
    return (
      <main className="setup-shell">
        <p>{error ?? 'Loading Babybot...'}</p>
      </main>
    );
  }

  if (!setupStatus.configured || showSetup) {
    return (
      <Setup
        status={setupStatus}
        {...(setupStatus.configured
          ? { onCancel: () => setShowSetup(false) }
          : {})}
        onConfigured={(nextStatus) => {
          setSetupStatus(nextStatus);
          setShowSetup(false);
          setSelectedProject(projects[0]);
        }}
      />
    );
  }

  return (
    <main className="shell">
      <aside className="sidebar">
        <header>
          <p className="eyebrow">Local personal assistant</p>
          <h1>Babybot</h1>
        </header>

        <form className="new-project" onSubmit={(event) => void createProject(event)}>
          <label htmlFor="project-name">New project</label>
          <div className="inline-form">
            <input
              id="project-name"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Project name"
            />
            <button disabled={busy}>Add</button>
          </div>
        </form>

        <nav aria-label="Projects">
          {projects.map((project) => (
            <button
              className={selectedProject?.id === project.id ? 'project active' : 'project'}
              key={project.id}
              onClick={() => setSelectedProject(project)}
            >
              {project.name}
            </button>
          ))}
        </nav>

        <footer>
          <div className="backend-status">
            <span className={health?.agentBackend.available === true ? 'dot ready' : 'dot'} />
            {health === undefined
              ? 'Connecting'
              : `${setupStatus.provider ?? health.agentBackend.name}: ${
                  setupStatus.model ?? 'not configured'
                }`}
          </div>
          <button className="model-settings" onClick={() => setShowSetup(true)}>
            Model settings
          </button>
        </footer>
      </aside>

      <section className="workspace">
        {selectedProject === undefined ? (
          <div className="empty">
            <p>Create a project to start a persistent workspace.</p>
          </div>
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <p className="eyebrow">Project workspace</p>
                <h2>{selectedProject.name}</h2>
              </div>
            </header>

            <form className="task-form" onSubmit={(event) => void submitTask(event)}>
              <textarea
                value={taskInput}
                onChange={(event) => setTaskInput(event.target.value)}
                placeholder="Describe what Babybot should do..."
                rows={5}
              />
              <div className="task-actions">
                <select
                  aria-label="Execution preference"
                  value={preference}
                  onChange={(event) =>
                    setPreference(event.target.value as ExecutionPreference)
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="capability">Existing capability</option>
                  <option value="coding">Coding agent</option>
                </select>
                <button disabled={busy}>{busy ? 'Working...' : 'Run task'}</button>
              </div>
            </form>

            {error === undefined ? null : <p className="error">{error}</p>}

            <div className="task-list">
              {tasks.map((task) => (
                <article className="task" key={task.id}>
                  <div className="task-meta">
                    <span className={`status ${task.status}`}>{task.status}</span>
                    <span>{task.route ?? task.preference}</span>
                    {task.tokenUsage === undefined ? null : (
                      <span>
                        {task.tokenUsage.input + task.tokenUsage.output} tokens
                      </span>
                    )}
                    {task.status === 'running' ? (
                      <button
                        className="cancel-task"
                        onClick={() => void cancelTask(task.id)}
                      >
                        Cancel
                      </button>
                    ) : null}
                  </div>
                  <h3>{task.input}</h3>
                  {task.usage === undefined ? null : <Usage usage={task.usage} />}
                  {task.result === undefined ? null : <pre>{task.result}</pre>}
                  {task.error === undefined ? null : <p className="error">{task.error}</p>}
                  {(traces[task.id]?.length ?? 0) === 0 ? null : (
                    <Trace events={traces[task.id] ?? []} />
                  )}
                </article>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function Setup({
  status,
  onConfigured,
  onCancel,
}: {
  readonly status: SetupStatus;
  readonly onConfigured: (status: SetupStatus) => void;
  readonly onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<ModelProvider>(
    status.provider ?? 'deepseek',
  );
  const [apiKey, setApiKey] = useState('');
  const [freeOnly, setFreeOnly] = useState(true);
  const [models, setModels] = useState<readonly SetupModel[]>([]);
  const [model, setModel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function loadModels(event: FormEvent) {
    event.preventDefault();
    if (apiKey.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const nextModels = await api.discoverModels({
        provider,
        apiKey,
        ...(provider === 'openrouter' ? { freeOnly } : {}),
      });
      setModels(nextModels);
      setModel(nextModels[0]?.id ?? '');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveSetup() {
    if (model === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const nextStatus = await api.configureModel({
        provider,
        apiKey,
        model,
        ...(provider === 'openrouter' ? { freeOnly } : {}),
      });
      setApiKey('');
      onConfigured(nextStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="setup-shell">
      <section className="setup-card">
        <p className="eyebrow">First-time setup</p>
        <h1>Connect a model</h1>
        <p className="setup-copy">
          Babybot uses kimi-code for model calls. Choose a provider, verify its
          API key, and select the default coding model.
        </p>
        {status.configured ? (
          <p className="current-model">
            Current: {status.provider} / {status.model}
          </p>
        ) : null}

        {!status.backendAvailable ? (
          <p className="error">
            kimi-code is not available. Configure KIMI_CODE_SDK_PATH and restart
            Babybot.
          </p>
        ) : (
          <form onSubmit={(event) => void loadModels(event)}>
            <label htmlFor="setup-provider">Provider</label>
            <select
              id="setup-provider"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as ModelProvider);
                setFreeOnly(event.target.value === 'openrouter');
                setModels([]);
                setModel('');
              }}
            >
              <option value="deepseek">DeepSeek API</option>
              <option value="openrouter">OpenRouter API</option>
            </select>

            <label htmlFor="setup-key">API key</label>
            <input
              id="setup-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setModels([]);
                setModel('');
              }}
              placeholder={provider === 'deepseek' ? 'sk-...' : 'sk-or-v1-...'}
            />

            {provider === 'openrouter' ? (
              <label className="free-model-filter">
                <input
                  type="checkbox"
                  checked={freeOnly}
                  onChange={(event) => {
                    setFreeOnly(event.target.checked);
                    setModels([]);
                    setModel('');
                  }}
                />
                Free tool-capable models only
              </label>
            ) : null}

            <button disabled={busy || apiKey.trim() === ''}>
              {busy && models.length === 0 ? 'Checking...' : 'Load models'}
            </button>
          </form>
        )}

        {models.length === 0 ? null : (
          <div className="model-picker">
            <label htmlFor="setup-model">Default model</label>
            <select
              id="setup-model"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            >
              {models.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.recommended ? 'Recommended: ' : ''}
                  {candidate.name} ({formatTokenLimit(candidate.contextTokens)}
                  {candidate.isFree ? ', free' : ''})
                </option>
              ))}
            </select>
            <button disabled={busy || model === ''} onClick={() => void saveSetup()}>
              {busy ? 'Saving...' : 'Save and continue'}
            </button>
          </div>
        )}

        {error === undefined ? null : <p className="error">{error}</p>}
        <p className="setup-note">
          The key is written to the local kimi-code configuration and is never
          returned by the Babybot API.
        </p>
        {onCancel === undefined ? null : (
          <button className="setup-cancel" onClick={onCancel}>
            Back to projects
          </button>
        )}
      </section>
    </main>
  );
}

function formatTokenLimit(tokens: number): string {
  return tokens >= 1_000_000
    ? `${tokens / 1_000_000}M context`
    : `${Math.round(tokens / 1_000)}K context`;
}

function Usage({ usage }: { readonly usage: AgentUsage }) {
  return (
    <div className="usage">
      {usage.model === undefined ? null : <span>model: {usage.model}</span>}
      {usage.total === undefined ? null : (
        <>
          <span>input: {usage.total.input}</span>
          <span>output: {usage.total.output}</span>
          <span>cache read: {usage.total.cacheRead}</span>
          <span>cache write: {usage.total.cacheCreation}</span>
        </>
      )}
      {usage.contextTokens === undefined || usage.maxContextTokens === undefined ? null : (
        <span>
          context: {usage.contextTokens}/{usage.maxContextTokens}
        </span>
      )}
    </div>
  );
}

function Trace({ events }: { readonly events: readonly AgentTraceEvent[] }) {
  const [open, setOpen] = useState(
    () => events.at(-1)?.event.type !== 'run.completed',
  );
  return (
    <details
      className="trace"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>Execution trace ({events.length})</summary>
      <div className="trace-list">
        {events.map((trace) => (
          <div className={`trace-event trace-${trace.event.type}`} key={trace.sequence}>
            <time>{new Date(trace.timestamp).toLocaleTimeString()}</time>
            <strong>{trace.event.type}</strong>
            <span>{describeTrace(trace)}</span>
          </div>
        ))}
      </div>
    </details>
  );
}

function describeTrace(trace: AgentTraceEvent): string {
  const event = trace.event;
  switch (event.type) {
    case 'run.started':
      return `turn ${event.turnId}`;
    case 'agent.status':
      return [
        event.model,
        event.contextTokens === undefined || event.maxContextTokens === undefined
          ? undefined
          : `context ${event.contextTokens}/${event.maxContextTokens}`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'step.started':
      return `turn ${event.turnId}, step ${event.step}`;
    case 'step.completed':
      return [
        `step ${event.step}`,
        event.usage === undefined
          ? undefined
          : `${event.usage.input + event.usage.output} tokens`,
        event.firstTokenLatencyMs === undefined
          ? undefined
          : `first token ${event.firstTokenLatencyMs}ms`,
        event.streamDurationMs === undefined
          ? undefined
          : `stream ${event.streamDurationMs}ms`,
      ]
        .filter(Boolean)
        .join(' · ');
    case 'step.retrying':
      return `attempt ${event.attempt}/${event.maxAttempts}: ${event.error}`;
    case 'message.delta':
    case 'thinking.delta':
      return event.text;
    case 'tool.started':
      return `${event.name} ${formatTraceValue(event.arguments)}`;
    case 'tool.progress':
      return event.text ?? `${event.kind}${event.percent === undefined ? '' : ` ${event.percent}%`}`;
    case 'tool.completed':
      return `${event.name}${event.isError ? ' failed' : ' completed'} ${formatTraceValue(event.output)}`;
    case 'subagent.started':
    case 'subagent.completed':
    case 'subagent.failed':
      return `${event.subagentId} ${event.summary ?? event.error ?? ''}`;
    case 'compaction.started':
      return event.trigger ?? '';
    case 'compaction.completed':
      return `${event.tokensBefore ?? '?'} -> ${event.tokensAfter ?? '?'} tokens`;
    case 'warning':
      return event.message;
    case 'run.completed':
      return `turn ${event.turnId}: ${event.reason}`;
    case 'run.failed':
      return event.error;
    case 'runtime.event':
      return `${event.name} ${formatTraceValue(event.data)}`;
  }
}

function formatTraceValue(value: unknown): string {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

declare global {
  var __babybotRoot: Root | undefined;
}

const root =
  globalThis.__babybotRoot ??
  createRoot(document.getElementById('root')!);
globalThis.__babybotRoot = root;
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
