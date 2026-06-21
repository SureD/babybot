import { describe, expect, it, vi } from 'vitest';

import {
  createAgentSession,
  type TokenUsage,
  type ToolRegistration,
} from '../src';
import type {
  Backend,
  BackendEvent,
  BackendRunInput,
  BackendSession,
} from '../src/backend';
import type { ContextSnapshot, ContextStore } from '../src/context';

const usage: TokenUsage = {
  input: 10,
  output: 4,
  cacheRead: 2,
  cacheCreation: 1,
};

const hostedTool: ToolRegistration = {
  name: 'lookup',
  description: 'Look up a value',
  inputSchema: {
    type: 'object',
    properties: { key: { type: 'string' } },
    required: ['key'],
    additionalProperties: false,
  },
  source: 'native',
  version: '1',
  lifetime: 'static',
  readOnly: true,
  execution: 'hosted',
  execute: vi.fn(async ({ key }) => ({
    content: `value:${String(key)}`,
    isError: false,
  })),
};

describe('AgentSession integration', () => {
  it('runs a Turn through permission, hosted tools, events, and usage', async () => {
    const backend = new FakeBackend(async function* (input) {
      const call = { id: 'call-1', name: 'lookup', arguments: { key: 'answer' } };
      yield { type: 'step.started', step: 1 };
      yield { type: 'message.delta', text: 'working' };
      yield { type: 'tool.started', call };
      const decision = await input.hooks.authorize(callRequest(input, call), abortSignal());
      expect(decision.decision).toBe('allow');
      const result = await input.hooks.invoke(call, abortSignal());
      await expect(input.hooks.invoke(call, abortSignal()))
        .rejects.toMatchObject({ code: 'permission.denied' });
      yield { type: 'tool.completed', toolCallId: call.id, result };
      yield { type: 'step.completed', step: 1, usage };
      yield { type: 'completed', output: result.content, finishReason: 'stop' };
    });
    const session = await createAgentSession({
      backend,
      workDir: '/project',
      tools: [hostedTool],
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    });
    const observed: Array<{ readonly type: string }> = [];
    session.subscribe((event) => {
      observed.push(event);
    });

    const turn = await session.prompt({ text: 'look up answer' });
    const turnEventsPromise = collectEventTypes(turn.events);

    await expect(turn.result).resolves.toEqual({
      output: 'value:answer',
      finishReason: 'stop',
      usage,
    });
    expect(turn.status).toBe('completed');
    const expectedEvents = [
      'turn.started',
      'step.started',
      'message.delta',
      'tool.started',
      'permission.decided',
      'tool.completed',
      'step.completed',
      'turn.completed',
    ];
    expect(await turnEventsPromise).toEqual(expectedEvents);
    expect(observed.map(({ type }) => type)).toEqual(expectedEvents);
    const permissionEvent = observed.find(
      (event) => event.type === 'permission.decided',
    );
    expect(permissionEvent).toMatchObject({
      decision: 'allow',
      policy: 'fallback.allow',
      asked: false,
    });
    await session.close();
    expect(backend.session.closed).toBe(true);
  });

  it('freezes mode and tools per Turn and rejects concurrent changes', async () => {
    const gate = deferred<void>();
    const backend = new FakeBackend(async function* (input) {
      expect(input.tools.tools.map(({ name }) => name)).toEqual(['lookup']);
      await gate.promise;
      yield { type: 'completed', output: 'done', finishReason: 'stop' };
    });
    const session = await createAgentSession({
      backend,
      workDir: '/project',
      mode: 'plan',
      tools: [hostedTool, mutatingBackendTool()],
    });
    const turn = await session.prompt({ text: 'plan' });

    await expect(session.prompt({ text: 'second' }))
      .rejects.toMatchObject({ code: 'session.busy' });
    await expect(session.setMode('build'))
      .rejects.toMatchObject({ code: 'session.busy' });
    expect(() => session.unregisterTool('lookup'))
      .toThrowError(expect.objectContaining({ code: 'session.busy' }));

    gate.resolve();
    await turn.result;
    await session.setMode('build');
    expect(session.mode).toBe('build');
    await session.close();
  });

  it('cancels an active Turn and releases the backend on close', async () => {
    const gate = deferred<void>();
    const backend = new FakeBackend(async function* () {
      await gate.promise;
      yield { type: 'failed', error: 'aborted' };
    }, () => gate.resolve());
    const session = await createAgentSession({ backend, workDir: '/project' });
    const turn = await session.prompt({ text: 'wait' });

    await session.cancel('user stopped');
    await expect(turn.result).rejects.toMatchObject({
      code: 'turn.cancelled',
      message: 'user stopped',
    });
    expect(turn.status).toBe('cancelled');
    await session.close();
    expect(backend.session.closed).toBe(true);
  });

  it('keeps compaction exclusive with Turn creation', async () => {
    const compactGate = deferred<void>();
    const backend = new FakeBackend(async function* () {
      yield { type: 'completed', output: 'done', finishReason: 'stop' };
    }, () => undefined, compactGate.promise);
    const session = await createAgentSession({ backend, workDir: '/project' });

    const compaction = session.compact('keep decisions');
    await expect(session.prompt({ text: 'race compaction' }))
      .rejects.toMatchObject({ code: 'session.busy' });
    compactGate.resolve();
    await compaction;
    await expect(session.contextSnapshot()).resolves.toMatchObject({ revision: 2 });
    await session.close();
  });

  it('binds hosted execution to the exact arguments that were authorized', async () => {
    const backend = new FakeBackend(async function* (input) {
      const authorized = {
        id: 'call-1',
        name: 'lookup',
        arguments: { key: 'safe' },
      };
      await input.hooks.authorize(
        callRequest(input, authorized),
        abortSignal(),
      );
      await expect(input.hooks.invoke({
        ...authorized,
        arguments: { key: 'changed' },
      }, abortSignal())).rejects.toMatchObject({ code: 'permission.denied' });
      yield { type: 'completed', output: 'protected', finishReason: 'stop' };
    });
    const session = await createAgentSession({
      backend,
      workDir: '/project',
      tools: [hostedTool],
    });

    const turn = await session.prompt({ text: 'lookup' });
    await expect(turn.result).resolves.toMatchObject({ output: 'protected' });
    await session.close();
  });
});

