import type {
  AgentToolDescriptor,
  AgentToolRuntime,
  ResolveAgentToolsInput,
} from '@babybot/core';

const DEFAULT_PROJECT_TOOLS: readonly AgentToolDescriptor[] = [
  { name: 'read', source: 'builtin', enabled: true },
  { name: 'write', source: 'builtin', enabled: true },
  { name: 'edit', source: 'builtin', enabled: true },
  { name: 'bash', source: 'builtin', enabled: true },
];

export class ProjectToolRuntime implements AgentToolRuntime {
  async resolve(
    _input: ResolveAgentToolsInput,
  ): Promise<readonly AgentToolDescriptor[]> {
    return DEFAULT_PROJECT_TOOLS;
  }
}
