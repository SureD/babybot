import type { AgentMode } from '../content';
import type { ToolCall, ToolDefinition } from '../tools/interface';

export interface PermissionRequest {
  readonly mode: AgentMode;
  readonly tool: ToolDefinition;
  readonly call: ToolCall;
}

export type PermissionPolicyResult =
  | { readonly decision: 'allow' | 'deny'; readonly reason: string }
  | { readonly decision: 'ask'; readonly reason: string; readonly prompt: string };

/** Returning undefined means this policy does not match. */
export interface PermissionPolicy {
  readonly name: string;
  readonly lifetime: 'static' | 'dynamic';
  evaluate(
    request: PermissionRequest,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}

export interface ApprovalProvider {
  request(
    prompt: string,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<boolean>;
}

export interface PermissionDecision {
  readonly decision: 'allow' | 'deny';
  readonly policy: string;
  readonly reason: string;
  readonly asked: boolean;
}

export interface Permission {
  /** Policies run in order; the first non-undefined result wins. */
  evaluate(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionDecision>;
  addPolicy(policy: PermissionPolicy): void;
  removePolicy(name: string): boolean;
}
