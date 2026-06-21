import type { TurnInput, TokenUsage } from '../content';
import type { AgentEvent } from '../observer/interface';

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
