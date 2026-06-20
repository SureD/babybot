import { describe, expect, it, vi } from 'vitest';

import type { AgentExecutableTool, ResolvedAgentTool } from '@babybot/core';

import { ProjectToolRuntime } from '../src';

describe('ProjectToolRuntime', () => {
  it('resolves coding tools and the native URL fetch tool', async () => {
    const runtime = new ProjectToolRuntime();
    const tools = await runtime.resolve({
      projectId: 'project-1',
      workDir: '/tmp/project-1',
    });

    expect(tools.map(({ name, source, enabled }) => ({ name, source, enabled }))).toEqual([
      { name: 'read', source: 'builtin', enabled: true },
      { name: 'write', source: 'builtin', enabled: true },
      { name: 'edit', source: 'builtin', enabled: true },
      { name: 'bash', source: 'builtin', enabled: true },
      { name: 'web_fetch', source: 'native', enabled: true },
    ]);
    expect(tools.some((tool) => tool.name === 'web_search')).toBe(false);
  });

  it('fetches public HTML, extracts readable text, and records provenance', async () => {
    const fetchImpl = vi.fn(async () => new Response(
      '<html><head><style>.hidden{}</style></head><body><h1>CoreWeave</h1><script>bad()</script><p>Cloud infrastructure &amp; GPUs.</p></body></html>',
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    )) as unknown as typeof fetch;
    const runtime = new ProjectToolRuntime({
      fetchImpl,
      async lookupHost() {
        return [{ address: '93.184.216.34' }];
      },
    });
    const tool = executableTool(
      await runtime.resolve({ projectId: 'project-1', workDir: '/tmp/project-1' }),
      'web_fetch',
    );

    const result = await tool.execute(
      { url: 'https://example.com/company' },
      { projectId: 'project-1', workDir: '/tmp/project-1' },
    );

    expect(result.content).toContain('URL: https://example.com/company');
    expect(result.content).toContain('CoreWeave');
    expect(result.content).toContain('Cloud infrastructure & GPUs.');
    expect(result.content).not.toContain('bad()');
    expect(result.details).toMatchObject({
      url: 'https://example.com/company',
      contentType: 'text/html',
      truncated: false,
    });
  });

  it('blocks local and private network URL fetches', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const runtime = new ProjectToolRuntime({ fetchImpl });
    const tool = executableTool(
      await runtime.resolve({ projectId: 'project-1', workDir: '/tmp/project-1' }),
      'web_fetch',
    );

    await expect(tool.execute(
      { url: 'http://127.0.0.1/admin' },
      { projectId: 'project-1', workDir: '/tmp/project-1' },
    )).rejects.toThrow('Private or local network URLs are not allowed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('exposes web search only when a provider is configured', async () => {
    const search = vi.fn(async () => [{
      title: 'CoreWeave investor relations',
      url: 'https://investors.coreweave.com/',
      snippet: 'Company information',
      date: '2026-06-01',
    }]);
    const runtime = new ProjectToolRuntime({ webSearchProvider: { search } });
    const tool = executableTool(
      await runtime.resolve({ projectId: 'project-1', workDir: '/tmp/project-1' }),
      'web_search',
    );

    const result = await tool.execute(
      { query: 'CoreWeave investor relations', limit: 3 },
      { projectId: 'project-1', workDir: '/tmp/project-1' },
    );

    expect(search).toHaveBeenCalledWith('CoreWeave investor relations', {
      limit: 3,
    });
    expect(result.content).toContain('Title: CoreWeave investor relations');
    expect(result.content).toContain('URL: https://investors.coreweave.com/');
    expect(result.details).toEqual({
      query: 'CoreWeave investor relations',
      resultCount: 1,
    });
  });
});

function executableTool(
  tools: readonly ResolvedAgentTool[],
  name: string,
): AgentExecutableTool {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined || !('execute' in tool)) {
    throw new Error(`Executable tool "${name}" was not resolved.`);
  }
  return tool;
}
