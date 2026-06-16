import { beforeAll, describe, expect, test } from 'bun:test';
import type { ChatProvider } from './modelRouting';

const getRequiredFunction = <T extends (...args: any[]) => any>(
  value: unknown,
  name: string
): T => {
  expect(typeof value).toBe('function');
  if (typeof value !== 'function') {
    throw new Error(`${name} is not implemented`);
  }
  return value as T;
};

const loadAgentRuntime = async () => {
  process.env.SUPABASE_URL ||= 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_KEY ||= 'test-service-key';
  return import('./agentRuntime');
};

let agentRuntimeModule: Awaited<ReturnType<typeof loadAgentRuntime>>;

beforeAll(async () => {
  agentRuntimeModule = await loadAgentRuntime();
});

describe('buildAgentModelAttemptPlan', () => {
  test('returns local-only attempt plan for local model source', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildAgentModelAttemptPlan = getRequiredFunction<
      (modelSource: 'auto' | 'google' | 'local', hasGoogleKey: boolean) => unknown
    >((agentRuntime as Record<string, unknown>).buildAgentModelAttemptPlan, 'buildAgentModelAttemptPlan');

    expect(buildAgentModelAttemptPlan('local', true)).toEqual([
      { provider: 'local', reason: 'selected' },
    ]);
    expect(buildAgentModelAttemptPlan('local', false)).toEqual([
      { provider: 'local', reason: 'selected' },
    ]);
  });

  test('returns google-first plan when auto/google has a key and local-only when it does not', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildAgentModelAttemptPlan = getRequiredFunction<
      (modelSource: 'auto' | 'google' | 'local', hasGoogleKey: boolean) => unknown
    >((agentRuntime as Record<string, unknown>).buildAgentModelAttemptPlan, 'buildAgentModelAttemptPlan');

    expect(buildAgentModelAttemptPlan('auto', true)).toEqual([
      { provider: 'google', reason: 'selected' },
      { provider: 'local', reason: 'fallback' },
    ]);
    expect(buildAgentModelAttemptPlan('google', true)).toEqual([
      { provider: 'google', reason: 'selected' },
      { provider: 'local', reason: 'fallback' },
    ]);
    expect(buildAgentModelAttemptPlan('auto', false)).toEqual([
      { provider: 'local', reason: 'selected' },
    ]);
    expect(buildAgentModelAttemptPlan('google', false)).toEqual([
      { provider: 'local', reason: 'selected' },
    ]);
  });
});

describe('createLocalOnlyStructuredOutputBinder', () => {
  test('creates a dedicated structured-output helper that is independent from chat routing', async () => {
    const agentRuntime = agentRuntimeModule;
    const createLocalOnlyStructuredOutputBinder = getRequiredFunction<
      <TModel extends { withStructuredOutput: (schema: unknown) => unknown }>(model: TModel) => {
        withStructuredOutput: (schema: unknown) => unknown;
      }
    >(
      (agentRuntime as Record<string, unknown>).createLocalOnlyStructuredOutputBinder,
      'createLocalOnlyStructuredOutputBinder'
    );

    const seenSchemas: unknown[] = [];
    const fakeLocalStructuredOutputModel = {
      withStructuredOutput(schema: unknown) {
        seenSchemas.push(schema);
        return { schema, provider: 'local-only-test-double' };
      },
    };

    const binder = createLocalOnlyStructuredOutputBinder(fakeLocalStructuredOutputModel);
    const structuredOutput = binder.withStructuredOutput({ kind: 'summary' });

    expect(structuredOutput).toEqual({
      schema: { kind: 'summary' },
      provider: 'local-only-test-double',
    });
    expect(seenSchemas).toEqual([{ kind: 'summary' }]);
  });
});

