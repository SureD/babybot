import type { JsonObject } from '../content';

export type ToolSource = 'builtin' | 'native' | 'generated' | 'mcp';
export type ToolLifetime = 'static' | 'dynamic';

interface ToolBase {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: JsonObject;
  readonly source: ToolSource;
  readonly version: string;
  readonly lifetime: ToolLifetime;
  readonly readOnly: boolean;
}

export type ToolDefinition = ToolBase & {
  readonly execution: 'backend' | 'hosted';
  readonly enabled: boolean;
};

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: JsonObject;
}

export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly turnId: string;
  readonly signal: AbortSignal;
}

export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly details?: unknown;
}

export type ToolHandler = (
  arguments_: JsonObject,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

export type ToolRegistration =
  | (ToolBase & {
      readonly execution: 'backend';
      readonly enabled?: boolean;
    })
  | (ToolBase & {
      readonly execution: 'hosted';
      readonly enabled?: boolean;
      readonly execute: ToolHandler;
    });

export interface ToolSnapshot {
  readonly revision: number;
  readonly tools: readonly ToolDefinition[];
}

export type ToolFilter = (tool: ToolDefinition) => boolean;

export interface Tools {
  register(tool: ToolRegistration): void;
  replace(tool: ToolRegistration): void;
  unregister(name: string): boolean;
  enable(name: string): void;
  disable(name: string): void;
  get(name: string): ToolDefinition | undefined;
  list(): readonly ToolDefinition[];
  snapshot(filter?: ToolFilter): ToolSnapshot;
  invoke(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolResult>;
}
