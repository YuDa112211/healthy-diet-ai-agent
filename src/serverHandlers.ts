import type { Request, Response } from 'express';
import { z } from 'zod';
import { getUserProfileTool, updateUserProfileTool } from '../agent_skills/db_tools';
import { llm, runAgentStream } from './server/agentRuntime';
import {
  AGENT_STREAM_TIMEOUT_MS,
  PROFILE_LOOKUP_TIMEOUT_MS,
  REQUEST_BODY_LIMIT,
  USER_PROFILE_CACHE_TTL_MS,
  corsMiddleware,
  createRequestId,
  formatDurationMs,
  isTimeoutError,
  isUpstreamConnectionError,
  jsonBodyParser,
  requestLoggerMiddleware,
  toStatusText,
  urlencodedBodyParser,
  withTimeout,
} from './server/httpRuntime';
import { saveIncomingImageToWorkspace } from './server/imageStorage';
import {
  PENDING_APPROVAL_TTL_MS,
  buildApprovalProposalItems,
  cleanupExpiredApprovals,
  clearPendingApprovalById,
  clearPendingApprovalByThread,
  formatProfileUpdateSummary,
  hasAnyProfileField,
  pendingProfileUpdates,
  type ApprovalProposalItem,
  type ProfileUpdateFields,
} from './server/profileApproval';
import { AI_API_URL, isSupabaseReady, supabase } from './server/supabaseRuntime';
import { imagesStaticMiddleware } from './server/workspacePaths';

export {
  AI_API_URL,
  corsMiddleware,
  imagesStaticMiddleware,
  isSupabaseReady,
  jsonBodyParser,
  requestLoggerMiddleware,
  REQUEST_BODY_LIMIT,
  urlencodedBodyParser,
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

type UserProfileCacheEntry = {
  context: string;
  expiresAt: number;
};

const userProfileCache = new Map<string, UserProfileCacheEntry>();

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

const extractUrls = (text: string): string[] => {
  const matches = text.match(/https?:\/\/[^\s)]+/gi);
  if (!matches) return [];
  return matches.map((item) => item.trim());
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

const cleanupExpiredUserProfileCache = () => {
  const now = Date.now();
  for (const [userId, item] of userProfileCache.entries()) {
    if (item.expiresAt <= now) {
      userProfileCache.delete(userId);
    }
  }
};

const fetchUserProfileContext = async (userId?: string): Promise<string> => {
  if (!userId) {
    return 'No user_id provided, skip profile lookup.';
  }

  cleanupExpiredUserProfileCache();
  const cached = userProfileCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.context;
  }

  try {
    const result = await getUserProfileTool.invoke({ user_id: userId });
    if (typeof result !== 'string') {
      return `user_id: ${userId}\nprofile lookup returned non-string result.`;
    }
    if (result.includes('Error') || result.includes('憭望?')) {
      return `user_id: ${userId}\nprofile lookup failed: ${result}`;
    }
    const context = formatUserProfileContext(result, userId);
    userProfileCache.set(userId, {
      context,
      expiresAt: Date.now() + USER_PROFILE_CACHE_TTL_MS,
    });
    return context;
  } catch (error) {
    console.error('Fetch profile failed:', error);
    return `user_id: ${userId}\nprofile lookup exception.`;
  }
};

const sendSSE = (res: Response, data: object) => {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
};

