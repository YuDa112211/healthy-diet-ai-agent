import type { Request, Response } from 'express';
import { z } from 'zod';
import { searchKnowledgeTool } from '../../agent_skills/file_tools';

const RagSearchSchema = z.object({
  query: z.string().trim().min(1),
  top_k: z.coerce.number().int().min(1).max(12).optional().default(5),
  source_types: z
    .array(z.enum(['nutrition_rules', 'mohw_news', 'uploaded_knowledge']))
    .optional(),
  force_refresh: z.coerce.boolean().optional().default(false),
});

const runSearch = async (payload: z.infer<typeof RagSearchSchema>) => {
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
  const parsed = RagSearchSchema.safeParse(req.method === 'GET' ? req.query : req.body);
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

