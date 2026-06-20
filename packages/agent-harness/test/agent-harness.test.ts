import { describe, expect, it } from 'vitest';

import { generalAgentProfile } from '../src';

describe('generalAgentProfile', () => {
  it('renders a general project agent prompt with runtime capabilities', () => {
    const prompt = generalAgentProfile.renderSystemPrompt({
      projectId: 'project-1',
      projectName: 'CoreWeave research',
      workDir: '/projects/project-1/workspace',
      toolNames: ['read', 'write', 'bash', 'web_search'],
    });

    expect(prompt).toContain('persistent general-purpose project agent');
    expect(prompt).toContain('# Research Policy');
    expect(prompt).toContain('# Coding Policy');
    expect(prompt).toContain('If the task combines research and implementation');
    expect(prompt).toContain('Project name: "CoreWeave research"');
    expect(prompt).toContain('Workspace: "/projects/project-1/workspace"');
    expect(prompt).toContain('- web_search');
    expect(prompt).not.toContain('expert coding assistant operating inside pi');
  });

  it('states when the runtime has no tools', () => {
    const prompt = generalAgentProfile.renderSystemPrompt({
      projectId: 'project-1',
      projectName: 'Questions',
      workDir: '/projects/project-1/workspace',
      toolNames: [],
    });

    expect(prompt).toContain('Available tools:\n(none)');
    expect(prompt).toContain('Never pretend to have used a tool');
  });
});
