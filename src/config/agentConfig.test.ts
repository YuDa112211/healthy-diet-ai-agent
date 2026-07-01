import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { ROOT_DIR } from '../server/workspacePaths';
import {
  DEFAULT_AGENT_CONFIG_PATH,
  KNOWN_AGENT_RAG_SOURCE_TYPES,
  loadAgentConfig,
  loadDefaultAgentConfig,
} from './agentConfig';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((tempDir) => rm(tempDir, { recursive: true, force: true })),
  );
});

async function writeTempConfig(config: unknown): Promise<string> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agent-config-'));
  tempDirs.push(tempDir);

  const configPath = path.join(tempDir, 'agent_config.json');
  await writeFile(configPath, JSON.stringify(config, null, 2));
  return configPath;
}

function buildRawConfig(overrides?: Partial<Record<string, unknown>>) {
  return {
    agent: {
      name: 'Healthy Diet AI Agent',
      description: 'Nutrition and healthy-diet advisor',
      system_prompt_file: 'knowledge_base/AGENT.md',
      skills_index_file: 'knowledge_base/SKILL_INDEX.md',
      rules_file: 'knowledge_base/NUTRITION_RULES.md',
    },
    response_style: {
      language: 'zh-TW',
      paragraph_style: 'short',
      use_numbered_lists_for_advice: true,
      allow_markdown_tables: false,
      allow_raw_json: false,
    },
    features: {
      mohw_enabled: true,
    },
    rag: {
      enabled_sources: ['nutrition_rules', 'mohw_news', 'uploaded_knowledge'],
      paths: {
        knowledge_base_dir: 'knowledge_base',
        nutrition_rules_file: 'knowledge_base/NUTRITION_RULES.md',
        mohw_articles_dir: 'knowledge_base/mohw_clarifications/articles',
        uploaded_markdown_dir: 'knowledge_base/ingested_markdown',
      },
      search: {
        cache_ttl_ms: 120000,
        max_keywords: 48,
        chunk_chars: 900,
        default_top_k: 5,
        max_top_k: 12,
      },
    },
    ...overrides,
  };
}

describe('agentConfig', () => {
  test('loads the default repo config and resolves repo-root-relative paths', async () => {
    const config = await loadDefaultAgentConfig();

    expect(DEFAULT_AGENT_CONFIG_PATH).toBe(path.join(ROOT_DIR, 'agent_config.json'));
    expect(config.agent.name).toBe('Healthy Diet AI Agent');
    expect(config.agent.description).toBe('Nutrition and healthy-diet advisor');
    expect(config.agent.systemPromptFile).toBe(path.join(ROOT_DIR, 'knowledge_base', 'AGENT.md'));
    expect(config.agent.skillsIndexFile).toBe(path.join(ROOT_DIR, 'knowledge_base', 'SKILL_INDEX.md'));
    expect(config.agent.rulesFile).toBe(path.join(ROOT_DIR, 'knowledge_base', 'NUTRITION_RULES.md'));
    expect(config.responseStyle.language).toBe('zh-TW');
    expect(config.responseStyle.paragraphStyle).toBe('short');
    expect(config.features.mohwEnabled).toBe(true);
    expect(config.rag.enabledSources).toContain('mohw_news');
    expect(config.rag.paths.knowledgeBaseDir).toBe(path.join(ROOT_DIR, 'knowledge_base'));
    expect(config.rag.paths.mohwArticlesDir).toBe(
      path.join(ROOT_DIR, 'knowledge_base', 'mohw_clarifications', 'articles'),
    );
    expect(config.rag.search.cacheTtlMs).toBe(120000);
    expect(config.rag.search.maxTopK).toBe(12);
  });

  test('exports known source types that include mohw_news', () => {
    expect(KNOWN_AGENT_RAG_SOURCE_TYPES).toContain('mohw_news');
  });

  test('resolves relative paths from the provided config file directory', async () => {
    const configPath = await writeTempConfig(buildRawConfig());
    const config = await loadAgentConfig(configPath);

    const configDir = path.dirname(configPath);
    expect(config.agent.systemPromptFile).toBe(path.join(configDir, 'knowledge_base', 'AGENT.md'));
    expect(config.rag.paths.uploadedMarkdownDir).toBe(
      path.join(configDir, 'knowledge_base', 'ingested_markdown'),
    );
  });

  test('rejects paths that escape the config file directory', async () => {
    const configPath = await writeTempConfig(
      buildRawConfig({
        rag: {
          enabled_sources: ['nutrition_rules', 'mohw_news', 'uploaded_knowledge'],
          paths: {
            knowledge_base_dir: '../outside',
            nutrition_rules_file: 'knowledge_base/NUTRITION_RULES.md',
            mohw_articles_dir: 'knowledge_base/mohw_clarifications/articles',
            uploaded_markdown_dir: 'knowledge_base/ingested_markdown',
          },
          search: {
            cache_ttl_ms: 120000,
            max_keywords: 48,
            chunk_chars: 900,
            default_top_k: 5,
            max_top_k: 12,
          },
        },
      }),
    );

    await expect(loadAgentConfig(configPath)).rejects.toThrow(/must stay within the config directory/i);
  });

  test('rejects search settings when default_top_k exceeds max_top_k', async () => {
    const configPath = await writeTempConfig(
      buildRawConfig({
        rag: {
          enabled_sources: ['nutrition_rules', 'mohw_news', 'uploaded_knowledge'],
          paths: {
            knowledge_base_dir: 'knowledge_base',
            nutrition_rules_file: 'knowledge_base/NUTRITION_RULES.md',
            mohw_articles_dir: 'knowledge_base/mohw_clarifications/articles',
            uploaded_markdown_dir: 'knowledge_base/ingested_markdown',
          },
          search: {
            cache_ttl_ms: 120000,
            max_keywords: 48,
            chunk_chars: 900,
            default_top_k: 13,
            max_top_k: 12,
          },
        },
      }),
    );

    await expect(loadAgentConfig(configPath)).rejects.toThrow(/default_top_k/i);
  });
});
