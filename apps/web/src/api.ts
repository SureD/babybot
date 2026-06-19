import type {
  AgentTraceEvent,
  ConfigureModelInput,
  CreateProjectInput,
  CreateTaskInput,
  DiscoverModelsInput,
  HealthResponse,
  Project,
  SetupModel,
  SetupStatus,
  Task,
} from '@babybot/contracts';

export const api = {
  health: (): Promise<HealthResponse> => request('/api/health'),
  setupStatus: (): Promise<SetupStatus> => request('/api/setup'),
  discoverModels: (input: DiscoverModelsInput): Promise<readonly SetupModel[]> =>
    request('/api/setup/models', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  configureModel: (input: ConfigureModelInput): Promise<SetupStatus> =>
    request('/api/setup', {
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
