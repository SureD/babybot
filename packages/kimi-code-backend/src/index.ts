import { access } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

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
import type {
  AgentBackend,
  AgentBackendCapabilities,
  AgentEvent,
  AgentUsage,
  ConfigureModelInput,
  CreateAgentSessionInput,
  DirectChatTestInput,
  DirectChatTestResult,
  DiscoverModelsInput,
  ModelProvider,
  ResumeAgentSessionInput,
  SetupModel,
  SetupStatus,
  TraceValue,
} from '@babybot/core';

type PermissionMode = 'auto' | 'manual' | 'yolo';

interface KimiEvent {
  readonly type: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly origin?: unknown;
  readonly step?: number;
  readonly stepId?: string;
  readonly delta?: string;
  readonly code?: string;
  readonly message?: string;
  readonly reason?: string;
  readonly name?: string;
  readonly toolCallId?: string;
  readonly args?: unknown;
  readonly description?: string;
  readonly update?: unknown;
  readonly output?: unknown;
  readonly isError?: boolean;
  readonly usage?: KimiTokenUsage | KimiUsageStatus;
  readonly finishReason?: string;
  readonly llmFirstTokenLatencyMs?: number;
  readonly llmStreamDurationMs?: number;
  readonly failedAttempt?: number;
  readonly nextAttempt?: number;
  readonly maxAttempts?: number;
  readonly delayMs?: number;
  readonly errorName?: string;
  readonly errorMessage?: string;
  readonly statusCode?: number;
  readonly model?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
  readonly subagentId?: string;
  readonly subagentName?: string;
  readonly resultSummary?: string;
  readonly error?: string;
  readonly trigger?: string;
  readonly result?: {
    readonly compactedCount?: number;
    readonly tokensBefore?: number;
    readonly tokensAfter?: number;
  };
}

interface KimiTokenUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

interface KimiUsageStatus {
  readonly byModel?: Readonly<Record<string, KimiTokenUsage>>;
  readonly currentTurn?: KimiTokenUsage;
  readonly total?: KimiTokenUsage;
}

interface KimiSessionStatus {
  readonly model?: string;
  readonly contextTokens: number;
  readonly maxContextTokens: number;
  readonly contextUsage: number;
  readonly usage?: KimiUsageStatus;
}

interface KimiSession {
  readonly id: string;
  onEvent(listener: (event: KimiEvent) => void): () => void;
  setApprovalHandler(
    handler: (request: unknown) => { decision: 'rejected'; feedback: string },
  ): void;
  prompt(input: string): Promise<void>;
  cancel(): Promise<void>;
  getUsage(): Promise<{ readonly total?: KimiTokenUsage }>;
  getStatus(): Promise<KimiSessionStatus>;
}

interface KimiHarness {
  getConfig(options?: { readonly reload?: boolean }): Promise<KimiConfig>;
  setConfig(patch: KimiConfigPatch): Promise<KimiConfig>;
  createSession(options: {
    readonly workDir: string;
    readonly model: string;
    readonly permission: PermissionMode;
  }): Promise<KimiSession>;
  resumeSession(options: { readonly id: string }): Promise<KimiSession>;
  close(): Promise<void>;
}

interface KimiProviderConfig {
  readonly type?: string;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly oauth?: unknown;
}

interface KimiModelAlias {
  readonly provider?: string;
  readonly model?: string;
  readonly maxContextSize?: number;
  readonly maxOutputSize?: number;
  readonly capabilities?: readonly string[];
}

interface KimiConfig {
  readonly providers: Readonly<Record<string, KimiProviderConfig>>;
  readonly defaultModel?: string;
  readonly models?: Readonly<Record<string, KimiModelAlias>>;
}

interface KimiConfigPatch {
  readonly providers?: Readonly<Record<string, KimiProviderConfig>>;
  readonly defaultModel?: string;
  readonly models?: Readonly<Record<string, KimiModelAlias>>;
  readonly defaultThinking?: boolean;
}

interface KimiSdkModule {
  createKimiHarness(options: {
    readonly homeDir?: string;
    readonly identity: {
      readonly userAgentProduct: string;
      readonly version: string;
    };
  }): KimiHarness;
}

export interface KimiCodeAgentBackendOptions {
  readonly sdkPath: string;
  readonly homeDir?: string;
  readonly model?: string;
  readonly permission: PermissionMode;
  readonly turnTimeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const KIMI_CODE_CAPABILITIES: AgentBackendCapabilities = {
  streaming: true,
  sessionResume: true,
  cancellation: true,
  tokenUsage: true,
  tracing: true,
};

const OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS = 8_000;
const OPENROUTER_MAX_OUTPUT_TOKENS = 16_000;
const MIN_CONTEXT_INPUT_RESERVE_TOKENS = 4_096;

export class KimiCodeAgentBackend implements AgentBackend {
  readonly name = 'kimi-code';
  readonly capabilities = KIMI_CODE_CAPABILITIES;

