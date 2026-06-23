import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentSessionEvent, SessionStats } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentExecutableTool, AgentToolRuntime } from '@babybot/core';

import {
  PiAgentBackend,
  type PiRuntimeFactory,
  type PiRuntimeInput,
  type PiSessionLike,
} from '../src';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('PiAgentBackend', () => {
  it('runs a persistent Pi session with project tools and translates events', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-pi-'));
    temporaryDirectories.push(directory);
    const session = new FakePiSession('pi-session-1');
    const factory = new FakePiRuntimeFactory(session);
    const toolRuntime: AgentToolRuntime = {
      async resolve() {
        return [
          { name: 'read', source: 'builtin', enabled: true },
          { name: 'write', source: 'builtin', enabled: true },
          testNativeTool(),
          { name: 'disabled', source: 'native', enabled: false },
        ];
      },
    };
    const backend = new PiAgentBackend({
      agentDir: directory,
      toolRuntime,
      runtimeFactory: factory,
      fetchImpl: openRouterFetch,
    });

    await backend.configure({
      provider: 'openrouter',
      apiKey: 'test-key',
      model: 'vendor/coder',
    });
    const runtime = await backend.createSession({
      projectId: 'project-1',
      projectName: 'Test project',
      workDir: '/tmp/project-1',
    });
    const turn = await runtime.prompt({ text: 'Build it' });
    const events = [];
    for await (const event of turn.events) {
      events.push(event);
    }
    await expect(turn.result).resolves.toEqual({
      output: 'done',
      finishReason: 'stop',
      usage: { input: 10, output: 2, cacheRead: 3, cacheCreation: 1 },
    });

    expect(factory.createInputs).toHaveLength(1);
    expect(factory.createInputs[0]).toMatchObject({
      projectId: 'project-1',
      projectName: 'Test project',
      workDir: '/tmp/project-1',
      provider: 'openrouter',
      model: 'vendor/coder',
      tools: ['read', 'write', 'test_native'],
    });
    expect(factory.createInputs[0]?.customTools.map((tool) => tool.name)).toEqual([
      'test_native',
    ]);
    expect(factory.createInputs[0]?.systemPrompt).toContain(
      'persistent general-purpose project agent',
    );
    expect(factory.createInputs[0]?.systemPrompt).toContain(
      'Project name: "Test project"',
    );
    expect(factory.createInputs[0]?.systemPrompt).toContain(
      'Available tools:\n- read\n- write\n- test_native',
    );
    expect(events.map(({ type }) => type)).toEqual([
      'turn.started',
      'step.started',
      'thinking.delta',
      'tool.started',
      'permission.decided',
      'tool.completed',
      'message.delta',
      'step.completed',
      'turn.completed',
    ]);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'tool.started',
      toolCallId: 'tool-1',
      name: 'read',
      arguments: { path: 'README.md' },
    }));
    await expect(runtime.contextSnapshot()).resolves.toMatchObject({
      usage: { input: 10, output: 2, cacheRead: 3, cacheCreation: 1 },
      contextTokens: 16,
      contextWindow: 128_000,
    });
  });

  it('resumes and cancels a Pi runtime through the stable backend contract', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-pi-'));
    temporaryDirectories.push(directory);
    const firstFactory = new FakePiRuntimeFactory(new FakePiSession('pi-session-1'));
    const backend = new PiAgentBackend({
      agentDir: directory,
      toolRuntime: emptyToolRuntime(),
      runtimeFactory: firstFactory,
      fetchImpl: openRouterFetch,
    });
    await backend.configure({
      provider: 'openrouter',
      apiKey: 'test-key',
      model: 'vendor/coder',
    });
    await backend.close();

    const resumedSession = new FakePiSession('pi-session-1');
    const resumedFactory = new FakePiRuntimeFactory(resumedSession);
    const restarted = new PiAgentBackend({
      agentDir: directory,
      toolRuntime: emptyToolRuntime(),
      runtimeFactory: resumedFactory,
      fetchImpl: openRouterFetch,
    });
    const runtime = await restarted.resumeSession({
      projectId: 'project-1',
      projectName: 'Test project',
      workDir: '/tmp/project-1',
      sessionId: 'pi-session-1',
    });
    const turn = await runtime.prompt({ text: 'Wait' });
    await runtime.cancel();
    await expect(turn.result).rejects.toMatchObject({ code: 'turn.cancelled' });

    expect(resumedFactory.resumeInputs[0]).toMatchObject({
      projectId: 'project-1',
      sessionId: 'pi-session-1',
    });
    expect(resumedSession.abortCalls).toBe(1);
  });

  it('creates a real Pi SDK session with Babybot native tools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'babybot-pi-'));
    temporaryDirectories.push(directory);
    const workDir = join(directory, 'project');
    await mkdir(workDir);
    const backend = new PiAgentBackend({
      agentDir: join(directory, 'pi'),
      toolRuntime: nativeToolRuntime(),
      fetchImpl: openRouterFetch,
    });
    await backend.configure({
      provider: 'openrouter',
      apiKey: 'test-key',
      model: 'vendor/coder',
    });

    const runtime = await backend.createSession({
      projectId: 'project-1',
      projectName: 'Test project',
      workDir,
    });

    expect(runtime.id).toBeTruthy();
    await expect(runtime.contextSnapshot()).resolves.toMatchObject({
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    });
    await backend.close();
  });
});

