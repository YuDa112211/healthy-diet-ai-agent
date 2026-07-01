export type StorageBackend = 'sqlite' | 'supabase';

export type ChatHistoryInsertInput = {
  roomId: string;
  userId?: string;
  userMessage: string;
  imagePath?: string;
  title?: string;
  aiAnalysisReport: string;
  dietReport?: unknown;
  recordType?: 'chat' | 'summary';
  summaryText?: string;
};

export type ChatRoomUpsertInput = {
  threadId: string;
  userId?: string;
  title?: string;
  compactSummary?: string;
  summaryArray?: string[];
  summaryIndexEntries?: unknown[];
};

export type UserProfileRecord = {
  id: string;
  nickname: string | null;
  avatar_url: string | null;
  height: number | null;
  weight: number | null;
  age: number | null;
  gender: string | null;
  taboo: string[];
  disease: string[];
};

export type UserProfileUpdateInput = {
  userId: string;
  nickname?: string;
  avatarUrl?: string;
  height?: number;
  weight?: number;
  age?: number;
  gender?: string;
  taboo?: string[];
  disease?: string[];
};

export type ChatHistoryRecord = {
  id: string;
  created_at: string;
  title: string | null;
  user_message: string | null;
  ai_analysis_report: string | null;
  summary: string | null;
  diet_report: unknown;
  record_type: string | null;
};

export type ChatHistoryQuery = {
  roomId: string;
  limit?: number;
  recordType?: 'all' | 'chat' | 'summary';
  chatHistoryIds?: string[];
  dateFrom?: string;
  dateTo?: string;
};

export type KnowledgeDocumentRecord = {
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
  tags?: string[];
};

export type KnowledgeIngestionJobRecord = {
  id: string;
  documentId: string;
  status: string;
  extractor: string | null;
  parseMethod: string | null;
  parsedMdPath: string | null;
  extractedCharCount: number | null;
  extractedTextExcerpt: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export interface AppStorage {
  backend: StorageBackend;
  ensureReady(): Promise<void>;
  insertChatHistory(input: ChatHistoryInsertInput): Promise<{ id?: string }>;
  updateChatHistoryReply(input: { chatHistoryId: string; aiReply: string }): Promise<void>;
  upsertChatRoom(input: ChatRoomUpsertInput): Promise<void>;
  getChatRoomSummary(threadId: string, userId?: string): Promise<unknown>;
  getUserProfile(userId: string): Promise<UserProfileRecord | null>;
  updateUserProfile(input: UserProfileUpdateInput): Promise<UserProfileRecord>;
  getChatHistory(input: ChatHistoryQuery): Promise<ChatHistoryRecord[]>;
  listKnowledgeDocuments(): Promise<KnowledgeDocumentRecord[]>;
  getKnowledgeDocument(documentId: string): Promise<KnowledgeDocumentRecord | null>;
  findKnowledgeDocumentByHash(fileHash: string): Promise<KnowledgeDocumentRecord | null>;
  createKnowledgeDocument(record: KnowledgeDocumentRecord): Promise<KnowledgeDocumentRecord>;
  updateKnowledgeDocument(
    documentId: string,
    patch: Partial<KnowledgeDocumentRecord>
  ): Promise<KnowledgeDocumentRecord>;
  deleteKnowledgeDocument(documentId: string): Promise<void>;
  createKnowledgeIngestionJob(record: KnowledgeIngestionJobRecord): Promise<KnowledgeIngestionJobRecord>;
  updateKnowledgeIngestionJob(
    jobId: string,
    patch: Partial<KnowledgeIngestionJobRecord>
  ): Promise<KnowledgeIngestionJobRecord>;
  getKnowledgeIngestionJob(jobId: string): Promise<KnowledgeIngestionJobRecord | null>;
}
