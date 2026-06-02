import { z } from 'zod';

export const ProfileUpdateFieldsSchema = z.object({
  nickname_to_set: z.string().trim().optional(),
  avatar_url_to_set: z.string().trim().optional(),
  height_to_set: z.number().positive().optional(),
  weight_to_set: z.number().positive().optional(),
  age_to_set: z.number().positive().optional(),
  gender_to_set: z.string().trim().optional(),
  taboo_to_add: z.string().trim().optional(),
  disease_to_add: z.string().trim().optional(),
  taboo_to_remove: z.string().trim().optional(),
  disease_to_remove: z.string().trim().optional(),
});

export type ProfileUpdateFields = z.infer<typeof ProfileUpdateFieldsSchema>;
export type ProfileUpdateFieldKey = keyof ProfileUpdateFields;

export type ApprovalAction = 'set' | 'add' | 'remove';

export type ApprovalProposalItem = {
  field: ProfileUpdateFieldKey;
  label: string;
  action: ApprovalAction;
  value: string | number;
};

const PROFILE_UPDATE_META: Record<ProfileUpdateFieldKey, { label: string; action: ApprovalAction }> = {
  nickname_to_set: { label: '暱稱', action: 'set' },
  avatar_url_to_set: { label: '頭像 URL', action: 'set' },
  height_to_set: { label: '身高', action: 'set' },
  weight_to_set: { label: '體重', action: 'set' },
  age_to_set: { label: '年齡', action: 'set' },
  gender_to_set: { label: '性別', action: 'set' },
  taboo_to_add: { label: '忌口', action: 'add' },
  disease_to_add: { label: '疾病', action: 'add' },
  taboo_to_remove: { label: '忌口', action: 'remove' },
  disease_to_remove: { label: '疾病', action: 'remove' },
};

export type PendingProfileUpdate = {
  approvalId: string;
  requestId: string;
  threadId: string;
  userId: string;
  deferredAiReply: string;
  fields: ProfileUpdateFields;
  items: ApprovalProposalItem[];
  summary: string;
  createdAt: number;
  expiresAt: number;
};

export const PENDING_APPROVAL_TTL_MS = 10 * 60 * 1000;
export const pendingProfileUpdates = new Map<string, PendingProfileUpdate>();
export const pendingApprovalByThread = new Map<string, string>();

export const hasAnyProfileField = (fields: ProfileUpdateFields): boolean => {
  return Object.entries(fields).some(([, value]) => {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    return true;
  });
};

const parseJsonSafe = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const normalizeProposalCandidate = (rawOutput: unknown): unknown => {
  let candidate: unknown = rawOutput;
  if (typeof candidate === 'string') {
    candidate = parseJsonSafe(candidate);
  }

  if (!candidate || typeof candidate !== 'object') return candidate;
  const objectCandidate = candidate as Record<string, unknown>;

  const toolMessageContent =
    objectCandidate.kwargs &&
    typeof objectCandidate.kwargs === 'object' &&
    'content' in (objectCandidate.kwargs as Record<string, unknown>)
      ? (objectCandidate.kwargs as Record<string, unknown>).content
      : undefined;

  if (typeof toolMessageContent === 'string') {
    return parseJsonSafe(toolMessageContent);
  }

  if (typeof objectCandidate.content === 'string') {
    return parseJsonSafe(objectCandidate.content);
  }

  return candidate;
};

export const parseProfileUpdateProposalOutput = (rawOutput: unknown): ProfileUpdateFields | null => {
  const candidate = normalizeProposalCandidate(rawOutput);
  if (!candidate || typeof candidate !== 'object') return null;

  const value = candidate as Record<string, unknown>;
  const shouldRequestApproval =
    value.should_request_approval == null ? true : Boolean(value.should_request_approval);

  const maybeFields = value.fields && typeof value.fields === 'object' ? value.fields : value;
  const parsed = ProfileUpdateFieldsSchema.safeParse(maybeFields);
  if (!parsed.success) return null;

  const sanitized = sanitizeProfileUpdateFields(parsed.data);
  if (!hasAnyProfileField(sanitized)) return null;
  if (!shouldRequestApproval) return null;
  return sanitized;
};

