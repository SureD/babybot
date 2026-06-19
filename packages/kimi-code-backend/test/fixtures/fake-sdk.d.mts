export const state: {
  cancelCalls: number;
  resumeCalls: number;
  config: {
    defaultModel: string;
    providers: Record<string, Record<string, unknown>>;
    models: Record<string, Record<string, unknown>>;
  };
};

export function createKimiHarness(): unknown;
