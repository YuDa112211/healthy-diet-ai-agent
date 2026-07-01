import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ROOT_DIR } from '../server/workspacePaths';

describe('Docker packaging', () => {
  test('Dockerfile copies agent_config.json into /app', () => {
    const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
    const dockerfile = readFileSync(dockerfilePath, 'utf8');

    expect(dockerfile).toMatch(/COPY\s+agent_config\.json\s+\.\/agent_config\.json/);
  });
});
