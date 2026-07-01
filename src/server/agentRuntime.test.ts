import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadDefaultAgentConfig } from '../config/agentConfig';
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
const tempDirs: string[] = [];

beforeAll(async () => {
  agentRuntimeModule = await loadAgentRuntime();
});

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

const createTempDir = async (): Promise<string> => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-runtime-skills-index-'));
  tempDirs.push(tempDir);
  return tempDir;
};

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
    ]);
    expect(buildAgentModelAttemptPlan('auto', false)).toEqual([
      { provider: 'local', reason: 'selected' },
    ]);
    expect(buildAgentModelAttemptPlan('google', false)).toEqual([]);
  });
});

describe('resolveAgentRuntimePromptPaths', () => {
  test('uses resolved config prompt paths and keeps compatible skills-index candidates', async () => {
    const agentRuntime = agentRuntimeModule;
    const resolveAgentRuntimePromptPaths = getRequiredFunction<
      (config: {
        agent: {
          systemPromptFile: string;
          skillsIndexFile: string;
          rulesFile: string;
        };
      }) => {
        systemPromptFile: string;
        skillsIndexCandidates: string[];
        rulesFile: string;
      }
    >(
      (agentRuntime as Record<string, unknown>).resolveAgentRuntimePromptPaths,
      'resolveAgentRuntimePromptPaths'
    );

    const config = await loadDefaultAgentConfig();
    const promptPaths = resolveAgentRuntimePromptPaths(config);

    expect(promptPaths.systemPromptFile).toBe(config.agent.systemPromptFile);
    expect(promptPaths.rulesFile).toBe(config.agent.rulesFile);
    expect(promptPaths.skillsIndexCandidates[0]).toBe(config.agent.skillsIndexFile);
    expect(promptPaths.skillsIndexCandidates).toContain(
      path.join(path.dirname(config.agent.skillsIndexFile), 'SKILLS_INDEX.md')
    );
  });
});

describe('loadAgentRuntimeSkillsIndexText', () => {
  test('loads skills-index text through config-driven compatible prompt paths', async () => {
    const agentRuntime = agentRuntimeModule;
    const loadAgentRuntimeSkillsIndexText = getRequiredFunction<
      (config: {
        agent: {
          systemPromptFile: string;
          skillsIndexFile: string;
          rulesFile: string;
        };
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).loadAgentRuntimeSkillsIndexText,
      'loadAgentRuntimeSkillsIndexText'
    );

    const config = await loadDefaultAgentConfig();
    const skillsIndexText = loadAgentRuntimeSkillsIndexText(config);

    expect(skillsIndexText.length).toBeGreaterThan(0);
    expect(skillsIndexText).toContain('`');
  });

  test('falls back from missing SKILL_INDEX.md to existing SKILLS_INDEX.md', async () => {
    const agentRuntime = agentRuntimeModule;
    const loadAgentRuntimeSkillsIndexText = getRequiredFunction<
      (config: {
        agent: {
          systemPromptFile: string;
          skillsIndexFile: string;
          rulesFile: string;
        };
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).loadAgentRuntimeSkillsIndexText,
      'loadAgentRuntimeSkillsIndexText'
    );

    const tempDir = await createTempDir();
    const legacyPath = path.join(tempDir, 'SKILL_INDEX.md');
    const pluralPath = path.join(tempDir, 'SKILLS_INDEX.md');
    await writeFile(pluralPath, '# Skills\n- `fallback_tool`: from plural file\n');

    const skillsIndexText = loadAgentRuntimeSkillsIndexText({
      agent: {
        systemPromptFile: path.join(tempDir, 'AGENT.md'),
        skillsIndexFile: legacyPath,
        rulesFile: path.join(tempDir, 'NUTRITION_RULES.md'),
      },
    });

    expect(skillsIndexText).toContain('fallback_tool');
    expect(skillsIndexText).toContain('plural file');
  });

  test('falls back from missing SKILLS_INDEX.md to existing SKILL_INDEX.md', async () => {
    const agentRuntime = agentRuntimeModule;
    const loadAgentRuntimeSkillsIndexText = getRequiredFunction<
      (config: {
        agent: {
          systemPromptFile: string;
          skillsIndexFile: string;
          rulesFile: string;
        };
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).loadAgentRuntimeSkillsIndexText,
      'loadAgentRuntimeSkillsIndexText'
    );

    const tempDir = await createTempDir();
    const legacyPath = path.join(tempDir, 'SKILL_INDEX.md');
    const pluralPath = path.join(tempDir, 'SKILLS_INDEX.md');
    await writeFile(legacyPath, '# Skills\n- `fallback_tool`: from singular file\n');

    const skillsIndexText = loadAgentRuntimeSkillsIndexText({
      agent: {
        systemPromptFile: path.join(tempDir, 'AGENT.md'),
        skillsIndexFile: pluralPath,
        rulesFile: path.join(tempDir, 'NUTRITION_RULES.md'),
      },
    });

    expect(skillsIndexText).toContain('fallback_tool');
    expect(skillsIndexText).toContain('singular file');
  });
});

