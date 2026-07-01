import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  resolveKnowledgeRuntimeConfig,
  searchKnowledgeTool,
} from '../../agent_skills/file_tools';
import { loadDefaultAgentConfig, type AgentConfig } from '../config/agentConfig';

const BooleanLikeSchema = z.union([z.boolean(), z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected boolean-like value' });
    return z.NEVER;
  }

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;

  ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Expected boolean-like value' });
  return z.NEVER;
});

export const buildRagSearchSchema = (config: Pick<AgentConfig, 'rag'>) => {
  const runtimeConfig = resolveKnowledgeRuntimeConfig(config);

  return z.object({
    query: z.string().trim().min(1),
    top_k: z.coerce.number().int().min(1).max(runtimeConfig.search.maxTopK).optional().default(
      runtimeConfig.search.defaultTopK,
    ),
    source_types: z
      .array(z.enum(['nutrition_rules', 'mohw_news', 'uploaded_knowledge']))
      .optional(),
    force_refresh: BooleanLikeSchema.optional().default(false),
  });
};

export const parseRagSearchPayload = (
  payload: unknown,
  config: Pick<AgentConfig, 'rag'>,
) => buildRagSearchSchema(config).safeParse(payload);

const runSearch = async (
  payload: {
    query: string;
    top_k: number;
    source_types?: Array<'nutrition_rules' | 'mohw_news' | 'uploaded_knowledge'>;
    force_refresh: boolean;
  },
) => {
  const toolOutput = await searchKnowledgeTool.invoke({
    query: payload.query,
    top_k: payload.top_k,
    source_types: payload.source_types,
    force_refresh: payload.force_refresh,
  });

  if (typeof toolOutput !== 'string') {
    return { query: payload.query, total_hits: 0, hits: [] as unknown[] };
  }

  try {
    return JSON.parse(toolOutput) as {
      query: string;
      total_hits: number;
      hits: Array<{
        id: string;
        source_type: string;
        title: string;
        source_path: string;
        published_date: string | null;
        score: number;
        snippet: string;
      }>;
    };
  } catch {
    return { query: payload.query, total_hits: 0, hits: [] as unknown[] };
  }
};

export const ragSearchHandler = async (req: Request, res: Response): Promise<void> => {
  const config = await loadDefaultAgentConfig();
  const parsed = parseRagSearchPayload(req.method === 'GET' ? req.query : req.body, config);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: 'invalid_payload',
      details: parsed.error.flatten(),
    });
    return;
  }

  const result = await runSearch(parsed.data);
  res.json({ ok: true, ...result });
};
