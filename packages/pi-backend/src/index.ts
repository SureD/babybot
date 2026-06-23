import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AuthStorage,
  createAgentSession as createPiSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
  type SessionStats,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent';
import {
  createAgentSession,
  type AgentSession,
  type JsonObject,
  type ToolRegistration,
} from '@babybot/agent';
import type {
  Backend,
  BackendEvent,
  BackendRunInput,
  BackendSession,
} from '@babybot/agent/backend';
import type { ContextSnapshot, ContextStore } from '@babybot/agent/context';
import {
  generalAgentProfile,
  type AgentProfile,
} from '@babybot/agent-harness';
import type {
  AgentBackend,
  AgentBackendCapabilities,
  AgentExecutableTool,
  AgentToolRuntime,
  ConfigureModelInput,
  CreateAgentSessionInput,
  DirectChatTestInput,
  DirectChatTestResult,
  DiscoverModelsInput,
  ResumeAgentSessionInput,
  SetupModel,
  SetupStatus,
  TokenUsage,
} from '@babybot/core';

interface PiModelReference {
  readonly provider: string;
  readonly id: string;
  readonly contextWindow?: number;
}

export interface PiSessionLike {
  readonly sessionId: string;
  readonly model: PiModelReference | undefined;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(input: string): Promise<void>;
  steer(input: string): Promise<void>;
  compact(instruction?: string): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): void;
  getSessionStats(): SessionStats;
  setActiveToolsByName?(toolNames: string[]): void;
}

export interface PiRuntimeInput {
  readonly projectId: string;
  readonly projectName: string;
  readonly workDir: string;
  readonly provider: string;
  readonly model: string;
  readonly tools: readonly string[];
  readonly customTools: readonly AgentExecutableTool[];
  readonly systemPrompt: string;
}

export interface PiRuntimeFactory {
  create(input: PiRuntimeInput): Promise<PiSessionLike>;
  resume(input: PiRuntimeInput & { readonly sessionId: string }): Promise<PiSessionLike>;
  refresh(): void;
}

export interface PiAgentBackendOptions {
  readonly agentDir: string;
  readonly toolRuntime: AgentToolRuntime;
  readonly agentProfile?: AgentProfile;
  readonly model?: string;
  readonly fetchImpl?: typeof fetch;
  readonly runtimeFactory?: PiRuntimeFactory;
}

interface PiBackendConfiguration {
  readonly provider: ConfigureModelInput['provider'];
  readonly model: string;
}

const PI_CAPABILITIES: AgentBackendCapabilities = {
  streaming: true,
  sessionResume: true,
  cancellation: true,
  tokenUsage: true,
  tracing: true,
};

const OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
const OPENROUTER_MAX_OUTPUT_TOKENS = 16_000;
const MIN_CONTEXT_INPUT_RESERVE_TOKENS = 4_096;

export class PiAgentBackend implements AgentBackend {
  readonly name = 'pi';
  readonly capabilities = PI_CAPABILITIES;

  private readonly authStorage: AuthStorage;
  private readonly modelRegistry: ModelRegistry;
  private readonly runtimeFactory: PiRuntimeFactory;
  private readonly sessions = new Map<string, AgentSession>();
  private readonly configurationPath: string;
  private readonly modelsPath: string;