  private harness?: KimiHarness;
  private sdkModule?: Promise<KimiSdkModule>;
  private readonly sessions = new Map<string, AgentSession>();

  constructor(private readonly options: KimiCodeAgentBackendOptions) {}

  async isAvailable(): Promise<boolean> {
    try {
      await access(this.options.sdkPath);
      await this.loadSdk();
      return true;
    } catch {
      return false;
    }
  }

  async getSetupStatus(): Promise<SetupStatus> {
    if (!(await this.isAvailable())) {
      return unavailableSetupStatus();
    }
    const config = await (await this.getHarness()).getConfig();
    return setupStatusFromConfig(config, this.options.model);
  }

  async discoverModels(
    input: DiscoverModelsInput,
  ): Promise<readonly SetupModel[]> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const apiKey =
      input.apiKey ??
      findStoredApiKey(await (await this.getHarness()).getConfig(), input.provider);
    if (apiKey === undefined) {
      throw new Error(`Enter an API key before loading ${input.provider} models.`);
    }
    if (input.provider === 'openrouter') {
      await requestJson(
        fetchImpl,
        'https://openrouter.ai/api/v1/auth/key',
        apiKey,
      );
    }
    const endpoint =
      input.provider === 'deepseek'
        ? 'https://api.deepseek.com/models'
        : 'https://openrouter.ai/api/v1/models?supported_parameters=tools';
    const payload = await requestJson(fetchImpl, endpoint, apiKey);
    const models = parseProviderModels(
      input.provider,
      payload,
      input.freeOnly === true,
    );
    if (models.length === 0) {
      throw new Error(`No tool-capable ${input.provider} models were returned.`);
    }
    return models;
  }

  async configure(input: ConfigureModelInput): Promise<SetupStatus> {
    if (this.options.model !== undefined) {
      throw new Error(
        'KIMI_CODE_MODEL overrides the setup model. Remove it and restart Babybot.',
      );
    }
    const harness = await this.getHarness();
    const config = await harness.getConfig();
    const apiKey =
      input.apiKey ?? findStoredApiKey(config, input.provider);
    if (apiKey === undefined) {
      throw new Error(
        `Enter an API key before configuring ${input.provider}.`,
      );
    }
    const model = (await this.discoverModels({ ...input, apiKey })).find(
      (candidate) => candidate.id === input.model,
    );
    if (model === undefined) {
      throw new Error(`Model "${input.model}" was not returned by ${input.provider}.`);
    }

    const providerId = `babybot-${input.provider}`;
    const modelAlias = `${providerId}/${model.id}`;
    await harness.setConfig({
      providers: {
        [providerId]: {
          type: 'openai',
          baseUrl:
            input.provider === 'deepseek'
              ? 'https://api.deepseek.com'
              : 'https://openrouter.ai/api/v1',
          apiKey,
        },
      },
      models: {
        [modelAlias]: {
          provider: providerId,
          model: model.id,
          maxContextSize: model.contextTokens,
          ...(model.maxOutputTokens === undefined
            ? {}
            : { maxOutputSize: model.maxOutputTokens }),
          capabilities: [
            'tool_use',
            ...(model.supportsThinking ? ['thinking'] : []),
          ],
        },
      },
      defaultModel: modelAlias,
      defaultThinking: model.supportsThinking,
    });
    this.sessions.clear();
    return {
      backendAvailable: true,
      configured: true,
      provider: input.provider,
      model: model.id,
      hasApiKey: true,
      modelLockedByEnvironment: false,
    };
  }

