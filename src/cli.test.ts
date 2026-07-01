import { describe, expect, test } from 'bun:test';

import { runCliForTest } from './cli';

describe('runCliForTest', () => {
  test('prints the final agent response for a prompt', async () => {
    const output = await runCliForTest(['--message', 'hello'], async () => ({
      finalText: 'hello from cli',
    }));

    expect(output).toContain('hello from cli');
  });
});
