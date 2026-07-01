import { describe, expect, mock, test } from 'bun:test';
import {
  formatStartupBannerForTest,
  requestLoggerMiddleware,
  resolveStorageBackendForTest,
} from './httpRuntime';

const createResponse = (statusCode: number) => {
  let finishHandler: (() => void) | undefined;

  return {
    locals: {} as Record<string, unknown>,
    statusCode,
    on(event: string, handler: () => void) {
      if (event === 'finish') {
        finishHandler = handler;
      }
    },
    finish() {
      finishHandler?.();
    },
  };
};

describe('requestLoggerMiddleware', () => {
  test('skips logging successful ping requests', () => {
    const logSpy = mock(() => {});
    const originalLog = console.log;
    console.log = logSpy as typeof console.log;

    try {
      const req = {
        method: 'GET',
        originalUrl: '/ping',
        ip: '127.0.0.1',
        body: undefined,
        header: () => undefined,
      };
      const res = createResponse(200);
      const next = mock(() => {});

      requestLoggerMiddleware(req as never, res as never, next);
      res.finish();

      expect(next).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(0);
    } finally {
      console.log = originalLog;
    }
  });

  test('logs ping requests when the status is not 200', () => {
    const logSpy = mock(() => {});
    const originalLog = console.log;
    console.log = logSpy as typeof console.log;

    try {
      const req = {
        method: 'GET',
        originalUrl: '/ping',
        ip: '127.0.0.1',
        body: undefined,
        header: () => undefined,
      };
      const res = createResponse(503);
      const next = mock(() => {});

      requestLoggerMiddleware(req as never, res as never, next);
      res.finish();

      expect(next).toHaveBeenCalledTimes(1);
      expect(logSpy).toHaveBeenCalledTimes(2);
    } finally {
      console.log = originalLog;
    }
  });
});

describe('resolveStorageBackendForTest', () => {
  test('defaults to sqlite when STORAGE_BACKEND is missing', () => {
    const originalBackend = process.env.STORAGE_BACKEND;
    delete process.env.STORAGE_BACKEND;

    try {
      expect(resolveStorageBackendForTest()).toBe('sqlite');
    } finally {
      if (originalBackend === undefined) {
        delete process.env.STORAGE_BACKEND;
      } else {
        process.env.STORAGE_BACKEND = originalBackend;
      }
    }
  });

  test('returns supabase when STORAGE_BACKEND is set to supabase', () => {
    const originalBackend = process.env.STORAGE_BACKEND;
    process.env.STORAGE_BACKEND = 'supabase';

    try {
      expect(resolveStorageBackendForTest()).toBe('supabase');
    } finally {
      if (originalBackend === undefined) {
        delete process.env.STORAGE_BACKEND;
      } else {
        process.env.STORAGE_BACKEND = originalBackend;
      }
    }
  });
});

describe('formatStartupBannerForTest', () => {
  test('includes the selected storage backend and port', () => {
    expect(
      formatStartupBannerForTest({
        backend: 'sqlite',
        port: 8001,
        aiApiUrl: 'http://localhost:8080/v1',
      })
    ).toContain('Storage backend: sqlite');
  });
});
