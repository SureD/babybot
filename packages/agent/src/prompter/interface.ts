import type { AgentMode, TurnInput } from '../content';
import type { ContextSnapshot } from '../context/interface';
import type { ToolSnapshot } from '../tools/interface';

export type PromptInjectionPosition =
  | 'system-append'
  | 'turn-prefix'
  | 'turn-suffix';

export interface PromptInjection {
  readonly source: string;
  readonly position: PromptInjectionPosition;
  readonly text: string;
}

export interface PromptRequest {
  readonly mode: AgentMode;
  readonly context: ContextSnapshot;
  readonly tools: ToolSnapshot;
  readonly input: TurnInput;
}

/** A Prompter is composed from ordered contributors when the Session is created. */
export interface PromptContributor {
  readonly name: string;
  render(request: PromptRequest):
    | readonly PromptInjection[]
    | Promise<readonly PromptInjection[]>;
}

export interface Prompter {
  render(request: PromptRequest): Promise<readonly PromptInjection[]>;
}
