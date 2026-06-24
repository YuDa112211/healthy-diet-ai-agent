import { describe, expect, test } from 'bun:test';
import { ChatRequestSchema } from './chatPayload';

const basePayload = {
  message: 'Hello',
  thread_id: 'thread-1',
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
      message: '   ',
    });

    expect(result.success).toBe(false);
  });

  test('accepts payloads without chat_history_id because the agent creates it', () => {
    const result = ChatRequestSchema.safeParse({
      message: 'Hello',
      thread_id: 'thread-1',
      user_id: 'user-1',
      is_new_conversation: true,
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.chat_history_id).toBeUndefined();
  });

  test('accepts attachment metadata arrays from the Rust proxy', () => {
    const result = ChatRequestSchema.safeParse({
      message: 'Please review the attached meal photo.',
      thread_id: 'thread-1',
      attachments: [
        {
          kind: 'image',
          name: 'lunch.png',
          mime_type: 'image/png',
          data_url: 'data:image/png;base64,abc123',
        },
      ],
    });

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data.attachments).toHaveLength(1);
  });
});
