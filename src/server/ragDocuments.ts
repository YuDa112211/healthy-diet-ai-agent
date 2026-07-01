import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Router, type Request, type Response } from 'express';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';
import { invalidateKnowledgeSearchCache } from '../../agent_skills/file_tools';
import { ROOT_DIR } from './workspacePaths';
import { getStorage } from '../storage/runtime';

const MAX_UPLOAD_BYTES = Number(process.env.RAG_DOCUMENT_MAX_UPLOAD_BYTES || 20 * 1024 * 1024);
const MAX_EXTRACTED_TEXT_CHARS = Number(process.env.RAG_DOCUMENT_MAX_EXTRACTED_TEXT_CHARS || 350000);
const MAX_PREVIEW_CHARS = Number(process.env.RAG_DOCUMENT_MAX_PREVIEW_CHARS || 4000);

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/x-markdown',
]);

const DocumentParamsSchema = z.object({
  document_id: z.string().trim().min(1),
});

const normalizeWhitespace = (value: string): string =>
  value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

const sanitizeBaseFileName = (value: string): string => {
  const base = value
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
  return base.length > 0 ? base : 'uploaded_document';
};

const detectExtension = (fileName: string, mimeType?: string | null): string => {
  const ext = path.extname(fileName).replace('.', '').toLowerCase();
  if (ext) return ext;
  if (!mimeType) return '';

  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (mimeType === 'text/plain') return 'txt';
  if (mimeType === 'text/markdown' || mimeType === 'text/x-markdown') return 'md';
  return '';
};

const inferMimeType = (extension: string): string => {
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'docx') {
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  }
  if (extension === 'md') return 'text/markdown; charset=utf-8';
  return 'text/plain; charset=utf-8';
};

