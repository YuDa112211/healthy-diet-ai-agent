import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { createClient } from '@supabase/supabase-js';
import { ChatOpenAI } from '@langchain/openai';
import { MemorySaver, StateGraph, START, END, MessagesAnnotation, Annotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';

import { readKnowledgeTool, updateKnowledgeTool } from '../agent_skills/admin_knowledge/file_tools';
import { visionAnalyzerTool } from '../agent_skills/vision_analyzer/vision_model';
import { calculateNutritionTool } from '../agent_skills/calorie_calculator/calc_tools';
import { getChatHistoryTool, getUserProfileTool, updateUserProfileTool } from '../agent_skills/supabase_logger/db_tools';
import { compressChatHistoryTool } from '../agent_skills/memory_summarizer/summarizer_tools';

const app = express();
app.use(cors());
const MAX_REQUEST_BODY_MB = Number(process.env.MAX_REQUEST_BODY_MB || 15);
const REQUEST_BODY_LIMIT = `${MAX_REQUEST_BODY_MB}mb`;
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: true, limit: REQUEST_BODY_LIMIT }));

const createRequestId = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const formatDurationMs = (startAt: number): string => `${Date.now() - startAt}ms`;

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

app.use((req: Request, res: Response, next) => {
  const requestId = req.header('x-request-id')?.trim() || createRequestId();
  const startAt = Date.now();
  res.locals.requestId = requestId;

  console.log(
    `[REQ ${requestId}] -> ${req.method} ${req.originalUrl} ip=${req.ip || 'unknown'} body=${JSON.stringify(
      sanitizeForLog(req.body)
    )}`
  );

  res.on('finish', () => {
    console.log(
      `[REQ ${requestId}] <- ${req.method} ${req.originalUrl} status=${res.statusCode} duration=${formatDurationMs(
        startAt
      )}`
    );
  });

  next();
});

const ROOT_DIR = path.resolve(__dirname, '..');
const USERS_IMAGES_DIR = path.join(ROOT_DIR, 'users_images');
const KNOWLEDGE_BASE_DIR = path.join(ROOT_DIR, 'knowledge_base');
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES || 10 * 1024 * 1024);

const AGENT_FILE = path.join(KNOWLEDGE_BASE_DIR, 'AGENT.md');
const INDEX_FILE = path.join(KNOWLEDGE_BASE_DIR, 'SKILLS_INDEX.md');
const RULES_FILE = path.join(KNOWLEDGE_BASE_DIR, 'NUTRITION_RULES.md');

app.use('/images', express.static(USERS_IMAGES_DIR));

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const sanitizePathToken = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

const parseDataUrlImage = (
  raw: string
): { mimeType: string; buffer: Buffer } | null => {
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mimeTypeRaw = match[1];
  const base64 = match[2];
  if (!mimeTypeRaw || !base64) return null;
  const mimeType = mimeTypeRaw.toLowerCase();
  const buffer = Buffer.from(base64, 'base64');
  return { mimeType, buffer };
};

const parsePlainBase64Image = (
  raw: string,
  mimeTypeHint?: string
): { mimeType: string; buffer: Buffer } | null => {
  const normalized = raw.trim().replace(/\s+/g, '');
  if (!normalized) return null;
  if (normalized.startsWith('data:image/')) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;

  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer || buffer.length === 0) return null;

  const hinted = (mimeTypeHint || '').toLowerCase();
  const mimeType = IMAGE_MIME_TO_EXT[hinted] ? hinted : 'image/jpeg';
  return { mimeType, buffer };
};

