import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { ROOT_DIR } from './workspacePaths';
import { supabase } from './supabaseRuntime';

const MAX_UPLOAD_BYTES = Number(process.env.KNOWLEDGE_MAX_UPLOAD_BYTES || 12 * 1024 * 1024);
const MAX_EXTRACTED_TEXT_CHARS = Number(process.env.KNOWLEDGE_MAX_EXTRACTED_TEXT_CHARS || 350000);

const SUPPORTED_EXTENSIONS = new Set(['pdf', 'docx', 'txt', 'md']);
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown'
]);

const UploadKnowledgeSchema = z.object({
  file_name: z.string().trim().min(1).max(180),
  file_base64: z.string().trim().min(1),
  mime_type: z.string().trim().min(1).max(120).optional(),
  title: z.string().trim().max(240).optional(),
  uploaded_by: z.string().trim().min(1).max(120),
  uploader_role: z.enum(['admin', 'nutritionist']),
  source_type: z.string().trim().max(80).optional().default('manual_upload'),
  tags: z.array(z.string().trim().min(1).max(40)).optional().default([])
});

const IngestParamsSchema = z.object({
  id: z.string().uuid()
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
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
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
    input.extractedText
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
  if (extension === 'txt' || extension === 'md') {
    return parseTxtLike(absolutePath);
  }
  if (extension === 'docx') {
    return parseDocx(absolutePath);
  }
  if (extension === 'pdf') {
    return parsePdf(absolutePath);
  }
  throw new Error(`Unsupported extension for extraction: ${extension}`);
};

const ensureSupabase = (res: Response): boolean => {
  if (supabase) return true;
  res.status(503).json({
    error: 'Supabase is not configured. Please set SUPABASE_URL and SUPABASE_SERVICE_KEY.'
  });
  return false;
};

export const uploadKnowledgeHandler = async (req: Request, res: Response) => {
  if (!ensureSupabase(res)) return;

  const parsed = UploadKnowledgeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid payload',
      details: parsed.error.flatten()
    });
  }

  const payload = parsed.data;
  const mimeType = payload.mime_type?.toLowerCase();
  const extension = detectExtension(payload.file_name, mimeType);
  if (!SUPPORTED_EXTENSIONS.has(extension)) {
    return res.status(400).json({
      error: `Unsupported file extension: ${extension || '(none)'}`,
      supported_extensions: Array.from(SUPPORTED_EXTENSIONS)
    });
  }
  if (mimeType && !SUPPORTED_MIME_TYPES.has(mimeType)) {
    return res.status(400).json({
      error: `Unsupported mime type: ${mimeType}`,
      supported_mime_types: Array.from(SUPPORTED_MIME_TYPES)
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
      error: `File too large. Max allowed is ${MAX_UPLOAD_BYTES} bytes.`
    });
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  const existingCheck = await supabase!
    .from('knowledge_documents')
    .select('id, file_name, status, created_at')
    .eq('file_hash', sha256)
    .maybeSingle();

  if (existingCheck.error) {
    return res.status(500).json({
      error: `Failed to check duplicate document: ${existingCheck.error.message}`
    });
  }

  if (existingCheck.data) {
    return res.status(200).json({
      duplicate: true,
      document: existingCheck.data
    });
  }

  const safeBaseName = sanitizeBaseFileName(path.basename(payload.file_name, path.extname(payload.file_name)));
  const relativeStoragePath = buildRelativeStoragePath(sha256, safeBaseName, extension);
  const absolutePath = path.resolve(ROOT_DIR, relativeStoragePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, buffer);

  const nowIso = new Date().toISOString();
  const insertResult = await supabase!
    .from('knowledge_documents')
    .insert({
      title: payload.title || safeBaseName,
      source_type: payload.source_type,
      file_name: payload.file_name,
      file_ext: extension,
      mime_type: mimeType || null,
      file_size_bytes: buffer.length,
      file_hash: sha256,
      storage_path: relativeStoragePath.replace(/\\/g, '/'),
      uploaded_by: payload.uploaded_by,
      uploader_role: payload.uploader_role,
      tags: payload.tags,
      status: 'uploaded',
      created_at: nowIso,
      updated_at: nowIso
    })
    .select('id, title, source_type, file_name, file_ext, mime_type, file_size_bytes, file_hash, storage_path, uploaded_by, uploader_role, tags, status, created_at, updated_at')
    .single();

  if (insertResult.error) {
    return res.status(500).json({
      error: `Failed to insert knowledge document: ${insertResult.error.message}`
    });
  }

  return res.status(201).json({
    duplicate: false,
    document: insertResult.data
  });
};

