import { describe, expect, it, vi } from 'vitest';

import { AgentTools } from '../src/tools';
import type { ToolRegistration } from '../src';

const readTool: ToolRegistration = {
  name: 'read',
  description: 'Read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string', minLength: 1 } },
    required: ['path'],
    additionalProperties: false,
  },
  source: 'builtin',
  version: '1',
  lifetime: 'static',
  readOnly: true,
  execution: 'backend',
};

function hostedTool(execute = vi.fn().mockResolvedValue({
  content: 'saved',
  isError: false,
})): ToolRegistration {
  return {
    name: 'save_note',
    description: 'Save a note',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    source: 'native',
    version: '1',
    lifetime: 'dynamic',
    readOnly: false,
    execution: 'hosted',
    execute,
  };
}

describe('AgentTools', () => {
  it('maintains immutable snapshots across dynamic changes', () => {
    const tools = new AgentTools({ registrations: [readTool, hostedTool()] });
    const snapshot = tools.snapshot();

    tools.disable('save_note');

    expect(snapshot.revision).toBe(2);
    expect(snapshot.tools.map(({ name }) => name)).toEqual(['read', 'save_note']);
    expect(tools.snapshot()).toMatchObject({ revision: 3, tools: [{ name: 'read' }] });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tools)).toBe(true);
    expect(Object.isFrozen(snapshot.tools[0]?.inputSchema)).toBe(true);
  });

  it('rejects registration conflicts and protects static registrations', () => {
    const tools = new AgentTools({ registrations: [readTool] });

    expect(() => tools.register(readTool)).toThrowError(
      expect.objectContaining({ code: 'tool.registration_conflict' }),
    );
    expect(() => tools.replace(readTool)).toThrowError(
      expect.objectContaining({ code: 'tool.registration_conflict' }),
    );
    expect(() => tools.unregister('read')).toThrowError(
      expect.objectContaining({ code: 'tool.registration_conflict' }),
    );
  });

  it('replaces and removes dynamic tools', () => {
    const tools = new AgentTools({ registrations: [hostedTool()] });
    const replacement = { ...hostedTool(), version: '2' };

    tools.replace(replacement);
    expect(tools.get('save_note')?.version).toBe('2');
    expect(tools.unregister('save_note')).toBe(true);
    expect(tools.unregister('save_note')).toBe(false);
  });

  it('validates hosted input before executing the handler', async () => {
    const execute = vi.fn().mockResolvedValue({ content: 'saved', isError: false });
    const tools = new AgentTools({ registrations: [hostedTool(execute)] });
    const context = {
      sessionId: 'session-1',
      turnId: 'turn-1',
      signal: new AbortController().signal,
    };

    await expect(tools.invoke({
      id: 'call-1',
      name: 'save_note',
      arguments: { text: '', extra: true },
    }, context)).rejects.toMatchObject({ code: 'tool.invalid_input' });
    expect(execute).not.toHaveBeenCalled();

    await expect(tools.invoke({
      id: 'call-2',
      name: 'save_note',
      arguments: { text: 'hello' },
    }, context)).resolves.toEqual({ content: 'saved', isError: false });
    expect(execute).toHaveBeenCalledOnce();
  });
});
