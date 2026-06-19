import type {
  AgentEvent,
  AgentTraceEvent,
  AgentUsage,
  ConfigureModelInput,
  DiscoverModelsInput,
  ExecutionPreference,
  Project,
  SetupModel,
  SetupStatus,
  Task,
  TokenUsage,
} from '@babybot/contracts';

export interface ProjectRepository {
  listProjects(): Promise<readonly Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  saveProject(project: Project): Promise<void>;
}

export interface TaskRepository {
  listTasks(projectId: string): Promise<readonly Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  saveTask(task: Task): Promise<void>;
}

export interface AgentSessionRepository {
  getSession(projectId: string, backend: string): Promise<string | undefined>;
  saveSession(projectId: string, backend: string, sessionId: string): Promise<void>;
  clearSessions(backend: string): Promise<void>;
}

export interface TraceRepository {
  appendTrace(event: AgentTraceEvent): Promise<void>;
  listTrace(
    taskId: string,
    afterSequence?: number,
  ): Promise<readonly AgentTraceEvent[]>;
}

export interface ProjectWorkspace {
  ensure(projectId: string): Promise<string>;
}

export interface CapabilityMatch {
  readonly name: string;
}

export interface CapabilityResult {
  readonly output: string;
  readonly tokenUsage?: TokenUsage;
}

export interface CapabilityRuntime {
  find(projectId: string, input: string): Promise<CapabilityMatch | undefined>;
  run(match: CapabilityMatch, projectId: string, input: string): Promise<CapabilityResult>;
}

export interface AgentBackendCapabilities {
  readonly streaming: boolean;
  readonly sessionResume: boolean;
  readonly cancellation: boolean;
  readonly tokenUsage: boolean;
  readonly tracing: boolean;
}

export interface CreateAgentSessionInput {
  readonly projectId: string;
  readonly workDir: string;
}

export interface ResumeAgentSessionInput extends CreateAgentSessionInput {
  readonly sessionId: string;
}

export interface AgentRunInput {
  readonly prompt: string;
}

export interface AgentSession {
  readonly id: string;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
  cancel(): Promise<void>;
  getUsage(): Promise<AgentUsage | undefined>;
}

export interface AgentBackend {
  readonly name: string;
  readonly capabilities: AgentBackendCapabilities;
  isAvailable(): Promise<boolean>;
  getSetupStatus(): Promise<SetupStatus>;
  discoverModels(input: DiscoverModelsInput): Promise<readonly SetupModel[]>;
  configure(input: ConfigureModelInput): Promise<SetupStatus>;
  createSession(input: CreateAgentSessionInput): Promise<AgentSession>;
  resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession>;
  close(): Promise<void>;
}

export interface SubmitTaskRequest {
  readonly projectId: string;
  readonly input: string;
  readonly preference: ExecutionPreference;
}

export interface RuntimeDependencies {
  readonly projects: ProjectRepository;
  readonly tasks: TaskRepository;
  readonly agentSessions: AgentSessionRepository;
  readonly traces: TraceRepository;
  readonly workspaces: ProjectWorkspace;
  readonly capabilities: CapabilityRuntime;
  readonly agentBackend: AgentBackend;
}
