export type AgentMode = 'default' | 'plan' | 'build';

export type JsonObject = Readonly<Record<string, unknown>>;

export interface TurnInput {
  readonly text: string;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheCreation: number;
}
