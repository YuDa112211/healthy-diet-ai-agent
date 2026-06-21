import { tool } from '@langchain/core/tools';
import { z } from 'zod';

import { createLocalChatModel } from '../src/server/modelRouting';

const ConversationSummaryToolResultSchema = z.object({
  should_persist: z.boolean(),
  compact_summary: z.string(),
  detailed_summary: z.string(),
  reason: z.string(),
});

export type ConversationSummaryToolResult = z.infer<typeof ConversationSummaryToolResultSchema>;

const parseJsonSafe = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const normalizeToolOutputCandidate = (rawOutput: unknown): unknown => {
  let candidate: unknown = rawOutput;
  if (typeof candidate === 'string') {
    candidate = parseJsonSafe(candidate);
  }

  if (!candidate || typeof candidate !== 'object') return candidate;
  const objectCandidate = candidate as Record<string, unknown>;

  if (typeof objectCandidate.content === 'string') {
    return parseJsonSafe(objectCandidate.content);
  }

  const kwargsContent =
    objectCandidate.kwargs &&
    typeof objectCandidate.kwargs === 'object' &&
    'content' in (objectCandidate.kwargs as Record<string, unknown>)
      ? (objectCandidate.kwargs as Record<string, unknown>).content
      : undefined;

  if (typeof kwargsContent === 'string') {
    return parseJsonSafe(kwargsContent);
  }

  return candidate;
};

export const parseConversationSummaryToolOutput = (
  rawOutput: unknown
): ConversationSummaryToolResult | null => {
  const candidate = normalizeToolOutputCandidate(rawOutput);
  const parsed = ConversationSummaryToolResultSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data;
};

const trivialExactPhrases = new Set([
  '你好',
  '哈囉',
  'hi',
  'hello',
  '謝謝',
  '收到',
  '好',
  'ok',
  'thanks',
]);

const containsAny = (text: string, patterns: string[]): boolean =>
  patterns.some((pattern) => text.includes(pattern));

export const buildSummaryPersistenceGuard = (input: {
  current_user_message: string;
  current_assistant_reply: string;
}): { shouldPersist: boolean; reason: string } => {
  const userText = input.current_user_message.trim();
  const assistantText = input.current_assistant_reply.trim();

  if (!userText || !assistantText) {
    return { shouldPersist: false, reason: 'empty-turn' };
  }

  if (
    trivialExactPhrases.has(userText.toLowerCase()) ||
    trivialExactPhrases.has(assistantText.toLowerCase())
  ) {
    return { shouldPersist: false, reason: 'trivial-turn' };
  }

  if (
    containsAny(assistantText.toLowerCase(), [
      'temporarily unreachable',
      'timed out',
      '請稍後再試',
      '暫時無法',
      '抱歉',
      'failed to process',
    ])
  ) {
    return { shouldPersist: false, reason: 'error-like-turn' };
  }

  return { shouldPersist: true, reason: 'durable-turn-detected' };
};

const localStructuredSummaryModel = createLocalChatModel();

export const generateConversationSummaryForTurn = async ({
  room_id,
  user_id,
  existing_room_summary,
  current_user_message,
  current_assistant_reply,
}: {
  room_id: string;
  user_id?: string;
  existing_room_summary?: string;
  current_user_message: string;
  current_assistant_reply: string;
}): Promise<ConversationSummaryToolResult> => {
  const guard = buildSummaryPersistenceGuard({
    current_user_message,
    current_assistant_reply,
  });

  if (!guard.shouldPersist) {
    return {
      should_persist: false,
      compact_summary: '',
      detailed_summary: '',
      reason: guard.reason,
    };
  }

  const structured = await localStructuredSummaryModel
    .withStructuredOutput(
      z.object({
        compact_summary: z.string(),
        detailed_summary: z.string(),
      })
    )
    .invoke([
      {
        role: 'system',
        content: [
          'You summarize meaningful conversation turns in Traditional Chinese.',
          'Use the existing room summary plus the latest user and assistant exchange.',
          'Return compact_summary as a concise room-memory summary.',
          'Return detailed_summary as a fuller archival summary for future retrieval.',
          'Do not include markdown tables or JSON outside the schema.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `room_id: ${room_id}`,
          user_id ? `user_id: ${user_id}` : 'user_id: unknown',
          `existing_room_summary: ${existing_room_summary?.trim() || '(none)'}`,
          `current_user_message: ${current_user_message}`,
          `current_assistant_reply: ${current_assistant_reply}`,
        ].join('\n\n'),
      },
    ]);

  return {
    should_persist: true,
    compact_summary: structured.compact_summary.trim(),
    detailed_summary: structured.detailed_summary.trim(),
    reason: guard.reason,
  };
};

export const decideConversationSummaryNeed = async ({
  room_id,
  user_id,
  existing_room_summary,
  current_user_message,
  current_assistant_reply,
}: {
  room_id: string;
  user_id?: string;
  existing_room_summary?: string;
  current_user_message: string;
  current_assistant_reply: string;
}): Promise<{ should_persist: boolean; reason: string }> => {
  const guard = buildSummaryPersistenceGuard({
    current_user_message,
    current_assistant_reply,
  });

  if (!guard.shouldPersist) {
    return {
      should_persist: false,
      reason: guard.reason,
    };
  }

  const decision = await localStructuredSummaryModel
    .withStructuredOutput(
      z.object({
        should_persist: z.boolean(),
        reason: z.string(),
      })
    )
    .invoke([
      {
        role: 'system',
        content: [
          'You decide whether a completed conversation turn deserves long-term memory.',
          'Use Traditional Chinese reasoning compressed into a short reason string.',
          'Mark should_persist true only when the turn has durable future value such as meal plans, personalized health analysis, nutrition strategy, verified recommendations, or stable user preferences.',
          'Mark should_persist false for greetings, retries, errors, tiny clarifications, or short low-value exchanges.',
          'Return only the schema.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `room_id: ${room_id}`,
          user_id ? `user_id: ${user_id}` : 'user_id: unknown',
          `existing_room_summary: ${existing_room_summary?.trim() || '(none)'}`,
          `current_user_message: ${current_user_message}`,
          `current_assistant_reply: ${current_assistant_reply}`,
        ].join('\n\n'),
      },
    ]);

  return {
    should_persist: decision.should_persist,
    reason: decision.reason.trim() || 'model-decision',
  };
};

export const summarizeConversationTurnTool = tool(
  async (input) => {
    const result = await generateConversationSummaryForTurn(input);
    return JSON.stringify(result satisfies ConversationSummaryToolResult);
  },
  {
    name: 'summarize_conversation_turn',
    description:
      'Use the local model to summarize a meaningful completed conversation turn into compact room memory and detailed archival memory.',
    schema: z.object({
      room_id: z.string(),
      user_id: z.string().optional(),
      existing_room_summary: z.string().optional(),
      current_user_message: z.string(),
      current_assistant_reply: z.string(),
    }),
  }
);
