import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';

export const corsMiddleware = cors();
export const MAX_REQUEST_BODY_MB = Number(process.env.MAX_REQUEST_BODY_MB || 15);
export const REQUEST_BODY_LIMIT = `${MAX_REQUEST_BODY_MB}mb`;
export const jsonBodyParser = express.json({ limit: REQUEST_BODY_LIMIT });
export const urlencodedBodyParser = express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT });

export const createRequestId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export const formatDurationMs = (startAt: number): string => `${Date.now() - startAt}ms`;
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS || 45000);
export const PROFILE_LOOKUP_TIMEOUT_MS = Number(process.env.PROFILE_LOOKUP_TIMEOUT_MS || 4000);
export const AGENT_STREAM_TIMEOUT_MS = Number(process.env.AGENT_STREAM_TIMEOUT_MS || 60000);
export const USER_PROFILE_CACHE_TTL_MS = Number(process.env.USER_PROFILE_CACHE_TTL_MS || 120000);
export type StorageBackend = 'sqlite' | 'supabase';

export const resolveStorageBackend = (): StorageBackend => {
  const rawValue = String(process.env.STORAGE_BACKEND || 'sqlite').trim().toLowerCase();
  return rawValue === 'supabase' ? 'supabase' : 'sqlite';
};

export const resolveStorageBackendForTest = resolveStorageBackend;

export const formatStartupBanner = (input: {
  backend: StorageBackend;
  port: number;
  aiApiUrl: string;
}): string =>
  [
    'Diet Manager Agent Server started',
    `Storage backend: ${input.backend}`,
    `API URL: http://localhost:${input.port}/api/chat`,
    `LLM base URL: ${input.aiApiUrl}`,
  ].join('\n');

export const formatStartupBannerForTest = formatStartupBanner;

export const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> => {
  let timeoutHandle: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`${label} timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
};

export const isTimeoutError = (error: unknown): boolean => {
  return error instanceof Error && /timeout/i.test(error.message);
};

export const toStatusText = (value: unknown, maxLength = 220): string => {
  let raw = '';
  if (typeof value === 'string') {
    raw = value;
  } else {
    try {
      raw = JSON.stringify(value);
    } catch {
      raw = String(value);
    }
  }

  const oneLine = raw.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= maxLength) return oneLine;
  return `${oneLine.slice(0, maxLength)}...`;
};

export const isUpstreamConnectionError = (error: unknown): boolean => {
  const text = toStatusText(error, 2000).toLowerCase();
  return (
    text.includes('connectionrefused') ||
    text.includes('unable to connect') ||
    text.includes('api connection error') ||
    text.includes('connection error')
  );
};

const ANSI = {
  reset: '\x1b[0m',
  blue: '\x1b[34m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

const rawConsoleLog = console.log.bind(console);
const rawConsoleError = console.error.bind(console);
const rawConsoleWarn = console.warn.bind(console);

console.log = (...args: unknown[]) => {
  rawConsoleLog(`${ANSI.blue}[INFO]${ANSI.reset}`, ...args);
};

console.error = (...args: unknown[]) => {
  rawConsoleError(`${ANSI.red}[ERROR]${ANSI.reset}`, ...args);
};

console.warn = (...args: unknown[]) => {
  rawConsoleWarn(`${ANSI.yellow}[WARN]${ANSI.reset}`, ...args);
};

const sanitizeForLog = (body: unknown): Record<string, unknown> => {
  if (!body || typeof body !== 'object') return {};
  const raw = body as Record<string, unknown>;
  return {
    thread_id: typeof raw.thread_id === 'string' ? raw.thread_id : undefined,
    chat_history_id: typeof raw.chat_history_id === 'string' ? raw.chat_history_id : undefined,
    user_id: typeof raw.user_id === 'string' ? raw.user_id : undefined,
    is_new_conversation:
      typeof raw.is_new_conversation === 'boolean' ? raw.is_new_conversation : undefined,
    message_length: typeof raw.message === 'string' ? raw.message.length : undefined,
    user_context_count: Array.isArray(raw.user_context) ? raw.user_context.length : undefined,
    has_image: raw.image != null,
    image_mime_type:
      typeof raw.image_mime_type === 'string'
        ? raw.image_mime_type
        : typeof raw.imageMimeType === 'string'
          ? raw.imageMimeType
          : undefined,
  };
};

export const requestLoggerMiddleware = (req: Request, res: Response, next: (err?: unknown) => void) => {
  const requestId = req.header('x-request-id')?.trim() || createRequestId();
  const startAt = Date.now();
  const isPingRequest = req.method === 'GET' && req.originalUrl === '/ping';
  res.locals.requestId = requestId;

  if (!isPingRequest) {
    console.log(
      `[REQ ${requestId}] -> ${req.method} ${req.originalUrl} ip=${req.ip || 'unknown'} body=${JSON.stringify(
        sanitizeForLog(req.body)
      )}`
    );
  }

  res.on('finish', () => {
    if (isPingRequest && res.statusCode === 200) {
      return;
    }

    if (isPingRequest) {
      console.log(
        `[REQ ${requestId}] -> ${req.method} ${req.originalUrl} ip=${req.ip || 'unknown'} body=${JSON.stringify(
          sanitizeForLog(req.body)
        )}`
      );
    }

    console.log(
      `[REQ ${requestId}] <- ${req.method} ${req.originalUrl} status=${res.statusCode} duration=${formatDurationMs(
        startAt
      )}`
    );
  });

  next();
};
