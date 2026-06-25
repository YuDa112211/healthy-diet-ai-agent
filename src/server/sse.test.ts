import { describe, expect, test } from 'bun:test';

import { formatSSEMessage, sendSSE } from './sse';

describe('formatSSEMessage', () => {
  test('uses payload type as SSE event name when no explicit event name is provided', () => {
    expect(formatSSEMessage({ type: 'status', content: 'thinking' })).toBe(
      'event: status\ndata: {"type":"status","content":"thinking"}\n\n'
    );
  });

  test('prefers explicit event name when one is provided', () => {
    expect(formatSSEMessage({ type: 'status', content: 'thinking' }, 'done')).toBe(
      'event: done\ndata: {"type":"status","content":"thinking"}\n\n'
    );
  });
});

describe('sendSSE', () => {
  test('writes standardized SSE frames for typed payloads', () => {
    const writes: string[] = [];

    sendSSE(
      {
        write(chunk: string) {
          writes.push(chunk);
        },
      } as never,
      { type: 'text', content: 'hello' }
    );

    expect(writes).toEqual([
      'event: text\ndata: {"type":"text","content":"hello"}\n\n',
    ]);
  });
});
