import { afterEach, describe, expect, test } from 'bun:test';

const ORIGINAL_AI_API_URL = process.env.AI_API_URL;

afterEach(() => {
  if (ORIGINAL_AI_API_URL === undefined) {
    delete process.env.AI_API_URL;
  } else {
    process.env.AI_API_URL = ORIGINAL_AI_API_URL;
  }
});

describe('getAiApiUrl', () => {
  test('returns configured AI_API_URL when present', async () => {
    process.env.AI_API_URL = 'http://example.local:9000/v1/';

    const { getAiApiUrl } = await import('./aiRuntime');

    expect(getAiApiUrl()).toBe('http://example.local:9000/v1/');
  });

  test('uses the shared non-local fallback when AI_API_URL is missing', async () => {
    delete process.env.AI_API_URL;

    const { DEFAULT_AI_API_URL, getAiApiUrl } = await import('./aiRuntime');

    expect(DEFAULT_AI_API_URL).toBe('http://100.113.105.18:8080/v1');
    expect(getAiApiUrl()).toBe(DEFAULT_AI_API_URL);
    expect(getAiApiUrl()).not.toContain('localhost');
  });
});
