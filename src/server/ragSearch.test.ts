import { describe, expect, test } from 'bun:test';

import { loadDefaultAgentConfig } from '../config/agentConfig';
import { parseRagSearchPayload } from './ragSearch';

describe('parseRagSearchPayload', () => {
  test('uses config-driven default and max top-k constraints', async () => {
    const config = await loadDefaultAgentConfig();

    const defaultParsed = parseRagSearchPayload({ query: 'protein' }, config);
    expect(defaultParsed.success).toBe(true);
    if (defaultParsed.success) {
      expect(defaultParsed.data.top_k).toBe(5);
    }

    const overMaxParsed = parseRagSearchPayload({ query: 'protein', top_k: 99 }, config);
    expect(overMaxParsed.success).toBe(false);
  });

  test('treats force_refresh=false as false instead of coercing it to true', async () => {
    const config = await loadDefaultAgentConfig();

    const parsed = parseRagSearchPayload({ query: 'protein', force_refresh: 'false' }, config);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.force_refresh).toBe(false);
    }
  });

  test('uses non-default config bounds for top_k default and validation', () => {
    const config = {
      rag: {
        enabledSources: ['nutrition_rules', 'mohw_news', 'uploaded_knowledge'] as const,
        paths: {
          knowledgeBaseDir: 'knowledge_base',
          nutritionRulesFile: 'knowledge_base/NUTRITION_RULES.md',
          mohwArticlesDir: 'knowledge_base/mohw_clarifications/articles',
          uploadedMarkdownDir: 'knowledge_base/ingested_markdown',
        },
        search: {
          cacheTtlMs: 120000,
          maxKeywords: 48,
          chunkChars: 900,
          defaultTopK: 3,
          maxTopK: 4,
        },
      },
    };

    const defaultParsed = parseRagSearchPayload({ query: 'protein' }, config);
    expect(defaultParsed.success).toBe(true);
    if (defaultParsed.success) {
      expect(defaultParsed.data.top_k).toBe(3);
    }

    const overMaxParsed = parseRagSearchPayload({ query: 'protein', top_k: 5 }, config);
    expect(overMaxParsed.success).toBe(false);
  });
});
