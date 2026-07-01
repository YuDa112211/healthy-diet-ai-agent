import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadDefaultAgentConfig } from '../src/config/agentConfig';
import {
  buildKnowledgeCorpus,
  clampKnowledgeTopK,
  findKnowledgeInCorpus,
  resolveKnowledgeRuntimeConfig,
  searchKnowledgeTool,
} from './file_tools';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })));
});

const createTempKnowledgeLayout = async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-config-'));
  tempDirs.push(tempDir);

  const knowledgeBaseDir = path.join(tempDir, 'knowledge_base');
  const rulesFile = path.join(knowledgeBaseDir, 'NUTRITION_RULES.md');
  const mohwArticlesDir = path.join(knowledgeBaseDir, 'mohw_clarifications', 'articles');
  const uploadedMarkdownDir = path.join(knowledgeBaseDir, 'ingested_markdown');

  await mkdir(mohwArticlesDir, { recursive: true });
  await mkdir(uploadedMarkdownDir, { recursive: true });
  await writeFile(rulesFile, '# Nutrition Rules\nFiber supports digestion.\n');
  await writeFile(path.join(mohwArticlesDir, '2026-07-01_1.md'), '# MOHW Alert\nMOHW update on food labeling.\n');
  await writeFile(path.join(uploadedMarkdownDir, 'notes.md'), '# Uploaded Notes\nPersonal knowledge base note.\n');

  return {
    knowledgeBaseDir,
    rulesFile,
    mohwArticlesDir,
    uploadedMarkdownDir,
  };
};

describe('resolveKnowledgeRuntimeConfig', () => {
  test('matches the checked-in default search settings', async () => {
    const config = await loadDefaultAgentConfig();
    const runtimeConfig = resolveKnowledgeRuntimeConfig(config);

    expect(runtimeConfig.search.cacheTtlMs).toBe(120000);
    expect(runtimeConfig.search.maxKeywords).toBe(48);
    expect(runtimeConfig.search.chunkChars).toBe(900);
    expect(runtimeConfig.search.defaultTopK).toBe(5);
    expect(runtimeConfig.search.maxTopK).toBe(12);
    expect(runtimeConfig.enabledSources).toContain('mohw_news');
  });
});

describe('buildKnowledgeCorpus', () => {
  test('excludes disabled mohw_news from corpus and search results', async () => {
    const layout = await createTempKnowledgeLayout();
    const config = {
      rag: {
        enabledSources: ['nutrition_rules', 'uploaded_knowledge'] as const,
        paths: {
          knowledgeBaseDir: layout.knowledgeBaseDir,
          nutritionRulesFile: layout.rulesFile,
          mohwArticlesDir: layout.mohwArticlesDir,
          uploadedMarkdownDir: layout.uploadedMarkdownDir,
        },
        search: {
          cacheTtlMs: 120000,
          maxKeywords: 48,
          chunkChars: 900,
          defaultTopK: 5,
          maxTopK: 12,
        },
      },
    };

    const corpus = buildKnowledgeCorpus(config);
    expect(corpus.some((chunk) => chunk.sourceType === 'mohw_news')).toBe(false);

    const hits = findKnowledgeInCorpus(
      {
        query: 'food labeling',
        topK: 5,
      },
      corpus,
      config,
    );

    expect(hits.some((hit) => hit.source_type === 'mohw_news')).toBe(false);
  });

  test('enforces configured chunk size for oversized single paragraphs and preserves custom source paths', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'knowledge-config-'));
    tempDirs.push(tempDir);

    const knowledgeBaseDir = path.join(tempDir, 'knowledge_base');
    const rulesFile = path.join(knowledgeBaseDir, 'NUTRITION_RULES.md');
    const uploadedMarkdownDir = path.join(knowledgeBaseDir, 'ingested_markdown');
    await mkdir(uploadedMarkdownDir, { recursive: true });

    const oversizedParagraph = 'A'.repeat(55);
    await writeFile(rulesFile, `# Nutrition Rules\n\n${oversizedParagraph}\n`);
    await writeFile(
      path.join(uploadedMarkdownDir, 'custom.md'),
      ['# Uploaded Note', '- source_path: custom/source.md', '', oversizedParagraph].join('\n'),
    );

    const config = {
      rag: {
        enabledSources: ['nutrition_rules', 'uploaded_knowledge'] as const,
        paths: {
          knowledgeBaseDir,
          nutritionRulesFile: rulesFile,
          mohwArticlesDir: path.join(knowledgeBaseDir, 'mohw_clarifications', 'articles'),
          uploadedMarkdownDir,
        },
        search: {
          cacheTtlMs: 120000,
          maxKeywords: 48,
          chunkChars: 20,
          defaultTopK: 5,
          maxTopK: 12,
        },
      },
    };

    const corpus = buildKnowledgeCorpus(config);

    expect(corpus.length).toBeGreaterThan(2);
    expect(corpus.every((chunk) => chunk.content.length <= 20)).toBe(true);
    expect(corpus.some((chunk) => chunk.sourcePath === 'custom/source.md')).toBe(true);
  });
});

describe('clampKnowledgeTopK', () => {
  test('keeps current default and max top-k behavior from config', async () => {
    const config = await loadDefaultAgentConfig();

    expect(clampKnowledgeTopK(undefined, config)).toBe(5);
    expect(clampKnowledgeTopK(99, config)).toBe(12);
    expect(clampKnowledgeTopK(0, config)).toBe(1);
  });

  test('uses non-default config values for default and max top-k', () => {
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

    expect(clampKnowledgeTopK(undefined, config)).toBe(3);
    expect(clampKnowledgeTopK(99, config)).toBe(4);
  });
});

describe('searchKnowledgeTool', () => {
  test('continues to work with the checked-in default config and repo knowledge files', async () => {
    const output = await searchKnowledgeTool.invoke({
      query: 'Protein',
      force_refresh: true,
    });

    expect(typeof output).toBe('string');
    const parsed = JSON.parse(output as string) as {
      total_hits: number;
      hits: Array<{ source_type: string; source_path: string }>;
    };

    expect(parsed.total_hits).toBeGreaterThan(0);
    expect(parsed.hits.some((hit) => hit.source_type === 'nutrition_rules')).toBe(true);
  });
});
