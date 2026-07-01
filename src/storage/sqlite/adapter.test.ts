import { describe, expect, test } from 'bun:test';

import { createSqliteStorageForTest } from './adapter';

describe('createSqliteStorageForTest', () => {
  test('creates the required standalone tables on ensureReady', async () => {
    const storage = createSqliteStorageForTest(':memory:');

    await storage.ensureReady();

    await storage.updateUserProfile({
      userId: 'local-user',
      nickname: 'Local Demo',
      taboo: ['spicy'],
      disease: [],
    });

    const profile = await storage.getUserProfile('local-user');
    expect(profile?.nickname).toBe('Local Demo');

    const document = await storage.createKnowledgeDocument({
      id: 'doc-1',
      title: 'Demo Guide',
      sourceType: 'manual_upload',
      filename: 'demo.txt',
      fileExt: 'txt',
      mimeType: 'text/plain',
      sizeBytes: 12,
      fileHash: 'hash-demo-1',
      storagePath: 'knowledge_base/uploads/demo.txt',
      uploadedBy: 'local-user',
      uploaderRole: 'admin',
      status: 'uploaded',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
      parsedMdPath: null,
      parseMethod: null,
      parsedCharCount: null,
      embeddingModel: null,
      errorMessage: null,
      tags: ['demo'],
    });

    expect(document.id).toBe('doc-1');

    await storage.createKnowledgeIngestionJob({
      id: 'job-1',
      documentId: 'doc-1',
      status: 'processing',
      extractor: 'native_txt',
      parseMethod: null,
      parsedMdPath: null,
      extractedCharCount: null,
      extractedTextExcerpt: null,
      errorMessage: null,
      startedAt: '2026-07-01T00:00:00.000Z',
      finishedAt: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    });

    const job = await storage.getKnowledgeIngestionJob('job-1');
    expect(job?.documentId).toBe('doc-1');
  });
});