describe('buildResponseFormatInstructions', () => {
  test('derives current default response guidance from resolved config responseStyle', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildResponseFormatInstructions = getRequiredFunction<
      (responseStyle: {
        language: string;
        paragraphStyle: 'short' | 'medium' | 'long';
        useNumberedListsForAdvice: boolean;
        allowMarkdownTables: boolean;
        allowRawJson: boolean;
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).buildResponseFormatInstructions,
      'buildResponseFormatInstructions'
    );

    const instructions = buildResponseFormatInstructions({
      language: 'zh-TW',
      paragraphStyle: 'short',
      useNumberedListsForAdvice: true,
      allowMarkdownTables: false,
      allowRawJson: false,
    });

    expect(instructions).toContain('Traditional Chinese');
    expect(instructions).toContain('short paragraphs');
    expect(instructions).toContain('use numbered lists');
    expect(instructions).toContain('Keep headings minimal');
    expect(instructions).toContain('Do not output markdown tables');
    expect(instructions).toContain('Do not output raw JSON');
    expect(instructions).toContain('convert it into concise Traditional Chinese explanation');
    expect(instructions).toContain('End cleanly without meta commentary');
  });

  test('adjusts tool-json explanation language when response language changes', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildResponseFormatInstructions = getRequiredFunction<
      (responseStyle: {
        language: string;
        paragraphStyle: 'short' | 'medium' | 'long';
        useNumberedListsForAdvice: boolean;
        allowMarkdownTables: boolean;
        allowRawJson: boolean;
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).buildResponseFormatInstructions,
      'buildResponseFormatInstructions'
    );

    const instructions = buildResponseFormatInstructions({
      language: 'en',
      paragraphStyle: 'short',
      useNumberedListsForAdvice: true,
      allowMarkdownTables: false,
      allowRawJson: false,
    });

    expect(instructions).toContain('Use en.');
    expect(instructions).toContain('convert it into concise explanation in en');
    expect(instructions).not.toContain('Traditional Chinese explanation');
  });

  test('uses allowRawJson as the single source of truth for raw-json guidance', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildResponseFormatInstructions = getRequiredFunction<
      (responseStyle: {
        language: string;
        paragraphStyle: 'short' | 'medium' | 'long';
        useNumberedListsForAdvice: boolean;
        allowMarkdownTables: boolean;
        allowRawJson: boolean;
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).buildResponseFormatInstructions,
      'buildResponseFormatInstructions'
    );

    const disallowInstructions = buildResponseFormatInstructions({
      language: 'zh-TW',
      paragraphStyle: 'short',
      useNumberedListsForAdvice: true,
      allowMarkdownTables: false,
      allowRawJson: false,
    });
    const allowInstructions = buildResponseFormatInstructions({
      language: 'zh-TW',
      paragraphStyle: 'short',
      useNumberedListsForAdvice: true,
      allowMarkdownTables: false,
      allowRawJson: true,
    });

    expect(disallowInstructions).toContain('Do not output raw JSON');
    expect(allowInstructions).toContain('Raw JSON is allowed only when the user explicitly asks for it.');
    expect(allowInstructions).not.toContain('Do not output raw JSON');
  });
});

describe('buildResponseStylePromptSection', () => {
  test('does not append a second hardcoded raw-json ban outside config-driven guidance', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildResponseStylePromptSection = getRequiredFunction<
      (responseStyle: {
        language: string;
        paragraphStyle: 'short' | 'medium' | 'long';
        useNumberedListsForAdvice: boolean;
        allowMarkdownTables: boolean;
        allowRawJson: boolean;
      }) => string[]
    >(
      (agentRuntime as Record<string, unknown>).buildResponseStylePromptSection,
      'buildResponseStylePromptSection'
    );

    const promptSection = buildResponseStylePromptSection({
      language: 'zh-TW',
      paragraphStyle: 'short',
      useNumberedListsForAdvice: true,
      allowMarkdownTables: false,
      allowRawJson: true,
    });

    expect(promptSection).toEqual([
      '--- Response Style ---',
      expect.stringContaining('Raw JSON is allowed only when the user explicitly asks for it.'),
    ]);
    expect(promptSection.join('\n')).not.toContain('Never output raw JSON directly to the user.');
  });
});

