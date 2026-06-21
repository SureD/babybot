import { AgentRuntimeError } from '../errors';
import type {
  ApprovalProvider,
  Permission,
  PermissionDecision,
  PermissionPolicy,
  PermissionPolicyResult,
  PermissionRequest,
} from './interface';

export interface AgentPermissionOptions {
  readonly policies?: readonly PermissionPolicy[];
  readonly approvalProvider?: ApprovalProvider;
}

const PLAN_POLICY: PermissionPolicy = {
  name: 'mode.plan.read-only',
  lifetime: 'static',
  evaluate(request) {
    if (request.mode !== 'plan' || request.tool.readOnly) return undefined;
    return {
      decision: 'deny',
      reason: `Plan mode does not allow the mutating tool ${request.tool.name}.`,
    };
  },
};

export class AgentPermission implements Permission {
  private readonly policies: PermissionPolicy[];

  constructor(private readonly options: AgentPermissionOptions = {}) {
    this.policies = [PLAN_POLICY];
    for (const policy of options.policies ?? []) this.addPolicy(policy);
  }

  async evaluate(
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    signal.throwIfAborted();
    for (const policy of this.policies) {
      let result: PermissionPolicyResult | undefined;
      try {
        result = await policy.evaluate(request);
      } catch (cause) {
        throw new AgentRuntimeError(
          'permission.failed',
          `Permission policy ${policy.name} failed.`,
          { cause, details: { policy: policy.name, tool: request.tool.name } },
        );
      }
      if (result === undefined) continue;
      return this.resolve(policy.name, result, request, signal);
    }
    return {
      decision: 'allow',
      policy: 'fallback.allow',
      reason: 'Enabled tools are allowed by the default policy.',
      asked: false,
    };
  }

  addPolicy(policy: PermissionPolicy): void {
    if (policy.name.trim() === '') {
      throw new TypeError('Permission policy name cannot be empty.');
    }
    if (this.policies.some(({ name }) => name === policy.name)) {
      throw new AgentRuntimeError(
        'permission.failed',
        `Permission policy ${policy.name} is already registered.`,
        { details: { policy: policy.name } },
      );
    }
    this.policies.push(policy);
  }

  removePolicy(name: string): boolean {
    const index = this.policies.findIndex((policy) => policy.name === name);
    if (index < 0) return false;
    const policy = this.policies[index];
    if (policy?.lifetime === 'static') return false;
    this.policies.splice(index, 1);
    return true;
  }

  private async resolve(
    policy: string,
    result: PermissionPolicyResult,
    request: PermissionRequest,
    signal: AbortSignal,
  ): Promise<PermissionDecision> {
    if (result.decision !== 'ask') {
      return { ...result, policy, asked: false };
    }
    if (this.options.approvalProvider === undefined) {
      return {
        decision: 'deny',
        policy,
        reason: `${result.reason} Approval is unavailable.`,
        asked: true,
      };
    }
    let approved: boolean;
    try {
      approved = await this.options.approvalProvider.request(
        result.prompt,
        request,
        signal,
      );
      signal.throwIfAborted();
    } catch (cause) {
      if (signal.aborted) throw cause;
      throw new AgentRuntimeError(
        'permission.failed',
        `Approval request from policy ${policy} failed.`,
        { cause, details: { policy, tool: request.tool.name } },
      );
    }
    return {
      decision: approved ? 'allow' : 'deny',
      policy,
      reason: approved
        ? `${result.reason} Approval was granted.`
        : `${result.reason} Approval was denied.`,
      asked: true,
    };
  }
}