const saveIncomingImageToWorkspace = (input: {
  rawImage: unknown;
  userId?: string;
  threadId: string;
  mimeTypeHint?: string;
}): string | undefined => {
  const { rawImage, userId, threadId, mimeTypeHint: topLevelMimeHint } = input;
  if (!rawImage) return undefined;

  if (typeof rawImage === 'object') {
    const objectImage = rawImage as Record<string, unknown>;
    const directPath = objectImage.imagePath ?? objectImage.image_path ?? objectImage.path;
    if (typeof directPath === 'string' && directPath.trim().length > 0) {
      return directPath.trim();
    }
  }

  let dataUrl: string | undefined;
  let mimeTypeHint: string | undefined;
  if (typeof rawImage === 'string') {
    dataUrl = rawImage;
  } else if (rawImage && typeof rawImage === 'object') {
    const objectImage = rawImage as Record<string, unknown>;
    const maybeDataUrl = objectImage.dataUrl ?? objectImage.data_url ?? objectImage.url ?? objectImage.src;
    const maybeBase64 = objectImage.base64 ?? objectImage.image_base64;
    const maybeMime = objectImage.mimeType ?? objectImage.mime_type ?? objectImage.type;
    if (typeof maybeMime === 'string') mimeTypeHint = maybeMime.toLowerCase();

    if (typeof maybeDataUrl === 'string' && maybeDataUrl.startsWith('data:image/')) {
      dataUrl = maybeDataUrl;
    } else if (typeof maybeBase64 === 'string' && maybeBase64.trim().length > 0) {
      const normalizedMime = mimeTypeHint && IMAGE_MIME_TO_EXT[mimeTypeHint] ? mimeTypeHint : 'image/jpeg';
      dataUrl = `data:${normalizedMime};base64,${maybeBase64.trim()}`;
    }
  }

  let parsed = dataUrl ? parseDataUrlImage(dataUrl) : null;
  if (!parsed && typeof rawImage === 'string') {
    parsed = parsePlainBase64Image(rawImage, topLevelMimeHint);
  }

  if (!parsed && rawImage && typeof rawImage === 'object') {
    const objectImage = rawImage as Record<string, unknown>;
    const maybeBase64 = objectImage.base64 ?? objectImage.image_base64;
    const nestedMimeHint =
      typeof objectImage.mimeType === 'string'
        ? objectImage.mimeType
        : typeof objectImage.mime_type === 'string'
          ? objectImage.mime_type
          : topLevelMimeHint;
    if (typeof maybeBase64 === 'string') {
      parsed = parsePlainBase64Image(maybeBase64, nestedMimeHint);
    }
  }

  if (!parsed) {
    throw new Error('Invalid image payload format. Expected data URL or base64 string.');
  }

  const normalizedMime = IMAGE_MIME_TO_EXT[parsed.mimeType] ? parsed.mimeType : 'image/jpeg';
  const ext = IMAGE_MIME_TO_EXT[normalizedMime];

  if (parsed.buffer.length === 0) {
    throw new Error('Empty image buffer.');
  }
  if (parsed.buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image payload is too large (${parsed.buffer.length} bytes). Max allowed is ${MAX_IMAGE_BYTES} bytes.`
    );
  }

  const safeUserSegment = sanitizePathToken(userId || 'guest_user');
  const safeThreadSegment = sanitizePathToken(threadId || 'thread');
  const userDir = path.join(USERS_IMAGES_DIR, safeUserSegment);
  fs.mkdirSync(userDir, { recursive: true });

  const filename = `${safeThreadSegment}_${Date.now()}.${ext}`;
  const absolutePath = path.join(userDir, filename);
  fs.writeFileSync(absolutePath, parsed.buffer);

  return path.join('users_images', safeUserSegment, filename);
};

const PORT = Number(process.env.PORT) || 8001;
const AI_API_URL = process.env.AI_API_URL || 'http://localhost:8080/v1';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

const agentTools = [
  readKnowledgeTool,
  updateKnowledgeTool,
  visionAnalyzerTool,
  calculateNutritionTool,
  getChatHistoryTool,
  updateUserProfileTool,
  compressChatHistoryTool,
];
const toolNode = new ToolNode(agentTools);

const llm = new ChatOpenAI({
  modelName: 'gemma',
  temperature: 0,
  configuration: { baseURL: AI_API_URL },
  apiKey: 'dummy',
});

const AgentState = Annotation.Root({
  ...MessagesAnnotation.spec,
  user_id: Annotation<string>(),
  room_id: Annotation<string>(),
  user_profile_context: Annotation<string>(),
  image_path: Annotation<string>(),
});

const callModel = async (state: typeof AgentState.State) => {
  const agentInstructions = fs.existsSync(AGENT_FILE) ? fs.readFileSync(AGENT_FILE, 'utf-8') : '';
  const skillsIndex = fs.existsSync(INDEX_FILE) ? fs.readFileSync(INDEX_FILE, 'utf-8') : '';
  const nutritionRules = fs.existsSync(RULES_FILE) ? fs.readFileSync(RULES_FILE, 'utf-8') : '';

  const userInfo = state.user_id
    ? `Current user id: ${state.user_id}`
    : 'Current user id is missing.';
  const roomInfo = state.room_id
    ? `Current room id: ${state.room_id}`
    : 'Current room id is missing.';
  const userProfileContext = state.user_profile_context || 'No extra user context provided.';
  const imagePath = state.image_path || '';
  const needsImageToolCall = Boolean(imagePath) && !hasAnalyzeFoodToolResult(state.messages as unknown[]);

  const prompt = [
    agentInstructions,
    '',
    '--- Runtime Context ---',
    userInfo,
    roomInfo,
    '',
    '--- Skills Index ---',
    skillsIndex,
    '',
    '--- Nutrition Rules ---',
    nutritionRules,
    '',
    '--- User Profile + Conversation Summary Context ---',
    userProfileContext,
    '',
    '--- Image Context ---',
    imagePath
      ? [
          `Attached image path: ${imagePath}`,
          needsImageToolCall
            ? 'You MUST call tool analyze_food_image exactly once with this exact imagePath before your final answer.'
            : 'Image tool result is already available in message history. Use it for your final answer.',
        ].join('\n')
      : 'No image attached in this request.',
    '',
    '--- Response Style ---',
    'Never output raw JSON directly to the user.',
    'If tool outputs JSON, convert it into concise Traditional Chinese explanation.',
    'When dish_name and ingredients exist, summarize dish and estimated calories in plain text.',
    '',
    '--- Profile Update Policy ---',
    'Decide autonomously whether profile update is needed; do not force tool usage every turn.',
    'Use update_user_profile only when user clearly provides NEW profile information about themselves.',
    'Supported profile fields: nickname, avatar_url, height, weight, age, gender, taboo, disease.',
    'Do not update profile for guesses, hypotheticals, or unclear statements.',
    'If information is ambiguous, ask a short confirmation question before updating.',
    'When no new profile info is provided, skip update_user_profile.',
  ].join('\n');

  const systemMessage = { role: 'system', content: prompt };

  const MAX_HISTORY_MESSAGES = 10;
  let recentMessages = state.messages;
  if (state.messages.length > MAX_HISTORY_MESSAGES) {
    recentMessages = state.messages.slice(-MAX_HISTORY_MESSAGES);
  }

  const modelWithTools = needsImageToolCall
    ? llm.bindTools(agentTools, { tool_choice: 'analyze_food_image' })
    : llm.bindTools(agentTools);

  const response = await modelWithTools.invoke([systemMessage, ...recentMessages]);
  return { messages: [response] };
};

const workflow = new StateGraph(AgentState)
  .addNode('agent', callModel)
  .addNode('tools', toolNode)
  .addEdge(START, 'agent')
  .addConditionalEdges('agent', (state) => {
    const lastMessage = state.messages[state.messages.length - 1];
    const toolCalls = (lastMessage as { tool_calls?: unknown[] } | undefined)?.tool_calls;
    if (!toolCalls?.length) return END;
    return 'tools';
  })
  .addEdge('tools', 'agent');

const checkpointer = new MemorySaver();
const agentApp = workflow.compile({
  checkpointer,
});

const sendSSE = (res: Response, data: object) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

const getChunkText = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (
        part &&
        typeof part === 'object' &&
        'text' in part &&
        typeof (part as { text?: unknown }).text === 'string'
      ) {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
};

const getLatestAiTextFromState = (messages: unknown[] | undefined): string => {
  if (!Array.isArray(messages)) return '';

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index];
    if (!item || typeof item !== 'object') continue;

    const role = (item as { role?: unknown }).role;
    if (role !== 'assistant') continue;

    const content = (item as { content?: unknown }).content;
    const text = getChunkText(content).trim();
    if (text.length > 0) return text;
  }

  return '';
};

const hasAnalyzeFoodToolResult = (messages: unknown[] | undefined): boolean => {
  if (!Array.isArray(messages)) return false;

  return messages.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const role = (item as { role?: unknown }).role;
    const name = (item as { name?: unknown }).name;
    if (role === 'tool' && name === 'analyze_food_image') return true;

    const lcKwargsName = (item as { lc_kwargs?: { name?: unknown } }).lc_kwargs?.name;
    if (lcKwargsName === 'analyze_food_image') return true;

    return false;
  });
};

const ChatRequestSchema = z
  .object({
    message: z.string().optional().default(''),
    thread_id: z.string().trim().min(1),
    chat_history_id: z.string().trim().min(1),
    user_id: z.string().trim().optional(),
    user_context: z
      .union([
        z.array(z.unknown()),
        z.record(z.string(), z.unknown()),
        z.null(),
      ])
      .optional()
      .default([]),
    image: z.unknown().optional(),
    image_mime_type: z.string().trim().optional(),
    imageMimeType: z.string().trim().optional(),
    is_new_conversation: z.boolean().optional().default(false),
  })
  .superRefine((value, ctx) => {
    const hasMessage = value.message.trim().length > 0;
    const hasImage = value.image != null;
    if (!hasMessage && !hasImage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Either message or image is required.',
        path: ['message'],
      });
    }
  });

type ChatRequestPayload = z.infer<typeof ChatRequestSchema>;

const ConversationSummarySchema = z.object({
  summary: z.array(z.string()).default([]),
});

type ConversationSummary = z.infer<typeof ConversationSummarySchema>;

const ConversationTitleSchema = z.object({
  title: z.string().default(''),
});

const summaryExtractor = llm.withStructuredOutput(ConversationSummarySchema);
const titleExtractor = llm.withStructuredOutput(ConversationTitleSchema);

const normalizeUserContext = (rawContext: ChatRequestPayload['user_context']): string[] => {
  if (rawContext == null) return [];

  const inputItems = Array.isArray(rawContext) ? rawContext : [rawContext];

  return inputItems
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item == null) return '';
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter((item) => item.length > 0);
};

const normalizeTitle = (value: string, fallbackText: string): string => {
  const trimmed = value.trim();
  if (trimmed.length > 0) return trimmed.slice(0, 60);
  return fallbackText.trim().slice(0, 60) || 'New conversation';
};

const formatSummaryContext = (summaryArray: string[]): string => {
  if (summaryArray.length === 0) {
    return 'No previous conversation summary.';
  }

  const lines = summaryArray.map((item, index) => `${index + 1}. ${item}`);
  return ['Previous conversation summaries:', ...lines].join('\n');
};

const buildFallbackSummary = (
  previousSummary: string[],
  userMessage: string,
  aiResponse: string
): string[] => {
  const condensed = `User: ${userMessage.trim()} | AI: ${aiResponse.trim()}`.slice(0, 260);
  return [...previousSummary, condensed].slice(-20);
};

const extractConversationSummary = async (
  previousSummary: string[],
  userMessage: string,
  aiResponse: string
): Promise<ConversationSummary> => {
  try {
    const structured = await summaryExtractor.invoke([
      {
        role: 'system',
        content: [
          'You are a conversation summarizer.',
          'Return JSON only with key: summary (array of short strings).',
          'Merge previous summary with latest exchange and keep the most useful points.',
          'Keep each item concise and avoid duplicates.',
          'Do not include markdown.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `Previous summary array: ${JSON.stringify(previousSummary)}`,
          `User message: ${userMessage}`,
          `AI response: ${aiResponse}`,
        ].join('\n\n'),
      },
    ]);

    const normalizedSummary = (structured.summary ?? [])
      .map((item) => item.trim())
      .filter((item) => item.length > 0)
      .slice(-20);

    return { summary: normalizedSummary };
  } catch (error) {
    console.error('Summary extraction failed, using fallback:', error);
    return {
      summary: buildFallbackSummary(previousSummary, userMessage, aiResponse),
    };
  }
};

const generateConversationTitle = async (
  userMessage: string,
  aiResponse?: string
): Promise<string> => {
  try {
    const structured = await titleExtractor.invoke([
      {
        role: 'system',
        content: [
          'You generate a short conversation title.',
          'Return JSON only with key: title.',
          'Title length should be 8 to 20 Chinese characters or a concise equivalent.',
          'No punctuation at the end and no markdown.',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User message: ${userMessage}`,
          aiResponse ? `AI response: ${aiResponse}` : '',
        ]
          .filter(Boolean)
          .join('\n\n'),
      },
    ]);

    return normalizeTitle(structured.title || '', userMessage);
  } catch (error) {
    console.error('Title generation failed, using fallback:', error);
    return normalizeTitle('', userMessage);
  }
};

