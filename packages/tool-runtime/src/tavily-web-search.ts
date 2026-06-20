import type { WebSearchProvider, WebSearchResult } from './index';

interface TavilySearchResponse {
  readonly results?: readonly TavilySearchResult[];
}

interface TavilySearchResult {
  readonly title?: unknown;
  readonly url?: unknown;
  readonly content?: unknown;
  readonly published_date?: unknown;
}

export interface TavilyWebSearchProviderOptions {
  readonly apiKey: string;
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
}

export class TavilyWebSearchProvider implements WebSearchProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: TavilyWebSearchProviderOptions) {
    if (options.apiKey.trim() === '') {
      throw new Error('Tavily API key cannot be empty.');
    }
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.endpoint = options.endpoint ?? 'https://api.tavily.com/search';
  }

  async search(
    query: string,
    options: { readonly limit: number; readonly signal?: AbortSignal },
  ): Promise<readonly WebSearchResult[]> {
    const response = await this.fetchImpl(this.endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        max_results: options.limit,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
      }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500).trim();
      throw new Error(
        `Tavily search failed with HTTP ${String(response.status)}${
          detail === '' ? '.' : `: ${detail}`
        }`,
      );
    }
    const payload = await response.json() as TavilySearchResponse;
    if (!Array.isArray(payload.results)) return [];
    return payload.results.flatMap((result) => {
      if (
        typeof result.title !== 'string' ||
        typeof result.url !== 'string' ||
        typeof result.content !== 'string'
      ) {
        return [];
      }
      return [{
        title: result.title,
        url: result.url,
        snippet: result.content,
        ...(typeof result.published_date === 'string'
          ? { date: result.published_date }
          : {}),
      }];
    });
  }
}