class FakeBackend implements Backend {
  readonly session: FakeBackendSession;

  constructor(
    run: (input: BackendRunInput) => AsyncIterable<BackendEvent>,
    abort: () => void = () => undefined,
    compactWait?: Promise<void>,
  ) {
    this.session = new FakeBackendSession(run, abort, compactWait);
  }

  async open(): Promise<BackendSession> {
    return this.session;
  }
}

class FakeBackendSession implements BackendSession {
  readonly id = 'session-1';
  closed = false;
  private revision = 1;

  constructor(
    private readonly runImplementation: (
      input: BackendRunInput,
    ) => AsyncIterable<BackendEvent>,
    private readonly abortImplementation: () => void,
    private readonly compactWait?: Promise<void>,
  ) {}

  run(input: BackendRunInput): AsyncIterable<BackendEvent> {
    return this.runImplementation(input);
  }

  async steer(): Promise<void> {}

  async abort(): Promise<void> {
    this.abortImplementation();
  }

  contextStore(): ContextStore {
    return {
      snapshot: async (): Promise<ContextSnapshot> => ({
        revision: this.revision,
        entries: [],
      }),
      compact: async () => {
        await this.compactWait;
        this.revision += 1;
      },
      clear: async () => {
        this.revision += 1;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function callRequest(input: BackendRunInput, call: {
  readonly id: string;
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}) {
  const tool = input.tools.tools.find(({ name }) => name === call.name);
  if (tool === undefined) throw new Error('Tool missing from snapshot.');
  return { mode: 'build' as const, tool, call };
}

function mutatingBackendTool(): ToolRegistration {
  return {
    name: 'write',
    description: 'Write a file',
    inputSchema: { type: 'object' },
    source: 'builtin',
    version: '1',
    lifetime: 'static',
    readOnly: false,
    execution: 'backend',
  };
}

function abortSignal(): AbortSignal {
  return new AbortController().signal;
}

async function collectEventTypes(events: AsyncIterable<{ readonly type: string }>) {
  const types: string[] = [];
  for await (const event of events) types.push(event.type);
  return types;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