export const cleanupExpiredApprovals = () => {
  const now = Date.now();
  for (const [approvalId, pending] of pendingProfileUpdates.entries()) {
    if (pending.expiresAt <= now) {
      pendingProfileUpdates.delete(approvalId);
      if (pendingApprovalByThread.get(pending.threadId) === approvalId) {
        pendingApprovalByThread.delete(pending.threadId);
      }
    }
  }
};

export const clearPendingApprovalById = (approvalId: string) => {
  const pending = pendingProfileUpdates.get(approvalId);
  if (!pending) return;
  pendingProfileUpdates.delete(approvalId);
  if (pendingApprovalByThread.get(pending.threadId) === approvalId) {
    pendingApprovalByThread.delete(pending.threadId);
  }
};

export const clearPendingApprovalByThread = (threadId: string) => {
  const existingApprovalId = pendingApprovalByThread.get(threadId);
  if (!existingApprovalId) return;
  pendingApprovalByThread.delete(threadId);
  pendingProfileUpdates.delete(existingApprovalId);
};

const PROFILE_AMBIGUOUS_VALUE_TOKENS = new Set([
  'any',
  'anything',
  'something',
  'whatever',
  '隨便',
  '不知道',
]);

const normalizeProfileListValue = (rawValue: string): string | undefined => {
  const trimmed = rawValue.trim().replace(/[，。、,.]+$/g, '');
  if (!trimmed) return undefined;

  const normalized = trimmed.toLowerCase().replace(/\s+/g, '');
  if (PROFILE_AMBIGUOUS_VALUE_TOKENS.has(trimmed) || PROFILE_AMBIGUOUS_VALUE_TOKENS.has(normalized)) {
    return undefined;
  }

  return trimmed.slice(0, 120);
};

const sanitizeListField = (value: string | undefined): string | undefined => {
  if (typeof value !== 'string') return undefined;
  return normalizeProfileListValue(value);
};

export const sanitizeProfileUpdateFields = (fields: ProfileUpdateFields): ProfileUpdateFields => {
  const sanitized: ProfileUpdateFields = { ...fields };

  const tabooToAdd = sanitizeListField(sanitized.taboo_to_add);
  const diseaseToAdd = sanitizeListField(sanitized.disease_to_add);
  const tabooToRemove = sanitizeListField(sanitized.taboo_to_remove);
  const diseaseToRemove = sanitizeListField(sanitized.disease_to_remove);

  if (tabooToAdd) sanitized.taboo_to_add = tabooToAdd;
  else delete sanitized.taboo_to_add;

  if (diseaseToAdd) sanitized.disease_to_add = diseaseToAdd;
  else delete sanitized.disease_to_add;

  if (tabooToRemove) sanitized.taboo_to_remove = tabooToRemove;
  else delete sanitized.taboo_to_remove;

  if (diseaseToRemove) sanitized.disease_to_remove = diseaseToRemove;
  else delete sanitized.disease_to_remove;

  return sanitized;
};

export const buildApprovalProposalItems = (fields: ProfileUpdateFields): ApprovalProposalItem[] => {
  const keys = Object.keys(PROFILE_UPDATE_META) as ProfileUpdateFieldKey[];
  const items: ApprovalProposalItem[] = [];

  for (const key of keys) {
    const rawValue = fields[key];
    if (rawValue == null) continue;

    let value: string | number | undefined;
    if (typeof rawValue === 'string') {
      const trimmed = rawValue.trim();
      if (!trimmed) continue;
      value = trimmed;
    } else if (typeof rawValue === 'number') {
      value = rawValue;
    } else {
      continue;
    }

    const meta = PROFILE_UPDATE_META[key];
    items.push({
      field: key,
      label: meta.label,
      action: meta.action,
      value,
    });
  }

  return items;
};

export const formatProfileUpdateSummary = (fields: ProfileUpdateFields): string => {
  return buildApprovalProposalItems(fields)
    .map((item) => {
      const actionText =
        item.action === 'add' ? '新增' : item.action === 'remove' ? '刪除' : '設定';
      return `${actionText}${item.label} -> ${item.value}`;
    })
    .join('\n');
};
