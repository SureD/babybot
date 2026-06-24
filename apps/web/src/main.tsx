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
  AppSettings,
  DirectChatTestResult,
  HealthResponse,
  ModelProvider,
  Project,
  ProjectStreamEvent,
  SetupModel,
  SetupStatus,
  Task,
} from '@babybot/contracts';

import { api } from './api';
import './styles.css';

interface ProjectConversation {
  readonly tasks: readonly Task[];
  readonly traces: Readonly<Record<string, readonly AgentTraceEvent[]>>;
}

function App() {
  const [health, setHealth] = useState<HealthResponse>();
  const [settings, setSettings] = useState<AppSettings>();
  const [setupStatus, setSetupStatus] = useState<SetupStatus>();
  const [projects, setProjects] = useState<readonly Project[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>();
  const [conversations, setConversations] = useState<
    Readonly<Record<string, ProjectConversation>>
  >({});
  const [projectName, setProjectName] = useState('');
  const [taskInputs, setTaskInputs] = useState<Readonly<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [showSetup, setShowSetup] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const traceCursors = useRef<Record<string, number>>({});
  const activeProjectId = useRef<string | undefined>(undefined);
  const conversationRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  useEffect(() => {
    void Promise.all([
      api.health(),
      api.settings(),
      api.setupStatus(),
      api.listProjects(),
    ])
      .then(([nextHealth, nextSettings, nextSetupStatus, nextProjects]) => {
        setHealth(nextHealth);
        setSettings(nextSettings);
        setSetupStatus(nextSetupStatus);
        setProjects(nextProjects);
        if (nextSetupStatus.configured) {
          setSelectedProjectId(nextProjects[0]?.id);
        }
      })
      .catch(showError);
  }, []);

  useEffect(() => {
    if (selectedProjectId === undefined) {
      activeProjectId.current = undefined;
      return;
    }
    const projectId = selectedProjectId;
    activeProjectId.current = projectId;
    const unsubscribe = api.subscribeProject(projectId, {
      onReady: () => void synchronizeProject(projectId),
      onEvent: (event) => applyProjectEvent(projectId, event),
    });
    void synchronizeProject(projectId);
    return unsubscribe;
  }, [selectedProjectId]);

  async function synchronizeProject(projectId: string) {
    const cursors = { ...traceCursors.current };
    try {
      const nextTasks = await api.listTasks(projectId);
      if (activeProjectId.current !== projectId) return;
      setConversations((current) => ({
        ...current,
        [projectId]: {
          tasks: mergeTasks(current[projectId]?.tasks ?? [], nextTasks),
          traces: current[projectId]?.traces ?? {},
        },
      }));
      const traceEntries = await Promise.all(
        nextTasks
          .filter((task) => task.preference !== 'capability')
          .map(async (task) => {
            const afterSequence = cursors[task.id] ?? 0;
            return [
              task.id,
              await api.getTrace(task.id, afterSequence),
            ] as const;
          }),
      );
      if (activeProjectId.current !== projectId) return;
      for (const [taskId, events] of traceEntries) {
        mergeTraceEvents(projectId, taskId, events);
      }
    } catch (caught) {
      showError(caught);
    }
  }

  function applyProjectEvent(projectId: string, event: ProjectStreamEvent) {
    if (activeProjectId.current !== projectId) return;
    if (event.type === 'task.updated') {
      setConversations((current) => ({
        ...current,
        [projectId]: {
          tasks: upsertTask(current[projectId]?.tasks ?? [], event.task),
          traces: current[projectId]?.traces ?? {},
        },
      }));
    } else {
      mergeTraceEvents(projectId, event.trace.taskId, [event.trace]);
    }
  }

  function mergeTraceEvents(
    projectId: string,
    taskId: string,
    events: readonly AgentTraceEvent[],
  ) {
    if (events.length === 0) return;
    setConversations((current) => {
      const conversation = current[projectId] ?? { tasks: [], traces: {} };
      const bySequence = new Map(
        (conversation.traces[taskId] ?? []).map((event) => [event.sequence, event]),
      );
      for (const event of events) bySequence.set(event.sequence, event);
      const merged = [...bySequence.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );
      traceCursors.current[taskId] = merged.at(-1)?.sequence ?? 0;
      return {
        ...current,
        [projectId]: {
          ...conversation,
          traces: { ...conversation.traces, [taskId]: merged },
        },
      };
    });
  }

  async function createProject(event: FormEvent) {
    event.preventDefault();
    if (projectName.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const project = await api.createProject({ name: projectName });
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setProjectName('');
    } catch (caught) {
      showError(caught);
    } finally {
      setBusy(false);
    }
  }

  async function submitTask(event: FormEvent) {
    event.preventDefault();
    if (selectedProjectId === undefined || taskInput.trim() === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const task = await api.createTask(selectedProjectId, {
        input: taskInput,
        preference: 'auto',
      });
      setConversations((current) => {
        const conversation = current[selectedProjectId] ?? { tasks: [], traces: {} };
        return {
          ...current,
          [selectedProjectId]: {
            tasks: upsertTask(conversation.tasks, task),
            traces:
              conversation.traces[task.id] === undefined
                ? { ...conversation.traces, [task.id]: [] }
                : conversation.traces,
          },
        };
      });
      traceCursors.current[task.id] ??= 0;
      setTaskInputs((current) => ({ ...current, [selectedProjectId]: '' }));
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

  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );
  const conversation =
    selectedProjectId === undefined ? undefined : conversations[selectedProjectId];
  const tasks = conversation?.tasks ?? [];
  const traces = conversation?.traces ?? {};
  const taskInput =
    selectedProjectId === undefined ? '' : taskInputs[selectedProjectId] ?? '';
  const latestTraceSequence =
    tasks[0] === undefined ? 0 : traces[tasks[0].id]?.at(-1)?.sequence ?? 0;

  useEffect(() => {
    stickToBottom.current = true;
  }, [selectedProjectId]);

  useEffect(() => {
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      const element = conversationRef.current;
      if (element !== null) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [latestTraceSequence, selectedProjectId, tasks.length]);

  if (health === undefined || setupStatus === undefined || settings === undefined) {
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
        settings={settings}
        {...(setupStatus.configured
          ? { onCancel: () => setShowSetup(false) }
          : {})}
        onSettingsChanged={setSettings}
        onSetupStatusChanged={setSetupStatus}
        onConfigured={(nextStatus) => {
          setSetupStatus(nextStatus);
          setShowSetup(false);
          setSelectedProjectId(projects[0]?.id);
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

        <div className="project-summary">
          <span>{projects.length}</span>
          <p>Projects stay open as tabs in your workspace.</p>
        </div>

        <footer>
          <button className="model-settings" onClick={() => setShowSetup(true)}>
            Model settings
          </button>
          <button className="model-settings" onClick={() => setShowSettings(true)}>
            Workspace settings
          </button>
        </footer>
      </aside>

      {showSettings ? (
        <SettingsPage
          settings={settings}
          onClose={() => setShowSettings(false)}
          onOpenModelSettings={() => setShowSetup(true)}
          onSettingsChanged={setSettings}
        />
      ) : (
      <section className="workspace">
        <nav className="project-tabs" aria-label="Project tabs" role="tablist">
          {projects.map((project) => (
            <button
              aria-selected={selectedProjectId === project.id}
              className={selectedProjectId === project.id ? 'project-tab active' : 'project-tab'}
              key={project.id}
              onClick={() => setSelectedProjectId(project.id)}
              role="tab"
            >
              <span>{project.name}</span>
              {(conversations[project.id]?.tasks ?? []).some(
                (task) => task.status === 'running' || task.status === 'pending',
              ) ? <span className="tab-running">Running</span> : null}
            </button>
          ))}
        </nav>
        {selectedProject === undefined ? (
          <div className="empty">
            <p>Create a project to start a persistent workspace.</p>
          </div>
        ) : (
          <>
            <header className="workspace-header">
              <div>
                <p className="eyebrow">Conversation</p>
                <h2>{selectedProject.name}</h2>
              </div>
              <p>
                {tasks.length === 0
                  ? 'No messages yet'
                  : `${tasks.length} ${tasks.length === 1 ? 'turn' : 'turns'}`}
              </p>
            </header>

            {error === undefined ? null : <p className="error">{error}</p>}

            <div
              className="conversation"
              aria-live="polite"
              onScroll={(event) => {
                const element = event.currentTarget;
                stickToBottom.current =
                  element.scrollHeight - element.scrollTop - element.clientHeight < 120;
              }}
              ref={conversationRef}
            >
              {tasks.length === 0 ? (
                <div className="conversation-empty">
                  <h3>Start a conversation</h3>
                  <p>
                    Ask Babybot to research, write, plan, or work in this project.
                    Agent activity will appear here as it happens.
                  </p>
                </div>
              ) : null}
              {[...tasks].reverse().map((task) => (
                <article className="conversation-turn" key={task.id}>
                  <section className="message user-message">
                    <p className="message-author">You</p>
                    <div className="message-body">{task.input}</div>
                  </section>
                  <section className="message agent-message">
                    <div className="agent-heading">
                      <p className="message-author">Babybot</p>
                      <div className="task-meta">
                        <span className={`status ${task.status}`}>{task.status}</span>
                        {task.status === 'running' ? (
                          <button
                            className="cancel-task"
                            onClick={() => void cancelTask(task.id)}
                          >
                            Stop
                          </button>
                        ) : null}
                      </div>
                    </div>
                    <AgentActivity
                      events={traces[task.id] ?? []}
                      status={task.status}
                    />
                    {task.result === undefined ? null : (
                      <div className="agent-response">{task.result}</div>
                    )}
                    {task.error === undefined ? null : (
                      <p className="error agent-error">{task.error}</p>
                    )}
                    {task.usage === undefined ? null : <Usage usage={task.usage} />}
                    {(traces[task.id]?.length ?? 0) === 0 ? null : (
                      <TechnicalTrace events={traces[task.id] ?? []} />
                    )}
                  </section>
                </article>
              ))}
            </div>

            <form className="task-form" onSubmit={(event) => void submitTask(event)}>
              <textarea
                aria-label={`Message ${selectedProject.name}`}
                value={taskInput}
                onChange={(event) =>
                  setTaskInputs((current) => ({
                    ...current,
                    [selectedProject.id]: event.target.value,
                  }))
                }
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="Message Babybot..."
                rows={3}
              />
              <div className="task-actions">
                <span className="composer-hint">Enter to send · Shift Enter for a new line</span>
                <button disabled={busy || taskInput.trim() === ''}>
                  {busy ? 'Sending...' : 'Send'}
                </button>
              </div>
            </form>
          </>
        )}
      </section>
      )}
    </main>
  );
}

function mergeTasks(
  current: readonly Task[],
  incoming: readonly Task[],
): readonly Task[] {
  let merged = current;
  for (const task of incoming) merged = upsertTask(merged, task);
  return merged;
}

function upsertTask(current: readonly Task[], task: Task): readonly Task[] {
  const existing = current.find((candidate) => candidate.id === task.id);
  const nextTask =
    existing !== undefined && compareTaskRevision(existing, task) >= 0
      ? existing
      : task;
  return [
    nextTask,
    ...current.filter((candidate) => candidate.id !== task.id),
  ].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function compareTaskRevision(left: Task, right: Task): number {
  const timestampComparison = left.updatedAt.localeCompare(right.updatedAt);
  if (timestampComparison !== 0) return timestampComparison;
  const statusOrder: Record<Task['status'], number> = {
    pending: 0,
    running: 1,
    completed: 2,
    failed: 2,
  };
  return statusOrder[left.status] - statusOrder[right.status];
}

function SettingsPage({
  settings,
  onSettingsChanged,
  onOpenModelSettings,
  onClose,
}: {
  readonly settings: AppSettings;
  readonly onSettingsChanged: (settings: AppSettings) => void;
  readonly onOpenModelSettings: () => void;
  readonly onClose: () => void;
}) {
  return (
    <section className="workspace settings-workspace">
      <header className="settings-header">
        <div>
          <p className="eyebrow">Settings</p>
          <h2>Workspace</h2>
        </div>
        <button className="secondary-action" onClick={onClose}>
          Back to projects
        </button>
      </header>
      <div className="settings-content">
        <WorkspaceSettings
          settings={settings}
          onSettingsChanged={onSettingsChanged}
        />
        <section className="settings-panel">
          <div>
            <p className="eyebrow">Model</p>
            <h3>Model connection</h3>
            <p className="settings-copy">
              Provider credentials and the default model are stored locally.
            </p>
          </div>
          <button className="secondary-action" onClick={onOpenModelSettings}>
            Model settings
          </button>
        </section>
      </div>
    </section>
  );
}

function WorkspaceSettings({
  settings,
  onSettingsChanged,
}: {
  readonly settings: AppSettings;
  readonly onSettingsChanged: (settings: AppSettings) => void;
}) {
  const active = settings.pending ?? settings.current;
  const [projectsDir, setProjectsDir] = useState(active.projectsDir);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const environmentManaged = settings.environmentOverrides.projectsDir;
  const overrideLabels = [
    settings.environmentOverrides.dataDir ? 'BABYBOT_DATA_DIR' : undefined,
    settings.environmentOverrides.projectsDir ? 'BABYBOT_PROJECTS_DIR' : undefined,
    settings.environmentOverrides.piAgentDir ? 'BABYBOT_PI_HOME' : undefined,
  ].filter((label): label is string => label !== undefined);

  useEffect(() => {
    setProjectsDir((settings.pending ?? settings.current).projectsDir);
    setSaved(false);
    setError(undefined);
  }, [settings]);

  async function chooseWorkspace() {
    if (environmentManaged || busy) return;
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const selection = await api.chooseDirectory({ defaultPath: projectsDir });
      if (selection.canceled) return;
      if (selection.path === undefined) {
        throw new Error('No folder was selected.');
      }
      setProjectsDir(selection.path);
      const nextSettings = await api.updateSettings({
        projectsDir: selection.path,
      });
      onSettingsChanged(nextSettings);
      setSaved(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-panel">
      <div>
        <p className="eyebrow">Workspace root</p>
        <h3>Project folder</h3>
        <p className="settings-copy">
          Babybot creates project workspaces under this folder. Model credentials
          stay in the existing local configuration.
        </p>
      </div>

      <div className="settings-form">
        <label htmlFor="project-folder">Folder path</label>
        <div className="path-form">
          <output
            id="project-folder"
            className="path-display"
          >
            {projectsDir}
          </output>
          <button
            type="button"
            disabled={busy || environmentManaged}
            onClick={() => void chooseWorkspace()}
          >
            {busy ? 'Choosing...' : 'Choose folder'}
          </button>
        </div>
      </div>

      {environmentManaged ? (
        <p className="settings-warning">
          BABYBOT_PROJECTS_DIR is set in the environment, so this path cannot be
          changed from the UI.
        </p>
      ) : null}
      {overrideLabels.length === 0 || environmentManaged ? null : (
        <p className="settings-warning">
          Environment variables still control {overrideLabels.join(', ')}.
          Those paths stay on their environment values.
        </p>
      )}
      {settings.restartRequired ? (
        <p className="settings-warning">
          Restart Babybot to use the pending project folder. Existing data is not
          moved.
        </p>
      ) : null}
      {saved && !settings.restartRequired ? (
        <p className="settings-success">Workspace settings are up to date.</p>
      ) : null}
      {error === undefined ? null : <p className="error">{error}</p>}

      <dl className="settings-paths">
        <div>
          <dt>Current projects</dt>
          <dd>{settings.current.projectsDir}</dd>
        </div>
        <div>
          <dt>Current state</dt>
          <dd>{settings.current.dataDir}</dd>
        </div>
        {settings.pending === undefined ? null : (
          <>
            <div>
              <dt>Pending projects</dt>
              <dd>{settings.pending.projectsDir}</dd>
            </div>
            <div>
              <dt>Pending state</dt>
              <dd>{settings.pending.dataDir}</dd>
            </div>
          </>
        )}
        <div>
          <dt>Settings file</dt>
          <dd>{settings.settingsPath}</dd>
        </div>
      </dl>
    </section>
  );
}

function Setup({
  status,
  settings,
  onSettingsChanged,
  onSetupStatusChanged,
  onConfigured,
  onCancel,
}: {
  readonly status: SetupStatus;
  readonly settings: AppSettings;
  readonly onSettingsChanged: (settings: AppSettings) => void;
  readonly onSetupStatusChanged: (status: SetupStatus) => void;
  readonly onConfigured: (status: SetupStatus) => void;
  readonly onCancel?: () => void;
}) {
  const [provider, setProvider] = useState<ModelProvider>(
    status.provider ?? 'deepseek',
  );
  const [apiKey, setApiKey] = useState('');
  const [freeOnly, setFreeOnly] = useState(false);
  const [models, setModels] = useState<readonly SetupModel[]>([]);
  const [model, setModel] = useState('');
  const [modelQuery, setModelQuery] = useState('');
  const [catalogUpdatedAt, setCatalogUpdatedAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [keySaved, setKeySaved] = useState(false);
  const [chatTest, setChatTest] = useState<DirectChatTestResult>();

  useEffect(() => {
    let active = true;
    setModels([]);
    setModel('');
    setCatalogUpdatedAt(undefined);
    setError(undefined);
    setKeySaved(false);
    setChatTest(undefined);
    void (async () => {
      try {
        const catalog = await api.modelCatalog(provider);
        const canUseSavedKey =
          status.hasApiKey && status.provider === provider;
        const nextModels =
          catalog.models.length === 0 && canUseSavedKey
            ? await api.discoverModels({ provider })
            : catalog.models;
        if (!active) return;
        setModels(nextModels);
        setCatalogUpdatedAt(
          catalog.updatedAt ??
            (nextModels.length === 0 ? undefined : new Date().toISOString()),
        );
        const currentModel =
          status.provider === provider &&
          nextModels.some((candidate) => candidate.id === status.model)
            ? status.model
            : nextModels.find((candidate) => candidate.recommended)?.id ??
              nextModels[0]?.id;
        setModel(currentModel ?? '');
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [provider, status.hasApiKey, status.model, status.provider]);

  async function loadModels(event: FormEvent) {
    event.preventDefault();
    const canUseSavedKey = status.hasApiKey && status.provider === provider;
    const trimmedApiKey = apiKey.trim();
    if (trimmedApiKey === '' && !canUseSavedKey) return;
    setBusy(true);
    setError(undefined);
    setKeySaved(false);
    try {
      const nextModels = await api.discoverModels({
        provider,
        ...(trimmedApiKey === '' ? {} : { apiKey: trimmedApiKey }),
      });
      setModels(nextModels);
      setCatalogUpdatedAt(new Date().toISOString());
      setModel((current) =>
        nextModels.some((candidate) => candidate.id === current)
          ? current
          : nextModels[0]?.id ?? '',
      );
      if (trimmedApiKey !== '') {
        const nextStatus = await api.saveApiKey({
          provider,
          apiKey: trimmedApiKey,
        });
        setApiKey('');
        setKeySaved(true);
        onSetupStatusChanged(nextStatus);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveApiKey() {
    const trimmedApiKey = apiKey.trim();
    if (trimmedApiKey === '') return;
    setBusy(true);
    setError(undefined);
    setKeySaved(false);
    try {
      const nextModels = await api.discoverModels({
        provider,
        apiKey: trimmedApiKey,
      });
      setModels(nextModels);
      setCatalogUpdatedAt(new Date().toISOString());
      setModel((current) =>
        nextModels.some((candidate) => candidate.id === current)
          ? current
          : nextModels[0]?.id ?? '',
      );
      const nextStatus = await api.saveApiKey({
        provider,
        apiKey: trimmedApiKey,
      });
      setApiKey('');
      setKeySaved(true);
      onSetupStatusChanged(nextStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveSetup() {
    if (model === '') return;
    const trimmedApiKey = apiKey.trim();
    setBusy(true);
    setError(undefined);
    setKeySaved(false);
    try {
      const nextStatus = await api.configureModel({
        provider,
        ...(trimmedApiKey === '' ? {} : { apiKey: trimmedApiKey }),
        model,
      });
      setApiKey('');
      setKeySaved(true);
      onConfigured(nextStatus);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function testDirectChat() {
    if (model === '') return;
    setBusy(true);
    setError(undefined);
    setChatTest(undefined);
    try {
      setChatTest(
        await api.testChat({
          provider,
          ...(apiKey.trim() === '' ? {} : { apiKey }),
          model,
        }),
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const visibleModels = models.filter((candidate) => {
    if (freeOnly && !candidate.isFree) return false;
    const query = modelQuery.trim().toLocaleLowerCase();
    return (
      query === '' ||
      candidate.name.toLocaleLowerCase().includes(query) ||
      candidate.id.toLocaleLowerCase().includes(query)
    );
  });
  const canUseSavedKey = status.hasApiKey && status.provider === provider;

  return (
    <main className="setup-shell">
      <section className="setup-card">
        <p className="eyebrow">
          {status.configured ? 'Model settings' : 'First-time setup'}
        </p>
        <h1>{status.configured ? 'Choose a model' : 'Connect a model'}</h1>
        <p className="setup-copy">
          Choose a model provider, verify its API key, and select the default
          model.
        </p>
        {status.configured ? (
          <p className="current-model">
            Current: {status.provider} / {status.model}
          </p>
        ) : null}

        <WorkspaceSettings
          settings={settings}
          onSettingsChanged={onSettingsChanged}
        />

        {!status.backendAvailable ? (
          <p className="error">
            Model connection is not available. Check local configuration and
            restart Babybot.
          </p>
        ) : (
          <form onSubmit={(event) => void loadModels(event)}>
            <label htmlFor="setup-provider">Provider</label>
            <select
              id="setup-provider"
              value={provider}
              onChange={(event) => {
                setProvider(event.target.value as ModelProvider);
                setKeySaved(false);
                setFreeOnly(false);
                setModelQuery('');
              }}
            >
              <option value="deepseek">DeepSeek API</option>
              <option value="openrouter">OpenRouter API</option>
            </select>

            <label htmlFor="setup-key">
              API key {canUseSavedKey ? '(saved)' : ''}
            </label>
            <input
              id="setup-key"
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(event) => {
                setApiKey(event.target.value);
                setKeySaved(false);
              }}
              placeholder={provider === 'deepseek' ? 'sk-...' : 'sk-or-v1-...'}
            />
            <button
              disabled={
                busy ||
                (apiKey.trim() === '' && !canUseSavedKey)
              }
            >
              {busy ? 'Checking...' : models.length === 0 ? 'Load models' : 'Refresh models'}
            </button>
            <button
              type="button"
              className="secondary-setup-action"
              disabled={busy || apiKey.trim() === ''}
              onClick={() => void saveApiKey()}
            >
              {busy ? 'Saving...' : 'Save API key'}
            </button>
            {keySaved || (canUseSavedKey && apiKey.trim() === '') ? (
              <p className="settings-success">API key saved locally.</p>
            ) : null}
          </form>
        )}

        {models.length === 0 ? null : (
          <div className="model-picker">
            <div className="model-picker-heading">
              <div>
                <label htmlFor="model-search">Available models</label>
                <p>
                  {models.length} saved locally
                  {catalogUpdatedAt === undefined
                    ? ''
                    : ` · updated ${formatCatalogDate(catalogUpdatedAt)}`}
                </p>
              </div>
              {provider === 'openrouter' ? (
                <label className="free-model-filter">
                  <input
                    type="checkbox"
                    checked={freeOnly}
                    onChange={(event) => setFreeOnly(event.target.checked)}
                  />
                  Free only
                </label>
              ) : null}
            </div>
            <input
              id="model-search"
              type="search"
              value={modelQuery}
              onChange={(event) => setModelQuery(event.target.value)}
              placeholder="Search model name or ID"
            />
            <div className="model-list" role="radiogroup" aria-label="Default model">
              {visibleModels.map((candidate) => (
                <label
                  className={candidate.id === model ? 'model-option selected' : 'model-option'}
                  key={candidate.id}
                >
                  <input
                    type="radio"
                    name="setup-model"
                    value={candidate.id}
                    checked={candidate.id === model}
                    onChange={() => setModel(candidate.id)}
                  />
                  <span className="model-option-copy">
                    <span className="model-name">
                      {candidate.name}
                      {candidate.recommended ? (
                        <span className="model-badge recommended">Recommended</span>
                      ) : null}
                    </span>
                    <span className="model-id">{candidate.id}</span>
                    <span className="model-meta">
                      <span className={candidate.isFree ? 'model-badge free' : 'model-badge paid'}>
                        {candidate.isFree ? 'Free' : 'Paid'}
                      </span>
                      <span>{formatTokenLimit(candidate.contextTokens)}</span>
                      {candidate.supportsThinking ? <span>Reasoning</span> : null}
                    </span>
                  </span>
                </label>
              ))}
              {visibleModels.length === 0 ? (
                <p className="model-empty">No models match these filters.</p>
              ) : null}
            </div>
            <button
              type="button"
              disabled={busy || model === ''}
              onClick={() => void saveSetup()}
            >
              {busy ? 'Saving...' : 'Save API key and model'}
            </button>
            {provider === 'openrouter' ? (
              <button
                className="direct-chat-test"
                type="button"
                disabled={busy || model === ''}
                onClick={() => void testDirectChat()}
              >
                {busy ? 'Testing...' : 'Test OpenRouter directly'}
              </button>
            ) : null}
            {chatTest === undefined ? null : (
              <div
                className={chatTest.ok ? 'chat-test-result success' : 'chat-test-result failure'}
              >
                <strong>
                  {chatTest.ok ? 'OpenRouter responded' : 'OpenRouter rejected the request'}
                </strong>
                <span>
                  HTTP {chatTest.statusCode} · {chatTest.latencyMs} ms
                </span>
                <span>Requested model: {chatTest.requestedModel}</span>
                {chatTest.responseModel === undefined ? null : (
                  <span>Response model: {chatTest.responseModel}</span>
                )}
                {chatTest.content === undefined ? null : (
                  <span>Response: {chatTest.content}</span>
                )}
                {chatTest.error === undefined ? null : (
                  <span>Error: {chatTest.error}</span>
                )}
                {chatTest.requestId === undefined ? null : (
                  <span>Request ID: {chatTest.requestId}</span>
                )}
              </div>
            )}
          </div>
        )}

        {error === undefined ? null : <p className="error">{error}</p>}
        <p className="setup-note">
          The key is written to the local model configuration and is never
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
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}K context`;
  const millions = tokens / 1_000_000;
  return `${Number(millions.toFixed(1))}M context`;
}

function formatCatalogDate(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
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

function AgentActivity({
  events,
  status,
}: {
  readonly events: readonly AgentTraceEvent[];
  readonly status: Task['status'];
}) {
  const thinking = events
    .flatMap((trace) =>
      trace.event.type === 'thinking.delta' ? [trace.event.text] : [],
    )
    .join('')
    .trim();
  const tools = collectToolActivity(events);
  const notices = events.filter((trace) =>
    [
      'step.retrying',
      'warning',
      'subagent.started',
      'subagent.completed',
      'subagent.failed',
      'compaction.started',
      'compaction.completed',
    ].includes(trace.event.type),
  );

  if (events.length === 0 && status !== 'running' && status !== 'pending') {
    return null;
  }

  return (
    <div className="agent-activity">
      <div className="activity-heading">
        <span>Agent activity</span>
        <span>{activitySummary(events, status)}</span>
      </div>
      {thinking === '' ? null : (
        <details className="thinking" open={status === 'running'}>
          <summary>Reasoning</summary>
          <p>{truncateStart(thinking, 1_200)}</p>
        </details>
      )}
      {tools.length === 0 ? null : (
        <div className="tool-activity">
          {tools.map((tool) => (
            <div className={`tool-row ${tool.state}`} key={tool.id}>
              <div>
                <strong>{tool.name}</strong>
                <span>{tool.description ?? tool.detail}</span>
              </div>
              <span className="tool-state">{tool.state}</span>
            </div>
          ))}
        </div>
      )}
      {notices.slice(-12).map((trace) => (
        <div className={`activity-notice notice-${trace.event.type}`} key={trace.sequence}>
          <strong>{activityLabel(trace)}</strong>
          <span>{describeTrace(trace)}</span>
        </div>
      ))}
      {events.length === 0 ? (
        <div className="activity-pending">Waiting for the agent to start…</div>
      ) : null}
    </div>
  );
}

interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly detail: string;
  readonly state: 'running' | 'completed' | 'failed';
}

function collectToolActivity(events: readonly AgentTraceEvent[]): readonly ToolActivity[] {
  const tools = new Map<string, ToolActivity>();
  for (const trace of events) {
    const event = trace.event;
    if (event.type === 'tool.started') {
      tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: event.name,
        ...(event.description === undefined ? {} : { description: event.description }),
        detail: formatTraceValue(event.arguments),
        state: 'running',
      });
    } else if (event.type === 'tool.progress') {
      const current = tools.get(event.toolCallId);
      if (current !== undefined) {
        tools.set(event.toolCallId, {
          ...current,
          detail: event.text ?? `${event.kind}${event.percent === undefined ? '' : ` ${event.percent}%`}`,
        });
      }
    } else if (event.type === 'tool.completed') {
      const current = tools.get(event.toolCallId);
      tools.set(event.toolCallId, {
        id: event.toolCallId,
        name: current?.name ?? event.name,
        ...(current?.description === undefined ? {} : { description: current.description }),
        detail: truncateEnd(formatTraceValue(event.output), 240),
        state: event.isError ? 'failed' : 'completed',
      });
    }
  }
  return [...tools.values()];
}

function activitySummary(
  events: readonly AgentTraceEvent[],
  status: Task['status'],
): string {
  if (status === 'pending') return 'Queued';
  if (status === 'completed') return 'Finished';
  if (status === 'failed') return 'Stopped with an error';
  const latest = [...events].reverse().find((trace) =>
    !['message.delta', 'thinking.delta', 'agent.status', 'runtime.event'].includes(
      trace.event.type,
    ),
  );
  if (latest === undefined) return 'Starting';
  if (latest.event.type === 'tool.started') return `Using ${latest.event.name}`;
  if (latest.event.type === 'tool.progress') return latest.event.text ?? 'Using a tool';
  if (latest.event.type === 'step.retrying') return 'Retrying';
  return 'Working';
}

function activityLabel(trace: AgentTraceEvent): string {
  switch (trace.event.type) {
    case 'step.retrying':
      return 'Retrying';
    case 'warning':
      return 'Warning';
    case 'subagent.started':
      return 'Sub-agent started';
    case 'subagent.completed':
      return 'Sub-agent finished';
    case 'subagent.failed':
      return 'Sub-agent failed';
    case 'compaction.started':
      return 'Optimizing context';
    case 'compaction.completed':
      return 'Context optimized';
    default:
      return 'Update';
  }
}

function TechnicalTrace({ events }: { readonly events: readonly AgentTraceEvent[] }) {
  const counts = new Map<string, number>();
  for (const trace of events) {
    counts.set(trace.event.type, (counts.get(trace.event.type) ?? 0) + 1);
  }
  const recentEvents = events.slice(-50);
  return (
    <details className="trace">
      <summary>Technical trace · {events.length} events</summary>
      <div className="trace-counts">
        {[...counts.entries()].map(([type, count]) => (
          <span key={type}>{type} {count}</span>
        ))}
      </div>
      <div className="trace-list">
        {events.length > recentEvents.length ? (
          <p>Showing the latest {recentEvents.length} events.</p>
        ) : null}
        {recentEvents.map((trace) => (
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

function truncateStart(value: string, length: number): string {
  return value.length > length ? `…${value.slice(-length)}` : value;
}

function truncateEnd(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length)}…` : value;
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