  constructor(private readonly options: PiAgentBackendOptions) {
    this.configurationPath = join(options.agentDir, 'babybot.json');
    this.modelsPath = join(options.agentDir, 'models.json');
    this.authStorage = AuthStorage.create(join(options.agentDir, 'auth.json'));
    this.modelRegistry = ModelRegistry.create(this.authStorage, this.modelsPath);
    this.runtimeFactory =
      options.runtimeFactory ??
      new SdkPiRuntimeFactory(
        options.agentDir,
        this.authStorage,
        this.modelRegistry,
      );
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async getSetupStatus(): Promise<SetupStatus> {
    const configuration = await this.readConfiguration();
    const provider = configuration?.provider;
    return {
      backendAvailable: true,
      configured:
        configuration !== undefined &&
        provider !== undefined &&
        this.authStorage.hasAuth(provider),
      ...(provider === undefined ? {} : { provider }),
      ...(configuration?.model === undefined
        ? {}
        : { model: this.options.model ?? configuration.model }),
      hasApiKey: provider !== undefined && this.authStorage.hasAuth(provider),
      modelLockedByEnvironment: this.options.model !== undefined,
    };
  }

  async discoverModels(
    input: DiscoverModelsInput,
  ): Promise<readonly SetupModel[]> {
    const apiKey = input.apiKey ?? this.storedApiKey(input.provider);
    if (apiKey === undefined) {
      throw new Error(`Enter an API key before loading ${input.provider} models.`);
    }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    if (input.provider === 'openrouter') {
      await requestJson(
        fetchImpl,
        'https://openrouter.ai/api/v1/auth/key',
        apiKey,
      );
      const payload = await requestJson(
        fetchImpl,
        'https://openrouter.ai/api/v1/models?supported_parameters=tools',
        apiKey,
      );
      return parseOpenRouterModels(payload, input.freeOnly === true);
    }
    const payload = await requestJson(
      fetchImpl,
      'https://api.deepseek.com/models',
      apiKey,
    );
    return parseDeepSeekModels(payload);
  }

  async configure(input: ConfigureModelInput): Promise<SetupStatus> {
    if (this.options.model !== undefined) {
      throw new Error(
        'BABYBOT_PI_MODEL overrides the setup model. Remove it and restart Babybot.',
      );
    }
    const apiKey = input.apiKey ?? this.storedApiKey(input.provider);
    if (apiKey === undefined) {
      throw new Error(`Enter an API key before configuring ${input.provider}.`);
    }
    const models = await this.discoverModels({
      provider: input.provider,
      apiKey,
      ...(input.freeOnly === undefined ? {} : { freeOnly: input.freeOnly }),
    });
    const selected = models.find((model) => model.id === input.model);
    if (selected === undefined) {
      throw new Error(`Model "${input.model}" was not returned by ${input.provider}.`);
    }

    this.authStorage.set(input.provider, { type: 'api_key', key: apiKey });
    await mkdir(this.options.agentDir, { recursive: true, mode: 0o700 });
    await writeFile(
      this.modelsPath,
      `${JSON.stringify(modelsFile(input.provider, selected), null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    await writeFile(
      this.configurationPath,
      `${JSON.stringify({ provider: input.provider, model: input.model }, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    this.modelRegistry.refresh();
    this.runtimeFactory.refresh();

    return {
      backendAvailable: true,
      configured: true,
      provider: input.provider,
      model: input.model,
      hasApiKey: true,
      modelLockedByEnvironment: false,
    };
  }

  async testChat(input: DirectChatTestInput): Promise<DirectChatTestResult> {
    const apiKey = input.apiKey ?? this.storedApiKey(input.provider);
    if (apiKey === undefined) {
      throw new Error(`Enter an API key before testing ${input.provider}.`);
    }
    const endpoint =
      input.provider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    const startedAt = Date.now();
    const response = await (this.options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        messages: [{ role: 'user', content: 'Reply only with OK.' }],
        max_tokens: 16,
        temperature: 0,
        stream: false,
      }),
    });
    const payload = await readJson(response);
    const common = {
      provider: input.provider,
      statusCode: response.status,
      requestedModel: input.model,
      latencyMs: Date.now() - startedAt,
      ...(response.headers.get('x-request-id') === null
        ? {}
        : { requestId: response.headers.get('x-request-id') ?? undefined }),
    };
    if (!response.ok) {
      return {
        ...common,
        ok: false,
        error: providerError(payload) ?? `Provider request failed with HTTP ${response.status}.`,
      };
    }
    return {
      ...common,
      ok: true,
      ...(objectString(payload, 'model') === undefined
        ? {}
        : { responseModel: objectString(payload, 'model') }),
      ...(chatContent(payload) === undefined ? {} : { content: chatContent(payload) }),
    };
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const runtimeInput = await this.runtimeInput(input);
    const session = await createAgentSession({
      backend: new PiSessionBackend(this.runtimeFactory, runtimeInput),
      workDir: input.workDir,
      tools: runtimeInput.tools.map((name) =>
        toolRegistration(name, runtimeInput.customTools)),
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    const active = this.sessions.get(input.sessionId);
    if (active !== undefined) return active;
    const runtimeInput = await this.runtimeInput(input);
    const session = await createAgentSession({
      backend: new PiSessionBackend(this.runtimeFactory, runtimeInput),
      workDir: input.workDir,
      sessionId: input.sessionId,
      tools: runtimeInput.tools.map((name) =>
        toolRegistration(name, runtimeInput.customTools)),
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    this.sessions.clear();
  }

  private async runtimeInput(
    input: CreateAgentSessionInput,
  ): Promise<PiRuntimeInput> {
    const configuration = await this.readConfiguration();
    if (configuration === undefined) {
      throw new Error('Pi is not configured. Choose a provider and model first.');
    }
    const descriptors = await this.options.toolRuntime.resolve(input);
    const tools = descriptors
      .filter((tool) => tool.enabled)
      .map((tool) => tool.name);
    const customTools = descriptors.filter(isExecutableTool).filter((tool) => tool.enabled);
    const profile = this.options.agentProfile ?? generalAgentProfile;
    return {
      projectId: input.projectId,
      projectName: input.projectName,
      workDir: input.workDir,
      provider: configuration.provider,
      model: this.options.model ?? configuration.model,
      tools,
      customTools,
      systemPrompt: profile.renderSystemPrompt({
        projectId: input.projectId,
        projectName: input.projectName,
        workDir: input.workDir,
        toolNames: tools,
      }),
    };
  }

  private storedApiKey(provider: ConfigureModelInput['provider']): string | undefined {
    const credential = this.authStorage.get(provider);
    return credential?.type === 'api_key' ? credential.key : undefined;
  }

  private async readConfiguration(): Promise<PiBackendConfiguration | undefined> {
    try {
      const value = JSON.parse(
        await readFile(this.configurationPath, 'utf8'),
      ) as Partial<PiBackendConfiguration>;
      if (
        (value.provider !== 'deepseek' && value.provider !== 'openrouter') ||
        typeof value.model !== 'string' ||
        value.model.length === 0
      ) {
        return undefined;
      }
      return { provider: value.provider, model: value.model };
    } catch {
      return undefined;
    }
  }
}

class PiSessionBackend implements Backend {
  constructor(
    private readonly factory: PiRuntimeFactory,
    private readonly input: PiRuntimeInput,
  ) {}

  async open(config: { readonly sessionId?: string }): Promise<BackendSession> {
    const session = config.sessionId === undefined
      ? await this.factory.create(this.input)
      : await this.factory.resume({
          ...this.input,
          sessionId: config.sessionId,
        });
    return new PiBackendSession(session);
  }
}

class PiBackendSession implements BackendSession, ContextStore {
  readonly id: string;

  private running = false;
  private revision: number;
  private runController: AbortController | undefined;

  constructor(private readonly session: PiSessionLike) {
    this.id = session.sessionId;
    this.revision = session.getSessionStats().totalMessages ?? 0;
  }

  async *run(input: BackendRunInput): AsyncIterable<BackendEvent> {
    if (this.running) throw new Error('The Pi backend session is already running.');
    this.running = true;
    const controller = new AbortController();
    this.runController = controller;
    const queue = new AsyncEventQueue<AgentSessionEvent>();
    const unsubscribe = this.session.subscribe((event) => queue.push(event));
    const output: string[] = [];
    let step = 0;
    let finishReason = 'completed';
    let promptError: unknown;
    let completed = false;

    this.session.setActiveToolsByName?.(
      input.tools.tools.filter(({ enabled }) => enabled).map(({ name }) => name),
    );
    void this.session.prompt(input.context.input.text).then(
      () => queue.close(),
      (error: unknown) => {
        promptError = error;
        queue.close();
      },
    );

    try {
      for await (const event of queue) {
        controller.signal.throwIfAborted();
        switch (event.type) {
          case 'agent_start':
            break;
          case 'turn_start':
            step += 1;
            yield { type: 'step.started', step };
            break;
          case 'message_update': {
            const update = event.assistantMessageEvent;
            if (update.type === 'text_delta') {
              output.push(update.delta);
              yield { type: 'message.delta', text: update.delta };
            } else if (update.type === 'thinking_delta') {
              yield { type: 'thinking.delta', text: update.delta };
            } else if (update.type === 'error') {
              yield {
                type: 'failed',
                error:
                  update.error.errorMessage ??
                  `Pi stopped with reason: ${update.reason}`,
              };
              return;
            }
            break;
          }
          case 'tool_execution_start': {
            const call = {
              id: event.toolCallId,
              name: event.toolName,
              arguments: toJsonObject(event.args),
            };
            yield { type: 'tool.started', call };
            const tool = input.tools.tools.find(({ name }) => name === call.name);
            if (tool === undefined) {
              yield {
                type: 'failed',
                error: `Pi called tool ${call.name}, which is not in the Turn tool snapshot.`,
              };
              return;
            }
            const decision = await input.hooks.authorize(
              { mode: 'build', tool, call },
              controller.signal,
            );
            if (decision.decision === 'deny') {
              await this.session.abort();
              yield {
                type: 'failed',
                error: `Tool ${call.name} was denied: ${decision.reason}`,
              };
              return;
            }
            break;
          }
          case 'tool_execution_update':
            yield {
              type: 'tool.progress',
              toolCallId: event.toolCallId,
              text: traceText(event.partialResult),
            };
            break;
          case 'tool_execution_end':
            yield {
              type: 'tool.completed',
              toolCallId: event.toolCallId,
              result: {
                content: traceText(event.result),
                isError: event.isError,
                details: event.result,
              },
            };
            break;
          case 'turn_end': {
            const message = event.message;
            if (message.role === 'assistant') {
              finishReason = message.stopReason;
              yield {
                type: 'step.completed',
                step: Math.max(step, 1),
                usage: tokenUsage(message.usage),
              };
            } else {
              yield { type: 'step.completed', step: Math.max(step, 1) };
            }
            break;
          }
          case 'agent_end':
            completed = true;
            this.revision = this.session.getSessionStats().totalMessages ?? this.revision;
            yield {
              type: 'completed',
              output: output.join('').trim(),
              finishReason,
            };
            return;
          case 'compaction_start':
            yield {
              type: 'warning',
              message: `Pi context compaction started (${event.reason}).`,
            };
            break;
          case 'compaction_end':
            yield {
              type: 'warning',
              message: event.errorMessage === undefined
                ? `Pi context compaction completed (${event.reason}).`
                : `Pi context compaction failed: ${event.errorMessage}`,
            };
            break;
          case 'auto_retry_start':
            yield {
              type: 'warning',
              message:
                `Pi retry ${String(event.attempt + 1)}/${String(event.maxAttempts)} ` +
                `after ${String(event.delayMs)}ms: ${event.errorMessage}`,
            };
            break;
          case 'auto_retry_end':
            if (!event.success) {
              yield {
                type: 'warning',
                message: event.finalError ?? 'Pi retry attempts were exhausted.',
              };
            }
            break;
        }
      }

      if (promptError !== undefined) {
        yield { type: 'failed', error: errorMessage(promptError) };
      } else if (!completed) {
        yield {
          type: 'failed',
          error: 'Pi ended without an agent completion event.',
        };
      }
    } finally {
      unsubscribe();
      this.running = false;
      if (this.runController === controller) this.runController = undefined;
    }
  }

  steer(input: { readonly text: string }): Promise<void> {
    return this.session.steer(input.text);
  }

  async abort(): Promise<void> {
    this.runController?.abort(new Error('Pi Turn was aborted.'));
    await this.session.abort();
  }

  contextStore(): ContextStore {
    return this;
  }

  async snapshot(): Promise<ContextSnapshot> {
    const stats = this.session.getSessionStats();
    const context = stats.contextUsage;
    this.revision = Math.max(this.revision, stats.totalMessages ?? 0);
    return {
      revision: this.revision,
      entries: [],
      usage: tokenUsage(stats.tokens),
      ...(this.session.model === undefined
        ? {}
        : { model: `${this.session.model.provider}/${this.session.model.id}` }),
      ...(context?.tokens === null || context?.tokens === undefined
        ? {}
        : { contextTokens: context.tokens }),
      ...(context?.contextWindow === undefined
        ? {}
        : { contextWindow: context.contextWindow }),
    };
  }

  async compact(instruction?: string): Promise<void> {
    await this.session.compact(instruction);
    this.revision += 1;
  }

  async clear(): Promise<void> {
    throw new Error('Pi does not support clearing a persistent session in place.');
  }

  async close(): Promise<void> {
    this.session.dispose();
  }
}

class SdkPiRuntimeFactory implements PiRuntimeFactory {
  constructor(
    private readonly agentDir: string,
    private readonly authStorage: AuthStorage,
    private readonly modelRegistry: ModelRegistry,
  ) {}

  async create(input: PiRuntimeInput): Promise<PiSessionLike> {
    const sessionDirectory = this.sessionDirectory(input.projectId);
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    return this.open(
      input,
      SessionManager.create(input.workDir, sessionDirectory),
    );
  }

  async resume(
    input: PiRuntimeInput & { readonly sessionId: string },
  ): Promise<PiSessionLike> {
    const sessionDirectory = this.sessionDirectory(input.projectId);
    const sessions = await SessionManager.list(input.workDir, sessionDirectory);
    const saved = sessions.find((session) => session.id === input.sessionId);
    if (saved === undefined) {
      throw new Error(`Pi session "${input.sessionId}" was not found.`);
    }
    return this.open(
      input,
      SessionManager.open(saved.path, sessionDirectory, input.workDir),
    );
  }

  refresh(): void {
    this.modelRegistry.refresh();
  }

  private async open(
    input: PiRuntimeInput,
    sessionManager: SessionManager,
  ): Promise<PiSessionLike> {
    const model = this.modelRegistry.find(input.provider, input.model);
    if (model === undefined) {
      throw new Error(
        `Pi model "${input.provider}/${input.model}" is not configured.`,
      );
    }
    const result = await createPiSession({
      cwd: input.workDir,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      tools: [...input.tools],
      customTools: input.customTools.map((tool) => adaptTool(tool, input)),
      sessionManager,
      resourceLoader: new DefaultResourceLoader({
        cwd: input.workDir,
        agentDir: this.agentDir,
        systemPrompt: input.systemPrompt,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
      }),
    });
    return result.session;
  }

  private sessionDirectory(projectId: string): string {
    return join(this.agentDir, 'sessions', projectId);
  }
}

function isExecutableTool(
  tool: Awaited<ReturnType<AgentToolRuntime['resolve']>>[number],
): tool is AgentExecutableTool {
  return 'execute' in tool && typeof tool.execute === 'function';
}

function adaptTool(
  tool: AgentExecutableTool,
  input: PiRuntimeInput,
): ToolDefinition {
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    parameters: tool.inputSchema as ToolDefinition['parameters'],
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    ...(tool.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...tool.promptGuidelines] }),
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    async execute(_toolCallId, parameters, signal) {
      const result = await tool.execute(parameters as Readonly<Record<string, unknown>>, {
        projectId: input.projectId,
        workDir: input.workDir,
        ...(signal === undefined ? {} : { signal }),
      });
      return {
        content: [{ type: 'text', text: result.content }],
        details: result.details ?? {},
      };
    },
  };
}

function toolRegistration(
  name: string,
  customTools: readonly AgentExecutableTool[],
): ToolRegistration {
  const custom = customTools.find((tool) => tool.name === name);
  return {
    name,
    description: custom?.description ?? `Pi built-in ${name} tool.`,
    inputSchema: custom?.inputSchema ?? {
      type: 'object',
      additionalProperties: true,
    },
    source: custom?.source ?? 'builtin',
    version: '1',
    lifetime: 'static',
    readOnly:
      name === 'read' || name === 'web_fetch' || name === 'web_search',
    execution: 'backend',
  };
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ value, done: false });
  }

  close(): void {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

function tokenUsage(usage: {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite?: number;
}): TokenUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheCreation: usage.cacheWrite ?? 0,
  };
}

