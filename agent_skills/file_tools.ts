import fs from 'fs';
import path from 'path';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { loadDefaultAgentConfig, type AgentConfig } from '../src/config/agentConfig';

const ROOT_DIR = path.resolve(__dirname, '..');

export type SourceType = 'nutrition_rules' | 'mohw_news' | 'uploaded_knowledge';

export type KnowledgeChunk = {
  chunkId: string;
  sourceType: SourceType;
  title: string;
  sourcePath: string;
  publishedDate: string | null;
  content: string;
};

export type KnowledgeRuntimeConfig = {
  enabledSources: SourceType[];
  paths: {
    knowledgeBaseDir: string;
    nutritionRulesFile: string;
    mohwArticlesDir: string;
    uploadedMarkdownDir: string;
  };
  search: {
    cacheTtlMs: number;
    maxKeywords: number;
    chunkChars: number;
    defaultTopK: number;
    maxTopK: number;
  };
};

let cacheExpiresAt = 0;
let cachedChunks: KnowledgeChunk[] = [];
let cachedConfigKey = '';

export const invalidateKnowledgeSearchCache = (): void => {
  cacheExpiresAt = 0;
  cachedChunks = [];
  cachedConfigKey = '';
};

const ensureDir = (dir: string): void => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();

const toPosixRelative = (absolutePath: string): string =>
  path.relative(ROOT_DIR, absolutePath).replace(/\\/g, '/');

const readTextFileSafe = (absolutePath: string): string => {
  try {
    return fs.readFileSync(absolutePath, 'utf8');
  } catch {
    return '';
  }
};

const listMarkdownFilesRecursively = (baseDir: string): string[] => {
  if (!fs.existsSync(baseDir)) return [];
  const output: string[] = [];
  const stack = [baseDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolutePath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        output.push(absolutePath);
      }
    }
  }

  return output;
};

