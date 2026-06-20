import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

describe('loadConfig', () => {
  it('loads optional Tavily web search credentials', () => {
    const config = loadConfig({
      BABYBOT_TAVILY_API_KEY: 'test-tavily-key',
    });

    expect(config.web).toEqual({ tavilyApiKey: 'test-tavily-key' });
  });

  it('does not configure web search for an empty key', () => {
    const config = loadConfig({
      BABYBOT_TAVILY_API_KEY: '  ',
    });

    expect(config.web).toEqual({});
  });
});