const persistChatHistoryReply = async (input: {
  chatHistoryId: string;
  aiReply: string;
}) => {
  if (!supabase) {
    console.warn('Supabase is not configured; skip chat history persistence.');
    return;
  }

  const updatePayload: Record<string, unknown> = {
    ai_analysis_report: input.aiReply,
  };

  const { data, error } = await supabase
    .from('diet_chat_history')
    .update(updatePayload)
    .eq('id', input.chatHistoryId)
    .select('id');

  if (error) {
    throw new Error(`Failed to update diet_chat_history (${input.chatHistoryId}): ${error.message}`);
  }

  if (!data || data.length === 0) {
    throw new Error(`No rows updated in diet_chat_history for id=${input.chatHistoryId}`);
  }
};

const persistChatRoomMeta = async (input: {
  threadId: string;
  userId?: string;
  summaryArray: string[];
  title?: string;
}) => {
  if (!supabase) {
    console.warn('Supabase is not configured; skip chat room persistence.');
    return;
  }

  const nowIso = new Date().toISOString();
  const payload: Record<string, unknown> = {
    room_id: input.threadId,
    summary: input.summaryArray,
    updated_at: nowIso,
    last_message_at: nowIso,
  };

  if (input.userId) payload.user_id = input.userId;
  if (input.title) payload.title = normalizeTitle(input.title, 'New conversation');

  const { error } = await supabase
    .from('chat_rooms')
    .upsert(payload, { onConflict: 'room_id' });

  if (!error) return;

  const conflictConstraintMissing =
    error.code === '42P10' ||
    error.message.includes('no unique or exclusion constraint matching the ON CONFLICT specification');

  if (!conflictConstraintMissing) {
    throw new Error(`Failed to upsert chat_rooms: ${error.message}`);
  }

  console.warn(
    '[persistChatRoomMeta] room_id is not unique in chat_rooms; fallback to update-then-insert flow.'
  );

  const { data: updatedRows, error: updateError } = await supabase
    .from('chat_rooms')
    .update(payload)
    .eq('room_id', input.threadId)
    .select('room_id');

  if (updateError) {
    throw new Error(`Fallback update chat_rooms failed: ${updateError.message}`);
  }

  if (updatedRows && updatedRows.length > 0) {
    return;
  }

  const { error: insertError } = await supabase
    .from('chat_rooms')
    .insert(payload);

  if (insertError) {
    throw new Error(`Fallback insert chat_rooms failed: ${insertError.message}`);
  }
};