  async testChat(input: DirectChatTestInput): Promise<DirectChatTestResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const apiKey =
      input.apiKey ??
      findStoredApiKey(await (await this.getHarness()).getConfig(), input.provider);
    if (apiKey === undefined) {
      throw new Error(`Enter an API key before testing ${input.provider}.`);
    }
    const endpoint =
      input.provider === 'deepseek'
        ? 'https://api.deepseek.com/chat/completions'
        : 'https://openrouter.ai/api/v1/chat/completions';
    const startedAt = performance.now();
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
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
    const latencyMs = Math.round(performance.now() - startedAt);
    const payload = await readJsonResponse(response);
    const requestId =
      response.headers.get('x-request-id') ??
      response.headers.get('openrouter-request-id') ??
      undefined;
    if (!response.ok) {
      return {
        ok: false,
        provider: input.provider,
        statusCode: response.status,
        requestedModel: input.model,
        error: readProviderError(payload, response.statusText),
        ...(requestId === undefined ? {} : { requestId }),
        latencyMs,
      };
    }
    return {
      ok: true,
      provider: input.provider,
      statusCode: response.status,
      requestedModel: input.model,
      ...readChatCompletion(payload),
      ...(requestId === undefined ? {} : { requestId }),
      latencyMs,
    };
  }

  async createSession(input: CreateAgentSessionInput): Promise<AgentSession> {
    const harness = await this.getHarness();
    const config = await harness.getConfig();
    const model = this.options.model || config.defaultModel;
    if (model === undefined || model.trim().length === 0) {
      throw new Error('No kimi-code model is configured.');
    }

    const session = await harness.createSession({
      workDir: input.workDir,
      model,
      permission: this.options.permission,
    });
    return this.wrapSession(session, input.workDir);
  }

  async resumeSession(input: ResumeAgentSessionInput): Promise<AgentSession> {
    const active = this.sessions.get(input.sessionId);
    if (active !== undefined) {
      return active;
    }

    const harness = await this.getHarness();
    return this.wrapSession(
      await harness.resumeSession({ id: input.sessionId }),
      input.workDir,
      input.sessionId,
    );
  }

  async close(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((session) => session.close()));
    await this.harness?.close();
    this.harness = undefined;
    this.sessions.clear();
  }

  private async wrapSession(
    session: KimiSession,
    workDir: string,
    sessionId?: string,
  ): Promise<AgentSession> {
    const runtime = new KimiCodeAgentRuntime(
      session,
      this.options.turnTimeoutMs ?? 600_000,
    );
    const wrapped = await createAgentSession({
      backend: new KimiRuntimeBackend(runtime),
      workDir,
      ...(sessionId === undefined ? {} : { sessionId }),
      tools: KIMI_TOOL_REGISTRATIONS,
    });
    this.sessions.set(wrapped.id, wrapped);
    return wrapped;
  }

  private async getHarness(): Promise<KimiHarness> {
    if (this.harness !== undefined) {
      return this.harness;
    }

    const sdk = await this.loadSdk();
    this.harness = sdk.createKimiHarness({
      ...(this.options.homeDir === undefined ? {} : { homeDir: this.options.homeDir }),
      identity: {
        userAgentProduct: 'babybot',
        version: '0.1.0',
      },
    });
    return this.harness;
  }

  private loadSdk(): Promise<KimiSdkModule> {
    this.sdkModule ??= this.importSdk();
    return this.sdkModule;
  }

  private async importSdk(): Promise<KimiSdkModule> {
    if (this.options.sdkPath.endsWith('.ts')) {
      const loaderPath = resolve(
        dirname(this.options.sdkPath),
        '../../../build/register-raw-text-loader.mjs',
      );
      await access(loaderPath);
      await import(pathToFileURL(loaderPath).href);
    }

    const moduleUrl = pathToFileURL(this.options.sdkPath).href;
    const sdk = (await import(moduleUrl)) as Partial<KimiSdkModule>;
    if (typeof sdk.createKimiHarness !== 'function') {
      throw new Error('Configured kimi-code SDK does not export createKimiHarness.');
    }
    return sdk as KimiSdkModule;
  }
}

class KimiCodeAgentRuntime {
  readonly id: string;
  private running = false;

  constructor(
    private readonly session: KimiSession,
    private readonly turnTimeoutMs: number,
  ) {
    this.id = session.id;
    this.session.setApprovalHandler(() => ({
      decision: 'rejected',
      feedback:
        'Babybot does not expose interactive approvals yet. Use auto mode or explicitly enable yolo mode.',
    }));
  }

  async *run(input: { readonly prompt: string }): AsyncIterable<AgentEvent> {
    if (this.running) {
      throw new Error(`Agent session "${this.id}" is already running.`);
    }
    this.running = true;

    const queue = new AsyncEventQueue();
    const toolNames = new Map<string, string>();
    const unsubscribe = this.session.onEvent((event) => {
      const translated = translateEvent(event, toolNames);
      if (translated !== undefined) {
        queue.push(translated);
      }
      if (event.type === 'turn.ended' || event.type === 'error') {
        queue.end();
      }
    });
    const timeout = setTimeout(() => {
      queue.push({
        type: 'run.failed',
        error: 'Timed out waiting for the kimi-code turn to finish.',
      });
      queue.end();
      void this.session.cancel();
    }, this.turnTimeoutMs);

    void this.session.prompt(input.prompt).catch((error: unknown) => {
      queue.push({
        type: 'run.failed',
        error: error instanceof Error ? error.message : String(error),
      });
      queue.end();
    });

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      this.running = false;
    }
  }

  cancel(): Promise<void> {
    return this.session.cancel();
  }

  async getUsage(): Promise<AgentUsage | undefined> {
    const status = await this.session.getStatus();
    const usage = status.usage;
    return {
      ...(usage?.byModel === undefined
        ? {}
        : {
            byModel: Object.fromEntries(
              Object.entries(usage.byModel).map(([model, value]) => [
                model,
                translateUsage(value),
              ]),
            ),
          }),
      ...(usage?.currentTurn === undefined
        ? {}
        : { currentTurn: translateUsage(usage.currentTurn) }),
      ...(usage?.total === undefined ? {} : { total: translateUsage(usage.total) }),
      ...(status.model === undefined ? {} : { model: status.model }),
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      contextUsage: status.contextUsage,
    };
  }
}

