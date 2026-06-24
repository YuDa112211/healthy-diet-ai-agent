import { describe, expect, test } from 'bun:test';

import { getChatHistoryWithClientForTest, logDietWithClientForTest } from '../../agent_skills/db_tools';

describe('logDietWithClientForTest', () => {
  test('retries chat inserts without title when the database schema does not expose that column', async () => {
    const payloads: Record<string, unknown>[] = [];

    const fakeClient = {
      from(table: string) {
        expect(table).toBe('diet_chat_history');
        return {
          insert(rows: Record<string, unknown>[]) {
            payloads.push(...rows);
            const row = rows[0] || {};
            return {
              select() {
                if ('title' in row) {
                  return Promise.resolve({
                    error: {
                      message: "Could not find the 'title' column of 'diet_chat_history' in the schema cache",
                    },
                    data: null,
                  });
                }

                return Promise.resolve({ error: null, data: [{ id: 'chat-row-fallback-1' }] });
              },
            };
          },
        };
      },
    };

    const result = await logDietWithClientForTest(fakeClient as never, {
      room_id: 'room-1',
      user_message: '外食時要怎麼點得更健康？',
      user_id: '00000000-0000-0000-0000-000000000001',
      title: '外食時要怎麼點得更健康',
      ai_analysis_report: '__PENDING__',
      record_type: 'chat',
    });

    expect(result).toEqual({ status: 'inserted', id: 'chat-row-fallback-1' });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toHaveProperty('title');
    expect(payloads[1]).not.toHaveProperty('title');
  });

  test('returns inserted id for chat rows so the agent can persist the later AI reply', async () => {
    const payloads: Record<string, unknown>[] = [];

    const fakeClient = {
      from(table: string) {
        expect(table).toBe('diet_chat_history');
        return {
          insert(rows: Record<string, unknown>[]) {
            payloads.push(...rows);
            return {
              select() {
                return Promise.resolve({ error: null, data: [{ id: 'chat-row-1' }] });
              },
            };
          },
        };
      },
    };

    const result = await logDietWithClientForTest(fakeClient as never, {
      room_id: 'room-1',
      user_message: '早餐吃什麼比較好？',
      user_id: '00000000-0000-0000-0000-000000000001',
      title: '早餐吃什麼比較好',
      ai_analysis_report: '先占位，稍後會改成完整 AI 回覆。',
      record_type: 'chat',
    });

    expect(result).toEqual({ status: 'inserted', id: 'chat-row-1' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.record_type).toBe('chat');
    expect(payloads[0]?.user_message).toBe('早餐吃什麼比較好？');
  });

  test('writes record_type=summary for summary inserts and returns inserted id', async () => {
    const payloads: Record<string, unknown>[] = [];

    const fakeClient = {
      from(table: string) {
        expect(table).toBe('diet_chat_history');
        return {
          insert(rows: Record<string, unknown>[]) {
            payloads.push(...rows);
            return {
              select() {
                return Promise.resolve({ error: null, data: [{ id: 'summary-row-1' }] });
              },
            };
          },
        };
      },
    };

    const result = await logDietWithClientForTest(
      fakeClient as never,
      {
        room_id: 'room-1',
        user_message: '[AUTO_SUMMARY]',
        title: '對話摘要',
        summary_text: 'detailed summary',
        record_type: 'summary',
      },
      { summaryColumnEnabled: true }
    );

    expect(result).toEqual({ status: 'inserted', id: 'summary-row-1' });
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.record_type).toBe('summary');
    expect(payloads[0]?.summary).toBe('detailed summary');
  });
});

describe('getChatHistoryWithClientForTest', () => {
  test('filters raw history by explicit chat history ids', async () => {
    const fakeRows = [
      {
        id: 'chat-1',
        created_at: '2026-06-20T08:00:00.000Z',
        title: '早餐',
        user_message: '我早餐吃蛋餅',
        ai_analysis_report: '已記錄早餐內容',
        summary: null,
        diet_report: null,
        record_type: 'chat',
      },
    ];

    const filters: Array<{ type: string; value: unknown }> = [];

    const fakeClient = {
      from(table: string) {
        expect(table).toBe('diet_chat_history');
        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push({ type: `eq:${column}`, value });
            return this;
          },
          in(column: string, value: unknown[]) {
            filters.push({ type: `in:${column}`, value });
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: fakeRows, error: null });
          },
        };
      },
    };

    const result = await getChatHistoryWithClientForTest(fakeClient as never, {
      room_id: 'room-1',
      format: 'raw',
      chat_history_ids: ['chat-1'],
    });

    expect(filters).toContainEqual({ type: 'eq:room_id', value: 'room-1' });
    expect(filters).toContainEqual({ type: 'in:id', value: ['chat-1'] });
    expect(result).toContain('"id":"chat-1"');
  });

  test('filters compact history by date range', async () => {
    const fakeRows = [
      {
        id: 'chat-2',
        created_at: '2026-06-21T12:00:00.000Z',
        title: '午餐',
        user_message: '我午餐吃雞胸肉',
        ai_analysis_report: '蛋白質足夠',
        summary: null,
        diet_report: null,
        record_type: 'chat',
      },
    ];

    const filters: Array<{ type: string; value: unknown }> = [];

    const fakeClient = {
      from() {
        return {
          select() {
            return this;
          },
          eq(column: string, value: unknown) {
            filters.push({ type: `eq:${column}`, value });
            return this;
          },
          gte(column: string, value: unknown) {
            filters.push({ type: `gte:${column}`, value });
            return this;
          },
          lte(column: string, value: unknown) {
            filters.push({ type: `lte:${column}`, value });
            return this;
          },
          order() {
            return this;
          },
          limit() {
            return Promise.resolve({ data: fakeRows, error: null });
          },
        };
      },
    };

    const result = await getChatHistoryWithClientForTest(fakeClient as never, {
      room_id: 'room-1',
      format: 'compact',
      date_from: '2026-06-21T00:00:00.000Z',
      date_to: '2026-06-21T23:59:59.999Z',
    });

    expect(filters).toContainEqual({ type: 'gte:created_at', value: '2026-06-21T00:00:00.000Z' });
    expect(filters).toContainEqual({ type: 'lte:created_at', value: '2026-06-21T23:59:59.999Z' });
    expect(result).toContain('午餐');
    expect(result).toContain('我午餐吃雞胸肉');
  });
});