export const ingestKnowledgeHandler = async (req: Request, res: Response) => {
  if (!ensureSupabase(res)) return;

  const parsedParams = IngestParamsSchema.safeParse(req.params);
  if (!parsedParams.success) {
    return res.status(400).json({
      error: 'Invalid document id',
      details: parsedParams.error.flatten()
    });
  }

  const documentId = parsedParams.data.id;

  const docResult = await supabase!
    .from('knowledge_documents')
    .select('id, title, source_type, file_name, file_ext, storage_path, uploaded_by, uploader_role, status')
    .eq('id', documentId)
    .maybeSingle();

  if (docResult.error) {
    return res.status(500).json({
      error: `Failed to query document: ${docResult.error.message}`
    });
  }
  if (!docResult.data) {
    return res.status(404).json({ error: 'Document not found' });
  }

  const documentRow = docResult.data;
  const absolutePath = path.resolve(ROOT_DIR, documentRow.storage_path);
  const nowIso = new Date().toISOString();
  const jobId = randomUUID();

  const createJobResult = await supabase!
    .from('knowledge_ingestion_jobs')
    .insert({
      id: jobId,
      document_id: documentId,
      status: 'processing',
      extractor: `native_${documentRow.file_ext}`,
      started_at: nowIso,
      created_at: nowIso,
      updated_at: nowIso
    });

  if (createJobResult.error) {
    return res.status(500).json({
      error: `Failed to create ingestion job: ${createJobResult.error.message}`
    });
  }

  try {
    const extractedText = await extractTextByExtension(absolutePath, String(documentRow.file_ext));
    const clippedText = extractedText.slice(0, MAX_EXTRACTED_TEXT_CHARS);
    if (clippedText.length === 0) {
      throw new Error(
        `No text extracted from ${documentRow.file_name}. This document may require OCR preprocessing.`
      );
    }

    const safeBaseName = sanitizeBaseFileName(
      String(documentRow.title || path.basename(String(documentRow.file_name), path.extname(String(documentRow.file_name))))
    );
    const relativeMdPath = buildRelativeMarkdownPath(documentId, safeBaseName);
    const absoluteMdPath = path.resolve(ROOT_DIR, relativeMdPath);
    await mkdir(path.dirname(absoluteMdPath), { recursive: true });

    const parseMethod =
      String(documentRow.file_ext).toLowerCase() === 'pdf'
        ? 'pdf_text_layer'
        : String(documentRow.file_ext).toLowerCase() === 'docx'
          ? 'docx_text_layer'
          : 'plain_text';

    const mdContent = toMarkdownDocument({
      title: String(documentRow.title || safeBaseName),
      sourcePath: String(documentRow.storage_path),
      sourceType: String(documentRow.source_type || 'manual_upload'),
      uploadedBy: String(documentRow.uploaded_by || 'unknown'),
      uploadedRole: String(documentRow.uploader_role || 'unknown'),
      parseMethod,
      extractedText: clippedText
    });
    await writeFile(absoluteMdPath, mdContent, 'utf8');

    const excerpt = clippedText.slice(0, 1200);
    const completedAt = new Date().toISOString();

    const updateJobResult = await supabase!
      .from('knowledge_ingestion_jobs')
      .update({
        status: 'success',
        parsed_md_path: relativeMdPath.replace(/\\/g, '/'),
        parse_method: parseMethod,
        extracted_char_count: clippedText.length,
        extracted_text_excerpt: excerpt,
        finished_at: completedAt,
        updated_at: completedAt
      })
      .eq('id', jobId);

    if (updateJobResult.error) {
      throw new Error(`Failed to update ingestion job: ${updateJobResult.error.message}`);
    }

    const updateDocResult = await supabase!
      .from('knowledge_documents')
      .update({
        status: 'ingested',
        parsed_md_path: relativeMdPath.replace(/\\/g, '/'),
        parse_method: parseMethod,
        parsed_char_count: clippedText.length,
        updated_at: completedAt
      })
      .eq('id', documentId);

    if (updateDocResult.error) {
      throw new Error(`Failed to update document status: ${updateDocResult.error.message}`);
    }

    return res.status(200).json({
      status: 'success',
      job_id: jobId,
      document_id: documentId,
      extracted_char_count: clippedText.length,
      parsed_md_path: relativeMdPath.replace(/\\/g, '/'),
      excerpt
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failedAt = new Date().toISOString();

    await supabase!
      .from('knowledge_ingestion_jobs')
      .update({
        status: 'failed',
        error_message: message.slice(0, 2000),
        finished_at: failedAt,
        updated_at: failedAt
      })
      .eq('id', jobId);

    await supabase!
      .from('knowledge_documents')
      .update({
        status: 'failed',
        updated_at: failedAt
      })
      .eq('id', documentId);

    return res.status(500).json({
      status: 'failed',
      job_id: jobId,
      document_id: documentId,
      error: message
    });
  }
};

const JobParamsSchema = z.object({
  jobId: z.string().uuid()
});

export const knowledgeJobStatusHandler = async (req: Request, res: Response) => {
  if (!ensureSupabase(res)) return;

  const parsed = JobParamsSchema.safeParse(req.params);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Invalid job id',
      details: parsed.error.flatten()
    });
  }

  const jobId = parsed.data.jobId;
  const result = await supabase!
    .from('knowledge_ingestion_jobs')
    .select('id, document_id, status, extractor, parse_method, parsed_md_path, extracted_char_count, extracted_text_excerpt, error_message, started_at, finished_at, created_at, updated_at')
    .eq('id', jobId)
    .maybeSingle();

  if (result.error) {
    return res.status(500).json({
      error: `Failed to query job: ${result.error.message}`
    });
  }
  if (!result.data) {
    return res.status(404).json({ error: 'Job not found' });
  }

  return res.status(200).json({
    job: result.data
  });
};