const normalizeMimeType = (mimeType?: string | null): string | null => {
  const normalized = String(mimeType || '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  return normalized ? normalized : null;
};

const buildRelativeStoragePath = (sha256: string, safeName: string, extension: string): string => {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const shortHash = sha256.slice(0, 12);
  return path.posix.join('knowledge_base', 'uploads', yyyy, mm, `${shortHash}_${safeName}.${extension}`);
};

const buildRelativeMarkdownPath = (documentId: string, safeName: string): string => {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  return path.posix.join('knowledge_base', 'ingested_markdown', yyyy, mm, `${documentId}_${safeName}.md`);
};

const resolveAbsolutePath = (rootDir: string, relativePath: string): string =>
  path.resolve(rootDir, relativePath.replace(/\//g, path.sep));

const toMarkdownDocument = (input: {
  documentId: string;
  title: string;
  filename: string;
  mimeType: string;
  sourcePath: string;
  uploadedBy: string;
  uploaderRole: string;
  parseMethod: string;
  extractedText: string;
}): string => {
  const lines = [
    `# ${input.title}`,
    '',
    `- document_id: ${input.documentId}`,
    `- filename: ${input.filename}`,
    `- mime_type: ${input.mimeType}`,
    '- source_type: uploaded_knowledge',
    `- source_path: ${input.sourcePath}`,
    `- uploaded_by: ${input.uploadedBy}`,
    `- uploader_role: ${input.uploaderRole}`,
    `- parse_method: ${input.parseMethod}`,
    `- generated_at_utc: ${new Date().toISOString()}`,
    '',
    '## Content',
    '',
    input.extractedText,
  ];
  return lines.join('\n');
};

const parseTxtLike = async (absolutePath: string): Promise<string> => {
  const content = await readFile(absolutePath, 'utf8');
  return normalizeWhitespace(content);
};

const parseDocx = async (absolutePath: string): Promise<string> => {
  const result = await mammoth.extractRawText({ path: absolutePath });
  return normalizeWhitespace(result.value || '');
};

const parsePdf = async (absolutePath: string): Promise<string> => {
  const buffer = await readFile(absolutePath);
  const parser = new PDFParse({ data: buffer });
  try {
    const result = await parser.getText();
    return normalizeWhitespace(result.text || '');
  } finally {
    await parser.destroy();
  }
};

const extractTextByExtension = async (absolutePath: string, extension: string): Promise<string> => {
  if (extension === 'txt' || extension === 'md') return parseTxtLike(absolutePath);
  if (extension === 'docx') return parseDocx(absolutePath);
  if (extension === 'pdf') return parsePdf(absolutePath);
  throw new Error(`Unsupported extension for extraction: ${extension}`);
};

const getBoundary = (contentType: string): string | null => {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match?.[1] || match?.[2] || null;
};

const readRequestBody = async (req: Request, maxBytes: number): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw Object.assign(new Error('File too large'), { statusCode: 413 });
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

type MultipartPart = {
  headers: Record<string, string>;
  content: Buffer;
};

const parseMultipartParts = (body: Buffer, boundary: string): MultipartPart[] => {
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const headerSeparator = Buffer.from('\r\n\r\n');
  const parts: MultipartPart[] = [];
  let cursor = body.indexOf(boundaryMarker);

  while (cursor !== -1) {
    const nextBoundary = body.indexOf(boundaryMarker, cursor + boundaryMarker.length);
    if (nextBoundary === -1) break;

    const partBuffer = body.subarray(cursor + boundaryMarker.length + 2, nextBoundary - 2);
    cursor = nextBoundary;

    if (partBuffer.length === 0) continue;
    const separatorIndex = partBuffer.indexOf(headerSeparator);
    if (separatorIndex === -1) continue;

    const headerText = partBuffer.subarray(0, separatorIndex).toString('utf8');
    const content = partBuffer.subarray(separatorIndex + headerSeparator.length);
    const headers: Record<string, string> = {};
    for (const rawLine of headerText.split('\r\n')) {
      const colonIndex = rawLine.indexOf(':');
      if (colonIndex < 0) continue;
      const key = rawLine.slice(0, colonIndex).trim().toLowerCase();
      const value = rawLine.slice(colonIndex + 1).trim();
      headers[key] = value;
    }

    parts.push({ headers, content });
  }

  return parts;
};

type ParsedUploadPayload = {
  fileName: string;
  mimeType: string | null;
  buffer: Buffer;
  embeddingModel: string | null;
  uploadedBy: string | null;
};

const parseMultipartUpload = async (req: Request): Promise<ParsedUploadPayload> => {
  const contentType = String(req.headers['content-type'] || '');
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
    throw Object.assign(new Error('Expected multipart/form-data'), { statusCode: 400 });
  }

  const boundary = getBoundary(contentType);
  if (!boundary) {
    throw Object.assign(new Error('Multipart boundary is missing'), { statusCode: 400 });
  }

  const body = await readRequestBody(req, MAX_UPLOAD_BYTES + 1024 * 512);
  const parts = parseMultipartParts(body, boundary);

  let fileName = '';
  let mimeType: string | null = null;
  let buffer: Buffer = Buffer.alloc(0);
  let embeddingModel: string | null = null;
  let uploadedBy: string | null = null;

  for (const part of parts) {
    const disposition = part.headers['content-disposition'] || '';
    const name = disposition.match(/name="([^"]+)"/i)?.[1] || '';
    const filename = disposition.match(/filename="([^"]*)"/i)?.[1] || '';

    if (name === 'file') {
      fileName = filename;
      mimeType = part.headers['content-type'] || null;
      buffer = Buffer.from(part.content);
    } else if (name === 'embeddingModel') {
      embeddingModel = part.content.toString('utf8').trim() || null;
    } else if (name === 'uploadedBy') {
      uploadedBy = part.content.toString('utf8').trim() || null;
    }
  }

  if (!fileName || buffer.length === 0) {
    throw Object.assign(new Error('Multipart upload must include a non-empty file field'), { statusCode: 400 });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw Object.assign(new Error(`File too large. Max allowed is ${MAX_UPLOAD_BYTES} bytes.`), { statusCode: 413 });
  }

  return { fileName, mimeType, buffer, embeddingModel, uploadedBy };
};

const parseAdminIdentity = (req: Request): { uploadedBy: string; uploaderRole: 'admin' | 'nutritionist' } | null => {
  const headerUserId = String(req.headers['x-admin-user-id'] || '').trim();
  const headerRole = String(req.headers['x-admin-role'] || '').trim().toLowerCase();

  if (headerUserId && (headerRole === 'admin' || headerRole === 'nutritionist')) {
    return {
      uploadedBy: headerUserId,
      uploaderRole: headerRole,
    };
  }

  return null;
};

const requireAdminIdentity = (req: Request, res: Response): { uploadedBy: string; uploaderRole: 'admin' | 'nutritionist' } | null => {
  const identity = parseAdminIdentity(req);
  if (identity) return identity;
  res.status(401).json({
    ok: false,
    error: 'admin_auth_required',
  });
  return null;
};

