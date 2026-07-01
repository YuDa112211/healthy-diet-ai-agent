import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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

const buildClient = (): SupabaseClient => {
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';
  if (!supabaseUrl || !supabaseKey) {
    throw new Error('Supabase is not configured. Missing SUPABASE_URL or SUPABASE_SERVICE_KEY.');
  }
  return createClient(supabaseUrl, supabaseKey);
};

const mapDocumentRow = (row: Record<string, unknown>): KnowledgeDocumentRecord => ({
  id: String(row.id),
  title: String(row.title || ''),
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
  createdAt: String(row.created_at || ''),
  updatedAt: String(row.updated_at || ''),
  parsedMdPath: row.parsed_md_path == null ? null : String(row.parsed_md_path),
  parseMethod: row.parse_method == null ? null : String(row.parse_method),
  parsedCharCount: row.parsed_char_count == null ? null : Number(row.parsed_char_count),
  embeddingModel: row.embedding_model == null ? null : String(row.embedding_model),
  errorMessage: row.error_message == null ? null : String(row.error_message),
  tags: Array.isArray(row.tags)
    ? row.tags.filter((item): item is string => typeof item === 'string')
    : [],
});

const mapJobRow = (row: Record<string, unknown>): KnowledgeIngestionJobRecord => ({
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

export const createSupabaseStorage = (
  client: SupabaseClient = buildClient()
): AppStorage => ({
  backend: 'supabase',
  async ensureReady() {},
  async insertChatHistory(input: ChatHistoryInsertInput) {
    const payload: Record<string, unknown> = {
      room_id: input.roomId,
      user_message: input.userMessage,
      ai_analysis_report: input.aiAnalysisReport,
      record_type: input.recordType ?? 'chat',
      title: input.title || input.userMessage.slice(0, 60),
      diet_report: input.dietReport,
    };
    if (input.userId) payload.user_id = input.userId;
    if (input.imagePath) payload.image_path = input.imagePath;
    if (input.summaryText) payload.summary = input.summaryText;

    let result = await client.from('diet_chat_history').insert([payload]).select('id');
    if (
      result.error &&
      payload.title !== undefined &&
      result.error.message.includes("'title' column")
    ) {
      delete payload.title;
      result = await client.from('diet_chat_history').insert([payload]).select('id');
    }
    if (result.error) throw new Error(result.error.message);
    return { id: typeof result.data?.[0]?.id === 'string' ? result.data[0].id : undefined };
  },
  async updateChatHistoryReply({ chatHistoryId, aiReply }) {
    const { data, error } = await client
      .from('diet_chat_history')
      .update({ ai_analysis_report: aiReply })
      .eq('id', chatHistoryId)
      .select('id');
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw new Error(`No rows updated in diet_chat_history for id=${chatHistoryId}`);
    }
  },
  async upsertChatRoom(input: ChatRoomUpsertInput) {
    const nowIso = new Date().toISOString();
    const payload: Record<string, unknown> = {
      room_id: input.threadId,
      updated_at: nowIso,
      last_message_at: nowIso,
    };
    if (input.userId) payload.user_id = input.userId;
    if (input.title !== undefined) payload.title = input.title;
    if (input.summaryIndexEntries !== undefined) payload.summary = input.summaryIndexEntries;
    else if (input.compactSummary !== undefined) payload.summary = input.compactSummary;
    else if (input.summaryArray !== undefined) payload.summary = input.summaryArray;
    const onConflict = input.userId ? 'room_id,user_id' : 'room_id';
    const { error } = await client.from('chat_rooms').upsert(payload, { onConflict });
    if (error) throw new Error(error.message);
  },
  async getChatRoomSummary(threadId: string, userId?: string) {
    let query = client.from('chat_rooms').select('summary').eq('room_id', threadId).limit(1);
    if (userId) query = query.eq('user_id', userId);
    const { data, error } = await query;
    if (error) throw new Error(error.message);
    return Array.isArray(data) && data.length > 0 ? data[0]?.summary ?? null : null;
  },
  async getUserProfile(userId: string) {
    const { data, error } = await client
      .from('users')
      .select('id, nickname, avatar_url, height, weight, age, gender, taboo, disease')
      .eq('id', userId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return null;
    return {
      id: String((data as Record<string, unknown>).id ?? userId),
      nickname: data.nickname ?? null,
      avatar_url: data.avatar_url ?? null,
      height: data.height ?? null,
      weight: data.weight ?? null,
      age: data.age ?? null,
      gender: data.gender ?? null,
      taboo: Array.isArray(data.taboo) ? data.taboo.filter((item): item is string => typeof item === 'string') : [],
      disease: Array.isArray(data.disease) ? data.disease.filter((item): item is string => typeof item === 'string') : [],
    } as UserProfileRecord;
  },
  async updateUserProfile(input: UserProfileUpdateInput) {
    const payload: Record<string, unknown> = {};
    if (input.nickname !== undefined) payload.nickname = input.nickname;
    if (input.avatarUrl !== undefined) payload.avatar_url = input.avatarUrl;
    if (input.height !== undefined) payload.height = input.height;
    if (input.weight !== undefined) payload.weight = input.weight;
    if (input.age !== undefined) payload.age = input.age;
    if (input.gender !== undefined) payload.gender = input.gender;
    if (input.taboo !== undefined) payload.taboo = input.taboo;
    if (input.disease !== undefined) payload.disease = input.disease;

    const { error } = await client.from('users').update(payload).eq('id', input.userId);
    if (error) throw new Error(error.message);
    const profile = await (createSupabaseStorage(client).getUserProfile(input.userId));
    if (!profile) throw new Error(`User not found after update: ${input.userId}`);
    return profile;
  },
  async getChatHistory(input: ChatHistoryQuery) {
    let query = client
      .from('diet_chat_history')
      .select('id, created_at, title, user_message, ai_analysis_report, summary, diet_report, record_type')
      .eq('room_id', input.roomId);
    if (input.recordType && input.recordType !== 'all') {
      query = query.eq('record_type', input.recordType);
    }
    if (input.chatHistoryIds && input.chatHistoryIds.length > 0) {
      query = query.in('id', input.chatHistoryIds);
    }
    if (input.dateFrom) query = query.gte('created_at', input.dateFrom);
    if (input.dateTo) query = query.lte('created_at', input.dateTo);
    const { data, error } = await query.order('created_at', { ascending: false }).limit(input.limit ?? 8);
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).slice().reverse().map((row) => ({
      id: String(row.id),
      created_at: String(row.created_at),
      title: row.title == null ? null : String(row.title),
      user_message: row.user_message == null ? null : String(row.user_message),
      ai_analysis_report: row.ai_analysis_report == null ? null : String(row.ai_analysis_report),
      summary: row.summary == null ? null : String(row.summary),
      diet_report: row.diet_report ?? null,
      record_type: row.record_type == null ? null : String(row.record_type),
    }));
  },
  async listKnowledgeDocuments() {
    const { data, error } = await client.from('knowledge_documents').select('*').order('created_at', { ascending: false });
    if (error) throw new Error(error.message);
    return ((data ?? []) as Record<string, unknown>[]).map(mapDocumentRow);
  },
  async getKnowledgeDocument(documentId: string) {
    const { data, error } = await client.from('knowledge_documents').select('*').eq('id', documentId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapDocumentRow(data as Record<string, unknown>) : null;
  },
  async findKnowledgeDocumentByHash(fileHash: string) {
    const { data, error } = await client.from('knowledge_documents').select('*').eq('file_hash', fileHash).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapDocumentRow(data as Record<string, unknown>) : null;
  },
  async createKnowledgeDocument(record: KnowledgeDocumentRecord) {
    const payload = {
      id: record.id,
      title: record.title,
      source_type: record.sourceType,
      file_name: record.filename,
      file_ext: record.fileExt,
      mime_type: record.mimeType,
      file_size_bytes: record.sizeBytes,
      file_hash: record.fileHash,
      storage_path: record.storagePath,
      uploaded_by: record.uploadedBy,
      uploader_role: record.uploaderRole,
      tags: record.tags ?? [],
      status: record.status,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
      parsed_md_path: record.parsedMdPath,
      parse_method: record.parseMethod,
      parsed_char_count: record.parsedCharCount,
      embedding_model: record.embeddingModel,
      error_message: record.errorMessage,
    };
    const { data, error } = await client.from('knowledge_documents').insert(payload).select('*').single();
    if (error) throw new Error(error.message);
    return mapDocumentRow(data as Record<string, unknown>);
  },
  async updateKnowledgeDocument(documentId: string, patch: Partial<KnowledgeDocumentRecord>) {
    const payload: Record<string, unknown> = {};
    if (patch.title !== undefined) payload.title = patch.title;
    if (patch.sourceType !== undefined) payload.source_type = patch.sourceType;
    if (patch.filename !== undefined) payload.file_name = patch.filename;
    if (patch.fileExt !== undefined) payload.file_ext = patch.fileExt;
    if (patch.mimeType !== undefined) payload.mime_type = patch.mimeType;
    if (patch.sizeBytes !== undefined) payload.file_size_bytes = patch.sizeBytes;
    if (patch.fileHash !== undefined) payload.file_hash = patch.fileHash;
    if (patch.storagePath !== undefined) payload.storage_path = patch.storagePath;
    if (patch.uploadedBy !== undefined) payload.uploaded_by = patch.uploadedBy;
    if (patch.uploaderRole !== undefined) payload.uploader_role = patch.uploaderRole;
    if (patch.tags !== undefined) payload.tags = patch.tags;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.createdAt !== undefined) payload.created_at = patch.createdAt;
    if (patch.updatedAt !== undefined) payload.updated_at = patch.updatedAt;
    if (patch.parsedMdPath !== undefined) payload.parsed_md_path = patch.parsedMdPath;
    if (patch.parseMethod !== undefined) payload.parse_method = patch.parseMethod;
    if (patch.parsedCharCount !== undefined) payload.parsed_char_count = patch.parsedCharCount;
    if (patch.embeddingModel !== undefined) payload.embedding_model = patch.embeddingModel;
    if (patch.errorMessage !== undefined) payload.error_message = patch.errorMessage;
    const { data, error } = await client.from('knowledge_documents').update(payload).eq('id', documentId).select('*').single();
    if (error) throw new Error(error.message);
    return mapDocumentRow(data as Record<string, unknown>);
  },
  async deleteKnowledgeDocument(documentId: string) {
    const { error } = await client.from('knowledge_documents').delete().eq('id', documentId);
    if (error) throw new Error(error.message);
  },
  async createKnowledgeIngestionJob(record: KnowledgeIngestionJobRecord) {
    const payload = {
      id: record.id,
      document_id: record.documentId,
      status: record.status,
      extractor: record.extractor,
      parse_method: record.parseMethod,
      parsed_md_path: record.parsedMdPath,
      extracted_char_count: record.extractedCharCount,
      extracted_text_excerpt: record.extractedTextExcerpt,
      error_message: record.errorMessage,
      started_at: record.startedAt,
      finished_at: record.finishedAt,
      created_at: record.createdAt,
      updated_at: record.updatedAt,
    };
    const { data, error } = await client.from('knowledge_ingestion_jobs').insert(payload).select('*').single();
    if (error) throw new Error(error.message);
    return mapJobRow(data as Record<string, unknown>);
  },
  async updateKnowledgeIngestionJob(jobId: string, patch: Partial<KnowledgeIngestionJobRecord>) {
    const payload: Record<string, unknown> = {};
    if (patch.documentId !== undefined) payload.document_id = patch.documentId;
    if (patch.status !== undefined) payload.status = patch.status;
    if (patch.extractor !== undefined) payload.extractor = patch.extractor;
    if (patch.parseMethod !== undefined) payload.parse_method = patch.parseMethod;
    if (patch.parsedMdPath !== undefined) payload.parsed_md_path = patch.parsedMdPath;
    if (patch.extractedCharCount !== undefined) payload.extracted_char_count = patch.extractedCharCount;
    if (patch.extractedTextExcerpt !== undefined) payload.extracted_text_excerpt = patch.extractedTextExcerpt;
    if (patch.errorMessage !== undefined) payload.error_message = patch.errorMessage;
    if (patch.startedAt !== undefined) payload.started_at = patch.startedAt;
    if (patch.finishedAt !== undefined) payload.finished_at = patch.finishedAt;
    if (patch.createdAt !== undefined) payload.created_at = patch.createdAt;
    if (patch.updatedAt !== undefined) payload.updated_at = patch.updatedAt;
    const { data, error } = await client.from('knowledge_ingestion_jobs').update(payload).eq('id', jobId).select('*').single();
    if (error) throw new Error(error.message);
    return mapJobRow(data as Record<string, unknown>);
  },
  async getKnowledgeIngestionJob(jobId: string) {
    const { data, error } = await client.from('knowledge_ingestion_jobs').select('*').eq('id', jobId).maybeSingle();
    if (error) throw new Error(error.message);
    return data ? mapJobRow(data as Record<string, unknown>) : null;
  },
});

export const createSupabaseStorageForTest = createSupabaseStorage;
