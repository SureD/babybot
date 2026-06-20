import { describe, expect, it, vi } from 'vitest';

import { TavilyWebSearchProvider } from '../src';

describe('TavilyWebSearchProvider', () => {
  it('searches with bearer authentication and normalizes results', async () => {
    const fetchImpl = vi.fn(async () => Response.json({
      results: [{
        title: 'CoreWeave',
        url: 'https://www.coreweave.com/',
        content: 'The AI Hyperscaler.',
        published_date: '2026-06-01',
      }],
    })) as unknown as typeof fetch;
    const provider = new TavilyWebSearchProvider({
      apiKey: 'test-key',
      fetchImpl,
    });

    await expect(provider.search('CoreWeave company', { limit: 3 })).resolves.toEqual([
      {
        title: 'CoreWeave',
        url: 'https://www.coreweave.com/',
        snippet: 'The AI Hyperscaler.',
        date: '2026-06-01',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: 'CoreWeave company',
        max_results: 3,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
    });
  });

  it('does not expose the API key in provider errors', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('quota exceeded', { status: 429 }),
    ) as unknown as typeof fetch;
    const provider = new TavilyWebSearchProvider({
      apiKey: 'secret-key',
      fetchImpl,
    });

    await expect(provider.search('query', { limit: 5 })).rejects.toThrow(
      'Tavily search failed with HTTP 429: quota exceeded',
    );
    await expect(provider.search('query', { limit: 5 })).rejects.not.toThrow('secret-key');
  });
});