export type RagDocumentRecord = {
  id: string;
  title: string;
  sourceType: string;
  filename: string;
  fileExt: string;
  mimeType: string | null;
  sizeBytes: number;
  fileHash: string;
  storagePath: string;
  uploadedBy: string;
  uploaderRole: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  parsedMdPath: string | null;
  parseMethod: string | null;
  parsedCharCount: number | null;
  embeddingModel: string | null;
  errorMessage: string | null;
};

export type RagDocumentsRepository = {
  listDocuments(): Promise<RagDocumentRecord[]>;
  getDocument(documentId: string): Promise<RagDocumentRecord | null>;
  findDocumentByHash(fileHash: string): Promise<RagDocumentRecord | null>;
  createDocument(record: RagDocumentRecord): Promise<RagDocumentRecord>;
  updateDocument(documentId: string, patch: Partial<RagDocumentRecord>): Promise<RagDocumentRecord>;
  deleteDocument(documentId: string): Promise<void>;
};

const mapDocumentRow = (row: Record<string, unknown>): RagDocumentRecord => ({
  id: String(row.id),
  title: String(row.title || path.basename(String(row.file_name || 'document'))),
  sourceType: String(row.source_type || 'manual_upload'),
  filename: String(row.file_name || ''),
  fileExt: String(row.file_ext || ''),
  mimeType: row.mime_type == null ? null : String(row.mime_type),
  sizeBytes: Number(row.file_size_bytes || 0),
  fileHash: String(row.file_hash || ''),
  storagePath: String(row.storage_path || ''),
  uploadedBy: String(row.uploaded_by || 'unknown'),
  uploaderRole: String(row.uploader_role || 'unknown'),
  status: String(row.status || 'uploaded'),
  createdAt: String(row.created_at || new Date().toISOString()),
  updatedAt: String(row.updated_at || new Date().toISOString()),
  parsedMdPath: row.parsed_md_path == null ? null : String(row.parsed_md_path),
  parseMethod: row.parse_method == null ? null : String(row.parse_method),
  parsedCharCount: row.parsed_char_count == null ? null : Number(row.parsed_char_count),
  embeddingModel: row.embedding_model == null ? null : String(row.embedding_model),
  errorMessage: row.error_message == null ? null : String(row.error_message),
});

const buildStorageRepository = (): RagDocumentsRepository => {
  return {
    async listDocuments() {
      const storage = await getStorage();
      return storage.listKnowledgeDocuments();
    },
    async getDocument(documentId) {
      const storage = await getStorage();
      return storage.getKnowledgeDocument(documentId);
    },
    async findDocumentByHash(fileHash) {
      const storage = await getStorage();
      return storage.findKnowledgeDocumentByHash(fileHash);
    },
    async createDocument(record) {
      const storage = await getStorage();
      return storage.createKnowledgeDocument(record);
    },
    async updateDocument(documentId, patch) {
      const storage = await getStorage();
      return storage.updateKnowledgeDocument(documentId, patch);
    },
    async deleteDocument(documentId) {
      const storage = await getStorage();
      await storage.deleteKnowledgeDocument(documentId);
    },
  };
};

const toDocumentItem = (document: RagDocumentRecord) => ({
  id: document.id,
  filename: document.filename,
  mimeType: document.mimeType || inferMimeType(document.fileExt),
  sizeBytes: document.sizeBytes,
  status: document.status,
  chunkCount: null,
  embeddingModel: document.embeddingModel,
  errorMessage: document.errorMessage,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
  fileUrl: `/api/rag/documents/${document.id}/file`,
  previewUrl: `/api/rag/documents/${document.id}/preview`,
});

const buildPreviewResponse = (
  document: RagDocumentRecord,
  previewKind: 'text' | 'unsupported',
  content: string,
  truncated: boolean,
  message: string | null,
  scope: 'documents' | 'sources',
) => ({
  documentId: document.id,
  filename: document.filename,
  mimeType: document.mimeType || inferMimeType(document.fileExt),
  previewKind,
  content,
  truncated,
  fileUrl: `/api/rag/${scope}/${document.id}/file`,
  previewUrl: `/api/rag/${scope}/${document.id}/preview`,
  message,
});

