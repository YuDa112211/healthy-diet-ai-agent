import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import express from 'express';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createKnowledgeGraphRouter } from './knowledgeGraph';
import type { RagDocumentRecord, RagDocumentsRepository } from './ragDocuments';

class MemoryRagDocumentsRepository implements RagDocumentsRepository {
  private readonly records = new Map<string, RagDocumentRecord>();

  async listDocuments(): Promise<RagDocumentRecord[]> {
    return Array.from(this.records.values());
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
    if (!current) throw new Error(`Document not found: ${documentId}`);
    const next = { ...current, ...patch };
    this.records.set(documentId, next);
    return next;
  }

  async deleteDocument(documentId: string): Promise<void> {
    this.records.delete(documentId);
  }
}

describe('createKnowledgeGraphRouter', () => {
  let tempRoot = '';
  let baseUrl = '';
  let server: Server | null = null;
  let repository: MemoryRagDocumentsRepository;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'knowledge-graph-'));
    repository = new MemoryRagDocumentsRepository();

    await mkdir(path.join(tempRoot, 'knowledge_base', 'uploads', '2026', '06'), { recursive: true });
    await mkdir(path.join(tempRoot, 'knowledge_base', 'mohw_clarifications', 'articles'), { recursive: true });

    const uploadPath = path.join('knowledge_base', 'uploads', '2026', '06', 'fiber-guide.md');
    await writeFile(
      path.join(tempRoot, uploadPath),
      '# Fiber Guide\n\nFiber helps digestion and is recommended for adults.\nBroccoli contains fiber.\n'
    );

    await writeFile(
      path.join(tempRoot, 'knowledge_base', 'NUTRITION_RULES.md'),
      '# Nutrition Rules\n\nBroccoli contains vitamin C and fiber.\nPatients with hypertension should reduce sodium.\n'
    );

    await writeFile(
      path.join(tempRoot, 'knowledge_base', 'mohw_clarifications', 'articles', '2026-06-08_10001.md'),
      '# Clarification\n\nVitamin C supports immunity for children.\n'
    );

    await repository.createDocument({
      id: 'doc-upload-1',
      title: 'Fiber Guide',
      sourceType: 'uploaded_knowledge',
      filename: 'fiber-guide.md',
      fileExt: 'md',
      mimeType: 'text/markdown',
      sizeBytes: 100,
      fileHash: 'hash-1',
      storagePath: uploadPath.replace(/\\/g, '/'),
      uploadedBy: 'admin-1',
      uploaderRole: 'admin',
      status: 'ingested',
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
      parsedMdPath: null,
      parseMethod: 'native_md',
      parsedCharCount: 100,
      embeddingModel: null,
      errorMessage: null,
    });

    const app = express();
    app.use(express.json());
    app.use(createKnowledgeGraphRouter({ rootDir: tempRoot, repository }));
    server = app.listen(0);
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => {
      if (!server) return resolve();
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

  test('extracts a document graph and returns related nodes and edges', async () => {
    const extractResponse = await fetch(`${baseUrl}/api/graph/documents/doc-upload-1/extract`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-admin-user-id': 'admin-1',
        'x-admin-role': 'admin',
      },
      body: JSON.stringify({ force: true }),
    });

    expect(extractResponse.status).toBe(200);
    const extractBody = await extractResponse.json();
    expect(extractBody.ok).toBe(true);
    expect(extractBody.document.id).toBe('doc-upload-1');
    expect(extractBody.nodes.length).toBeGreaterThan(0);
    expect(extractBody.edges.length).toBeGreaterThan(0);
  });

  test('returns graph search results centered on a nutrition query', async () => {
    await fetch(`${baseUrl}/api/graph/extract-all`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ force: true }),
    });

    const response = await fetch(`${baseUrl}/api/graph/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'fiber', max_nodes: 8 }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.nodes.some((node: { label: string }) => /fiber/i.test(node.label))).toBe(true);
    expect(body.edges.some((edge: { relation_type: string }) => edge.relation_type === 'contains')).toBe(true);
    expect(body.documents.length).toBeGreaterThan(0);
  });

  test('returns node detail with neighbors and evidence', async () => {
    await fetch(`${baseUrl}/api/graph/extract-all`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ force: true }),
    });

    const searchResponse = await fetch(`${baseUrl}/api/graph/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'broccoli', max_nodes: 8 }),
    });
    const searchBody = await searchResponse.json();
    const broccoliNode = searchBody.nodes.find((node: { label: string }) => /broccoli/i.test(node.label));

    const response = await fetch(`${baseUrl}/api/graph/nodes/${broccoliNode.id}`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.node.label).toBe(broccoliNode.label);
    expect(body.neighbors.length).toBeGreaterThan(0);
    expect(body.evidence.length).toBeGreaterThan(0);
  });

  test('lists all knowledge points from the rebuilt global graph', async () => {
    await fetch(`${baseUrl}/api/graph/extract-all`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ force: true }),
    });

    const response = await fetch(`${baseUrl}/api/graph/nodes?limit=50`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.total).toBeGreaterThan(0);
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.items.some((node: { label: string }) => /fiber/i.test(node.label))).toBe(true);
    expect(body.items.some((node: { label: string }) => /broccoli/i.test(node.label))).toBe(true);
  });

  test('requires forwarded admin identity for extract and document detail routes', async () => {
    const extractResponse = await fetch(`${baseUrl}/api/graph/documents/doc-upload-1/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    });
    expect(extractResponse.status).toBe(401);

    const detailResponse = await fetch(`${baseUrl}/api/graph/documents/doc-upload-1`);
    expect(detailResponse.status).toBe(401);
  });

  test('rebuilds the full graph from all current RAG sources and reports status', async () => {
    const rebuildResponse = await fetch(`${baseUrl}/api/graph/extract-all`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ force: true }),
    });

    expect(rebuildResponse.status).toBe(200);
    const rebuildBody = await rebuildResponse.json();
    expect(rebuildBody.ok).toBe(true);
    expect(rebuildBody.summary.document_count).toBeGreaterThanOrEqual(3);
    expect(rebuildBody.summary.node_count).toBeGreaterThan(0);
    expect(rebuildBody.summary.edge_count).toBeGreaterThan(0);

    const statusResponse = await fetch(`${baseUrl}/api/graph/status`);
    expect(statusResponse.status).toBe(200);
    const statusBody = await statusResponse.json();
    expect(statusBody.ok).toBe(true);
    expect(statusBody.ready).toBe(true);
    expect(statusBody.summary.document_count).toBe(rebuildBody.summary.document_count);
    expect(statusBody.summary.node_count).toBe(rebuildBody.summary.node_count);
    expect(statusBody.summary.edge_count).toBe(rebuildBody.summary.edge_count);
    expect(statusBody.summary.source_counts.uploaded_knowledge).toBeGreaterThanOrEqual(1);
    expect(statusBody.summary.source_counts.nutrition_rules).toBeGreaterThanOrEqual(1);
    expect(statusBody.summary.source_counts.mohw_news).toBeGreaterThanOrEqual(1);
  });

  test('allows full graph rebuild without forwarded admin identity', async () => {
    const response = await fetch(`${baseUrl}/api/graph/extract-all`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ force: true }),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.summary.document_count).toBeGreaterThan(0);
  });
});
