export type RoomSummaryIndexEntry = {
  summary_id: string;
  summary: string;
  source_chat_history_ids: string[];
  source_summary_history_id?: string;
  created_at: string;
  start_at?: string;
  end_at?: string;
};

const isRoomSummaryIndexEntry = (value: unknown): value is RoomSummaryIndexEntry => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.summary === 'string' &&
    Array.isArray(candidate.source_chat_history_ids) &&
    candidate.source_chat_history_ids.every((item) => typeof item === 'string')
  );
};

const normalizeRoomSummaryIndexEntry = (value: RoomSummaryIndexEntry): RoomSummaryIndexEntry => ({
  summary_id: value.summary_id.trim() || `summary-${value.created_at || Date.now()}`,
  summary: value.summary.trim(),
  source_chat_history_ids: value.source_chat_history_ids.map((item) => item.trim()).filter(Boolean),
  source_summary_history_id: value.source_summary_history_id?.trim() || undefined,
  created_at: value.created_at,
  start_at: value.start_at,
  end_at: value.end_at,
});

export const buildLegacySummaryIndexEntry = ({
  legacySummary,
  createdAt = '',
}: {
  legacySummary: string;
  createdAt?: string;
}): RoomSummaryIndexEntry => {
  const effectiveCreatedAt = createdAt || new Date().toISOString();
  const trimmed = legacySummary.trim();
  return {
    summary_id: `legacy-${effectiveCreatedAt}`,
    summary: trimmed,
    source_chat_history_ids: [],
    source_summary_history_id: undefined,
    created_at: effectiveCreatedAt,
    start_at: effectiveCreatedAt,
    end_at: effectiveCreatedAt,
  };
};

export const parseRoomSummaryIndex = (rawSummary: unknown): RoomSummaryIndexEntry[] => {
  if (typeof rawSummary === 'string') {
    const trimmed = rawSummary.trim();
    if (!trimmed || trimmed === '[]') return [];
    try {
      return parseRoomSummaryIndex(JSON.parse(trimmed));
    } catch {
      return [buildLegacySummaryIndexEntry({ legacySummary: trimmed })];
    }
  }

  if (Array.isArray(rawSummary)) {
    return rawSummary.filter(isRoomSummaryIndexEntry).map(normalizeRoomSummaryIndexEntry);
  }

  if (isRoomSummaryIndexEntry(rawSummary)) {
    return [normalizeRoomSummaryIndexEntry(rawSummary)];
  }

  return [];
};

export const summarizeRoomSummaryIndex = (entries: RoomSummaryIndexEntry[]): string => {
  if (entries.length === 0) return '';
  return entries.map((entry) => entry.summary).filter(Boolean).join('\n');
};

const toDateLabel = (value?: string): string => {
  if (!value) return 'unknown-date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  return date.toISOString().slice(0, 10);
};

export const formatRoomSummaryIndexContext = (entries: RoomSummaryIndexEntry[]): string => {
  if (entries.length === 0) return 'Room summary index: none.';

  const lines = entries.map((entry, index) => {
    const sourceChatIds = entry.source_chat_history_ids.join(',') || 'none';
    const sourceSummaryId = entry.source_summary_history_id || 'none';
    return `${index + 1}. [${toDateLabel(entry.start_at || entry.created_at)}] ${entry.summary} (source_chat_history_ids=${sourceChatIds}; source_summary_history_id=${sourceSummaryId})`;
  });

  return ['Room summary index:', ...lines].join('\n');
};

export const buildRoomSummaryIndexEntry = ({
  compactSummary,
  chatHistoryId,
  summaryHistoryId,
  createdAt = new Date().toISOString(),
}: {
  compactSummary: string;
  chatHistoryId: string;
  summaryHistoryId?: string;
  createdAt?: string;
}): RoomSummaryIndexEntry => ({
  summary_id: summaryHistoryId || `chat-${chatHistoryId}`,
  summary: compactSummary.trim(),
  source_chat_history_ids: [chatHistoryId],
  source_summary_history_id: summaryHistoryId,
  created_at: createdAt,
  start_at: createdAt,
  end_at: createdAt,
});