const reindexDocument = async (repository: RagDocumentsRepository, rootDir: string, document: RagDocumentRecord) => {
  const absolutePath = resolveAbsolutePath(rootDir, document.storagePath);
  const extractedText = await extractTextByExtension(absolutePath, document.fileExt);
  const clippedText = extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS);

  if (clippedText.length === 0) {
    const failedAt = new Date().toISOString();
    return repository.updateDocument(document.id, {
      status: 'failed',
      updatedAt: failedAt,
      errorMessage: `No text extracted from ${document.filename}. This document may require OCR preprocessing.`,
    });
  }

  const safeBaseName = sanitizeBaseFileName(path.basename(document.filename, path.extname(document.filename)));
  const relativeMdPath = buildRelativeMarkdownPath(document.id, safeBaseName);
  const absoluteMdPath = resolveAbsolutePath(rootDir, relativeMdPath);
  await mkdir(path.dirname(absoluteMdPath), { recursive: true });

  const parseMethod =
    document.fileExt === 'pdf' ? 'pdf_text_layer' : document.fileExt === 'docx' ? 'docx_text_layer' : 'plain_text';

  const markdown = toMarkdownDocument({
    documentId: document.id,
    title: document.title,
    filename: document.filename,
    mimeType: document.mimeType || inferMimeType(document.fileExt),
    sourcePath: document.storagePath,
    uploadedBy: document.uploadedBy,
    uploaderRole: document.uploaderRole,
    parseMethod,
    extractedText: clippedText,
  });
  await writeFile(absoluteMdPath, markdown, 'utf8');

  const updatedAt = new Date().toISOString();
  invalidateKnowledgeSearchCache();
  return repository.updateDocument(document.id, {
    status: 'ingested',
    parsedMdPath: relativeMdPath.replace(/\\/g, '/'),
    parseMethod,
    parsedCharCount: clippedText.length,
    updatedAt,
    errorMessage: null,
  });
};

const loadDocumentOr404 = async (
  repository: RagDocumentsRepository,
  req: Request,
  res: Response,
): Promise<RagDocumentRecord | null> => {
  const parsed = DocumentParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({
      error: 'invalid_document_id',
      details: parsed.error.flatten(),
    });
    return null;
  }

  const document = await repository.getDocument(parsed.data.document_id);
  if (!document) {
    res.status(404).json({ error: 'document_not_found' });
    return null;
  }

  return document;
};

type CreateRagApiRouterOptions = {
  repository?: RagDocumentsRepository | null;
  rootDir?: string;
};

