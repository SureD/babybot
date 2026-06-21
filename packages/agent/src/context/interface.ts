import type { JsonObject, TokenUsage, TurnInput } from '../content';
import type { PromptInjection } from '../prompter/interface';

interface ContextEntryBase {
  readonly source: string;
}

export type ContextEntry =
  | (ContextEntryBase & {
      readonly type: 'message';
      readonly role: 'system' | 'user' | 'assistant';
      readonly text: string;
    })
  | (ContextEntryBase & {
      readonly type: 'tool-call';
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    })
  | (ContextEntryBase & {
      readonly type: 'tool-result';
      readonly toolCallId: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
    });

export interface ContextSnapshot {
  readonly revision: number;
  readonly entries: readonly ContextEntry[];
  readonly usage?: TokenUsage;
  readonly contextTokens?: number;
  readonly contextWindow?: number;
}

/** Read-only input assembled for one Turn without changing stored history. */
export interface PreparedContext {
  readonly revision: number;
  readonly input: TurnInput;
  readonly systemAppend: readonly string[];
}

/** Physical transcript and compaction operations supplied by the Backend. */
export interface ContextStore {
  snapshot(): Promise<ContextSnapshot>;
  compact(instruction?: string): Promise<void>;
  clear(): Promise<void>;
}

/** Logical model-visible context facade. It does not own a Turn queue. */
export interface Context {
  snapshot(): Promise<ContextSnapshot>;
  prepare(
    input: TurnInput,
    injections: readonly PromptInjection[],
  ): Promise<PreparedContext>;
  compact(instruction?: string): Promise<void>;
  clear(): Promise<void>;
}
