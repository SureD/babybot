import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { KimiCodeAgentBackend } from '../src';
import { state } from './fixtures/fake-sdk.mjs';

beforeEach(() => {
  state.config = {
    defaultModel: 'fake-model',
    providers: {
      fake: {
        type: 'openai',
        baseUrl: 'https://api.deepseek.com',
        apiKey: 'fake-key',
      },
    },
    models: {
      'fake-model': {
        provider: 'fake',
        model: 'fake-model',
        maxContextSize: 32000,
      },
    },
  };
});

describe('KimiCodeAgentBackend', () => {
  it('creates a session and translates its event stream and token usage', async () => {
    const backend = new KimiCodeAgentBackend({
      sdkPath: fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url)),
      permission: 'auto',
      turnTimeoutMs: 1_000,
    });

    try {
      expect(await backend.isAvailable()).toBe(true);
      expect(backend.capabilities).toEqual({
        streaming: true,
        sessionResume: true,
        cancellation: true,
        tokenUsage: true,
        tracing: true,
      });

      const session = await backend.createSession({
        projectId: 'project-1',
        workDir: '/tmp/project-1',
      });
      const events = [];
      for await (const event of session.run({ prompt: 'Do work' })) {
        events.push(event);
      }

      expect(session.id).toBe('fake-session');
      expect(events).toEqual([
        { type: 'run.started', turnId: 4, origin: { kind: 'user' } },
        { type: 'step.started', turnId: 4, step: 1, stepId: 'step-1' },
        {
          type: 'tool.started',
          turnId: 4,
          toolCallId: 'tool-1',
          name: 'Read',
          arguments: { path: 'README.md' },
        },
        {
          type: 'tool.completed',
          turnId: 4,
          toolCallId: 'tool-1',
          name: 'Read',
          output: 'contents',
          isError: false,
        },
        { type: 'message.delta', turnId: 4, text: 'fake output' },
        {
          type: 'step.completed',
          turnId: 4,
          step: 1,
          stepId: 'step-1',
          usage: {
            input: 7,
            output: 3,
            cacheRead: 5,
            cacheCreation: 1,
          },
          firstTokenLatencyMs: 120,
          streamDurationMs: 450,
        },
        { type: 'run.completed', turnId: 4, reason: 'completed' },
      ]);
      await expect(session.getUsage()).resolves.toEqual({
        byModel: {
          'fake-model': {
            input: 7,
            output: 3,
            cacheRead: 5,
            cacheCreation: 1,
          },
        },
        currentTurn: {
          input: 7,
          output: 3,
          cacheRead: 5,
          cacheCreation: 1,
        },
        total: {
          input: 7,
          output: 3,
          cacheRead: 5,
          cacheCreation: 1,
        },
        model: 'fake-model',
        contextTokens: 1200,
        maxContextTokens: 32000,
        contextUsage: 0.0375,
      });
    } finally {
      await backend.close();
    }
  });

  it('resumes and cancels a kimi-code session through the stable session contract', async () => {
    state.cancelCalls = 0;
    state.resumeCalls = 0;
    const backend = new KimiCodeAgentBackend({
      sdkPath: fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url)),
      permission: 'auto',
    });

    try {
      const session = await backend.resumeSession({
        projectId: 'project-1',
        workDir: '/tmp/project-1',
        sessionId: 'fake-session',
      });
      await session.cancel();

      expect(session.id).toBe('fake-session');
      expect(state.resumeCalls).toBe(1);
      expect(state.cancelCalls).toBe(1);
    } finally {
      await backend.close();
    }
  });

  it('discovers and configures a DeepSeek model through kimi-code config', async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        data: [
          { id: 'deepseek-chat' },
          { id: 'deepseek-reasoner' },
        ],
      }),
    ) as unknown as typeof fetch;
    const backend = new KimiCodeAgentBackend({
      sdkPath: fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url)),
      permission: 'auto',
      fetchImpl,
    });

    try {
      await expect(
        backend.discoverModels({
          provider: 'deepseek',
          apiKey: 'sk-deepseek',
        }),
      ).resolves.toEqual([
        {
          id: 'deepseek-reasoner',
          name: 'deepseek-reasoner',
          contextTokens: 128_000,
          maxOutputTokens: 64_000,
          supportsThinking: true,
          isFree: false,
          recommended: true,
        },
        {
          id: 'deepseek-chat',
          name: 'deepseek-chat',
          contextTokens: 128_000,
          maxOutputTokens: 8_000,
          supportsThinking: false,
          isFree: false,
        },
      ]);

      await expect(
        backend.configure({
          provider: 'deepseek',
          apiKey: 'sk-deepseek',
          model: 'deepseek-chat',
        }),
      ).resolves.toEqual({
        backendAvailable: true,
        configured: true,
        provider: 'deepseek',
        model: 'deepseek-chat',
        hasApiKey: true,
        modelLockedByEnvironment: false,
      });
      expect(state.config).toMatchObject({
        defaultModel: 'babybot-deepseek/deepseek-chat',
        providers: {
          'babybot-deepseek': {
            type: 'openai',
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'sk-deepseek',
          },
        },
        models: {
          'babybot-deepseek/deepseek-chat': {
            provider: 'babybot-deepseek',
            model: 'deepseek-chat',
            maxContextSize: 128_000,
            maxOutputSize: 8_000,
            capabilities: ['tool_use'],
          },
        },
      });
    } finally {
      await backend.close();
    }
  });

  it('validates an OpenRouter key and returns only tool-capable models', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/auth/key')) {
        return Response.json({ data: { label: 'test' } });
      }
      return Response.json({
        data: [
          {
            id: 'vendor/tool-model',
            name: 'Tool Model',
            context_length: 128_000,
            supported_parameters: ['tools', 'reasoning'],
            pricing: { prompt: '0.001', completion: '0.002' },
            top_provider: { max_completion_tokens: 16_000 },
          },
          {
            id: 'vendor/chat-only',
            name: 'Chat Only',
            context_length: 32_000,
            supported_parameters: [],
          },
        ],
      });
    }) as unknown as typeof fetch;
    const backend = new KimiCodeAgentBackend({
      sdkPath: fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url)),
      permission: 'auto',
      fetchImpl,
    });

    try {
      await expect(
        backend.discoverModels({
          provider: 'openrouter',
          apiKey: 'sk-or-v1-test',
        }),
      ).resolves.toEqual([
        {
          id: 'vendor/tool-model',
          name: 'Tool Model',
          contextTokens: 128_000,
          maxOutputTokens: 16_000,
          supportsThinking: true,
          isFree: false,
          recommended: true,
        },
      ]);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      await backend.close();
    }
  });

  it('filters OpenRouter setup to free coding models and recommends coding first', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/auth/key')) {
        return Response.json({ data: { label: 'test' } });
      }
      return Response.json({
        data: [
          {
            id: 'reasoning/general:free',
            name: 'General Reasoning (free)',
            context_length: 1_000_000,
            supported_parameters: ['tools', 'reasoning'],
            pricing: { prompt: '0', completion: '0', request: '0' },
          },
          {
            id: 'qwen/coder:free',
            name: 'Qwen Coder (free)',
            context_length: 262_144,
            supported_parameters: ['tools'],
            pricing: { prompt: '0', completion: '0', request: '0' },
            top_provider: { max_completion_tokens: 262_144 },
          },
          {
            id: 'vendor/paid-coder',
            name: 'Paid Coder',
            context_length: 1_000_000,
            supported_parameters: ['tools', 'reasoning'],
            pricing: { prompt: '0.001', completion: '0.002' },
          },
        ],
      });
    }) as unknown as typeof fetch;
    const backend = new KimiCodeAgentBackend({
      sdkPath: fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url)),
      permission: 'auto',
      fetchImpl,
    });

    try {
      await expect(
        backend.discoverModels({
          provider: 'openrouter',
          apiKey: 'sk-or-v1-test',
          freeOnly: true,
        }),
      ).resolves.toEqual([
        {
          id: 'qwen/coder:free',
          name: 'Qwen Coder (free)',
          contextTokens: 262_144,
          maxOutputTokens: 16_000,
          supportsThinking: false,
          isFree: true,
          recommended: true,
        },
        {
          id: 'reasoning/general:free',
          name: 'General Reasoning (free)',
          contextTokens: 1_000_000,
          maxOutputTokens: 8_000,
          supportsThinking: true,
          isFree: true,
        },
      ]);

      await expect(
        backend.configure({
          provider: 'openrouter',
          apiKey: 'sk-or-v1-test',
          model: 'qwen/coder:free',
          freeOnly: true,
        }),
      ).resolves.toMatchObject({
        backendAvailable: true,
        configured: true,
        provider: 'openrouter',
        model: 'qwen/coder:free',
      });
      expect(state.config.models?.['babybot-openrouter/qwen/coder:free'])
        .toMatchObject({
          provider: 'babybot-openrouter',
          model: 'qwen/coder:free',
          maxContextSize: 262_144,
          maxOutputSize: 16_000,
          capabilities: ['tool_use'],
        });
    } finally {
      await backend.close();
    }
  });

  it('reuses the saved provider key when switching configured models', async () => {
    state.config = {
      defaultModel: 'babybot-openrouter/vendor/old-model',
      providers: {
        'babybot-openrouter': {
          type: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'saved-openrouter-key',
        },
      },
      models: {
        'babybot-openrouter/vendor/old-model': {
          provider: 'babybot-openrouter',
          model: 'vendor/old-model',
          maxContextSize: 32_000,
        },
      },
    };
    const fetchSpy = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit,
    ) => {
      return Response.json({
        data: [{
          id: 'vendor/new-model',
          name: 'New Model',
          context_length: 64_000,
          supported_parameters: ['tools'],
          pricing: { prompt: '0.001', completion: '0.002' },
        }],
      });
    });
    const fetchImpl = fetchSpy as unknown as typeof fetch;
    const backend = new KimiCodeAgentBackend({
      sdkPath: fileURLToPath(new URL('./fixtures/fake-sdk.mjs', import.meta.url)),
      permission: 'auto',
      fetchImpl,
    });

    try {
      await expect(backend.configure({
        provider: 'openrouter',
        model: 'vendor/new-model',
      })).resolves.toMatchObject({
        provider: 'openrouter',
        model: 'vendor/new-model',
      });
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      for (const call of fetchSpy.mock.calls) {
        expect(call[1]).toMatchObject({
          headers: expect.objectContaining({
            Authorization: 'Bearer saved-openrouter-key',
          }),
        });
      }
    } finally {
      await backend.close();
    }
  });
});
