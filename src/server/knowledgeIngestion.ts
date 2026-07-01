import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { ROOT_DIR } from './workspacePaths';
import { getStorage } from '../storage/runtime';

const MAX_UPLOAD_BYTES = Number(process.env.KNOWLEDGE_MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
const MAX_EXTRACTED_TEXT_CHARS = Number(process.env.KNOWLEDGE_MAX_EXTRACTED_TEXT_CHARS || 350000);

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
]);

const UploadKnowledgeSchema = z.object({
  file_name: z.string().trim().min(1).max(180),
  file_base64: z.string().trim().min(1),
  mime_type: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().max(240).optional(),
  uploaded_by: z.string().trim().min(1).max(120),
  uploader_role: z.enum(['admin', 'nutritionist']),
  source_type: z.string().trim().max(80).optional().default('manual_upload'),
  tags: z.array(z.string().trim().min(1).max(40)).optional().default([]),
});

const IngestParamsSchema = z.object({
  id: z.string().uuid(),
});

const JobParamsSchema = z.object({
  jobId: z.string().uuid(),
});

const stripDataUrlPrefix = (rawBase64: string): string => {
  if (!rawBase64.startsWith('data:')) return rawBase64;
  const idx = rawBase64.indexOf(',');
  if (idx < 0) return rawBase64;
  return rawBase64.slice(idx + 1);
};

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

const detectExtension = (fileName: string, mimeType?: string): string => {
  const ext = path.extname(fileName).replace('.', '').toLowerCase();
  if (ext) return ext;
  if (!mimeType) return '';

  if (mimeType === 'application/pdf') return 'pdf';
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    return 'docx';
  }
  if (mimeType === 'text/plain') return 'txt';
  if (mimeType === 'text/markdown') return 'md';
  return '';
};

const buildRelativeStoragePath = (sha256: string, safeName: string, extension: string): string => {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const shortHash = sha256.slice(0, 12);
  const file = `${shortHash}_${safeName}.${extension}`;
  return path.posix.join('knowledge_base', 'uploads', yyyy, mm, file);
};

const buildRelativeMarkdownPath = (documentId: string, safeName: string): string => {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const shortId = documentId.slice(0, 8);
  const file = `${shortId}_${safeName}.md`;
  return path.posix.join('knowledge_base', 'ingested_markdown', yyyy, mm, file);
};

const toMarkdownDocument = (input: {
  title: string;
  sourcePath: string;
  sourceType: string;
  uploadedBy: string;
  uploadedRole: string;
  parseMethod: string;
  extractedText: string;
}): string => {
  const lines = [
    `# ${input.title}`,
    '',
    `- source_type: ${input.sourceType}`,
    `- source_path: ${input.sourcePath}`,
    `- uploaded_by: ${input.uploadedBy}`,
    `- uploader_role: ${input.uploadedRole}`,
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

export const uploadKnowledgeHandler = async (req: Request, res: Response) => {
  const parsed = UploadKnowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid payload',
      details: parsed.error.flatten(),
    });
  }

  const payload = parsed.data;
  const mimeType = payload.mime_type?.toLowerCase();
  const extension = detectExtension(payload.file_name, mimeType);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return res.status(400).json({
      error: `Unsupported file extension: ${extension || '(none)'}`,
      supported_extensions: Array.from(SUPPORTED_EXTENSIONS),
    });
  }
  if (mimeType && !SUPPORTED_MIME_TYPES.has(mimeType)) {
    return res.status(400).json({
      error: `Unsupported mime type: ${mimeType}`,
      supported_mime_types: Array.from(SUPPORTED_MIME_TYPES),
    });
  }

  const base64 = stripDataUrlPrefix(payload.file_base64);
  let buffer: Buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid base64 payload' });
  }

  if (!buffer || buffer.length === 0) {
    return res.status(400).json({ error: 'Decoded file is empty' });
  }
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return res.status(413).json({
      error: `File too large. Max allowed is ${MAX_UPLOAD_BYTES} bytes.`,
    });
  }

  const storage = await getStorage();
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existing = await storage.findKnowledgeDocumentByHash(sha256);

  if (existing) {
    return res.status(200).json({
      duplicate: true,
      document: existing,
    });
  }

  const safeBaseName = sanitizeBaseFileName(path.basename(payload.file_name, path.extname(payload.file_name)));
  const relativeStoragePath = buildRelativeStoragePath(sha256, safeBaseName, extension);
  const absolutePath = path.resolve(ROOT_DIR, relativeStoragePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);

  const nowIso = new Date().toISOString();
  const document = await storage.createKnowledgeDocument({
    id: randomUUID(),
    title: payload.title || safeBaseName,
    sourceType: payload.source_type,
    filename: payload.file_name,
    fileExt: extension,
    mimeType: mimeType || null,
    sizeBytes: buffer.length,
    fileHash: sha256,
    storagePath: relativeStoragePath.replace(/\\/g, '/'),
    uploadedBy: payload.uploaded_by,
    uploaderRole: payload.uploader_role,
    tags: payload.tags,
    status: 'uploaded',
    createdAt: nowIso,
    updatedAt: nowIso,
    parsedMdPath: null,
    parseMethod: null,
    parsedCharCount: null,
    embeddingModel: null,
    errorMessage: null,
  });

  return res.status(201).json({
    duplicate: false,
    document,
  });
};

