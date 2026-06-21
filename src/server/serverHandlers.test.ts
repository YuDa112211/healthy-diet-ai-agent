import { describe, expect, test } from 'bun:test';

import {
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
      compactSummary: 'summary text',
      title: 'title',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.onConflict).toBe('room_id,user_id');
    expect(calls[0]?.payload.room_id).toBe('room-1');
    expect(calls[0]?.payload.user_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(calls[0]?.payload.summary).toBe('summary text');
    expect(calls[0]?.payload.title).toBe('title');
  });
});

describe('persistSummaryOutputsForTest', () => {
  test('persists compact and detailed summaries only when the tool requests it', async () => {
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
      threadId: 'room-1',
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
        writes.push('history');
        return 'Summary row inserted.';
      },
    });

    expect(writes).toEqual(['room', 'history']);
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