const KIMI_TOOL_NAMES = [
  'Read',
  'Write',
  'Edit',
  'Shell',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
] as const;

const KIMI_TOOL_REGISTRATIONS: readonly ToolRegistration[] = KIMI_TOOL_NAMES.map(
  (name) => ({
    name,
    description: `Kimi Code ${name} tool.`,
    inputSchema: { type: 'object', additionalProperties: true },
    source: 'builtin',
    version: '1',
    lifetime: 'static',
    readOnly: ['Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch'].includes(name),
    execution: 'backend',
  }),
);

class KimiRuntimeBackend implements Backend {
  constructor(private readonly runtime: KimiCodeAgentRuntime) {}

  async open(): Promise<BackendSession> {
    return new KimiBackendSession(this.runtime);
  }
}

class KimiBackendSession implements BackendSession, ContextStore {
  readonly id: string;

  private revision = 0;

  constructor(private readonly runtime: KimiCodeAgentRuntime) {
    this.id = runtime.id;
  }

  async *run(input: BackendRunInput): AsyncIterable<BackendEvent> {
    const controller = new AbortController();
    const output: string[] = [];
    for await (const event of this.runtime.run({
      prompt: input.context.input.text,
    })) {
      switch (event.type) {
        case 'run.started':
        case 'agent.status':
          break;
        case 'step.started':
          yield { type: event.type, step: event.step };
          break;
        case 'step.completed':
          yield {
            type: event.type,
            step: event.step,
            ...(event.usage === undefined ? {} : { usage: event.usage }),
          };
          break;
        case 'step.retrying':
          yield {
            type: 'warning',
            message:
              `Kimi Code retry ${String(event.nextAttempt)}/${String(event.maxAttempts)}: ` +
              event.error,
          };
          break;
        case 'message.delta':
          output.push(event.text);
          yield { type: event.type, text: event.text };
          break;
        case 'thinking.delta':
          yield { type: event.type, text: event.text };
          break;
        case 'tool.started': {
          const call = {
            id: event.toolCallId,
            name: event.name,
            arguments: kimiJsonObject(event.arguments),
          };
          yield { type: event.type, call };
          const tool = input.tools.tools.find(({ name }) => name === call.name);
          if (tool === undefined) {
            yield {
              type: 'failed',
              error: `Kimi Code called unregistered tool ${call.name}.`,
            };
            return;
          }
          const decision = await input.hooks.authorize(
            { mode: 'build', tool, call },
            controller.signal,
          );
          if (decision.decision === 'deny') {
            await this.runtime.cancel();
            yield {
              type: 'failed',
              error: `Tool ${call.name} was denied: ${decision.reason}`,
            };
            return;
          }
          break;
        }
        case 'tool.progress':
          yield {
            type: event.type,
            toolCallId: event.toolCallId,
            text: event.text ?? event.kind,
          };
          break;
        case 'tool.completed':
          yield {
            type: event.type,
            toolCallId: event.toolCallId,
            result: {
              content: traceValueText(event.output),
              isError: event.isError,
              ...(event.output === undefined ? {} : { details: event.output }),
            },
          };
          break;
        case 'run.completed':
          this.revision += 1;
          yield {
            type: 'completed',
            output: output.join('').trim(),
            finishReason: event.reason,
          };
          return;
        case 'run.failed':
          yield { type: 'failed', error: event.error };
          return;
        case 'warning':
          yield { type: event.type, message: event.message };
          break;
        case 'subagent.started':
        case 'subagent.completed':
        case 'subagent.failed':
        case 'compaction.started':
        case 'compaction.completed':
        case 'runtime.event':
          yield { type: 'warning', message: `Kimi Code event: ${event.type}.` };
          break;
      }
    }
  }

  async steer(): Promise<void> {
    throw new Error('Kimi Code rollback sessions do not support steering.');
  }

  abort(): Promise<void> {
    return this.runtime.cancel();
  }

  contextStore(): ContextStore {
    return this;
  }

