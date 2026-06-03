import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createRagApiRouter, type RagDocumentRecord, type RagDocumentsRepository } from './ragDocuments';

class MemoryRagDocumentsRepository implements RagDocumentsRepository {
  private readonly records = new Map<string, RagDocumentRecord>();

  async listDocuments(): Promise<RagDocumentRecord[]> {
    return Array.from(this.records.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDocument(documentId: string): Promise<RagDocumentRecord | null> {
    return this.records.get(documentId) ?? null;
  }

  async findDocumentByHash(fileHash: string): Promise<RagDocumentRecord | null> {
    for (const record of this.records.values()) {
      if (record.fileHash === fileHash) return record;
    }
    return null;
  }

  async createDocument(record: RagDocumentRecord): Promise<RagDocumentRecord> {
    this.records.set(record.id, record);
    return record;
  }

  async updateDocument(documentId: string, patch: Partial<RagDocumentRecord>): Promise<RagDocumentRecord> {
    const current = this.records.get(documentId);
    if (!current) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const next = { ...current, ...patch };
    this.records.set(documentId, next);
    return next;
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.records.delete(documentId);
  }
}

describe('createRagApiRouter', () => {
  let tempRoot = '';
  let baseUrl = '';
  let server: Server | null = null;
  let repository: MemoryRagDocumentsRepository;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'rag-documents-'));
    repository = new MemoryRagDocumentsRepository();

    const app = express();
    app.use(createRagApiRouter({ repository, rootDir: tempRoot }));

    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) {
        resolve();
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
    server = null;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test('uploads a multipart document and returns the unified document item', async () => {
    const form = new FormData();
    form.append('file', new File(['Fiber helps digestion.\nEat vegetables daily.'], 'guide.txt', { type: 'text/plain' }));
    form.append('embeddingModel', 'text-embedding-3-large');

    const response = await fetch(`${baseUrl}/api/rag/documents`, {
      method: 'POST',
      headers: {
        'X-Admin-User-Id': 'admin-1',
        'X-Admin-Role': 'admin',
      },
      body: form,
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.filename).toBe('guide.txt');
    expect(body.mimeType).toBe('text/plain');
    expect(body.embeddingModel).toBe('text-embedding-3-large');
    expect(body.status).toBe('ingested');
    expect(body.fileUrl).toBe(`/api/rag/documents/${body.id}/file`);
    expect(body.previewUrl).toBe(`/api/rag/documents/${body.id}/preview`);

    const listResponse = await fetch(`${baseUrl}/api/rag/documents`, {
      headers: {
        'X-Admin-User-Id': 'admin-1',
        'X-Admin-Role': 'admin',
      },
    });

    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    expect(listBody.total).toBe(1);
    expect(listBody.items).toHaveLength(1);
    expect(listBody.items[0].id).toBe(body.id);
  });

  test('returns preview and file responses for uploaded documents and public sources', async () => {
    const form = new FormData();
    form.append('file', new File(['Vitamin C supports immunity.'], 'notes.md', { type: 'text/markdown' }));

    const uploadResponse = await fetch(`${baseUrl}/api/rag/documents`, {
      method: 'POST',
      headers: {
        'X-Admin-User-Id': 'nutrition-admin',
        'X-Admin-Role': 'admin',
      },
      body: form,
    });
    const uploaded = await uploadResponse.json();

    const previewResponse = await fetch(`${baseUrl}${uploaded.previewUrl}`, {
      headers: {
        'X-Admin-User-Id': 'nutrition-admin',
        'X-Admin-Role': 'admin',
      },
    });
    expect(previewResponse.status).toBe(200);
    const previewBody = await previewResponse.json();
    expect(previewBody.documentId).toBe(uploaded.id);
    expect(previewBody.previewKind).toBe('text');
    expect(previewBody.content).toContain('Vitamin C supports immunity.');

    const sourcePreviewResponse = await fetch(`${baseUrl}/api/rag/sources/${uploaded.id}/preview`);
    expect(sourcePreviewResponse.status).toBe(200);
    const sourcePreviewBody = await sourcePreviewResponse.json();
    expect(sourcePreviewBody.documentId).toBe(uploaded.id);
    expect(sourcePreviewBody.fileUrl).toBe(`/api/rag/sources/${uploaded.id}/file`);
    expect(sourcePreviewBody.previewUrl).toBe(`/api/rag/sources/${uploaded.id}/preview`);

    const fileResponse = await fetch(`${baseUrl}/api/rag/sources/${uploaded.id}/file`);
    expect(fileResponse.status).toBe(200);
    expect(fileResponse.headers.get('content-type')).toContain('text/markdown');
    expect(await fileResponse.text()).toContain('Vitamin C supports immunity.');
  });

  test('reindexes and deletes an existing document', async () => {
    const form = new FormData();
    form.append('file', new File(['Whole grains are rich in fiber.'], 'fiber.txt', { type: 'text/plain' }));

    const uploadResponse = await fetch(`${baseUrl}/api/rag/documents`, {
      method: 'POST',
      headers: {
        'X-Admin-User-Id': 'admin-2',
        'X-Admin-Role': 'admin',
      },
      body: form,
    });
    const uploaded = await uploadResponse.json();
    const storedBeforeDelete = await repository.getDocument(uploaded.id);
    expect(storedBeforeDelete).not.toBeNull();
    expect(storedBeforeDelete?.storagePath).toBeTruthy();

    const reindexResponse = await fetch(`${baseUrl}/api/rag/documents/${uploaded.id}/reindex`, {
      method: 'POST',
      headers: {
        'X-Admin-User-Id': 'admin-2',
        'X-Admin-Role': 'admin',
      },
    });
    expect(reindexResponse.status).toBe(200);
    const reindexed = await reindexResponse.json();
    expect(reindexed.id).toBe(uploaded.id);
    expect(reindexed.status).toBe('ingested');

    const deleteResponse = await fetch(`${baseUrl}/api/rag/documents/${uploaded.id}`, {
      method: 'DELETE',
      headers: {
        'X-Admin-User-Id': 'admin-2',
        'X-Admin-Role': 'admin',
      },
    });
    expect(deleteResponse.status).toBe(200);
    expect(await deleteResponse.json()).toEqual({
      deleted: true,
      documentId: uploaded.id,
      ok: true,
    });

    const afterDelete = await repository.getDocument(uploaded.id);
    expect(afterDelete).toBeNull();

    const fileBytes = await readFile(path.join(tempRoot, storedBeforeDelete!.storagePath)).catch(() => null);
    expect(fileBytes).toBeNull();
  });

  test('rejects admin document routes without forwarded admin identity', async () => {
    const response = await fetch(`${baseUrl}/api/rag/documents`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      error: 'admin_auth_required',
      ok: false,
    });
  });
});
