import { describe, expect, test } from 'bun:test';

import {
  buildSummaryPersistenceGuard,
  parseConversationSummaryToolOutput,
} from '../../agent_skills/conversation_summary_tool';

describe('buildSummaryPersistenceGuard', () => {
  test('rejects trivial greeting exchanges', () => {
    const result = buildSummaryPersistenceGuard({
      current_user_message: '你好',
      current_assistant_reply: '你好，我可以幫你什麼？',
    });

    expect(result.shouldPersist).toBe(false);
    expect(result.reason).toBe('trivial-turn');
  });

  test('allows nutrition advice exchanges', () => {
    const result = buildSummaryPersistenceGuard({
      current_user_message: '幫我安排今天的菜單',
      current_assistant_reply: '今天建議早餐吃燕麥和無糖豆漿，午餐選鮭魚和花椰菜。',
    });

    expect(result.shouldPersist).toBe(true);
    expect(result.reason).toBe('durable-turn-detected');
  });
});

describe('parseConversationSummaryToolOutput', () => {
  test('parses valid JSON tool output', () => {
    const result = parseConversationSummaryToolOutput(
      JSON.stringify({
        should_persist: true,
        compact_summary: 'compact',
        detailed_summary: 'detailed',
        reason: 'durable-turn-detected',
      })
    );

    expect(result).toEqual({
      should_persist: true,
      compact_summary: 'compact',
      detailed_summary: 'detailed',
      reason: 'durable-turn-detected',
    });
  });
});