  async snapshot(): Promise<ContextSnapshot> {
    const usage = await this.runtime.getUsage();
    return {
      revision: this.revision,
      entries: [],
      ...(usage?.total === undefined ? {} : { usage: usage.total }),
      ...(usage?.model === undefined ? {} : { model: usage.model }),
      ...(usage?.contextTokens === undefined
        ? {}
        : { contextTokens: usage.contextTokens }),
      ...(usage?.maxContextTokens === undefined
        ? {}
        : { contextWindow: usage.maxContextTokens }),
    };
  }

  async compact(): Promise<void> {
    throw new Error('Kimi Code rollback sessions do not support compaction.');
  }

  async clear(): Promise<void> {
    throw new Error('Kimi Code rollback sessions do not support clearing context.');
  }

  async close(): Promise<void> {}
}

export class UnavailableAgentBackend implements AgentBackend {
  readonly name = 'unavailable';
  readonly capabilities: AgentBackendCapabilities = {
    streaming: false,
    sessionResume: false,
    cancellation: false,
    tokenUsage: false,
    tracing: false,
  };

  async isAvailable(): Promise<boolean> {
    return false;
  }

  async getSetupStatus(): Promise<SetupStatus> {
    return unavailableSetupStatus();
  }

  async discoverModels(_input: DiscoverModelsInput): Promise<readonly SetupModel[]> {
    throw new Error('No agent backend is configured.');
  }

  async configure(_input: ConfigureModelInput): Promise<SetupStatus> {
    throw new Error('No agent backend is configured.');
  }

  async testChat(_input: DirectChatTestInput): Promise<DirectChatTestResult> {
    throw new Error('No agent backend is configured.');
  }

  async createSession(_input: CreateAgentSessionInput): Promise<AgentSession> {
    throw new Error('No agent backend is configured.');
  }

  async resumeSession(_input: ResumeAgentSessionInput): Promise<AgentSession> {
    throw new Error('No agent backend is configured.');
  }

  async close(): Promise<void> {}
}

function unavailableSetupStatus(): SetupStatus {
  return {
    backendAvailable: false,
    configured: false,
    hasApiKey: false,
    modelLockedByEnvironment: false,
  };
}

function setupStatusFromConfig(
  config: KimiConfig,
  environmentModel: string | undefined,
): SetupStatus {
  const modelAlias = environmentModel || config.defaultModel;
  const alias = modelAlias === undefined ? undefined : config.models?.[modelAlias];
  const providerConfig =
    alias?.provider === undefined ? undefined : config.providers[alias.provider];
  const provider = detectProvider(providerConfig?.baseUrl);
  const hasApiKey =
    (providerConfig?.apiKey !== undefined && providerConfig.apiKey.trim() !== '') ||
    providerConfig?.oauth !== undefined;
  return {
    backendAvailable: true,
    configured:
      modelAlias !== undefined &&
      alias?.model !== undefined &&
      provider !== undefined &&
      hasApiKey,
    ...(provider === undefined ? {} : { provider }),
    ...(alias?.model === undefined ? {} : { model: alias.model }),
    hasApiKey,
    modelLockedByEnvironment: environmentModel !== undefined,
  };
}

function detectProvider(baseUrl: string | undefined): ModelProvider | undefined {
  if (baseUrl?.includes('deepseek.com') === true) return 'deepseek';
  if (baseUrl?.includes('openrouter.ai') === true) return 'openrouter';
  return undefined;
}

function findStoredApiKey(
  config: KimiConfig,
  provider: ModelProvider,
): string | undefined {
  return Object.values(config.providers).find(
    (candidate) =>
      detectProvider(candidate.baseUrl) === provider &&
      candidate.apiKey !== undefined &&
      candidate.apiKey.trim() !== '',
  )?.apiKey;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `Provider request failed with HTTP ${response.status}${
        text.trim() === '' ? '.' : `: ${text.slice(0, 500)}`
      }`,
    );
  }
  return response.json();
}

async function readJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.slice(0, 500);
  }
}

function readProviderError(payload: unknown, fallback: string): string {
  if (typeof payload === 'string') return payload;
  if (typeof payload === 'object' && payload !== null && 'error' in payload) {
    const error = payload.error;
    if (typeof error === 'string') return error;
    if (
      typeof error === 'object' &&
      error !== null &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return error.message;
    }
  }
  return fallback === '' ? 'Provider returned an unknown error.' : fallback;
}

function readChatCompletion(
  payload: unknown,
): Partial<Pick<DirectChatTestResult, 'responseModel' | 'content'>> {
  if (typeof payload !== 'object' || payload === null) return {};
  const responseModel =
    'model' in payload && typeof payload.model === 'string'
      ? payload.model
      : undefined;
  const choices =
    'choices' in payload && Array.isArray(payload.choices)
      ? payload.choices
      : [];
  const first = choices[0];
  const content =
    typeof first === 'object' &&
    first !== null &&
    'message' in first &&
    typeof first.message === 'object' &&
    first.message !== null &&
    'content' in first.message &&
    typeof first.message.content === 'string'
      ? first.message.content
      : undefined;
  return {
    ...(responseModel === undefined ? {} : { responseModel }),
    ...(content === undefined ? {} : { content }),
  };
}

