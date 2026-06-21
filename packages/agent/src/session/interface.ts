import type { AgentMode, TurnInput } from '../content';
import type { ContextSnapshot } from '../context/interface';
import type { AgentEventListener } from '../observer/interface';
import type { ToolRegistration } from '../tools/interface';
import type { Turn } from '../turn/interface';

/** Long-lived owner of context, tools, backend state, and at most one active Turn. */
export interface AgentSession {
  readonly id: string;
  readonly mode: AgentMode;

  /** Creates and starts a Turn. Rejects with session.busy if another Turn is active. */
  prompt(input: TurnInput): Promise<Turn>;
  setMode(mode: AgentMode): Promise<void>;

  registerTool(tool: ToolRegistration): void;
  replaceTool(tool: ToolRegistration): void;
  unregisterTool(name: string): boolean;

  contextSnapshot(): Promise<ContextSnapshot>;
  compact(instruction?: string): Promise<void>;
  subscribe(listener: AgentEventListener): () => void;
  cancel(reason?: string): Promise<void>;
  close(): Promise<void>;
}
