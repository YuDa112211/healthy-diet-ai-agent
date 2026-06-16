import { describe, expect, test } from 'bun:test';
import { ChatRequestSchema } from './chatPayload';

const basePayload = {
  message: 'Hello',
  thread_id: 'thread-1',
  chat_history_id: 'history-1',
};

describe('ChatRequestSchema', () => {
  test('defaults model_source to auto when omitted', () => {
    const result = ChatRequestSchema.safeParse(basePayload);

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.model_source).toBe('auto');
  });

  test('accepts google and local model sources', () => {
    const googleResult = ChatRequestSchema.safeParse({
      ...basePayload,
      model_source: 'google',
    });
    const localResult = ChatRequestSchema.safeParse({
      ...basePayload,
      model_source: 'local',
    });

    expect(googleResult.success).toBe(true);
    expect(localResult.success).toBe(true);
    if (!googleResult.success || !localResult.success) return;

    expect(googleResult.data.model_source).toBe('google');
    expect(localResult.data.model_source).toBe('local');
  });

  test('rejects invalid model_source values', () => {
    const result = ChatRequestSchema.safeParse({
      ...basePayload,
      model_source: 'unsupported',
    });

    expect(result.success).toBe(false);
  });

  test('still requires either message or image', () => {
    const result = ChatRequestSchema.safeParse({
      thread_id: 'thread-1',
      chat_history_id: 'history-1',
      message: '   ',
    });

    expect(result.success).toBe(false);
  });
});
