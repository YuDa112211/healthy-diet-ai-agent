import { describe, expect, test } from 'bun:test';

import { resolveMohwNewsSyncEnabled } from './mohwConfig';

describe('resolveMohwNewsSyncEnabled', () => {
  test('env false overrides config true', () => {
    expect(resolveMohwNewsSyncEnabled(true, 'false')).toBe(false);
  });

  test('config false stays false when env is unset', () => {
    expect(resolveMohwNewsSyncEnabled(false, null)).toBe(false);
  });

  test('config true stays true when env is unset', () => {
    expect(resolveMohwNewsSyncEnabled(true, null)).toBe(true);
  });
});
