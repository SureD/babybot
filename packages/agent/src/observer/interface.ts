import type { AgentMode, JsonObject, TokenUsage } from '../content';

export type AgentRecord =
  | {
      readonly type: 'turn.started';
      readonly turnId: string;
      readonly mode: AgentMode;
      readonly contextRevision: number;
      readonly toolRevision: number;
    }
  | {
      readonly type: 'turn.completed';
      readonly turnId: string;
      readonly finishReason: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly type: 'turn.failed';
      readonly turnId: string;
      readonly error: string;
    }
  | {
      readonly type: 'turn.cancelled';
      readonly turnId: string;
      readonly reason?: string;
    }
  | {
      readonly type: 'step.started';
      readonly turnId: string;
      readonly step: number;
    }
  | {
      readonly type: 'step.completed';
      readonly turnId: string;
      readonly step: number;
      readonly usage?: TokenUsage;
    }
  | {
      readonly type: 'tool.started';
      readonly turnId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments: JsonObject;
    }
  | {
      readonly type: 'tool.completed';
      readonly turnId: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly output: string;
      readonly isError: boolean;
    }
  | {
      readonly type: 'permission.decided';
      readonly turnId: string;
      readonly toolCallId: string;
      readonly decision: 'allow' | 'deny';
      readonly policy: string;
      readonly reason: string;
      readonly asked: boolean;
    }
  | { readonly type: 'context.compacted'; readonly revision: number }
  | { readonly type: 'warning'; readonly turnId?: string; readonly message: string };

export type AgentEmission =
  | {
      readonly type: 'message.delta' | 'thinking.delta';
      readonly turnId: string;
      readonly text: string;
    }
  | {
      readonly type: 'tool.progress';
      readonly turnId: string;
      readonly toolCallId: string;
      readonly text: string;
    };

export type RecordedAgentEvent = AgentRecord & {
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
};

export type EmittedAgentEvent = AgentEmission & {
  readonly sessionId: string;
  readonly timestamp: string;
};

export type AgentEvent = RecordedAgentEvent | EmittedAgentEvent;
export type AgentEventListener = (event: AgentEvent) => void | Promise<void>;

export interface AgentEventRecorder {
  append(event: RecordedAgentEvent): Promise<void>;
}

export interface Observer {
  record(event: AgentRecord): Promise<RecordedAgentEvent>;
  emit(event: AgentEmission): void;
  subscribe(listener: AgentEventListener): () => void;
}