export const chatHandler = async (req: Request, res: Response) => {
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

  const urlsInMessage = extractUrls(effectiveUserMessage);
  const firstUrl = urlsInMessage.length > 0 ? urlsInMessage[0] : '';
  const hasMultipleUrls = urlsInMessage.length > 1;
  const effectiveMessageForAgent = hasMultipleUrls && firstUrl
    ? `${effectiveUserMessage}\n\n[System note: multiple URLs detected. Only verify the first URL in this request: ${firstUrl}]`
    : effectiveUserMessage;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const config = { configurable: { thread_id: payload.thread_id } };

  try {
    console.log(`[REQ ${requestId}] /api/chat agent start`);
    console.log(`[REQ ${requestId}] /api/chat user_message="${effectiveUserMessage}"`);
    if (hasMultipleUrls && firstUrl) {
      console.log(
        `[REQ ${requestId}] /api/chat multiple URLs detected; only first URL will be verified: ${firstUrl}`
      );
      sendSSE(res, {
        type: 'status',
        content: `Detected multiple URLs. This turn verifies only the first URL: ${firstUrl}`,
      });
    }
    sendSSE(res, { type: 'status', content: 'AI is preparing your response...' });
    sendSSE(res, { type: 'status', content: `User message: ${effectiveUserMessage}` });

    console.log(
      `[REQ ${requestId}] /api/chat profile lookup start user_id=${normalizedUserId || 'guest'}`
    );
    const profileLookupStartAt = Date.now();
    let userProfileContext = 'No user_id provided, skip profile lookup.';
    try {
      userProfileContext = await withTimeout(
        fetchUserProfileContext(normalizedUserId),
        PROFILE_LOOKUP_TIMEOUT_MS,
        'profile lookup'
      );
      console.log(
        `[REQ ${requestId}] /api/chat profile lookup done duration=${formatDurationMs(profileLookupStartAt)}`
      );
    } catch (profileError) {
      console.warn(
        `[REQ ${requestId}] /api/chat profile lookup skipped (${formatDurationMs(profileLookupStartAt)}):`,
        profileError
      );
      userProfileContext = normalizedUserId
        ? `user_id: ${normalizedUserId}\nprofile lookup skipped due to timeout/error.`
        : 'No user_id provided, skip profile lookup.';
    }

    const combinedContext = [
      formatSummaryContext(normalizedUserContext),
      userProfileContext,
    ].join('\n\n');

    const streamResult = await withTimeout(
      runAgentStream(res, config, {
        messages: [{ role: 'user', content: effectiveMessageForAgent }],
        user_id: normalizedUserId || 'guest_user',
        room_id: payload.thread_id,
        user_profile_context: combinedContext,
        image_path: savedImagePath,
      }),
      AGENT_STREAM_TIMEOUT_MS,
      'agent stream'
    );
    const finalVisibleText = streamResult.finalText;
    const toolTraces = streamResult.toolTraces;
    const approvalProposals = streamResult.approvalProposals;
    let approvalPending = false;
    let approvalContent = '';
    let approvalProposal: ProfileUpdateFields | null = null;
    let approvalProposalItems: ApprovalProposalItem[] = [];
    let approvalId: string | null = null;
    console.log(
      `[REQ ${requestId}] /api/chat stream finished final_text_length=${finalVisibleText.length}`
    );
    if (toolTraces.length > 0) {
      console.log(`[REQ ${requestId}] /api/chat tool_traces=${JSON.stringify(toolTraces)}`);
      sendSSE(res, { type: 'status', content: `Tools used: ${toolTraces.map((item) => `${item.name}(${item.status})`).join(', ')}` });
    } else {
      sendSSE(res, { type: 'status', content: 'Tools used: none' });
    }

    cleanupExpiredApprovals();
    if (normalizedUserId && finalVisibleText.trim().length > 0) {
      const latestProposal =
        approvalProposals.length > 0 ? approvalProposals[approvalProposals.length - 1] : null;
      if (latestProposal && hasAnyProfileField(latestProposal)) {
        clearPendingApprovalByThread(payload.thread_id);
        const currentApprovalId = createRequestId();
        const summary = formatProfileUpdateSummary(latestProposal);
        const proposalItems = buildApprovalProposalItems(latestProposal);
        approvalPending = true;
        approvalContent = `偵測到可更新的個人資料，是否要寫入？\n${summary}`;
        approvalProposal = latestProposal;
        approvalProposalItems = proposalItems;
        approvalId = currentApprovalId;
        pendingProfileUpdates.set(currentApprovalId, {
          approvalId: currentApprovalId,
          requestId,
          threadId: payload.thread_id,
          userId: normalizedUserId,
          deferredAiReply: finalVisibleText,
          fields: latestProposal,
          items: proposalItems,
          summary,
          createdAt: Date.now(),
          expiresAt: Date.now() + PENDING_APPROVAL_TTL_MS,
        });

        sendSSE(res, {
          type: 'interrupt',
          content: approvalContent,
          approval_id: currentApprovalId,
          proposal: latestProposal,
          proposal_items: proposalItems,
        });
        console.log(
          `[REQ ${requestId}] approval pending approval_id=${currentApprovalId} thread_id=${payload.thread_id} fields=${JSON.stringify(
            latestProposal
          )}`
        );
      } else {
        clearPendingApprovalByThread(payload.thread_id);
      }
    } else {
      clearPendingApprovalByThread(payload.thread_id);
    }

    if (!approvalPending && finalVisibleText.trim().length > 0) {
      sendSSE(res, { type: 'text', content: finalVisibleText });
    }

    sendSSE(res, {
      type: 'done',
      user_message: effectiveUserMessage,
      tools: toolTraces,
      approval_pending: approvalPending,
      approval_id: approvalId,
      approval_content: approvalContent,
      approval_proposal: approvalProposal,
      approval_proposal_items: approvalProposalItems,
    });
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
    const timeoutHit = isTimeoutError(error);
    const upstreamConnectionError = isUpstreamConnectionError(error);
    if (timeoutHit) {
      console.error(`[REQ ${requestId}] /api/chat timeout:`, error);
    }
    if (upstreamConnectionError) {
      console.error(`[REQ ${requestId}] /api/chat upstream connection error AI_API_URL=${AI_API_URL}`);
    }
    console.error(`[REQ ${requestId}] Agent Error:`, error);
    if (!res.writableEnded) {
      sendSSE(
        res,
        timeoutHit
          ? { type: 'error', content: 'AI processing timed out. Please try again.' }
          : upstreamConnectionError
            ? { type: 'error', content: 'AI service is temporarily unreachable. Please check AI_API_URL or Rust server status.' }
            : { type: 'error', content: 'Failed to process chat.' }
      );
      res.end();
    }
  }
};

