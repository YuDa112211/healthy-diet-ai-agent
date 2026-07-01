import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import type {
  AppStorage,
  ChatHistoryInsertInput,
  ChatHistoryQuery,
  ChatRoomUpsertInput,
  KnowledgeDocumentRecord,
  KnowledgeIngestionJobRecord,
  UserProfileRecord,
  UserProfileUpdateInput,
} from '../types';
import { SQLITE_BOOTSTRAP_SQL } from './schema';

const parseJsonArray = (value: unknown): string[] => {
  if (typeof value !== 'string' || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
};

const serializeJson = (value: unknown): string | null => {
  if (value == null) return null;
  return JSON.stringify(value);
};

const parseDietReport = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const mapUserProfileRow = (row: Record<string, unknown>): UserProfileRecord => ({
  id: String(row.id),
  nickname: row.nickname == null ? null : String(row.nickname),
  avatar_url: row.avatar_url == null ? null : String(row.avatar_url),
  height: row.height == null ? null : Number(row.height),
  weight: row.weight == null ? null : Number(row.weight),
  age: row.age == null ? null : Number(row.age),
  gender: row.gender == null ? null : String(row.gender),
  taboo: parseJsonArray(row.taboo),
  disease: parseJsonArray(row.disease),
});

const mapKnowledgeDocumentRow = (row: Record<string, unknown>): KnowledgeDocumentRecord => ({
  id: String(row.id),
  title: String(row.title),
  sourceType: String(row.source_type),
  filename: String(row.file_name),
  fileExt: String(row.file_ext),
  mimeType: row.mime_type == null ? null : String(row.mime_type),
  sizeBytes: Number(row.file_size_bytes || 0),
  fileHash: String(row.file_hash),
  storagePath: String(row.storage_path),
  uploadedBy: String(row.uploaded_by),
  uploaderRole: String(row.uploader_role),
  status: String(row.status),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  parsedMdPath: row.parsed_md_path == null ? null : String(row.parsed_md_path),
  parseMethod: row.parse_method == null ? null : String(row.parse_method),
  parsedCharCount: row.parsed_char_count == null ? null : Number(row.parsed_char_count),
  embeddingModel: row.embedding_model == null ? null : String(row.embedding_model),
  errorMessage: row.error_message == null ? null : String(row.error_message),
  tags: parseJsonArray(row.tags),
});

const mapKnowledgeIngestionJobRow = (row: Record<string, unknown>): KnowledgeIngestionJobRecord => ({
  id: String(row.id),
  documentId: String(row.document_id),
  status: String(row.status),
  extractor: row.extractor == null ? null : String(row.extractor),
  parseMethod: row.parse_method == null ? null : String(row.parse_method),
  parsedMdPath: row.parsed_md_path == null ? null : String(row.parsed_md_path),
  extractedCharCount: row.extracted_char_count == null ? null : Number(row.extracted_char_count),
  extractedTextExcerpt:
    row.extracted_text_excerpt == null ? null : String(row.extracted_text_excerpt),
  errorMessage: row.error_message == null ? null : String(row.error_message),
  startedAt: row.started_at == null ? null : String(row.started_at),
  finishedAt: row.finished_at == null ? null : String(row.finished_at),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

export const createSqliteStorage = (dbPath: string): AppStorage => {
  if (dbPath !== ':memory:') {
    const normalizedPath = path.resolve(dbPath);
    mkdirSync(path.dirname(normalizedPath), { recursive: true });
    dbPath = normalizedPath;
  }

  const db = new Database(dbPath, { create: true });

  const ensureReady = async () => {
    db.exec(SQLITE_BOOTSTRAP_SQL);
  };

  const insertChatHistory = async (input: ChatHistoryInsertInput): Promise<{ id?: string }> => {
    const id = randomUUID();
    db.query(
      `insert into diet_chat_history
      (id, room_id, user_id, title, user_message, ai_analysis_report, image_path, summary, diet_report, record_type, created_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      input.roomId,
      input.userId ?? null,
      input.title ?? null,
      input.userMessage,
      input.aiAnalysisReport,
      input.imagePath ?? null,
      input.summaryText ?? null,
      serializeJson(input.dietReport),
      input.recordType ?? 'chat',
      new Date().toISOString()
    );
    return { id };
  };

  const updateChatHistoryReply = async ({
    chatHistoryId,
    aiReply,
  }: {
    chatHistoryId: string;
    aiReply: string;
  }): Promise<void> => {
    db.query(`update diet_chat_history set ai_analysis_report = ? where id = ?`).run(
      aiReply,
      chatHistoryId
    );
  };

  const upsertChatRoom = async (input: ChatRoomUpsertInput): Promise<void> => {
    const nowIso = new Date().toISOString();
    const summaryValue =
      input.summaryIndexEntries !== undefined
        ? JSON.stringify(input.summaryIndexEntries)
        : input.compactSummary !== undefined
          ? input.compactSummary
          : input.summaryArray !== undefined
            ? JSON.stringify(input.summaryArray)
            : null;

    db.query(
      `insert into chat_rooms (room_id, user_id, title, summary, updated_at, last_message_at)
       values (?, ?, ?, ?, ?, ?)
       on conflict(room_id, user_id) do update set
         title = excluded.title,
         summary = coalesce(excluded.summary, chat_rooms.summary),
         updated_at = excluded.updated_at,
         last_message_at = excluded.last_message_at`
    ).run(
      input.threadId,
      input.userId ?? '',
      input.title ?? null,
      summaryValue,
      nowIso,
      nowIso
    );
  };

  const getChatRoomSummary = async (threadId: string, userId?: string): Promise<unknown> => {
    const row = db
      .query(`select summary from chat_rooms where room_id = ? and user_id = ? limit 1`)
      .get(threadId, userId ?? '') as Record<string, unknown> | null;

    if (!row || row.summary == null) return null;

    if (typeof row.summary !== 'string') return row.summary;
    try {
      return JSON.parse(row.summary);
    } catch {
      return row.summary;
    }
  };

  const getUserProfile = async (userId: string): Promise<UserProfileRecord | null> => {
    const row = db.query(`select * from users where id = ? limit 1`).get(userId) as
      | Record<string, unknown>
      | null;
    return row ? mapUserProfileRow(row) : null;
  };

  const updateUserProfile = async (input: UserProfileUpdateInput): Promise<UserProfileRecord> => {
    const current = await getUserProfile(input.userId);
    const next: UserProfileRecord = {
      id: input.userId,
      nickname: input.nickname ?? current?.nickname ?? null,
      avatar_url: input.avatarUrl ?? current?.avatar_url ?? null,
      height: input.height ?? current?.height ?? null,
      weight: input.weight ?? current?.weight ?? null,
      age: input.age ?? current?.age ?? null,
      gender: input.gender ?? current?.gender ?? null,
      taboo: input.taboo ?? current?.taboo ?? [],
      disease: input.disease ?? current?.disease ?? [],
    };

    db.query(
      `insert into users (id, nickname, avatar_url, height, weight, age, gender, taboo, disease, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(id) do update set
         nickname = excluded.nickname,
         avatar_url = excluded.avatar_url,
         height = excluded.height,
         weight = excluded.weight,
         age = excluded.age,
         gender = excluded.gender,
         taboo = excluded.taboo,
         disease = excluded.disease,
         updated_at = excluded.updated_at`
    ).run(
      next.id,
      next.nickname,
      next.avatar_url,
      next.height,
      next.weight,
      next.age,
      next.gender,
      JSON.stringify(next.taboo),
      JSON.stringify(next.disease),
      new Date().toISOString()
    );

    return next;
  };

  const getChatHistory = async (input: ChatHistoryQuery) => {
    const conditions = ['room_id = ?'];
    const values: unknown[] = [input.roomId];

    if (input.recordType && input.recordType !== 'all') {
      conditions.push('record_type = ?');
      values.push(input.recordType);
    }
    if (input.chatHistoryIds && input.chatHistoryIds.length > 0) {
      conditions.push(`id in (${input.chatHistoryIds.map(() => '?').join(', ')})`);
      values.push(...input.chatHistoryIds);
    }
    if (input.dateFrom) {
      conditions.push('created_at >= ?');
      values.push(input.dateFrom);
    }
    if (input.dateTo) {
      conditions.push('created_at <= ?');
      values.push(input.dateTo);
    }

    const limit = input.limit ?? 8;
    const rows = db
      .query(
        `select id, created_at, title, user_message, ai_analysis_report, summary, diet_report, record_type
         from diet_chat_history
         where ${conditions.join(' and ')}
         order by created_at desc
         limit ?`
      )
      .all(...values, limit) as Record<string, unknown>[];

    return rows
      .map((row) => ({
        id: String(row.id),
        created_at: String(row.created_at),
        title: row.title == null ? null : String(row.title),
        user_message: row.user_message == null ? null : String(row.user_message),
        ai_analysis_report:
          row.ai_analysis_report == null ? null : String(row.ai_analysis_report),
        summary: row.summary == null ? null : String(row.summary),
        diet_report: parseDietReport(row.diet_report),
        record_type: row.record_type == null ? null : String(row.record_type),
      }))
      .reverse();
  };

  const listKnowledgeDocuments = async () => {
    const rows = db
      .query(`select * from knowledge_documents order by created_at desc`)
      .all() as Record<string, unknown>[];
    return rows.map(mapKnowledgeDocumentRow);
  };

  const getKnowledgeDocument = async (documentId: string) => {
    const row = db.query(`select * from knowledge_documents where id = ? limit 1`).get(documentId) as
      | Record<string, unknown>
      | null;
    return row ? mapKnowledgeDocumentRow(row) : null;
  };

  const findKnowledgeDocumentByHash = async (fileHash: string) => {
    const row = db
      .query(`select * from knowledge_documents where file_hash = ? limit 1`)
      .get(fileHash) as Record<string, unknown> | null;
    return row ? mapKnowledgeDocumentRow(row) : null;
  };

  const createKnowledgeDocument = async (record: KnowledgeDocumentRecord) => {
    db.query(
      `insert into knowledge_documents
      (id, title, source_type, file_name, file_ext, mime_type, file_size_bytes, file_hash, storage_path, uploaded_by, uploader_role, tags, status, created_at, updated_at, parsed_md_path, parse_method, parsed_char_count, embedding_model, error_message)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.title,
      record.sourceType,
      record.filename,
      record.fileExt,
      record.mimeType,
      record.sizeBytes,
      record.fileHash,
      record.storagePath,
      record.uploadedBy,
      record.uploaderRole,
      JSON.stringify(record.tags ?? []),
      record.status,
      record.createdAt,
      record.updatedAt,
      record.parsedMdPath,
      record.parseMethod,
      record.parsedCharCount,
      record.embeddingModel,
      record.errorMessage
    );
    return record;
  };

  const updateKnowledgeDocument = async (
    documentId: string,
    patch: Partial<KnowledgeDocumentRecord>
  ) => {
    const current = await getKnowledgeDocument(documentId);
    if (!current) {
      throw new Error(`Document not found: ${documentId}`);
    }

    const next: KnowledgeDocumentRecord = { ...current, ...patch };
    db.query(
      `update knowledge_documents set
        title = ?, source_type = ?, file_name = ?, file_ext = ?, mime_type = ?, file_size_bytes = ?,
        file_hash = ?, storage_path = ?, uploaded_by = ?, uploader_role = ?, tags = ?, status = ?,
        created_at = ?, updated_at = ?, parsed_md_path = ?, parse_method = ?, parsed_char_count = ?,
        embedding_model = ?, error_message = ?
      where id = ?`
    ).run(
      next.title,
      next.sourceType,
      next.filename,
      next.fileExt,
      next.mimeType,
      next.sizeBytes,
      next.fileHash,
      next.storagePath,
      next.uploadedBy,
      next.uploaderRole,
      JSON.stringify(next.tags ?? []),
      next.status,
      next.createdAt,
      next.updatedAt,
      next.parsedMdPath,
      next.parseMethod,
      next.parsedCharCount,
      next.embeddingModel,
      next.errorMessage,
      documentId
    );
    return next;
  };

  const deleteKnowledgeDocument = async (documentId: string) => {
    db.query(`delete from knowledge_documents where id = ?`).run(documentId);
  };

  const createKnowledgeIngestionJob = async (record: KnowledgeIngestionJobRecord) => {
    db.query(
      `insert into knowledge_ingestion_jobs
      (id, document_id, status, extractor, parse_method, parsed_md_path, extracted_char_count, extracted_text_excerpt, error_message, started_at, finished_at, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      record.id,
      record.documentId,
      record.status,
      record.extractor,
      record.parseMethod,
      record.parsedMdPath,
      record.extractedCharCount,
      record.extractedTextExcerpt,
      record.errorMessage,
      record.startedAt,
      record.finishedAt,
      record.createdAt,
      record.updatedAt
    );
    return record;
  };

  const getKnowledgeIngestionJob = async (jobId: string) => {
    const row = db
      .query(`select * from knowledge_ingestion_jobs where id = ? limit 1`)
      .get(jobId) as Record<string, unknown> | null;
    return row ? mapKnowledgeIngestionJobRow(row) : null;
  };

  const updateKnowledgeIngestionJob = async (
    jobId: string,
    patch: Partial<KnowledgeIngestionJobRecord>
  ) => {
    const current = await getKnowledgeIngestionJob(jobId);
    if (!current) {
      throw new Error(`Knowledge ingestion job not found: ${jobId}`);
    }

    const next: KnowledgeIngestionJobRecord = { ...current, ...patch };
    db.query(
      `update knowledge_ingestion_jobs set
        document_id = ?, status = ?, extractor = ?, parse_method = ?, parsed_md_path = ?,
        extracted_char_count = ?, extracted_text_excerpt = ?, error_message = ?, started_at = ?,
        finished_at = ?, created_at = ?, updated_at = ?
      where id = ?`
    ).run(
      next.documentId,
      next.status,
      next.extractor,
      next.parseMethod,
      next.parsedMdPath,
      next.extractedCharCount,
      next.extractedTextExcerpt,
      next.errorMessage,
      next.startedAt,
      next.finishedAt,
      next.createdAt,
      next.updatedAt,
      jobId
    );
    return next;
  };

  return {
    backend: 'sqlite',
    ensureReady,
    insertChatHistory,
    updateChatHistoryReply,
    upsertChatRoom,
    getChatRoomSummary,
    getUserProfile,
    updateUserProfile,
    getChatHistory,
    listKnowledgeDocuments,
    getKnowledgeDocument,
    findKnowledgeDocumentByHash,
    createKnowledgeDocument,
    updateKnowledgeDocument,
    deleteKnowledgeDocument,
    createKnowledgeIngestionJob,
    updateKnowledgeIngestionJob,
    getKnowledgeIngestionJob,
  };
};

export const createSqliteStorageForTest = createSqliteStorage;