const formatUserProfileContext = (raw: string, userId?: string): string => {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const nickname = typeof parsed.nickname === 'string' && parsed.nickname.trim().length > 0
      ? parsed.nickname.trim()
      : 'unknown';
    const height = parsed.height ?? 'unknown';
    const weight = parsed.weight ?? 'unknown';
    const age = parsed.age ?? 'unknown';
    const gender = parsed.gender ?? 'unknown';
    const taboo = Array.isArray(parsed.taboo) ? parsed.taboo.join(', ') || 'none' : 'unknown';
    const disease = Array.isArray(parsed.disease) ? parsed.disease.join(', ') || 'none' : 'unknown';

    return [
      `user_id: ${userId || 'unknown'}`,
      `nickname: ${nickname}`,
      `height: ${height}`,
      `weight: ${weight}`,
      `age: ${age}`,
      `gender: ${gender}`,
      `taboo: ${taboo}`,
      `disease: ${disease}`,
    ].join('\n');
  } catch {
    return `user_id: ${userId || 'unknown'}\nprofile_raw: ${raw}`;
  }
};

const fetchUserProfileContext = async (userId?: string): Promise<string> => {
  if (!userId) {
    return 'No user_id provided, skip profile lookup.';
  }

  try {
    const result = await getUserProfileTool.invoke({ user_id: userId });
    if (typeof result !== 'string') {
      return `user_id: ${userId}\nprofile lookup returned non-string result.`;
    }
    if (result.includes('Error') || result.includes('憭望?')) {
      return `user_id: ${userId}\nprofile lookup failed: ${result}`;
    }
    return formatUserProfileContext(result, userId);
  } catch (error) {
    console.error('Fetch profile failed:', error);
    return `user_id: ${userId}\nprofile lookup exception.`;
  }
};

