import type {
  AgentTraceEvent,
  AppSettings,
  ChooseDirectoryInput,
  ConfigureModelInput,
  CreateProjectInput,
  CreateTaskInput,
  DirectoryListing,
  DirectorySelection,
  DiscoverModelsInput,
  DirectChatTestInput,
  DirectChatTestResult,
  HealthResponse,
  ProjectStreamEvent,
  Project,
  SaveApiKeyInput,
  SetupModel,
  SetupModelCatalog,
  SetupStatus,
  Task,
  UpdateAppSettingsInput,
} from '@babybot/contracts';

export const api = {
  health: (): Promise<HealthResponse> => request('/api/health'),
  settings: (): Promise<AppSettings> => request('/api/settings'),
  directories: (path?: string): Promise<DirectoryListing> =>
    request(
      path === undefined
        ? '/api/settings/directories'
        : `/api/settings/directories?path=${encodeURIComponent(path)}`,
    ),
  updateSettings: (input: UpdateAppSettingsInput): Promise<AppSettings> =>
    request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  chooseDirectory: (input: ChooseDirectoryInput): Promise<DirectorySelection> =>
    request('/api/settings/choose-directory', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  setupStatus: (): Promise<SetupStatus> => request('/api/setup'),
  modelCatalog: (provider: DiscoverModelsInput['provider']): Promise<SetupModelCatalog> =>
    request(`/api/setup/models?provider=${encodeURIComponent(provider)}`),
  discoverModels: (input: DiscoverModelsInput): Promise<readonly SetupModel[]> =>
    request('/api/setup/models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  saveApiKey: (input: SaveApiKeyInput): Promise<SetupStatus> =>
    request('/api/setup/api-key', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  configureModel: (input: ConfigureModelInput): Promise<SetupStatus> =>
    request('/api/setup', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  testChat: (input: DirectChatTestInput): Promise<DirectChatTestResult> =>
    request('/api/setup/test-chat', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listProjects: (): Promise<readonly Project[]> => request('/api/projects'),
  createProject: (input: CreateProjectInput): Promise<Project> =>
    request('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  listTasks: (projectId: string): Promise<readonly Task[]> =>
    request(`/api/projects/${encodeURIComponent(projectId)}/tasks`),
  createTask: (projectId: string, input: CreateTaskInput): Promise<Task> =>
    request(`/api/projects/${encodeURIComponent(projectId)}/tasks`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  getTask: (taskId: string): Promise<Task> =>
    request(`/api/tasks/${encodeURIComponent(taskId)}`),
  getTrace: (
    taskId: string,
    afterSequence = 0,
  ): Promise<readonly AgentTraceEvent[]> =>
    request(
      `/api/tasks/${encodeURIComponent(taskId)}/trace?after=${afterSequence}`,
    ),
  cancelTask: (taskId: string): Promise<{ readonly status: string }> =>
    request(`/api/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
    }),
  subscribeProject: (
    projectId: string,
    handlers: {
      readonly onReady: () => void;
      readonly onEvent: (event: ProjectStreamEvent) => void;
    },
  ): (() => void) => {
    const source = new EventSource(
      `/api/projects/${encodeURIComponent(projectId)}/events`,
    );
    source.addEventListener('ready', handlers.onReady);
    for (const eventType of ['task.updated', 'trace.appended'] as const) {
      source.addEventListener(eventType, (event) => {
        if (!(event instanceof MessageEvent)) return;
        handlers.onEvent(JSON.parse(event.data) as ProjectStreamEvent);
      });
    }
    return () => source.close();
  },
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const response = await fetch(path, {
    ...init,
    headers,
  });
  const body = (await response.json()) as unknown;
  if (!response.ok) {
    const message =
      typeof body === 'object' &&
      body !== null &&
      'error' in body &&
      typeof body.error === 'string'
        ? body.error
        : `Request failed with ${response.status}.`;
    throw new Error(message);
  }
  return body as T;
}