describe('invokeWithModelRouting', () => {
  test('goes directly to local when google key is unavailable', async () => {
    const agentRuntime = agentRuntimeModule;
    const invokeWithModelRouting = getRequiredFunction<
      (input: {
        modelSource: 'auto' | 'google' | 'local';
        googleApiKey?: string;
        onStatus?: (message: string) => void;
        invokeProvider: (provider: ChatProvider) => Promise<string>;
      }) => Promise<{ provider: ChatProvider; value: string }>
    >((agentRuntime as Record<string, unknown>).invokeWithModelRouting, 'invokeWithModelRouting');

    const calls: ChatProvider[] = [];
    const statuses: string[] = [];

    const result = await invokeWithModelRouting({
      modelSource: 'google',
      onStatus: (message) => statuses.push(message),
      invokeProvider: async (provider) => {
        calls.push(provider);
        return `reply:${provider}`;
      },
    });

    expect(result).toEqual({ provider: 'local', value: 'reply:local' });
    expect(calls).toEqual(['local']);
    expect(statuses).toEqual(['Model selected: local']);
  });

  test('falls back to local after a retryable google upstream failure', async () => {
    const agentRuntime = agentRuntimeModule;
    const invokeWithModelRouting = getRequiredFunction<
      (input: {
        modelSource: 'auto' | 'google' | 'local';
        googleApiKey?: string;
        onStatus?: (message: string) => void;
        invokeProvider: (provider: ChatProvider) => Promise<string>;
      }) => Promise<{ provider: ChatProvider; value: string }>
    >((agentRuntime as Record<string, unknown>).invokeWithModelRouting, 'invokeWithModelRouting');

    const calls: ChatProvider[] = [];
    const statuses: string[] = [];

    const result = await invokeWithModelRouting({
      modelSource: 'auto',
      googleApiKey: 'google-key',
      onStatus: (message) => statuses.push(message),
      invokeProvider: async (provider) => {
        calls.push(provider);
        if (provider === 'google') {
          throw new Error('503 service unavailable');
        }
        return `reply:${provider}`;
      },
    });

    expect(result).toEqual({ provider: 'local', value: 'reply:local' });
    expect(calls).toEqual(['google', 'local']);
    expect(statuses).toEqual([
      'Model selected: google',
      'Google upstream failed, falling back to local model.',
    ]);
  });

  test('rejects non-retryable google errors without falling back to local', async () => {
    const agentRuntime = agentRuntimeModule;
    const invokeWithModelRouting = getRequiredFunction<
      (input: {
        modelSource: 'auto' | 'google' | 'local';
        googleApiKey?: string;
        onStatus?: (message: string) => void;
        invokeProvider: (provider: ChatProvider) => Promise<string>;
      }) => Promise<{ provider: ChatProvider; value: string }>
    >((agentRuntime as Record<string, unknown>).invokeWithModelRouting, 'invokeWithModelRouting');

    const calls: ChatProvider[] = [];
    const statuses: string[] = [];

    await expect(
      invokeWithModelRouting({
        modelSource: 'google',
        googleApiKey: 'google-key',
        onStatus: (message) => statuses.push(message),
        invokeProvider: async (provider) => {
          calls.push(provider);
          throw new Error('400 invalid api key');
        },
      })
    ).rejects.toThrow('400 invalid api key');

    expect(calls).toEqual(['google']);
    expect(statuses).toEqual(['Model selected: google']);
  });
});

describe('withRuntimeStatusEmitter', () => {
  test('cleans up the registered emitter when setup throws synchronously', async () => {
    const agentRuntime = agentRuntimeModule;
    const withRuntimeStatusEmitter = getRequiredFunction<
      <T>(input: {
        runtimeStreamId: string;
        res: Pick<Response, 'write'>;
        work: () => T | Promise<T>;
      }) => Promise<T>
    >(
      (agentRuntime as Record<string, unknown>).withRuntimeStatusEmitter,
      'withRuntimeStatusEmitter'
    );
    const getRuntimeStatusEmitterCount = getRequiredFunction<
      () => number
    >(
      (agentRuntime as Record<string, unknown>).getRuntimeStatusEmitterCount,
      'getRuntimeStatusEmitterCount'
    );

    const initialCount = getRuntimeStatusEmitterCount();
    const fakeResponse = { write: (_chunk: string) => true };

    await expect(
      withRuntimeStatusEmitter({
        runtimeStreamId: 'sync-throw-test',
        res: fakeResponse,
        work: () => {
          throw new Error('streamEvents sync failure');
        },
      })
    ).rejects.toThrow('streamEvents sync failure');

    expect(getRuntimeStatusEmitterCount()).toBe(initialCount);
  });
});

describe('capability guidance', () => {
  test('detects capability-related user questions', async () => {
    const agentRuntime = agentRuntimeModule;
    const isCapabilityQuestion = getRequiredFunction<
      (message: string) => boolean
    >((agentRuntime as Record<string, unknown>).isCapabilityQuestion, 'isCapabilityQuestion');

    expect(isCapabilityQuestion('你有什麼功能？')).toBe(true);
    expect(isCapabilityQuestion('你會做什麼')).toBe(true);
    expect(isCapabilityQuestion('請幫我分析今天吃的早餐')).toBe(false);
  });

  test('builds capability summary from registered tools and skills index text', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildCapabilitiesSummary = getRequiredFunction<
      (input: { toolNames: string[]; skillsIndex: string }) => string
    >(
      (agentRuntime as Record<string, unknown>).buildCapabilitiesSummary,
      'buildCapabilitiesSummary'
    );

    const summary = buildCapabilitiesSummary({
      toolNames: ['search_knowledge_tool', 'list_capabilities_tool', 'calculate_nutrition'],
      skillsIndex: [
        '# Skills',
        '- `search_knowledge_tool`: 搜尋知識庫',
        '- `calculate_nutrition`: 估算營養',
        '- `internet_search`: 網路搜尋',
      ].join('\n'),
    });

    expect(summary).toContain('search_knowledge_tool');
    expect(summary).toContain('calculate_nutrition');
    expect(summary).toContain('list_capabilities_tool');
    expect(summary).not.toContain('internet_search');
    expect(summary).toContain('搜尋知識庫');
  });
});

describe('visible text sanitization', () => {
  test('removes thought blocks from assistant-visible text', async () => {
    const agentRuntime = agentRuntimeModule;
    const sanitizeAssistantVisibleText = getRequiredFunction<
      (message: string) => string
    >(
      (agentRuntime as Record<string, unknown>).sanitizeAssistantVisibleText,
      'sanitizeAssistantVisibleText'
    );

    const sanitized = sanitizeAssistantVisibleText([
      '<thought>The list_capabilities_tool returned tools.</thought>',
      '我目前可以幫你做這些事：',
      '1. 分析食物照片',
    ].join('\n\n'));

    expect(sanitized).toBe(['我目前可以幫你做這些事：', '1. 分析食物照片'].join('\n\n'));
  });
});