const runAgentStream = async (
  res: Response,
  config: { configurable: { thread_id: string } },
  input: {
    messages: Array<{ role: 'user'; content: string }>;
    user_id: string;
    room_id: string;
    user_profile_context: string;
    image_path: string;
  }
): Promise<string> => {
  const stream = agentApp.streamEvents(input, { ...config, version: 'v2' });
  const textByMessageId = new Map<string, string>();
  let latestMessageId: string | null = null;
  let fallbackText = '';

  for await (const event of stream) {
    if (event.event === 'on_chat_model_stream') {
      const content = getChunkText(event.data.chunk?.content);
      if (!content) continue;

      const chunkId = event.data.chunk?.id;
      if (typeof chunkId === 'string' && chunkId.length > 0) {
        const prev = textByMessageId.get(chunkId) || '';
        const next = content.startsWith(prev) ? content : `${prev}${content}`;
        const delta = next.slice(prev.length);
        textByMessageId.set(chunkId, next);
        latestMessageId = chunkId;
        if (delta) {
          sendSSE(res, { type: 'text', content: delta });
        }
      } else {
        const next = content.startsWith(fallbackText) ? content : `${fallbackText}${content}`;
        const delta = next.slice(fallbackText.length);
        fallbackText = next;
        if (delta) {
          sendSSE(res, { type: 'text', content: delta });
        }
      }
    } else if (event.event === 'on_tool_start') {
      sendSSE(res, { type: 'status', content: `AI is calling tool: ${event.name}...` });
    }
  }

  const streamedText = latestMessageId
    ? textByMessageId.get(latestMessageId) || ''
    : fallbackText;

  if (streamedText.trim().length > 0) {
    return streamedText;
  }

  try {
    const snapshot = await agentApp.getState(config);
    const stateMessages = (snapshot?.values as { messages?: unknown[] } | undefined)?.messages;
    const recoveredText = getLatestAiTextFromState(stateMessages);
    if (recoveredText.length > 0) {
      return recoveredText;
    }
  } catch (stateError) {
    console.error('Failed to recover final assistant text from state:', stateError);
  }

  return '';
};