function parseProviderModels(
  provider: ModelProvider,
  payload: unknown,
  freeOnly: boolean,
): readonly SetupModel[] {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    !('data' in payload) ||
    !Array.isArray(payload.data)
  ) {
    throw new Error('Provider returned an invalid model list.');
  }

  const models = payload.data.flatMap((item): SetupModel[] => {
    if (typeof item !== 'object' || item === null || !('id' in item)) return [];
    const id = typeof item.id === 'string' ? item.id : undefined;
    if (id === undefined || id.trim() === '') return [];
    if (provider === 'deepseek') {
      const supportsThinking = id.includes('reasoner');
      return [{
        id,
        name: id,
        contextTokens: 128_000,
        maxOutputTokens: supportsThinking ? 64_000 : 8_000,
        supportsThinking,
        isFree: false,
      }];
    }

    const contextTokens =
      'context_length' in item && typeof item.context_length === 'number'
        ? item.context_length
        : undefined;
    if (contextTokens === undefined || contextTokens < 1) return [];
    const supportedParameters =
      'supported_parameters' in item && Array.isArray(item.supported_parameters)
        ? item.supported_parameters.filter(
            (parameter: unknown): parameter is string =>
              typeof parameter === 'string',
          )
        : [];
    if (!supportedParameters.includes('tools')) return [];
    const topProvider =
      'top_provider' in item &&
      typeof item.top_provider === 'object' &&
      item.top_provider !== null
        ? item.top_provider
        : undefined;
    const providerMaxOutputTokens =
      topProvider !== undefined &&
      'max_completion_tokens' in topProvider &&
      typeof topProvider.max_completion_tokens === 'number'
        ? topProvider.max_completion_tokens
        : undefined;
    const isFree =
      id.endsWith(':free') ||
      ('pricing' in item &&
        isZeroOpenRouterPricing(item.pricing));
    return [{
      id,
      name:
        'name' in item && typeof item.name === 'string' ? item.name : id,
      contextTokens,
      maxOutputTokens: normalizeOpenRouterMaxOutputTokens(
        providerMaxOutputTokens,
        contextTokens,
      ),
      supportsThinking:
        supportedParameters.includes('reasoning') ||
        supportedParameters.includes('include_reasoning'),
      isFree,
    }];
  });
  const filtered = freeOnly ? models.filter((model) => model.isFree) : models;
  const sorted = filtered.sort(compareSetupModels);
  return sorted.map((model, index) => ({
    ...model,
    ...(index === 0 ? { recommended: true } : {}),
  }));
}

function normalizeOpenRouterMaxOutputTokens(
  providerMaxOutputTokens: number | undefined,
  contextTokens: number,
): number {
  const providerLimit =
    providerMaxOutputTokens === undefined ||
    !Number.isFinite(providerMaxOutputTokens) ||
    providerMaxOutputTokens < 1
      ? OPENROUTER_DEFAULT_MAX_OUTPUT_TOKENS
      : Math.floor(providerMaxOutputTokens);
  const contextLimit = Math.max(
    1_024,
    contextTokens - MIN_CONTEXT_INPUT_RESERVE_TOKENS,
  );
  return Math.min(
    providerLimit,
    OPENROUTER_MAX_OUTPUT_TOKENS,
    contextLimit,
  );
}

function isZeroOpenRouterPricing(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const pricing = value as Record<string, unknown>;
  return ['prompt', 'completion', 'request'].every((field) => {
    const amount = pricing[field];
    return amount === undefined || Number(amount) === 0;
  });
}

function compareSetupModels(left: SetupModel, right: SetupModel): number {
  return (
    modelCompatibilityScore(right) - modelCompatibilityScore(left) ||
    left.name.localeCompare(right.name)
  );
}

function modelCompatibilityScore(model: SetupModel): number {
  const codingModel = /\b(code|coder|coding|devstral|starcoder)\b/i.test(
    `${model.id} ${model.name}`.replaceAll('-', ' '),
  );
  return (
    Number(codingModel) * 10_000_000_000 +
    Number(model.supportsThinking) * 1_000_000_000 +
    model.contextTokens * 100 +
    (model.maxOutputTokens ?? 0)
  );
}