const ApproveRequestSchema = z.object({
  approval_id: z.string().trim().min(1),
  action: z.enum(['approve', 'reject']),
});

export const approveHandler = async (req: Request, res: Response) => {
  const requestId = String(res.locals.requestId || createRequestId());
  const parsed = ApproveRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      status: 'invalid_payload',
      details: parsed.error.flatten(),
    });
  }

  cleanupExpiredApprovals();
  const { approval_id, action } = parsed.data;
  console.log(
    `[REQ ${requestId}] /api/approve user_message="${action}" approval_id=${approval_id}`
  );
  const pending = pendingProfileUpdates.get(approval_id);

  if (!pending) {
    return res.json({
      status: 'not_found',
      message: 'No pending profile update approval for this approval_id.',
    });
  }

  if (action === 'reject') {
    clearPendingApprovalById(approval_id);
    console.log(`[REQ ${requestId}] approval rejected approval_id=${approval_id}`);
    return res.json({
      status: 'rejected',
      message: '已取消更新個人資料。',
      user_message: action,
      approval_id,
      assistant_reply: pending.deferredAiReply || '',
      proposal: pending.fields,
      proposal_items: pending.items,
      tool: {
        name: 'updateUserProfileTool',
        status: 'skipped',
      },
    });
  }

  try {
    console.log(`[REQ ${requestId}] tool updateUserProfileTool status=running`);
    const toolResult = await updateUserProfileTool.invoke({
      user_id: pending.userId,
      ...pending.fields,
    });
    userProfileCache.delete(pending.userId);
    clearPendingApprovalById(approval_id);
    const resultText = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult);
    console.log(
      `[REQ ${requestId}] tool updateUserProfileTool status=success result=${toStatusText(resultText)}`
    );
    console.log(`[REQ ${requestId}] approval applied approval_id=${approval_id}`);
    return res.json({
      status: 'approved',
      user_message: action,
      approval_id,
      result: resultText,
      summary: pending.summary,
      assistant_reply: pending.deferredAiReply || '',
      proposal: pending.fields,
      proposal_items: pending.items,
      tool: {
        name: 'updateUserProfileTool',
        status: 'success',
        result: resultText,
      },
    });
  } catch (error) {
    console.error(
      `[REQ ${requestId}] tool updateUserProfileTool status=error result=${toStatusText(error)}`
    );
    console.error(`[REQ ${requestId}] approval apply failed approval_id=${approval_id}:`, error);
    return res.status(500).json({
      status: 'failed',
      user_message: action,
      approval_id,
      message: 'Failed to apply profile update.',
      assistant_reply: pending.deferredAiReply || '',
      tool: {
        name: 'updateUserProfileTool',
        status: 'error',
      },
    });
  }
};

export const generateTitleHandler = async (req: Request, res: Response) => {
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
};

export const pingHandler = (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    message: 'Pong! Node.js Agent is alive.',
    timestamp: new Date().toISOString(),
  });
};

export const errorHandler = (error: any, req: Request, res: Response, _next: (err?: unknown) => void) => {
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
};
