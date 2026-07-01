import { describe, expect, test } from 'bun:test';

import {
  createInitialChatPersistenceForTest,
  formatRoomSummaryIndexContextForTest,
  persistChatRoomMetaWithClientForTest,
  persistSummaryOutputsForTest,
  shouldFallbackSummarizeTurn,
} from '../serverHandlers';

describe('persistChatRoomMetaWithClientForTest', () => {
  test('upserts chat_rooms by room_id and user_id when user_id exists', async () => {
    const calls: Array<{ payload: Record<string, unknown>; onConflict?: string }> = [];

    const fakeSupabase = {
      from(table: string) {
        expect(table).toBe('chat_rooms');
        return {
          upsert(payload: Record<string, unknown>, options?: { onConflict?: string }) {
            calls.push({ payload, onConflict: options?.onConflict });
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await persistChatRoomMetaWithClientForTest(fakeSupabase as never, {
      threadId: 'room-1',
      userId: '00000000-0000-0000-0000-000000000001',
      summaryIndexEntries: [
        {
          summary_id: 'sum-1',
          summary: 'summary text',
          source_chat_history_ids: ['chat-1'],
          source_summary_history_id: 'summary-row-1',
          created_at: '2026-06-22T10:00:00.000Z',
          start_at: '2026-06-22T09:58:00.000Z',
          end_at: '2026-06-22T10:00:00.000Z',
        },
      ],
      title: 'title',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.onConflict).toBe('room_id,user_id');
    expect(calls[0]?.payload.room_id).toBe('room-1');
    expect(calls[0]?.payload.user_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(calls[0]?.payload.summary).toEqual([
      {
        summary_id: 'sum-1',
        summary: 'summary text',
        source_chat_history_ids: ['chat-1'],
        source_summary_history_id: 'summary-row-1',
        created_at: '2026-06-22T10:00:00.000Z',
        start_at: '2026-06-22T09:58:00.000Z',
        end_at: '2026-06-22T10:00:00.000Z',
      },
    ]);
    expect(calls[0]?.payload.title).toBe('title');
  });
});

describe('createInitialChatPersistenceForTest', () => {
  test('uses shared storage when explicit adapter methods are provided', async () => {
    const roomWrites: Array<Record<string, unknown>> = [];
    const historyWrites: Array<Record<string, unknown>> = [];

    const result = await createInitialChatPersistenceForTest({
      threadId: 'room-storage-1',
      userId: '00000000-0000-0000-0000-000000000010',
      userMessage: 'storage path test',
      isNewConversation: true,
      storage: {
        upsertChatRoom: async (input) => {
          roomWrites.push(input as unknown as Record<string, unknown>);
        },
        insertChatHistory: async (input) => {
          historyWrites.push(input as unknown as Record<string, unknown>);
          return { id: 'chat-storage-1' };
        },
      } as never,
    });

    expect(result.chatHistoryId).toBe('chat-storage-1');
    expect(roomWrites[0]?.threadId).toBe('room-storage-1');
    expect(historyWrites[0]?.roomId).toBe('room-storage-1');
  });

  test('upserts chat room and inserts an initial chat row before streaming begins', async () => {
    const roomWrites: Array<Record<string, unknown>> = [];
    const historyWrites: Array<Record<string, unknown>> = [];

    const result = await createInitialChatPersistenceForTest({
      threadId: 'room-1',
      userId: '00000000-0000-0000-0000-000000000001',
      userMessage: '午餐照片幫我分析一下',
      imagePath: 'images/room-1/lunch.png',
      isNewConversation: true,
      persistChatRoomMetaFn: async (input) => {
        roomWrites.push(input as unknown as Record<string, unknown>);
      },
      insertChatHistoryRowFn: async (input) => {
        historyWrites.push(input as unknown as Record<string, unknown>);
        return { status: 'inserted', id: 'chat-row-1' };
      },
    });

    expect(result).toEqual({
      chatHistoryId: 'chat-row-1',
      provisionalTitle: '午餐照片幫我分析一下',
    });
    expect(roomWrites).toHaveLength(1);
    expect(roomWrites[0]?.threadId).toBe('room-1');
    expect(roomWrites[0]?.userId).toBe('00000000-0000-0000-0000-000000000001');
    expect(roomWrites[0]?.title).toBe('午餐照片幫我分析一下');
    expect(historyWrites).toHaveLength(1);
    expect(historyWrites[0]?.threadId).toBe('room-1');
    expect(historyWrites[0]?.imagePath).toBe('images/room-1/lunch.png');
    expect(historyWrites[0]?.title).toBe('午餐照片幫我分析一下');
  });
});

describe('persistSummaryOutputsForTest', () => {
  test('persists compact and detailed summaries only when the tool requests it', async () => {
    const writes: Array<Record<string, unknown>> = [];

    const fakeSupabase = {
      from() {
        return {
          upsert(payload: Record<string, unknown>) {
            writes.push(payload);
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await persistSummaryOutputsForTest({
      threadId: 'room-1',
      chatHistoryId: 'chat-row-1',
      userId: '00000000-0000-0000-0000-000000000001',
      title: 'title',
      summaryProposals: [
        {
          should_persist: true,
          compact_summary: 'compact summary',
          detailed_summary: 'detailed summary',
          reason: 'durable-turn-detected',
        },
      ],
      persistChatRoomMetaFn: async (input) => {
        await persistChatRoomMetaWithClientForTest(fakeSupabase as never, input);
      },
      insertSummaryHistoryRowFn: async () => {
        return { status: 'inserted', id: 'summary-row-1' };
      },
    });

    expect(writes).toHaveLength(1);
    expect(writes[0]?.summary).toEqual([
      expect.objectContaining({
        summary: 'compact summary',
        source_chat_history_ids: ['chat-row-1'],
        source_summary_history_id: 'summary-row-1',
      }),
    ]);
  });

  test('updates only chat room metadata when no summary proposal is present', async () => {
    const writes: string[] = [];

    const fakeSupabase = {
      from() {
        return {
          upsert() {
            writes.push('room');
            return Promise.resolve({ error: null });
          },
        };
      },
    };

    await persistSummaryOutputsForTest({
      threadId: 'room-2',
      chatHistoryId: 'chat-row-2',
      userId: '00000000-0000-0000-0000-000000000002',
      title: 'title',
      summaryProposals: [],
      persistChatRoomMetaFn: async (input) => {
        await persistChatRoomMetaWithClientForTest(fakeSupabase as never, input);
      },
      insertSummaryHistoryRowFn: async () => {
        writes.push('history');
        return 'Summary row inserted.';
      },
    });

    expect(writes).toEqual(['room']);
  });
});

describe('shouldFallbackSummarizeTurn', () => {
  test('returns true for non-empty exchanges so the model can decide', () => {
    expect(
      shouldFallbackSummarizeTurn({
        userMessage: '可以分析我的身體狀況後給我一份今天的專屬食譜嗎',
        assistantReply: '這是一段有內容的回答。',
      })
    ).toBe(true);
  });

  test('returns false for empty exchanges', () => {
    expect(
      shouldFallbackSummarizeTurn({
        userMessage: '   ',
        assistantReply: '',
      })
    ).toBe(false);
  });
});

describe('formatRoomSummaryIndexContextForTest', () => {
  test('formats structured summary entries into readable indexed context', () => {
    const output = formatRoomSummaryIndexContextForTest([
      {
        summary_id: 'sum-1',
        summary: '6/20 討論 168 斷食與當日飲食。',
        source_chat_history_ids: ['chat-1'],
        source_summary_history_id: 'summary-row-1',
        created_at: '2026-06-20T08:30:00.000Z',
        start_at: '2026-06-20T08:00:00.000Z',
        end_at: '2026-06-20T08:30:00.000Z',
      },
      {
        summary_id: 'sum-2',
        summary: '6/21 分享弟弟一天的飲食。',
        source_chat_history_ids: ['chat-5'],
        source_summary_history_id: 'summary-row-2',
        created_at: '2026-06-21T12:00:00.000Z',
        start_at: '2026-06-21T11:40:00.000Z',
        end_at: '2026-06-21T12:00:00.000Z',
      },
    ]);

    expect(output).toContain('Room summary index:');
    expect(output).toContain('1. [2026-06-20]');
    expect(output).toContain('source_chat_history_ids=chat-1');
    expect(output).toContain('2. [2026-06-21]');
  });
});
