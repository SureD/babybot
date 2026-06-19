import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  type AgentSessionEvent,
  type SessionStats,
} from '@earendil-works/pi-coding-agent';
import type {
  AgentBackend,
  AgentBackendCapabilities,
  AgentEvent,
  AgentRunInput,
  AgentSession,
  AgentToolRuntime,
  AgentUsage,
  ConfigureModelInput,
  CreateAgentSessionInput,
  DirectChatTestInput,
  DirectChatTestResult,
  DiscoverModelsInput,
  ResumeAgentSessionInput,
  SetupModel,
  SetupStatus,
  TokenUsage,
  TraceValue,
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
  compact(): Promise<unknown>;
  abort(): Promise<void>;
  dispose(): void;
  getSessionStats(): SessionStats;
}

export interface PiRuntimeInput {
  readonly projectId: string;
  readonly workDir: string;
  readonly provider: string;
  readonly model: string;
  readonly tools: readonly string[];
}

export interface PiRuntimeFactory {
  create(input: PiRuntimeInput): Promise<PiSessionLike>;
  resume(input: PiRuntimeInput & { readonly sessionId: string }): Promise<PiSessionLike>;
  refresh(): void;
}

export interface PiAgentBackendOptions {
  readonly agentDir: string;
  readonly toolRuntime: AgentToolRuntime;
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
  private readonly runtimes = new Map<string, PiAgentRuntime>();
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
    const runtime = new PiAgentRuntime(
      await this.runtimeFactory.create(runtimeInput),
    );
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    const active = this.runtimes.get(input.sessionId);
    if (active !== undefined) return active;
    const runtimeInput = await this.runtimeInput(input);
    const runtime = new PiAgentRuntime(
      await this.runtimeFactory.resume({
        ...runtimeInput,
        sessionId: input.sessionId,
      }),
    );
    this.runtimes.set(runtime.id, runtime);
    return runtime;
  }

  async close(): Promise<void> {
    for (const runtime of this.runtimes.values()) runtime.close();
    this.runtimes.clear();
  }

  private async runtimeInput(
    input: CreateAgentSessionInput,
  ): Promise<PiRuntimeInput> {
    const configuration = await this.readConfiguration();
    if (configuration === undefined) {
      throw new Error('Pi is not configured. Choose a provider and model first.');
    }
    const descriptors = await this.options.toolRuntime.resolve(input);
    return {
      projectId: input.projectId,
      workDir: input.workDir,
      provider: configuration.provider,
      model: this.options.model ?? configuration.model,
      tools: descriptors
        .filter((tool) => tool.enabled)
        .map((tool) => tool.name),
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

export class PiAgentRuntime implements AgentSession {
  readonly id: string;

  private turnId = 0;
  private running = false;
  private readonly usageByModel = new Map<string, TokenUsage>();
  private currentTurnUsage: TokenUsage | undefined;

  constructor(private readonly session: PiSessionLike) {
    this.id = session.sessionId;
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    if (this.running) throw new Error('The Pi agent runtime is already running.');
    this.running = true;
    this.turnId += 1;
    const turnId = this.turnId;
    let step = 0;
    let failed = false;
    const queue = new AsyncEventQueue<AgentEvent>();
    const unsubscribe = this.session.subscribe((event) => {
      const translated = translatePiEvent(event, {
        turnId,
        nextStep() {
          step += 1;
          return step;
        },
        currentStep() {
          return Math.max(step, 1);
        },
        recordUsage: (model, usage) => {
          this.currentTurnUsage = usage;
          this.usageByModel.set(
            model,
            addUsage(this.usageByModel.get(model), usage),
          );
        },
        hasFailed() {
          return failed;
        },
        markFailed() {
          failed = true;
        },
      });
      for (const item of translated) queue.push(item);
    });

    void this.session.prompt(input.prompt).then(
      () => queue.close(),
      (error: unknown) => {
        failed = true;
        queue.push({
          type: 'run.failed',
          turnId,
          code: 'pi.prompt.failed',
          error: error instanceof Error ? error.message : String(error),
        });
        queue.close();
      },
    );

    try {
      for await (const event of queue) yield event;
    } finally {
      unsubscribe();
      this.running = false;
    }
  }

  cancel(): Promise<void> {
    return this.session.abort();
  }

  async getUsage(): Promise<AgentUsage | undefined> {
    const stats = this.session.getSessionStats();
    const total = tokenUsage(stats.tokens);
    const model = this.session.model;
    const context = stats.contextUsage;
    return {
      byModel: Object.fromEntries(this.usageByModel),
      ...(this.currentTurnUsage === undefined
        ? {}
        : { currentTurn: this.currentTurnUsage }),
      total,
      ...(model === undefined ? {} : { model: `${model.provider}/${model.id}` }),
      ...(context?.tokens === null || context?.tokens === undefined
        ? {}
        : { contextTokens: context.tokens }),
      ...(context?.contextWindow === undefined
        ? {}
        : { maxContextTokens: context.contextWindow }),
      ...(context?.percent === null || context?.percent === undefined
        ? {}
        : { contextUsage: context.percent / 100 }),
    };
  }

  steer(input: string): Promise<void> {
    return this.session.steer(input);
  }

  compact(): Promise<unknown> {
    return this.session.compact();
  }

  close(): void {
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
    const result = await createAgentSession({
      cwd: input.workDir,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      model,
      tools: [...input.tools],
      sessionManager,
      resourceLoader: new DefaultResourceLoader({
        cwd: input.workDir,
        agentDir: this.agentDir,
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

interface TranslationState {
  readonly turnId: number;
  nextStep(): number;
  currentStep(): number;
  recordUsage(model: string, usage: TokenUsage): void;
  hasFailed(): boolean;
  markFailed(): void;
}

function translatePiEvent(
  event: AgentSessionEvent,
  state: TranslationState,
): readonly AgentEvent[] {
  switch (event.type) {
    case 'agent_start':
      return [{ type: 'run.started', turnId: state.turnId }];
    case 'turn_start':
      return [{
        type: 'step.started',
        turnId: state.turnId,
        step: state.nextStep(),
      }];
    case 'message_update': {
      const update = event.assistantMessageEvent;
      if (update.type === 'text_delta') {
        return [{ type: 'message.delta', turnId: state.turnId, text: update.delta }];
      }
      if (update.type === 'thinking_delta') {
        return [{ type: 'thinking.delta', turnId: state.turnId, text: update.delta }];
      }
      if (update.type === 'error') {
        state.markFailed();
        return [{
          type: 'run.failed',
          turnId: state.turnId,
          code: 'pi.model.failed',
          error: update.error.errorMessage ?? `Pi stopped with reason: ${update.reason}`,
        }];
      }
      return [];
    }
    case 'tool_execution_start':
      return [{
        type: 'tool.started',
        turnId: state.turnId,
        toolCallId: event.toolCallId,
        name: event.toolName,
        arguments: toTraceValue(event.args),
      }];
    case 'tool_execution_update':
      return [{
        type: 'tool.progress',
        turnId: state.turnId,
        toolCallId: event.toolCallId,
        kind: 'output',
        text: traceText(event.partialResult),
      }];
    case 'tool_execution_end':
      return [{
        type: 'tool.completed',
        turnId: state.turnId,
        toolCallId: event.toolCallId,
        name: event.toolName,
        output: toTraceValue(event.result),
        isError: event.isError,
      }];
    case 'turn_end': {
      const message = event.message;
      if (message.role !== 'assistant') {
        return [{
          type: 'step.completed',
          turnId: state.turnId,
          step: state.currentStep(),
        }];
      }
      const usage = tokenUsage(message.usage);
      state.recordUsage(`${message.provider}/${message.model}`, usage);
      return [{
        type: 'step.completed',
        turnId: state.turnId,
        step: state.currentStep(),
        usage,
        finishReason: message.stopReason,
      }];
    }
    case 'agent_end':
      return state.hasFailed()
        ? []
        : [{ type: 'run.completed', turnId: state.turnId, reason: 'completed' }];
    case 'compaction_start':
      return [{ type: 'compaction.started', trigger: event.reason }];
    case 'compaction_end':
      return [{
        type: 'compaction.completed',
        trigger: event.reason,
        ...(event.errorMessage === undefined
          ? {}
          : { compactedCount: 0 }),
      }];
    case 'auto_retry_start':
      return [{
        type: 'step.retrying',
        turnId: state.turnId,
        step: state.currentStep(),
        attempt: event.attempt,
        nextAttempt: event.attempt + 1,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        error: event.errorMessage,
      }];
    case 'auto_retry_end':
      return event.success
        ? []
        : [{
            type: 'warning',
            code: 'pi.retry.exhausted',
            message: event.finalError ?? 'Pi retry attempts were exhausted.',
          }];
    default:
      return [{
        type: 'runtime.event',
        name: event.type,
        data: toTraceValue(event),
      }];
  }
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

function addUsage(current: TokenUsage | undefined, next: TokenUsage): TokenUsage {
  return {
    input: (current?.input ?? 0) + next.input,
    output: (current?.output ?? 0) + next.output,
    cacheRead: (current?.cacheRead ?? 0) + next.cacheRead,
    cacheCreation: (current?.cacheCreation ?? 0) + next.cacheCreation,
  };
}

function toTraceValue(value: unknown): TraceValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(toTraceValue);
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, toTraceValue(item)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'symbol';
  if (typeof value === 'function') return value.name || 'function';
  return null;
}

function traceText(value: unknown): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(toTraceValue(value));
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