describe('buildCallModelResponseStylePromptLines', () => {
  test('injects only the response-style section that callModel should place into the system prompt', async () => {
    const agentRuntime = agentRuntimeModule;
    const buildCallModelResponseStylePromptLines = getRequiredFunction<
      (responseStyle: {
        language: string;
        paragraphStyle: 'short' | 'medium' | 'long';
        useNumberedListsForAdvice: boolean;
        allowMarkdownTables: boolean;
        allowRawJson: boolean;
      }) => string[]
    >(
      (agentRuntime as Record<string, unknown>).buildCallModelResponseStylePromptLines,
      'buildCallModelResponseStylePromptLines'
    );
    const buildResponseFormatInstructions = getRequiredFunction<
      (responseStyle: {
        language: string;
        paragraphStyle: 'short' | 'medium' | 'long';
        useNumberedListsForAdvice: boolean;
        allowMarkdownTables: boolean;
        allowRawJson: boolean;
      }) => string
    >(
      (agentRuntime as Record<string, unknown>).buildResponseFormatInstructions,
      'buildResponseFormatInstructions'
    );

    const responseStyle = {
      language: 'zh-TW',
      paragraphStyle: 'short' as const,
      useNumberedListsForAdvice: true,
      allowMarkdownTables: false,
      allowRawJson: false,
    };

    expect(buildCallModelResponseStylePromptLines(responseStyle)).toEqual([
      '--- Response Style ---',
      buildResponseFormatInstructions(responseStyle),
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
  test('goes directly to local in auto mode when google key is unavailable', async () => {
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
      onStatus: (message) => statuses.push(message),
      invokeProvider: async (provider) => {
        calls.push(provider);
        return `reply:${provider}`;
      },
    });

    expect(result).toEqual({ provider: 'local', value: 'reply:local' });
    expect(calls).toEqual(['local']);
    expect(statuses).toEqual([
      'Model selected: local',
      'Provider local: requesting model response',
      'Provider local: response received',
    ]);
  });

  test('rejects google mode immediately when google key is unavailable', async () => {
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

    await expect(
      invokeWithModelRouting({
        modelSource: 'google',
        invokeProvider: async (provider) => {
          calls.push(provider);
          return `reply:${provider}`;
        },
      })
    ).rejects.toThrow('Google model requested but GEMINI_AI_API/GEMINI_API_KEY is not configured.');

    expect(calls).toEqual([]);
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
      'Provider google: requesting model response',
      'Google upstream failed, falling back to local model.',
      'Provider local: requesting model response',
      'Provider local: response received',
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
    expect(statuses).toEqual([
      'Model selected: google',
      'Provider google: requesting model response',
    ]);
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

  test('hides partial thought tags during streaming accumulation', async () => {
    const agentRuntime = agentRuntimeModule;
    const sanitizeAssistantStreamingText = getRequiredFunction<
      (message: string) => string
    >(
      (agentRuntime as Record<string, unknown>).sanitizeAssistantStreamingText,
      'sanitizeAssistantStreamingText'
    );

    expect(sanitizeAssistantStreamingText('測試猿你好！<tho')).toBe('測試猿你好！');
    expect(sanitizeAssistantStreamingText('測試猿你好！<thought>內部推理')).toBe('測試猿你好！');
    expect(
      sanitizeAssistantStreamingText('測試猿你好！<thought>內部推理</thought>今天建議清淡飲食')
    ).toBe('測試猿你好！今天建議清淡飲食');
  });
});

describe('stream chunk accumulation', () => {
  test('formats SSE messages with explicit event names when provided', async () => {
    const agentRuntime = agentRuntimeModule;
    const formatSSEMessage = getRequiredFunction<
      (data: object, eventName?: string) => string
    >(
      (agentRuntime as Record<string, unknown>).formatSSEMessage,
      'formatSSEMessage'
    );

    expect(formatSSEMessage({ type: 'text', content: 'hi' }, 'text')).toBe(
      'event: text\ndata: {"type":"text","content":"hi"}\n\n'
    );
    expect(formatSSEMessage({ type: 'status', content: 'thinking' })).toBe(
      'event: status\ndata: {"type":"status","content":"thinking"}\n\n'
    );
  });

  test('extracts only the new delta text from cumulative chunks', async () => {
    const agentRuntime = agentRuntimeModule;
    const appendStreamChunk = getRequiredFunction<
      (
        existing: string,
        incoming: string
      ) => { nextText: string; deltaText: string }
    >(
      (agentRuntime as Record<string, unknown>).appendStreamChunk,
      'appendStreamChunk'
    );

    expect(appendStreamChunk('', 'Hello')).toEqual({
      nextText: 'Hello',
      deltaText: 'Hello',
    });
    expect(appendStreamChunk('Hello', 'Hello world')).toEqual({
      nextText: 'Hello world',
      deltaText: ' world',
    });
    expect(appendStreamChunk('Hello world', '!')).toEqual({
      nextText: 'Hello world!',
      deltaText: '!',
    });
  });
});
