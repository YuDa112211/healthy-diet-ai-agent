import { describe, expect, test } from 'bun:test';

import { createStorageForTest } from './runtime';

describe('createStorageForTest', () => {
  test('creates sqlite storage when STORAGE_BACKEND=sqlite', async () => {
    const originalBackend = process.env.STORAGE_BACKEND;
    const originalDbPath = process.env.SQLITE_DB_PATH;
    process.env.STORAGE_BACKEND = 'sqlite';
    process.env.SQLITE_DB_PATH = ':memory:';

    try {
      const storage = await createStorageForTest();
      expect(storage.backend).toBe('sqlite');
    } finally {
      if (originalBackend === undefined) {
        delete process.env.STORAGE_BACKEND;
      } else {
        process.env.STORAGE_BACKEND = originalBackend;
      }

      if (originalDbPath === undefined) {
        delete process.env.SQLITE_DB_PATH;
      } else {
        process.env.SQLITE_DB_PATH = originalDbPath;
      }
    }
  });
});
