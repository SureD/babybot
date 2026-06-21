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

export class AgentRuntimeError extends Error implements AgentError {
  readonly code: AgentErrorCode;
  readonly details?: JsonObject;

  constructor(
    code: AgentErrorCode,
    message: string,
    options: { readonly details?: JsonObject; readonly cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'AgentRuntimeError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

export function isAgentError(error: unknown): error is AgentError {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string';
}