class FakePiRuntimeFactory implements PiRuntimeFactory {
  readonly createInputs: PiRuntimeInput[] = [];
  readonly resumeInputs: Array<PiRuntimeInput & { readonly sessionId: string }> = [];

  constructor(private readonly session: FakePiSession) {}

  async create(input: PiRuntimeInput): Promise<PiSessionLike> {
    this.createInputs.push(input);
    return this.session;
  }

  async resume(
    input: PiRuntimeInput & { readonly sessionId: string },
  ): Promise<PiSessionLike> {
    this.resumeInputs.push(input);
    return this.session;
  }

  refresh(): void {}
}

class FakePiSession implements PiSessionLike {
  readonly model = {
    provider: 'openrouter',
    id: 'vendor/coder',
    contextWindow: 128_000,
  };
  readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  abortCalls = 0;

  constructor(readonly sessionId: string) {}

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(_input: string): Promise<void> {
    this.emit({ type: 'agent_start' });
    this.emit({ type: 'turn_start' });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'checking' },
    });
    this.emit({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'README.md' },
    });
    this.emit({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'contents' }], details: {} },
      isError: false,
    });
    this.emit({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'done' },
    });
    this.emit({
      type: 'turn_end',
      message: {
        role: 'assistant',
        provider: 'openrouter',
        model: 'vendor/coder',
        usage: { input: 10, output: 2, cacheRead: 3, cacheWrite: 1 },
        stopReason: 'stop',
      },
      toolResults: [],
    });
    this.emit({ type: 'agent_end', messages: [], willRetry: false });
  }

  async steer(_input: string): Promise<void> {}

  async compact(): Promise<unknown> {
    return undefined;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  dispose(): void {}

  getSessionStats(): SessionStats {
    return {
      tokens: {
        input: 10,
        output: 2,
        cacheRead: 3,
        cacheWrite: 1,
        total: 16,
      },
      contextUsage: { tokens: 16, contextWindow: 128_000, percent: 0.0125 },
    } as SessionStats;
  }

  private emit(event: object): void {
    for (const listener of this.listeners) {
      listener(event as AgentSessionEvent);
    }
  }
}

const openRouterFetch = vi.fn(async (input: string | URL | Request) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.endsWith('/auth/key')) return Response.json({ data: { label: 'test' } });
  return Response.json({
    data: [{
      id: 'vendor/coder',
      name: 'Vendor Coder',
      context_length: 128_000,
      supported_parameters: ['tools', 'reasoning'],
      top_provider: { max_completion_tokens: 8_000 },
      pricing: { prompt: '0', completion: '0' },
    }],
  });
}) as unknown as typeof fetch;

function emptyToolRuntime(): AgentToolRuntime {
  return {
    async resolve() {
      return [];
    },
  };
}

function nativeToolRuntime(): AgentToolRuntime {
  return {
    async resolve() {
      return [testNativeTool()];
    },
  };
}

function testNativeTool(): AgentExecutableTool {
  return {
    name: 'test_native',
    label: 'Test native tool',
    source: 'native',
    enabled: true,
    description: 'Return a test value.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    async execute(input) {
      return { content: String(input['value']) };
    },
  };
}