export const createRagApiRouter = (options: CreateRagApiRouterOptions = {}): Router => {
  const router = Router();
  const repository = options.repository ?? buildStorageRepository();
  const rootDir = options.rootDir || ROOT_DIR;

  router.get('/api/rag/documents', async (req, res) => {
    if (!requireAdminIdentity(req, res)) return;

    const items = await repository.listDocuments();
    res.status(200).json({
      total: items.length,
      items: items.map((item) => toDocumentItem(item)),
    });
  });

  router.post('/api/rag/documents', async (req, res) => {
    const identity = requireAdminIdentity(req, res);
    if (!identity) return;

    try {
      const payload = await parseMultipartUpload(req);
      const mimeType = normalizeMimeType(payload.mimeType);
      const extension = detectExtension(payload.fileName, mimeType);

      if (!SUPPORTED_EXTENSIONS.has(extension)) {
        return res.status(400).json({
          error: `Unsupported file extension: ${extension || '(none)'}`,
          supportedExtensions: Array.from(SUPPORTED_EXTENSIONS),
        });
      }
      if (mimeType && !SUPPORTED_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({
          error: `Unsupported mime type: ${mimeType}`,
          supportedMimeTypes: Array.from(SUPPORTED_MIME_TYPES),
        });
      }

      const fileHash = createHash('sha256').update(payload.buffer).digest('hex');
      const existing = await repository.findDocumentByHash(fileHash);
      if (existing) {
        return res.status(200).json(toDocumentItem(existing));
      }

      const safeBaseName = sanitizeBaseFileName(path.basename(payload.fileName, path.extname(payload.fileName)));
      const relativeStoragePath = buildRelativeStoragePath(fileHash, safeBaseName, extension);
      const absolutePath = resolveAbsolutePath(rootDir, relativeStoragePath);
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, payload.buffer);

      const nowIso = new Date().toISOString();
      const created = await repository.createDocument({
        id: randomUUID(),
        title: safeBaseName,
        sourceType: 'manual_upload',
        filename: payload.fileName,
        fileExt: extension,
        mimeType: mimeType || inferMimeType(extension),
        sizeBytes: payload.buffer.length,
        fileHash,
        storagePath: relativeStoragePath.replace(/\\/g, '/'),
        uploadedBy: payload.uploadedBy || identity.uploadedBy,
        uploaderRole: identity.uploaderRole,
        status: 'uploaded',
        createdAt: nowIso,
        updatedAt: nowIso,
        parsedMdPath: null,
        parseMethod: null,
        parsedCharCount: null,
        embeddingModel: payload.embeddingModel,
        errorMessage: null,
      });

      const indexed = await reindexDocument(repository, rootDir, created);
      res.status(201).json(toDocumentItem(indexed));
    } catch (error) {
      const statusCode = typeof error === 'object' && error && 'statusCode' in error ? Number((error as { statusCode: number }).statusCode) : 500;
      res.status(statusCode).json({
        error: error instanceof Error ? error.message : 'Failed to upload document',
      });
    }
  });

  router.get('/api/rag/documents/:document_id', async (req, res) => {
    if (!requireAdminIdentity(req, res)) return;

    const document = await loadDocumentOr404(repository, req, res);
    if (!document) return;
    res.status(200).json(toDocumentItem(document));
  });

  router.delete('/api/rag/documents/:document_id', async (req, res) => {
    if (!requireAdminIdentity(req, res)) return;

    const document = await loadDocumentOr404(repository, req, res);
    if (!document) return;

    await rm(resolveAbsolutePath(rootDir, document.storagePath), { force: true });
    if (document.parsedMdPath) {
      await rm(resolveAbsolutePath(rootDir, document.parsedMdPath), { force: true });
    }
    await repository.deleteDocument(document.id);
    invalidateKnowledgeSearchCache();

    res.status(200).json({
      ok: true,
      deleted: true,
      documentId: document.id,
    });
  });

  router.post('/api/rag/documents/:document_id/reindex', async (req, res) => {
    if (!requireAdminIdentity(req, res)) return;

    const document = await loadDocumentOr404(repository, req, res);
    if (!document) return;

    const reindexed = await reindexDocument(repository, rootDir, document);
    res.status(200).json(toDocumentItem(reindexed));
  });

  const sendDocumentFile = async (
    repositoryInstance: RagDocumentsRepository,
    req: Request,
    res: Response,
    scope: 'documents' | 'sources',
  ) => {
    if (scope === 'documents' && !requireAdminIdentity(req, res)) return;
    const document = await loadDocumentOr404(repositoryInstance, req, res);
    if (!document) return;

    const absolutePath = resolveAbsolutePath(rootDir, document.storagePath);
    const info = await stat(absolutePath);
    res.setHeader('Content-Type', document.mimeType || inferMimeType(document.fileExt));
    res.setHeader('Content-Length', String(info.size));
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(document.filename)}"`);
    createReadStream(absolutePath).pipe(res);
  };

  const sendDocumentPreview = async (
    repositoryInstance: RagDocumentsRepository,
    req: Request,
    res: Response,
    scope: 'documents' | 'sources',
  ) => {
    if (scope === 'documents' && !requireAdminIdentity(req, res)) return;
    const document = await loadDocumentOr404(repositoryInstance, req, res);
    if (!document) return;

    try {
      const absolutePath = resolveAbsolutePath(rootDir, document.storagePath);
      const extractedText = await extractTextByExtension(absolutePath, document.fileExt);
      const truncated = extractedText.length > MAX_PREVIEW_CHARS;
      res.status(200).json(
        buildPreviewResponse(
          document,
          'text',
          extractedText.slice(0, MAX_PREVIEW_CHARS),
          truncated,
          null,
          scope,
        ),
      );
    } catch (error) {
      res.status(200).json(
        buildPreviewResponse(
          document,
          'unsupported',
          '',
          false,
          error instanceof Error ? error.message : 'Preview is not available for this file type.',
          scope,
        ),
      );
    }
  };

  router.get('/api/rag/documents/:document_id/file', async (req, res) => {
    await sendDocumentFile(repository, req, res, 'documents');
  });

  router.get('/api/rag/documents/:document_id/preview', async (req, res) => {
    await sendDocumentPreview(repository, req, res, 'documents');
  });

  router.get('/api/rag/sources/:document_id/file', async (req, res) => {
    await sendDocumentFile(repository, req, res, 'sources');
  });

  router.get('/api/rag/sources/:document_id/preview', async (req, res) => {
    await sendDocumentPreview(repository, req, res, 'sources');
  });

  return router;
};
