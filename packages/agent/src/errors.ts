import type { JsonObject } from './content';

export type AgentErrorCode =
  | 'backend.failed'
  | 'context.failed'
  | 'observer.record_failed'
  | 'permission.denied'
  | 'permission.failed'
  | 'session.busy'
  | 'session.closed'
  | 'tool.invalid_input'
  | 'tool.not_found'
  | 'tool.registration_conflict'
  | 'turn.cancelled'
  | 'turn.invalid_state';

export interface AgentError extends Error {
  readonly code: AgentErrorCode;
  readonly details?: JsonObject;
}
