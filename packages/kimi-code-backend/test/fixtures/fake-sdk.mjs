export const state = {
  cancelCalls: 0,
  resumeCalls: 0,
  config: {
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
  },
};

export function createKimiHarness() {
  const listeners = new Set();
  const session = {
    id: 'fake-session',
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setApprovalHandler() {},
    async prompt() {
      for (const listener of listeners) {
        listener({ type: 'turn.started', turnId: 4, origin: { kind: 'user' } });
        listener({ type: 'turn.step.started', turnId: 4, step: 1, stepId: 'step-1' });
        listener({
          type: 'tool.call.started',
          turnId: 4,
          toolCallId: 'tool-1',
          name: 'Read',
          args: { path: 'README.md' },
        });
        listener({
          type: 'tool.result',
          turnId: 4,
          toolCallId: 'tool-1',
          output: 'contents',
        });
        listener({ type: 'assistant.delta', turnId: 4, delta: 'fake output' });
        listener({
          type: 'turn.step.completed',
          turnId: 4,
          step: 1,
          stepId: 'step-1',
          usage: {
            inputOther: 7,
            output: 3,
            inputCacheRead: 5,
            inputCacheCreation: 1,
          },
          llmFirstTokenLatencyMs: 120,
          llmStreamDurationMs: 450,
        });
        listener({ type: 'turn.ended', turnId: 4, reason: 'completed' });
      }
    },
    async cancel() {
      state.cancelCalls += 1;
    },
    async getUsage() {
      return {
        total: {
          inputOther: 7,
          output: 3,
          inputCacheRead: 5,
          inputCacheCreation: 1,
        },
      };
    },
    async getStatus() {
      return {
        model: 'fake-model',
        contextTokens: 1200,
        maxContextTokens: 32000,
        contextUsage: 0.0375,
        usage: {
          byModel: {
            'fake-model': {
              inputOther: 7,
              output: 3,
              inputCacheRead: 5,
              inputCacheCreation: 1,
            },
          },
          currentTurn: {
            inputOther: 7,
            output: 3,
            inputCacheRead: 5,
            inputCacheCreation: 1,
          },
          total: {
            inputOther: 7,
            output: 3,
            inputCacheRead: 5,
            inputCacheCreation: 1,
          },
        },
      };
    },
  };

  return {
    async getConfig() {
      return structuredClone(state.config);
    },
    async setConfig(patch) {
      state.config = {
        ...state.config,
        ...patch,
        providers: {
          ...state.config.providers,
          ...patch.providers,
        },
        models: {
          ...state.config.models,
          ...patch.models,
        },
      };
      return structuredClone(state.config);
    },
    async createSession() {
      return session;
    },
    async resumeSession() {
      state.resumeCalls += 1;
      return session;
    },
    async close() {},
  };
}