const splitIntoParagraphChunks = (text: string, maxChunkChars: number): string[] => {
  const blocks = text
    .split(/\n{2,}/)
    .map((item) => normalizeWhitespace(item))
    .filter((item) => item.length > 0);

  const chunks: string[] = [];
  let current = '';
  const pushOversizedBlock = (block: string): void => {
    for (let index = 0; index < block.length; index += maxChunkChars) {
      chunks.push(block.slice(index, index + maxChunkChars));
    }
  };

  for (const block of blocks) {
    if (block.length > maxChunkChars) {
      if (current.length > 0) {
        chunks.push(current);
        current = '';
      }
      pushOversizedBlock(block);
      continue;
    }

    if (current.length === 0) {
      current = block;
      continue;
    }
    if (current.length + block.length + 2 <= maxChunkChars) {
      current = `${current}\n\n${block}`;
      continue;
    }
    chunks.push(current);
    current = block;
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [normalizeWhitespace(text).slice(0, maxChunkChars)];
};

const extractTitle = (markdown: string, fallback: string): string => {
  const h1 = markdown.match(/^#\s+(.+)$/m)?.[1];
  const title = normalizeWhitespace(h1 || '');
  return title.length > 0 ? title : fallback;
};

const readFrontMatterValue = (markdown: string, fieldName: string): string | null => {
  const match = markdown.match(new RegExp(`^- ${fieldName}:\\s*(.+)$`, 'm'));
  const value = normalizeWhitespace(match?.[1] || '');
  return value.length > 0 ? value : null;
};

const parsePublishedDate = (markdown: string, absolutePath?: string): string | null => {
  const lineDate = markdown.match(/^- date:\s*(.+)$/m)?.[1];
  if (lineDate) {
    const normalized = normalizeWhitespace(lineDate);
    if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(normalized)) return normalized;
  }

  if (absolutePath) {
    const fileDate = path.basename(absolutePath).match(/^(\d{4}-\d{2}-\d{2})_\d+\.md$/)?.[1];
    if (fileDate) return fileDate;
  }

  const fileDateInTitle = markdown.match(/^#\s+(\d{4}-\d{1,2}-\d{1,2})/m)?.[1];
  return fileDateInTitle || null;
};

export const resolveKnowledgeRuntimeConfig = (
  config: Pick<AgentConfig, 'rag'>
): KnowledgeRuntimeConfig => ({
  enabledSources: [...config.rag.enabledSources],
  paths: {
    knowledgeBaseDir: config.rag.paths.knowledgeBaseDir,
    nutritionRulesFile: config.rag.paths.nutritionRulesFile,
    mohwArticlesDir: config.rag.paths.mohwArticlesDir,
    uploadedMarkdownDir: config.rag.paths.uploadedMarkdownDir,
  },
  search: {
    cacheTtlMs: config.rag.search.cacheTtlMs,
    maxKeywords: config.rag.search.maxKeywords,
    chunkChars: config.rag.search.chunkChars,
    defaultTopK: config.rag.search.defaultTopK,
    maxTopK: config.rag.search.maxTopK,
  },
});

const buildConfigCacheKey = (config: Pick<AgentConfig, 'rag'>): string =>
  JSON.stringify(resolveKnowledgeRuntimeConfig(config));

export const buildKnowledgeCorpus = (config: Pick<AgentConfig, 'rag'>): KnowledgeChunk[] => {
  const runtimeConfig = resolveKnowledgeRuntimeConfig(config);
  const chunks: KnowledgeChunk[] = [];
  const enabledSources = new Set(runtimeConfig.enabledSources);

  if (enabledSources.has('nutrition_rules') && fs.existsSync(runtimeConfig.paths.nutritionRulesFile)) {
    const markdown = readTextFileSafe(runtimeConfig.paths.nutritionRulesFile);
    const parts = splitIntoParagraphChunks(markdown, runtimeConfig.search.chunkChars);
    for (let i = 0; i < parts.length; i += 1) {
      chunks.push({
        chunkId: `nutrition_rules:${i}`,
        sourceType: 'nutrition_rules',
        title: extractTitle(markdown, 'Nutrition Rules'),
        sourcePath: toPosixRelative(runtimeConfig.paths.nutritionRulesFile),
        publishedDate: null,
        content: parts[i] || '',
      });
    }
  }

  if (enabledSources.has('mohw_news')) {
    const mohwFiles = listMarkdownFilesRecursively(runtimeConfig.paths.mohwArticlesDir);
    for (const absolutePath of mohwFiles) {
      const markdown = readTextFileSafe(absolutePath);
      if (!markdown) continue;
      const title = extractTitle(markdown, path.basename(absolutePath));
      const publishedDate = parsePublishedDate(markdown, absolutePath);
      const parts = splitIntoParagraphChunks(markdown, runtimeConfig.search.chunkChars);
      for (let i = 0; i < parts.length; i += 1) {
        chunks.push({
          chunkId: `mohw_news:${path.basename(absolutePath)}:${i}`,
          sourceType: 'mohw_news',
          title,
          sourcePath: toPosixRelative(absolutePath),
          publishedDate,
          content: parts[i] || '',
        });
      }
    }
  }

  if (enabledSources.has('uploaded_knowledge')) {
    const ingestedFiles = listMarkdownFilesRecursively(runtimeConfig.paths.uploadedMarkdownDir);
    for (const absolutePath of ingestedFiles) {
      const markdown = readTextFileSafe(absolutePath);
      if (!markdown) continue;
      const sourcePath = readFrontMatterValue(markdown, 'source_path') || toPosixRelative(absolutePath);
      const sourceName = path.basename(sourcePath);
      const title = extractTitle(markdown, path.basename(absolutePath));
      const parts = splitIntoParagraphChunks(markdown, runtimeConfig.search.chunkChars);
      for (let i = 0; i < parts.length; i += 1) {
        chunks.push({
          chunkId: `uploaded_knowledge:${sourceName}:${i}`,
          sourceType: 'uploaded_knowledge',
          title,
          sourcePath,
          publishedDate: null,
          content: parts[i] || '',
        });
      }
    }
  }

  return chunks;
};

const loadKnowledgeConfig = async (): Promise<Pick<AgentConfig, 'rag'>> => loadDefaultAgentConfig();

const getCorpus = async (
  config: Pick<AgentConfig, 'rag'>,
  forceRefresh: boolean
): Promise<KnowledgeChunk[]> => {
  const now = Date.now();
  const configKey = buildConfigCacheKey(config);
  const runtimeConfig = resolveKnowledgeRuntimeConfig(config);
  if (
    !forceRefresh &&
    configKey === cachedConfigKey &&
    now < cacheExpiresAt &&
    cachedChunks.length > 0
  ) {
    return cachedChunks;
  }
  cachedChunks = buildKnowledgeCorpus(config);
  cachedConfigKey = configKey;
  cacheExpiresAt = now + runtimeConfig.search.cacheTtlMs;
  return cachedChunks;
};

const extractQueryKeywords = (query: string, maxKeywords: number): string[] => {
  const normalized = query.toLowerCase();
  const tokens = new Set<string>();

  const asciiWords = normalized.match(/[a-z0-9]{2,}/g) || [];
  for (const word of asciiWords) tokens.add(word);

  const cjkBlocks = query.match(/[\u4e00-\u9fff]{2,}/g) || [];
  for (const block of cjkBlocks) {
    const compact = block.trim();
    if (compact.length < 2) continue;
    for (let i = 0; i < compact.length - 1; i += 1) {
      tokens.add(compact.slice(i, i + 2));
    }
    tokens.add(compact);
  }

  return Array.from(tokens).slice(0, maxKeywords);
};

const scoreChunk = (chunk: KnowledgeChunk, query: string, keywords: string[]): number => {
  if (keywords.length === 0) return 0;
  const contentLower = chunk.content.toLowerCase();
  const titleLower = chunk.title.toLowerCase();
  const queryLower = query.toLowerCase();
  let score = 0;

  for (const keyword of keywords) {
    if (contentLower.includes(keyword)) score += 2;
    if (titleLower.includes(keyword)) score += 3;
  }

  if (queryLower.length > 3 && contentLower.includes(queryLower)) score += 6;
  if (queryLower.length > 3 && titleLower.includes(queryLower)) score += 8;

  if (chunk.sourceType === 'mohw_news' && chunk.publishedDate) {
    const dateValue = Date.parse(`${chunk.publishedDate}T00:00:00Z`);
    if (Number.isFinite(dateValue)) {
      const ageDays = (Date.now() - dateValue) / (24 * 60 * 60 * 1000);
      if (ageDays <= 7) score += 3;
      else if (ageDays <= 30) score += 2;
      else if (ageDays <= 90) score += 1;
    }
  }

  return score;
};

export const clampKnowledgeTopK = (
  requestedTopK: number | undefined,
  config: Pick<AgentConfig, 'rag'>
): number => {
  const { defaultTopK, maxTopK } = resolveKnowledgeRuntimeConfig(config).search;
  const topK = requestedTopK ?? defaultTopK;
  return Math.max(1, Math.min(maxTopK, topK));
};

export const findKnowledgeInCorpus = (input: {
  query: string;
  topK: number;
  sourceTypes?: SourceType[];
}, corpus: KnowledgeChunk[], config: Pick<AgentConfig, 'rag'>) => {
  const runtimeConfig = resolveKnowledgeRuntimeConfig(config);
  const query = normalizeWhitespace(input.query);
  const topK = clampKnowledgeTopK(input.topK, config);
  const allowed = input.sourceTypes && input.sourceTypes.length > 0 ? new Set(input.sourceTypes) : null;
  const keywords = extractQueryKeywords(query, runtimeConfig.search.maxKeywords);

  const scored = corpus
    .filter((chunk) => (allowed ? allowed.has(chunk.sourceType) : true))
    .map((chunk) => ({
      chunk,
      score: scoreChunk(chunk, query, keywords),
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored.map((item) => ({
    id: item.chunk.chunkId,
    source_type: item.chunk.sourceType,
    title: item.chunk.title,
    source_path: item.chunk.sourcePath,
    published_date: item.chunk.publishedDate,
    score: item.score,
    snippet: item.chunk.content.slice(0, 450),
  }));
};

const findKnowledge = async (input: {
  query: string;
  topK?: number;
  sourceTypes?: SourceType[];
  forceRefresh?: boolean;
}, config: Pick<AgentConfig, 'rag'>) => {
  const corpus = await getCorpus(config, Boolean(input.forceRefresh));
  return findKnowledgeInCorpus(
    {
      query: input.query,
      topK: input.topK ?? resolveKnowledgeRuntimeConfig(config).search.defaultTopK,
      sourceTypes: input.sourceTypes,
    },
    corpus,
    config,
  );
};

export const readKnowledgeTool = tool(
  async () => {
    const config = await loadKnowledgeConfig();
    const rulesFilePath = resolveKnowledgeRuntimeConfig(config).paths.nutritionRulesFile;
    if (!fs.existsSync(rulesFilePath)) {
      return 'Knowledge file NUTRITION_RULES.md was not found.';
    }
    const content = fs.readFileSync(rulesFilePath, 'utf8');
    return `--- NUTRITION_RULES.md ---\n${content}\n--- END ---`;
  },
  {
    name: 'read_knowledge_tool',
    description: 'Read local nutrition rules markdown content.',
    schema: z.object({}),
  },
);

export const updateKnowledgeTool = tool(
  async ({ newRules, overwrite }) => {
    const config = await loadKnowledgeConfig();
    const runtimeConfig = resolveKnowledgeRuntimeConfig(config);
    const rulesFilePath = runtimeConfig.paths.nutritionRulesFile;
    if (!rulesFilePath.startsWith(runtimeConfig.paths.knowledgeBaseDir)) {
      return 'Blocked by path safety rule.';
    }
    ensureDir(path.dirname(rulesFilePath));

    if (overwrite) {
      fs.writeFileSync(rulesFilePath, newRules, 'utf8');
    } else {
      const current = fs.existsSync(rulesFilePath) ? fs.readFileSync(rulesFilePath, 'utf8') : '';
      const next = `${current}\n\n${newRules}`.trim();
      fs.writeFileSync(rulesFilePath, next, 'utf8');
    }

    invalidateKnowledgeSearchCache();
    return overwrite
      ? 'Knowledge rules overwritten successfully.'
      : 'Knowledge rules appended successfully.';
  },
  {
    name: 'update_knowledge_tool',
    description: 'Update local nutrition rules markdown file.',
    schema: z.object({
      newRules: z.string().min(1).describe('Markdown content to write or append.'),
      overwrite: z.boolean().describe('If true, replace entire file; otherwise append.'),
    }),
  },
);

export const searchKnowledgeTool = tool(
  async ({ query, top_k, source_types, force_refresh }) => {
    const config = await loadKnowledgeConfig();
    const hits = await findKnowledge({
      query,
      topK: top_k,
      sourceTypes: source_types as SourceType[] | undefined,
      forceRefresh: force_refresh,
    }, config);

    return JSON.stringify({
      query,
      total_hits: hits.length,
      hits,
    });
  },
  {
    name: 'search_knowledge_tool',
    description:
      'Search local knowledge markdown corpus (MOHW news, uploaded documents, nutrition rules) and return top relevant snippets with source paths.',
    schema: z.object({
      query: z.string().min(1).describe('User question or search query.'),
      top_k: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('Optional result count. Defaults to the configured value and is capped by the configured maximum.'),
      source_types: z
        .array(z.enum(['nutrition_rules', 'mohw_news', 'uploaded_knowledge']))
        .optional()
        .describe('Optional source filter.'),
      force_refresh: z.boolean().optional().default(false),
    }),
  },
);
