import { z } from 'zod';

export const executionPreferenceSchema = z.enum(['auto', 'capability', 'coding']);
export type ExecutionPreference = z.infer<typeof executionPreferenceSchema>;

export const executionRouteSchema = z.enum(['capability', 'coding']);
export type ExecutionRoute = z.infer<typeof executionRouteSchema>;

export const taskStatusSchema = z.enum(['pending', 'running', 'completed', 'failed']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const modelProviderSchema = z.enum(['deepseek', 'openrouter']);
export type ModelProvider = z.infer<typeof modelProviderSchema>;

export interface SetupStatus {
  readonly backendAvailable: boolean;
  readonly configured: boolean;
  readonly provider?: ModelProvider;
  readonly model?: string;
  readonly hasApiKey: boolean;
  readonly modelLockedByEnvironment: boolean;
}

export interface SetupModel {
  readonly id: string;
  readonly name: string;
  readonly contextTokens: number;
  readonly maxOutputTokens?: number;
  readonly supportsThinking: boolean;
  readonly isFree: boolean;
  readonly recommended?: boolean;
}

export interface SetupModelCatalog {
  readonly provider: ModelProvider;
  readonly models: readonly SetupModel[];
  readonly updatedAt?: string;
}

export const discoverModelsInputSchema = z.object({
  provider: modelProviderSchema,
  apiKey: z.string().trim().min(1).optional(),
  freeOnly: z.boolean().optional(),
});
export type DiscoverModelsInput = z.infer<typeof discoverModelsInputSchema>;

export const configureModelInputSchema = z.object({
  provider: modelProviderSchema,
  apiKey: z.string().trim().min(1).optional(),
  freeOnly: z.boolean().optional(),
  model: z.string().trim().min(1),
});
export type ConfigureModelInput = z.infer<typeof configureModelInputSchema>;

export const directChatTestInputSchema = z.object({
  provider: modelProviderSchema,
  apiKey: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1),
});
export type DirectChatTestInput = z.infer<typeof directChatTestInputSchema>;

export interface DirectChatTestResult {
  readonly ok: boolean;
  readonly provider: ModelProvider;
  readonly statusCode: number;
  readonly requestedModel: string;
  readonly responseModel?: string;
  readonly content?: string;
  readonly error?: string;
  readonly requestId?: string;
  readonly latencyMs: number;
}

export const projectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof projectSchema>;

export const tokenUsageSchema = z.object({
  input: z.number().int().nonnegative(),
  output: z.number().int().nonnegative(),
  cacheRead: z.number().int().nonnegative(),
  cacheCreation: z.number().int().nonnegative(),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export interface AgentUsage {
  readonly byModel?: Readonly<Record<string, TokenUsage>>;
  readonly currentTurn?: TokenUsage;
  readonly total?: TokenUsage;
  readonly model?: string;
  readonly contextTokens?: number;
  readonly maxContextTokens?: number;
  readonly contextUsage?: number;
}

export type TraceValue =
  | string
  | number
  | boolean
  | null
  | readonly TraceValue[]
  | { readonly [key: string]: TraceValue };

export type AgentTurnId = string | number;

type AgentEventPayload =
  | {
      readonly type: 'run.started';
      readonly turnId: AgentTurnId;
      readonly origin?: TraceValue;
    }
  | {
      readonly type: 'agent.status';
      readonly model?: string;
      readonly contextTokens?: number;
      readonly maxContextTokens?: number;
      readonly contextUsage?: number;
      readonly usage?: AgentUsage;
    }
  | {
      readonly type: 'step.started';
      readonly turnId: AgentTurnId;
      readonly step: number;
      readonly stepId?: string;
    }
  | {
      readonly type: 'step.completed';
      readonly turnId: AgentTurnId;
      readonly step: number;
      readonly stepId?: string;
      readonly usage?: TokenUsage;
      readonly finishReason?: string;
      readonly firstTokenLatencyMs?: number;
      readonly streamDurationMs?: number;
    }
  | {
      readonly type: 'step.retrying';
      readonly turnId: AgentTurnId;
      readonly step: number;
      readonly stepId?: string;
      readonly attempt: number;
      readonly nextAttempt: number;
      readonly maxAttempts: number;
      readonly delayMs: number;
      readonly error: string;
      readonly statusCode?: number;
    }
  | {
      readonly type: 'message.delta' | 'thinking.delta';
      readonly turnId: AgentTurnId;
      readonly text: string;
    }
  | {
      readonly type: 'tool.started';
      readonly turnId: AgentTurnId;
      readonly toolCallId: string;
      readonly name: string;
      readonly arguments?: TraceValue;
      readonly description?: string;
    }
  | {
      readonly type: 'tool.progress';
      readonly turnId: AgentTurnId;
      readonly toolCallId: string;
      readonly kind: string;
      readonly text?: string;
      readonly percent?: number;
    }
  | {
      readonly type: 'tool.completed';
      readonly turnId: AgentTurnId;
      readonly toolCallId: string;
      readonly name: string;
      readonly output?: TraceValue;
      readonly isError: boolean;
    }
  | {
      readonly type: 'subagent.started' | 'subagent.completed' | 'subagent.failed';
      readonly subagentId: string;
      readonly name?: string;
      readonly summary?: string;
      readonly error?: string;
      readonly usage?: TokenUsage;
    }
  | {
      readonly type: 'compaction.started' | 'compaction.completed';
      readonly trigger?: string;
      readonly compactedCount?: number;
      readonly tokensBefore?: number;
      readonly tokensAfter?: number;
    }
  | { readonly type: 'warning'; readonly code?: string; readonly message: string }
  | {
      readonly type: 'run.completed';
      readonly turnId: AgentTurnId;
      readonly reason: string;
    }
  | {
      readonly type: 'run.failed';
      readonly turnId?: AgentTurnId;
      readonly code?: string;
      readonly error: string;
    }
  | {
      readonly type: 'runtime.event';
      readonly name: string;
      readonly data?: TraceValue;
    };

export type AgentEvent = AgentEventPayload & {
  readonly agentId?: string;
};

export interface AgentTraceEvent {
  readonly taskId: string;
  readonly sessionId: string;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: AgentEvent;
}

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  input: z.string(),
  preference: executionPreferenceSchema,
  route: executionRouteSchema.optional(),
  status: taskStatusSchema,
  result: z.string().optional(),
  error: z.string().optional(),
  tokenUsage: tokenUsageSchema.optional(),
  usage: z.custom<AgentUsage>().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

export type ProjectStreamEvent =
  | {
      readonly type: 'task.updated';
      readonly task: Task;
    }
  | {
      readonly type: 'trace.appended';
      readonly trace: AgentTraceEvent;
    };

export const createProjectInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
});
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const createTaskInputSchema = z.object({
  input: z.string().trim().min(1).max(100_000),
  preference: executionPreferenceSchema.default('auto'),
});
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export interface HealthResponse {
  readonly status: 'ok';
  readonly agentBackend: {
    readonly name: string;
    readonly available: boolean;
    readonly capabilities: {
      readonly streaming: boolean;
      readonly sessionResume: boolean;
      readonly cancellation: boolean;
      readonly tokenUsage: boolean;
      readonly tracing: boolean;
    };
  };
}

export interface ApiError {
  readonly error: string;
}
