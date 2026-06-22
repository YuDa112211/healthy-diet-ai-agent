import { describe, expect, test } from 'bun:test';

import {
  buildLegacySummaryIndexEntry,
  parseRoomSummaryIndex,
  type RoomSummaryIndexEntry,
} from './roomSummaryIndex';

describe('buildLegacySummaryIndexEntry', () => {
  test('converts a legacy plain-text summary into one traceable index entry', () => {
    const entry = buildLegacySummaryIndexEntry({
      legacySummary: '使用者先前聊過 168 斷食與飲食控制。',
      createdAt: '2026-06-22T10:00:00.000Z',
    });

    expect(entry).toEqual({
      summary_id: 'legacy-2026-06-22T10:00:00.000Z',
      summary: '使用者先前聊過 168 斷食與飲食控制。',
      source_chat_history_ids: [],
      source_summary_history_id: undefined,
      created_at: '2026-06-22T10:00:00.000Z',
      start_at: '2026-06-22T10:00:00.000Z',
      end_at: '2026-06-22T10:00:00.000Z',
    });
  });
});

describe('parseRoomSummaryIndex', () => {
  test('wraps legacy string summaries into a one-entry summary index', () => {
    const result = parseRoomSummaryIndex('使用者先前聊過 168 斷食與飲食控制。');

    expect(result).toHaveLength(1);
    expect(result[0]?.summary).toBe('使用者先前聊過 168 斷食與飲食控制。');
    expect(result[0]?.source_chat_history_ids).toEqual([]);
  });

  test('keeps structured summary index arrays intact', () => {
    const existing: RoomSummaryIndexEntry[] = [
      {
        summary_id: 'sum-1',
        summary: '6/20 討論早餐。',
        source_chat_history_ids: ['chat-1'],
        source_summary_history_id: 'summary-1',
        created_at: '2026-06-20T08:30:00.000Z',
        start_at: '2026-06-20T08:00:00.000Z',
        end_at: '2026-06-20T08:30:00.000Z',
      },
    ];

    const result = parseRoomSummaryIndex(existing);

    expect(result).toEqual(existing);
  });
});
