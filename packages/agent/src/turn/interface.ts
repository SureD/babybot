import type { BackendSession } from '../backend/interface';
import type { AgentMode, TurnInput, TokenUsage } from '../content';
import type { Context } from '../context/interface';
import type { AgentEvent } from '../observer/interface';
import type { Observer } from '../observer/interface';
import type { Permission } from '../permission/interface';
import type { Prompter } from '../prompter/interface';
import type { ToolFilter, Tools } from '../tools/interface';

/** One user request, from input until the agent stops. */
export type TurnStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface TurnResult {
  readonly output: string;
  readonly finishReason: string;
  readonly usage?: TokenUsage;
}

/**
 * A Turn is already running when Session.prompt resolves.
 * `result` rejects with AgentError when the Turn fails or is cancelled.
 */
export interface Turn {
  readonly id: string;
  readonly status: TurnStatus;
  readonly events: AsyncIterable<AgentEvent>;
  readonly result: Promise<TurnResult>;

  steer(input: TurnInput): Promise<void>;
  cancel(reason?: string): Promise<void>;
}

/** Frozen dependencies used by Session to create and immediately start a Turn. */
export interface TurnStartInput {
  readonly id: string;
  readonly sessionId: string;
  readonly mode: AgentMode;
  readonly input: TurnInput;
  readonly context: Context;
  readonly tools: Tools;
  readonly toolFilter?: ToolFilter;
  readonly observer: Observer;
  readonly prompter: Prompter;
  readonly permission: Permission;
  readonly backend: BackendSession;
  readonly onSettled?: () => void;
}

export type TurnFactory = (input: TurnStartInput) => Turn;