// --- API Router ---
app.post('/api/chat', async (req: Request, res: Response) => {
  const requestId = String(res.locals.requestId || createRequestId());
  const parsedBody = ChatRequestSchema.safeParse(req.body);
  if (!parsedBody.success) {
    console.warn(`[REQ ${requestId}] /api/chat invalid payload:`, parsedBody.error.flatten());
    return res.status(400).json({
      error: 'Invalid payload',
      details: parsedBody.error.flatten(),
    });
  }

  const payload: ChatRequestPayload = parsedBody.data;
  console.log(
    `[REQ ${requestId}] /api/chat accepted payload thread_id=${payload.thread_id} chat_history_id=${payload.chat_history_id} user_id=${
      payload.user_id || 'guest'
    } has_image=${Boolean(payload.image)} image_mime_type=${payload.image_mime_type || payload.imageMimeType || 'n/a'}`
  );

  const normalizedUserId = payload.user_id && payload.user_id.length > 0
    ? payload.user_id
    : undefined;
  const normalizedMessage = payload.message.trim();
  const normalizedUserContext = normalizeUserContext(payload.user_context);
  let savedImagePath = '';

  try {
    const maybeImagePath = saveIncomingImageToWorkspace({
      rawImage: payload.image,
      userId: normalizedUserId,
      threadId: payload.thread_id,
      mimeTypeHint: payload.image_mime_type || payload.imageMimeType,
    });
    if (maybeImagePath) {
      savedImagePath = maybeImagePath;
      if (normalizedMessage.length === 0) {
        console.log(
          `[REQ ${requestId}] /api/chat empty message detected; use image-only fallback prompt`
        );
      }
      console.log(`[REQ ${requestId}] /api/chat image saved image_path=${savedImagePath}`);
    }
  } catch (imageError) {
    console.warn(`[REQ ${requestId}] /api/chat invalid image payload:`, imageError);
    return res.status(400).json({
      error: 'Invalid image payload',
      message: imageError instanceof Error ? imageError.message : 'Unable to process image payload.',
    });
  }

  const effectiveUserMessage = normalizedMessage.length > 0
    ? normalizedMessage
    : savedImagePath
      ? 'Please analyze this image and explain the key details.'
      : 'Please help me with this request.';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const config = { configurable: { thread_id: payload.thread_id } };

  try {
    console.log(`[REQ ${requestId}] /api/chat agent start`);
    sendSSE(res, { type: 'status', content: 'AI is preparing your response...' });

    const userProfileContext = await fetchUserProfileContext(normalizedUserId);
    const combinedContext = [
      formatSummaryContext(normalizedUserContext),
      userProfileContext,
    ].join('\n\n');

    const finalVisibleText = await runAgentStream(res, config, {
      messages: [{ role: 'user', content: effectiveUserMessage }],
      user_id: normalizedUserId || 'guest_user',
      room_id: payload.thread_id,
      user_profile_context: combinedContext,
      image_path: savedImagePath,
    });
    console.log(
      `[REQ ${requestId}] /api/chat stream finished final_text_length=${finalVisibleText.length}`
    );

    sendSSE(res, { type: 'done' });
    res.end();

    if (finalVisibleText.trim().length === 0) {
      console.warn(`[REQ ${requestId}] /api/chat final text empty; skip persistence`);
      return;
    }

    void (async () => {
      try {
        console.log(
          `[REQ ${requestId}] persistence start chat_history_id=${payload.chat_history_id} room_id=${payload.thread_id}`
        );
        await persistChatHistoryReply({
          chatHistoryId: payload.chat_history_id,
          aiReply: finalVisibleText,
        });

        const { summary } = await extractConversationSummary(
          normalizedUserContext,
          effectiveUserMessage,
          finalVisibleText
        );

        const title = payload.is_new_conversation
          ? await generateConversationTitle(effectiveUserMessage, finalVisibleText)
          : undefined;

        await persistChatRoomMeta({
          threadId: payload.thread_id,
          userId: normalizedUserId,
          summaryArray: summary,
          title,
        });
        console.log(
          `[REQ ${requestId}] persistence success chat_history_id=${payload.chat_history_id} room_id=${payload.thread_id}`
        );
      } catch (persistError) {
        console.error(`[REQ ${requestId}] Background persistence failed:`, persistError);
      }
    })();
  } catch (error) {
    console.error(`[REQ ${requestId}] Agent Error:`, error);
    if (!res.writableEnded) {
      sendSSE(res, { type: 'error', content: 'Failed to process chat.' });
      res.end();
    }
  }
});

