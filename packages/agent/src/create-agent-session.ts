import type { Backend } from './backend/interface';
import type { AgentMode } from './content';
import { AgentContext } from './context/context';
import { AgentRuntimeError } from './errors';
import { AgentObserver } from './observer/observer';
import type { AgentEventRecorder } from './observer/interface';
import { AgentPermission } from './permission/permission';
import type { ApprovalProvider, PermissionPolicy } from './permission/interface';
import { AgentPrompter } from './prompter/prompter';
import type { PromptContributor } from './prompter/interface';
import { AgentSessionImpl } from './session/session';
import type { AgentSession } from './session/interface';
import { AgentTools } from './tools/tools';
import type { ToolRegistration } from './tools/interface';
import { AgentTurn } from './turn/turn';

export interface CreateAgentSessionOptions {
  readonly backend: Backend;
  readonly workDir: string;
  readonly sessionId?: string;
  readonly mode?: AgentMode;
  readonly tools?: readonly ToolRegistration[];
  readonly permissionPolicies?: readonly PermissionPolicy[];
  readonly approvalProvider?: ApprovalProvider;
  readonly promptContributors?: readonly PromptContributor[];
  readonly eventRecorder?: AgentEventRecorder;
  readonly now?: () => Date;
}

export async function createAgentSession(
  options: CreateAgentSessionOptions,
): Promise<AgentSession> {
  let backendSession;
  try {
    backendSession = await options.backend.open({
      workDir: options.workDir,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
    });
  } catch (cause) {
    throw new AgentRuntimeError(
      'backend.failed',
      'Failed to open the agent backend session.',
      { cause },
    );
  }

  try {
    const context = new AgentContext(backendSession.contextStore());
    const tools = new AgentTools({ registrations: options.tools });
    const observer = new AgentObserver({
      sessionId: backendSession.id,
      ...(options.eventRecorder === undefined
        ? {}
        : { recorder: options.eventRecorder }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const permission = new AgentPermission({
      policies: options.permissionPolicies,
      ...(options.approvalProvider === undefined
        ? {}
        : { approvalProvider: options.approvalProvider }),
    });
    const prompter = new AgentPrompter({
      contributors: options.promptContributors,
    });
    return new AgentSessionImpl({
      backend: backendSession,
      context,
      tools,
      observer,
      prompter,
      permission,
      createTurn: (input) => new AgentTurn(input),
      ...(options.mode === undefined ? {} : { initialMode: options.mode }),
    });
  } catch (cause) {
    await backendSession.close();
    throw cause;
  }
}
