import { describe, expect, it, vi } from 'vitest';

import { AgentContext } from '../src/context';
import { AgentPermission } from '../src/permission';
import { AgentPrompter } from '../src/prompter';
import type { ContextSnapshot } from '../src';
import type { ToolDefinition } from '../src/tools';

const mutatingTool: ToolDefinition = {
  name: 'write',
  description: 'Write a file',
  inputSchema: { type: 'object' },
  source: 'builtin',
  version: '1',
  lifetime: 'static',
  readOnly: false,
  execution: 'backend',
  enabled: true,
};

describe('AgentPermission', () => {
  it('enforces plan mode before custom policies and allows by fallback', async () => {
    const permission = new AgentPermission({
      policies: [{
        name: 'custom.allow',
        lifetime: 'dynamic',
        evaluate: () => ({ decision: 'allow', reason: 'custom allow' }),
      }],
    });
    const call = { id: 'call-1', name: 'write', arguments: {} };

    await expect(permission.evaluate({
      mode: 'plan',
      tool: mutatingTool,
      call,
    }, new AbortController().signal)).resolves.toMatchObject({
      decision: 'deny',
      policy: 'mode.plan.read-only',
    });
    await expect(permission.evaluate({
      mode: 'build',
      tool: mutatingTool,
      call,
    }, new AbortController().signal)).resolves.toMatchObject({
      decision: 'allow',
      policy: 'custom.allow',
    });
  });

  it('resolves ask policies through the approval provider', async () => {
    const request = vi.fn().mockResolvedValue(false);
    const permission = new AgentPermission({
      approvalProvider: { request },
      policies: [{
        name: 'confirm.write',
        lifetime: 'dynamic',
        evaluate: () => ({
          decision: 'ask',
          reason: 'Confirmation required.',
          prompt: 'Allow write?',
        }),
      }],
    });

    await expect(permission.evaluate({
      mode: 'build',
      tool: mutatingTool,
      call: { id: 'call-1', name: 'write', arguments: {} },
    }, new AbortController().signal)).resolves.toMatchObject({
      decision: 'deny',
      policy: 'confirm.write',
      asked: true,
    });
    expect(request).toHaveBeenCalledOnce();
  });
});

describe('AgentPrompter', () => {
  it('renders mode and custom contributors in deterministic order', async () => {
    const prompter = new AgentPrompter({
      contributors: [{
        name: 'project.instructions',
        render: () => [{
          source: 'project:AGENTS.md',
          position: 'turn-prefix',
          text: 'Project instruction',
        }],
      }],
    });

    const injections = await prompter.render({
      mode: 'plan',
      context: { revision: 1, entries: [] },
      tools: { revision: 1, tools: [] },
      input: { text: 'Make a plan' },
    });

    expect(injections.map(({ source }) => source)).toEqual([
      'mode:plan',
      'project:AGENTS.md',
    ]);
    expect(Object.isFrozen(injections)).toBe(true);
  });
});

describe('AgentContext', () => {
  it('prepares injections without writing the user input to history', async () => {
    let snapshot: ContextSnapshot = { revision: 4, entries: [] };
    const store = {
      snapshot: vi.fn(async () => snapshot),
      compact: vi.fn(async () => {
        snapshot = { ...snapshot, revision: snapshot.revision + 1 };
      }),
      clear: vi.fn(),
    };
    const context = new AgentContext(store);

    const prepared = await context.prepare({ text: 'request' }, [
      { source: 'system', position: 'system-append', text: 'system rule' },
      { source: 'prefix', position: 'turn-prefix', text: 'before' },
      { source: 'suffix', position: 'turn-suffix', text: 'after' },
    ]);

    expect(prepared).toEqual({
      revision: 4,
      input: { text: 'before\n\nrequest\n\nafter' },
      systemAppend: ['system rule'],
    });
    expect(store.compact).not.toHaveBeenCalled();

    await context.compact('keep decisions');
    await expect(context.snapshot()).resolves.toMatchObject({ revision: 5 });
    expect(store.compact).toHaveBeenCalledWith('keep decisions');
  });
});