function translateEvent(
  event: KimiEvent,
  toolNames: Map<string, string>,
): AgentEvent | undefined {
  const agentId = event.agentId;
  const withAgent = <T extends AgentEvent>(translated: T): AgentEvent => ({
    ...translated,
    ...(agentId === undefined ? {} : { agentId }),
  });

  switch (event.type) {
    case 'turn.started':
      return withAgent({
        type: 'run.started',
        turnId: event.turnId ?? 0,
        ...(event.origin === undefined ? {} : { origin: toTraceValue(event.origin) }),
      });
    case 'agent.status.updated':
      return withAgent({
        type: 'agent.status',
        ...(event.model === undefined ? {} : { model: event.model }),
        ...(event.contextTokens === undefined
          ? {}
          : { contextTokens: event.contextTokens }),
        ...(event.maxContextTokens === undefined
          ? {}
          : { maxContextTokens: event.maxContextTokens }),
        ...(event.contextUsage === undefined ? {} : { contextUsage: event.contextUsage }),
        ...(isUsageStatus(event.usage)
          ? { usage: translateUsageStatus(event.usage) }
          : {}),
      });
    case 'turn.step.started':
      return withAgent({
        type: 'step.started',
        turnId: event.turnId ?? 0,
        step: event.step ?? 0,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
      });
    case 'turn.step.completed':
      return withAgent({
        type: 'step.completed',
        turnId: event.turnId ?? 0,
        step: event.step ?? 0,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        ...(isTokenUsage(event.usage) ? { usage: translateUsage(event.usage) } : {}),
        ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason }),
        ...(event.llmFirstTokenLatencyMs === undefined
          ? {}
          : { firstTokenLatencyMs: event.llmFirstTokenLatencyMs }),
        ...(event.llmStreamDurationMs === undefined
          ? {}
          : { streamDurationMs: event.llmStreamDurationMs }),
      });
    case 'turn.step.retrying':
      return withAgent({
        type: 'step.retrying',
        turnId: event.turnId ?? 0,
        step: event.step ?? 0,
        ...(event.stepId === undefined ? {} : { stepId: event.stepId }),
        attempt: event.failedAttempt ?? 0,
        nextAttempt: event.nextAttempt ?? 0,
        maxAttempts: event.maxAttempts ?? 0,
        delayMs: event.delayMs ?? 0,
        error: [event.errorName, event.errorMessage].filter(Boolean).join(': '),
        ...(event.statusCode === undefined ? {} : { statusCode: event.statusCode }),
      });
    case 'assistant.delta':
      return event.delta === undefined
        ? undefined
        : withAgent({
            type: 'message.delta',
            turnId: event.turnId ?? 0,
            text: event.delta,
          });
    case 'thinking.delta':
      return event.delta === undefined
        ? undefined
        : withAgent({
            type: 'thinking.delta',
            turnId: event.turnId ?? 0,
            text: event.delta,
          });
    case 'tool.call.started': {
      const name = event.name ?? 'unknown';
      if (event.toolCallId !== undefined) {
        toolNames.set(event.toolCallId, name);
      }
      return withAgent({
        type: 'tool.started',
        turnId: event.turnId ?? 0,
        toolCallId: event.toolCallId ?? 'unknown',
        name,
        ...(event.args === undefined ? {} : { arguments: toTraceValue(event.args) }),
        ...(event.description === undefined ? {} : { description: event.description }),
      });
    }
    case 'tool.progress': {
      const update = translateToolProgress(event.update);
      return withAgent({
        type: 'tool.progress',
        turnId: event.turnId ?? 0,
        toolCallId: event.toolCallId ?? 'unknown',
        ...update,
      });
    }
    case 'tool.result':
      return withAgent({
        type: 'tool.completed',
        turnId: event.turnId ?? 0,
        toolCallId: event.toolCallId ?? 'unknown',
        name:
          (event.toolCallId === undefined ? undefined : toolNames.get(event.toolCallId)) ??
          'unknown',
        ...(event.output === undefined ? {} : { output: toTraceValue(event.output) }),
        isError: event.isError === true,
      });
    case 'subagent.started':
      return withAgent({
        type: 'subagent.started',
        subagentId: event.subagentId ?? 'unknown',
        ...(event.subagentName === undefined ? {} : { name: event.subagentName }),
      });
    case 'subagent.completed':
      return withAgent({
        type: 'subagent.completed',
        subagentId: event.subagentId ?? 'unknown',
        ...(event.resultSummary === undefined ? {} : { summary: event.resultSummary }),
        ...(isTokenUsage(event.usage) ? { usage: translateUsage(event.usage) } : {}),
      });
    case 'subagent.failed':
      return withAgent({
        type: 'subagent.failed',
        subagentId: event.subagentId ?? 'unknown',
        error: event.error ?? event.message ?? 'Subagent failed.',
      });
    case 'compaction.started':
      return withAgent({
        type: 'compaction.started',
        ...(event.trigger === undefined ? {} : { trigger: event.trigger }),
      });
    case 'compaction.completed':
      return withAgent({
        type: 'compaction.completed',
        ...(event.result?.compactedCount === undefined
          ? {}
          : { compactedCount: event.result.compactedCount }),
        ...(event.result?.tokensBefore === undefined
          ? {}
          : { tokensBefore: event.result.tokensBefore }),
        ...(event.result?.tokensAfter === undefined
          ? {}
          : { tokensAfter: event.result.tokensAfter }),
      });
    case 'warning':
      return withAgent({
        type: 'warning',
        ...(event.code === undefined ? {} : { code: event.code }),
        message: event.message ?? 'Unknown warning.',
      });
    case 'turn.ended':
      return event.reason === 'completed'
        ? withAgent({
            type: 'run.completed',
            turnId: event.turnId ?? 0,
            reason: event.reason,
          })
        : withAgent({
            type: 'run.failed',
            turnId: event.turnId,
            error: `Kimi Code turn ended with reason: ${event.reason ?? 'unknown'}`,
          });
    case 'error':
      return withAgent({
        type: 'run.failed',
        ...(event.turnId === undefined ? {} : { turnId: event.turnId }),
        ...(event.code === undefined ? {} : { code: event.code }),
        error: `${event.code ?? 'kimi.error'}: ${event.message ?? 'Unknown error'}`,
      });
    default:
      return withAgent({
        type: 'runtime.event',
        name: event.type,
        data: toTraceValue(event),
      });
  }
}

