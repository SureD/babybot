import type {
  PromptContributor,
  PromptInjection,
  Prompter,
  PromptRequest,
} from './interface';

export interface AgentPrompterOptions {
  readonly contributors?: readonly PromptContributor[];
  readonly includeModePrompt?: boolean;
}

const MODE_PROMPTS = {
  default: 'Work in the normal conversational mode. Use tools when they are needed to complete the request.',
  plan: 'Analyze the request and produce a concrete plan. Do not modify project state or perform other side effects.',
  build: 'Complete the requested work. You may modify project state through the tools allowed by the runtime.',
} as const;

export const modePromptContributor: PromptContributor = {
  name: 'agent.mode',
  render(request) {
    return [{
      source: `mode:${request.mode}`,
      position: 'system-append',
      text: MODE_PROMPTS[request.mode],
    }];
  },
};

export class AgentPrompter implements Prompter {
  private readonly contributors: readonly PromptContributor[];

  constructor(options: AgentPrompterOptions = {}) {
    const contributors = [
      ...(options.includeModePrompt === false ? [] : [modePromptContributor]),
      ...(options.contributors ?? []),
    ];
    const names = new Set<string>();
    for (const contributor of contributors) {
      if (contributor.name.trim() === '') {
        throw new TypeError('Prompt contributor name cannot be empty.');
      }
      if (names.has(contributor.name)) {
        throw new TypeError(`Prompt contributor ${contributor.name} is duplicated.`);
      }
      names.add(contributor.name);
    }
    this.contributors = Object.freeze(contributors);
  }

  async render(request: PromptRequest): Promise<readonly PromptInjection[]> {
    const rendered: PromptInjection[] = [];
    for (const contributor of this.contributors) {
      const injections = await contributor.render(request);
      for (const injection of injections) {
        if (injection.source.trim() === '' || injection.text.trim() === '') {
          throw new TypeError(
            `Prompt contributor ${contributor.name} returned an empty source or text.`,
          );
        }
        rendered.push(Object.freeze({ ...injection }));
      }
    }
    return Object.freeze(rendered);
  }
}