export const ingestKnowledgeHandler = async (req: Request, res: Response) => {
  const parsedParams = IngestParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: 'Invalid document id',
      details: parsedParams.error.flatten(),
    });
  }

  const documentId = parsedParams.data.id;
  const storage = await getStorage();
  const documentRow = await storage.getKnowledgeDocument(documentId);

  if (!documentRow) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const absolutePath = path.resolve(ROOT_DIR, documentRow.storagePath);
  const nowIso = new Date().toISOString();
  const jobId = randomUUID();

  await storage.createKnowledgeIngestionJob({
    id: jobId,
    documentId,
    status: 'processing',
    extractor: `native_${documentRow.fileExt}`,
    parseMethod: null,
    parsedMdPath: null,
    extractedCharCount: null,
    extractedTextExcerpt: null,
    errorMessage: null,
    startedAt: nowIso,
    finishedAt: null,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  try {
    const extractedText = await extractTextByExtension(absolutePath, String(documentRow.fileExt));
    const clippedText = extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS);
    if (clippedText.length === 0) {
      throw new Error(
        `No text extracted from ${documentRow.filename}. This document may require OCR preprocessing.`
      );
    }

    const safeBaseName = sanitizeBaseFileName(
      String(documentRow.title || path.basename(String(documentRow.filename), path.extname(String(documentRow.filename))))
    );
    const relativeMdPath = buildRelativeMarkdownPath(documentId, safeBaseName);
    const absoluteMdPath = path.resolve(ROOT_DIR, relativeMdPath);
    await mkdir(path.dirname(absoluteMdPath), { recursive: true });

    const parseMethod =
      String(documentRow.fileExt).toLowerCase() === 'pdf'
        ? 'pdf_text_layer'
        : String(documentRow.fileExt).toLowerCase() === 'docx'
          ? 'docx_text_layer'
          : 'plain_text';

    const mdContent = toMarkdownDocument({
      title: String(documentRow.title || safeBaseName),
      sourcePath: String(documentRow.storagePath),
      sourceType: String(documentRow.sourceType || 'manual_upload'),
      uploadedBy: String(documentRow.uploadedBy || 'unknown'),
      uploadedRole: String(documentRow.uploaderRole || 'unknown'),
      parseMethod,
      extractedText: clippedText,
    });
    await writeFile(absoluteMdPath, mdContent, 'utf8');

    const excerpt = clippedText.slice(0, 1200);
    const completedAt = new Date().toISOString();

    await storage.updateKnowledgeIngestionJob(jobId, {
      status: 'success',
      parsedMdPath: relativeMdPath.replace(/\\/g, '/'),
      parseMethod,
      extractedCharCount: clippedText.length,
      extractedTextExcerpt: excerpt,
      finishedAt: completedAt,
      updatedAt: completedAt,
    });

    await storage.updateKnowledgeDocument(documentId, {
      status: 'ingested',
      parsedMdPath: relativeMdPath.replace(/\\/g, '/'),
      parseMethod,
      parsedCharCount: clippedText.length,
      updatedAt: completedAt,
    });

    return res.status(200).json({
      status: 'success',
      job_id: jobId,
      document_id: documentId,
      extracted_char_count: clippedText.length,
      parsed_md_path: relativeMdPath.replace(/\\/g, '/'),
      excerpt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();

    await storage.updateKnowledgeIngestionJob(jobId, {
      status: 'failed',
      errorMessage: message.slice(0, 2000),
      finishedAt: failedAt,
      updatedAt: failedAt,
    });

    await storage.updateKnowledgeDocument(documentId, {
      status: 'failed',
      updatedAt: failedAt,
    });

    return res.status(500).json({
      status: 'failed',
      job_id: jobId,
      document_id: documentId,
      error: message,
    });
  }
};

export const knowledgeJobStatusHandler = async (req: Request, res: Response) => {
  const parsed = JobParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid job id',
      details: parsed.error.flatten(),
    });
  }

  const storage = await getStorage();
  const job = await storage.getKnowledgeIngestionJob(parsed.data.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.status(200).json({
    job,
  });
};
