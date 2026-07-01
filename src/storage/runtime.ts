import { resolveStorageBackend } from '../server/httpRuntime';
import { createSqliteStorage } from './sqlite/adapter';
import { createSupabaseStorage } from './supabase/adapter';
import type { AppStorage } from './types';

let storagePromise: Promise<AppStorage> | null = null;

const resolveSqliteDbPath = (): string =>
  String(process.env.SQLITE_DB_PATH || './data/healthy-diet-agent.db');

export const createStorage = async (): Promise<AppStorage> => {
  const backend = resolveStorageBackend();
  if (backend === 'supabase') {
    return createSupabaseStorage();
  }
  return createSqliteStorage(resolveSqliteDbPath());
};

export const getStorage = async (): Promise<AppStorage> => {
  if (!storagePromise) {
    storagePromise = createStorage();
  }
  return storagePromise;
};

export const resetStorageForTest = (): void => {
  storagePromise = null;
};

export const createStorageForTest = createStorage;
