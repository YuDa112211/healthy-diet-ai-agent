import { afterEach, describe, expect, test } from 'bun:test';
import {
  buildPreferredProviderOrder,
  isRetryableGoogleFailure,
  pickGoogleApiKey,
} from './modelRouting';

const savedEnv = {
  GEMINI_AI_API: process.env.GEMINI_AI_API,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY,
};

afterEach(() => {
  if (savedEnv.GEMINI_AI_API === undefined) {
    delete process.env.GEMINI_AI_API;
  } else {
    process.env.GEMINI_AI_API = savedEnv.GEMINI_AI_API;
  }

  if (savedEnv.GEMINI_API_KEY === undefined) {
    delete process.env.GEMINI_API_KEY;
  } else {
    process.env.GEMINI_API_KEY = savedEnv.GEMINI_API_KEY;
  }
});

describe('pickGoogleApiKey', () => {
  test('prefers GEMINI_AI_API over GEMINI_API_KEY', () => {
    process.env.GEMINI_AI_API = 'primary-key';
    process.env.GEMINI_API_KEY = 'fallback-key';

    expect(pickGoogleApiKey()).toBe('primary-key');
  });

  test('falls back to GEMINI_API_KEY when primary key is missing', () => {
    delete process.env.GEMINI_AI_API;
    process.env.GEMINI_API_KEY = 'fallback-key';

    expect(pickGoogleApiKey()).toBe('fallback-key');
  });

  test('returns undefined when no key is present', () => {
    delete process.env.GEMINI_AI_API;
    delete process.env.GEMINI_API_KEY;

    expect(pickGoogleApiKey()).toBeUndefined();
  });
});

describe('buildPreferredProviderOrder', () => {
  test('forces local for local model source', () => {
    expect(buildPreferredProviderOrder('local', true)).toEqual(['local']);
    expect(buildPreferredProviderOrder('local', false)).toEqual(['local']);
  });

  test('prefers google then local when auto has a key', () => {
    expect(buildPreferredProviderOrder('auto', true)).toEqual(['google', 'local']);
  });

  test('uses google-only when google model source has a key', () => {
    expect(buildPreferredProviderOrder('google', true)).toEqual(['google']);
  });

  test('falls back to local when auto has no key', () => {
    expect(buildPreferredProviderOrder('auto', false)).toEqual(['local']);
  });

  test('returns no providers when google model source has no key', () => {
    expect(buildPreferredProviderOrder('google', false)).toEqual([]);
  });
});

describe('isRetryableGoogleFailure', () => {
  test('treats quota, rate limit, timeout, and temporary connection errors as retryable', () => {
    expect(isRetryableGoogleFailure(new Error('429 quota exceeded'))).toBe(true);
    expect(isRetryableGoogleFailure(new Error('rate limit exceeded'))).toBe(true);
    expect(isRetryableGoogleFailure(new Error('request timeout while waiting for response'))).toBe(true);
    expect(isRetryableGoogleFailure(new Error('temporary connection reset by peer'))).toBe(true);
  });

  test('treats structured 503 errors as retryable', () => {
    expect(isRetryableGoogleFailure({ status: 503, message: 'service unavailable' })).toBe(true);
    expect(isRetryableGoogleFailure({ response: { status: 503 }, message: 'internal error' })).toBe(true);
  });

  test('treats timeout text with 4000ms as retryable', () => {
    expect(isRetryableGoogleFailure(new Error('request timeout after 4000ms'))).toBe(true);
  });

  test('does not treat unrelated errors as retryable', () => {
    expect(isRetryableGoogleFailure(new Error('validation failed after 1500 tokens'))).toBe(false);
    expect(isRetryableGoogleFailure(new Error('bad field count 2502 in payload'))).toBe(false);
    expect(isRetryableGoogleFailure(new Error('invalid api key'))).toBe(false);
    expect(isRetryableGoogleFailure(new Error('permission denied'))).toBe(false);
    expect(isRetryableGoogleFailure({ status: 400, message: 'invalid api key' })).toBe(false);
  });
});