app.post('/api/approve', async (_req: Request, res: Response) => {
  res.json({
    status: 'not_required',
    message: 'No approval flow is required for this version.',
  });
});

app.post('/api/generate_title', async (req: Request, res: Response) => {
  try {
    const body = z.object({ message: z.string().trim().min(1) }).safeParse(req.body);
    if (!body.success) {
      return res.status(400).json({ error: 'No message provided' });
    }

    const title = await generateConversationTitle(body.data.message);
    res.json({ title });
  } catch (error) {
    console.error('Title generation failed:', error);
    res.status(500).json({ title: 'New conversation' });
  }
});

app.get('/ping', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    message: 'Pong! Node.js Agent is alive.',
    timestamp: new Date().toISOString(),
  });
});

app.use((error: any, req: Request, res: Response, _next: (err?: unknown) => void) => {
  const requestId = String(res.locals.requestId || 'unknown');

  if (error?.type === 'entity.too.large') {
    console.error(
      `[REQ ${requestId}] PayloadTooLarge path=${req.originalUrl} limit=${REQUEST_BODY_LIMIT}:`,
      error.message
    );
    return res.status(413).json({
      error: 'Payload too large',
      message: `Request body exceeds ${REQUEST_BODY_LIMIT}. Please compress the image or lower resolution.`,
    });
  }

  console.error(`[REQ ${requestId}] Unhandled Express Error:`, error);
  return res.status(500).json({
    error: 'Internal server error',
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('\nDiet Manager Agent Server started');
  console.log(`Thread-based memory ready (Supabase): ${Boolean(supabase)}`);
  console.log(`API URL: http://localhost:${PORT}/api/chat`);
  console.log(`Request body limit: ${REQUEST_BODY_LIMIT}`);
});

process.on('unhandledRejection', (reason) => {
  console.error('[PROCESS] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[PROCESS] Uncaught Exception:', error);
});