type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toJsonValue(item)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'symbol';
  if (typeof value === 'function') return value.name || 'function';
  return null;
}

function toJsonObject(value: unknown): JsonObject {
  const converted = toJsonValue(value);
  return isJsonRecord(converted) ? converted : { value: converted };
}

function isJsonRecord(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function traceText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(toJsonValue(value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function modelsFile(
  provider: ConfigureModelInput['provider'],
  model: SetupModel,
): object {
  return {
    providers: {
      [provider]: {
        baseUrl:
          provider === 'deepseek'
            ? 'https://api.deepseek.com'
            : 'https://openrouter.ai/api/v1',
        api: 'openai-completions',
        models: [{
          id: model.id,
          name: model.name,
          reasoning: model.supportsThinking,
          input: ['text'],
          contextWindow: model.contextTokens,
          maxTokens: model.maxOutputTokens ?? OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }],
      },
    },
  };
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const payload = await readJson(response);
  if (!response.ok) {
    throw new Error(
      providerError(payload) ?? `Provider request failed with HTTP ${response.status}.`,
    );
  }
  return payload;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseDeepSeekModels(payload: unknown): readonly SetupModel[] {
  const data = objectArray(payload, 'data');
  const models = data
    .map((item) => objectString(item, 'id'))
    .filter((id): id is string => id !== undefined)
    .map((id): SetupModel => ({
      id,
      name: id,
      contextTokens: 128_000,
      maxOutputTokens: id.includes('reasoner') ? 64_000 : 8_000,
      supportsThinking: id.includes('reasoner'),
      isFree: false,
    }))
    .sort((left, right) => Number(right.supportsThinking) - Number(left.supportsThinking));
  return models.map((model, index) => ({
    ...model,
    ...(index === 0 ? { recommended: true } : {}),
  }));
}

function parseOpenRouterModels(
  payload: unknown,
  freeOnly: boolean,
): readonly SetupModel[] {
  const models = objectArray(payload, 'data').flatMap((item): SetupModel[] => {
    const id = objectString(item, 'id');
    const supported = objectStringArray(item, 'supported_parameters');
    if (id === undefined || !supported.includes('tools')) return [];
    const contextTokens = objectNumber(item, 'context_length') ?? 32_000;
    const providerMaxOutputTokens = objectNumber(
      objectValue(item, 'top_provider'),
      'max_completion_tokens',
    );
    const isFree = id.endsWith(':free') || isZeroPricing(objectValue(item, 'pricing'));
    return [{
      id,
      name: objectString(item, 'name') ?? id,
      contextTokens,
      maxOutputTokens: normalizeOpenRouterMaxOutputTokens(
        providerMaxOutputTokens,
        contextTokens,
      ),
      supportsThinking:
        supported.includes('reasoning') || supported.includes('include_reasoning'),
      isFree,
    }];
  });
  const filtered = freeOnly ? models.filter((model) => model.isFree) : models;
  return filtered
    .sort((left, right) =>
      modelCompatibilityScore(right) - modelCompatibilityScore(left) ||
      left.name.localeCompare(right.name),
    )
    .map((model, index) => ({
      ...model,
      ...(index === 0 ? { recommended: true } : {}),
    }));
}

function normalizeOpenRouterMaxOutputTokens(
  providerLimit: number | undefined,
  contextTokens: number,
): number {
  const limit =
    providerLimit === undefined || providerLimit < 1
      ? OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS
      : Math.floor(providerLimit);
  return Math.min(
    limit,
    OPENROUTER_MAX_OUTPUT_TOKENS,
    Math.max(1_024, contextTokens - MIN_CONTEXT_INPUT_RESERVE_TOKENS),
  );
}

function modelCompatibilityScore(model: SetupModel): number {
  const coding = /\b(code|coder|coding|devstral|starcoder)\b/i.test(
    `${model.id} ${model.name}`.replaceAll('-', ' '),
  );
  return (
    Number(coding) * 10_000_000_000 +
    Number(model.supportsThinking) * 1_000_000_000 +
    model.contextTokens * 100 +
    (model.maxOutputTokens ?? 0)
  );
}

function isZeroPricing(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const pricing = value as Record<string, unknown>;
  return ['prompt', 'completion', 'request'].every((field) => {
    const amount = pricing[field];
    return amount === undefined || Number(amount) === 0;
  });
}

function providerError(payload: unknown): string | undefined {
  const error = objectValue(payload, 'error');
  return typeof error === 'string'
    ? error
    : objectString(error, 'message') ?? objectString(payload, 'message');
}

function chatContent(payload: unknown): string | undefined {
  const choice = objectArray(payload, 'choices')[0];
  return objectString(objectValue(choice, 'message'), 'content');
}

function objectValue(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function objectString(value: unknown, key: string): string | undefined {
  const item = objectValue(value, key);
  return typeof item === 'string' ? item : undefined;
}

function objectNumber(value: unknown, key: string): number | undefined {
  const item = objectValue(value, key);
  return typeof item === 'number' && Number.isFinite(item) ? item : undefined;
}

function objectArray(value: unknown, key: string): readonly unknown[] {
  const item = objectValue(value, key);
  return Array.isArray(item) ? item : [];
}

function objectStringArray(value: unknown, key: string): readonly string[] {
  return objectArray(value, key).filter((item): item is string => typeof item === 'string');
}
