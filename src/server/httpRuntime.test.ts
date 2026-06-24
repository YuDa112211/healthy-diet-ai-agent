import { describe, expect, mock, test } from 'bun:test';
import { requestLoggerMiddleware } from './httpRuntime';

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