function translateToolProgress(update: unknown): {
  readonly kind: string;
  readonly text?: string;
  readonly percent?: number;
} {
  if (
    typeof update === 'object' &&
    update !== null
  ) {
    const kind =
      'kind' in update && typeof update.kind === 'string' ? update.kind : 'progress';
    const text = 'text' in update && typeof update.text === 'string' ? update.text : undefined;
    const percent =
      'percent' in update && typeof update.percent === 'number'
        ? update.percent
        : undefined;
    return {
      kind,
      ...(text === undefined ? {} : { text }),
      ...(percent === undefined ? {} : { percent }),
    };
  }
  return {
    kind: 'progress',
    ...(typeof update === 'string' ? { text: update } : {}),
  };
}

function translateUsage(usage: KimiTokenUsage) {
  return {
    input: usage.inputOther,
    output: usage.output,
    cacheRead: usage.inputCacheRead,
    cacheCreation: usage.inputCacheCreation,
  };
}

function translateUsageStatus(usage: KimiUsageStatus): AgentUsage {
  return {
    ...(usage.byModel === undefined
      ? {}
      : {
          byModel: Object.fromEntries(
            Object.entries(usage.byModel).map(([model, value]) => [
              model,
              translateUsage(value),
            ]),
          ),
        }),
    ...(usage.currentTurn === undefined
      ? {}
      : { currentTurn: translateUsage(usage.currentTurn) }),
    ...(usage.total === undefined ? {} : { total: translateUsage(usage.total) }),
  };
}

function isTokenUsage(value: KimiEvent['usage']): value is KimiTokenUsage {
  return value !== undefined && 'inputOther' in value;
}

function isUsageStatus(value: KimiEvent['usage']): value is KimiUsageStatus {
  return value !== undefined && !('inputOther' in value);
}

function toTraceValue(value: unknown, seen = new WeakSet<object>()): TraceValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 20_000 ? `${value.slice(0, 20_000)}...[truncated]` : value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => toTraceValue(item, seen));
  }
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 100)
        .map(([key, item]) => [key, toTraceValue(item, seen)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'symbol') return value.description ?? 'symbol';
  if (typeof value === 'function') return `[function ${value.name || 'anonymous'}]`;
  return null;
}

function kimiJsonObject(value: unknown): JsonObject {
  const converted = toTraceValue(value);
  return isTraceRecord(converted) ? converted : { value: converted };
}

function isTraceRecord(
  value: TraceValue,
): value is { readonly [key: string]: TraceValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function traceValueText(value: TraceValue | undefined): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

class AsyncEventQueue implements AsyncIterable<AgentEvent> {
  private readonly values: AgentEvent[] = [];
  private readonly waiters: Array<(result: IteratorResult<AgentEvent>) => void> = [];
  private ended = false;

  push(event: AgentEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) {
      this.values.push(event);
    } else {
      waiter({ done: false, value: event });
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return {
      next: async (): Promise<IteratorResult<AgentEvent>> => {
        const value = this.values.shift();
        if (value !== undefined) {
          return { done: false, value };
        }
        if (this.ended) {
          return { done: true, value: undefined };
        }
        return new Promise((resolveNext) => {
          this.waiters.push(resolveNext);
        });
      },
    };
  }
}
