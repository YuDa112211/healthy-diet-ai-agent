import { describe, expect, test } from 'bun:test';

import { logDietWithClientForTest } from '../../agent_skills/db_tools';

describe('logDietWithClientForTest', () => {
  test('writes record_type=summary for summary inserts', async () => {
    const payloads: Record<string, unknown>[] = [];

    const fakeClient = {
      from(table: string) {
        expect(table).toBe('diet_chat_history');
        return {
          insert(rows: Record<string, unknown>[]) {
            payloads.push(...rows);
            return Promise.resolve({ error: null });
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

    expect(result).toBe('Summary row inserted.');
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.record_type).toBe('summary');
    expect(payloads[0]?.summary).toBe('detailed summary');
  });
});
