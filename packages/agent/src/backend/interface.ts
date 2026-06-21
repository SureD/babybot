import type { TokenUsage, TurnInput } from '../content';
import type { ContextStore, PreparedContext } from '../context/interface';
import type { PermissionDecision, PermissionRequest } from '../permission/interface';
import type { ToolCall, ToolResult, ToolSnapshot } from '../tools/interface';

export interface BackendOpenConfig {
  readonly sessionId?: string;
  readonly workDir: string;
}

export type BackendEvent =
  | { readonly type: 'step.started'; readonly step: number }
  | {
      readonly type: 'step.completed';
      readonly step: number;
      readonly usage?: TokenUsage;
    }
  | { readonly type: 'message.delta' | 'thinking.delta'; readonly text: string }
  | { readonly type: 'tool.started'; readonly call: ToolCall }
  | {
      readonly type: 'tool.progress';
      readonly toolCallId: string;
      readonly text: string;
    }
  | {
      readonly type: 'tool.completed';
      readonly toolCallId: string;
      readonly result: ToolResult;
    }
  | {
      readonly type: 'completed';
      readonly output: string;
      readonly finishReason: string;
      readonly usage?: TokenUsage;
    }
  | { readonly type: 'failed'; readonly error: string }
  | { readonly type: 'warning'; readonly message: string };

export interface BackendHooks {
  authorize(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionDecision>;
  invoke(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

export interface BackendRunInput {
  readonly turnId: string;
  readonly context: PreparedContext;
  readonly tools: ToolSnapshot;
  readonly hooks: BackendHooks;
}

export interface BackendSession {
  readonly id: string;
  run(input: BackendRunInput): AsyncIterable<BackendEvent>;
  steer(input: TurnInput): Promise<void>;
  abort(): Promise<void>;
  contextStore(): ContextStore;
  close(): Promise<void>;
}

export interface Backend {
  open(config: BackendOpenConfig): Promise<BackendSession>;
}
