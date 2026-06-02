import fs from 'fs';
import path from 'path';
import { MAX_IMAGE_BYTES, USERS_IMAGES_DIR } from './workspacePaths';

const IMAGE_MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const sanitizePathToken = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);

const parseDataUrlImage = (
  raw: string
): { mimeType: string; buffer: Buffer } | null => {
  const match = raw.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) return null;
  const mimeTypeRaw = match[1];
  const base64 = match[2];
  if (!mimeTypeRaw || !base64) return null;
  const mimeType = mimeTypeRaw.toLowerCase();
  const buffer = Buffer.from(base64, 'base64');
  return { mimeType, buffer };
};

const parsePlainBase64Image = (
  raw: string,
  mimeTypeHint?: string
): { mimeType: string; buffer: Buffer } | null => {
  const normalized = raw.trim().replace(/\s+/g, '');
  if (!normalized) return null;
  if (normalized.startsWith('data:image/')) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized)) return null;

  const buffer = Buffer.from(normalized, 'base64');
  if (!buffer || buffer.length === 0) return null;

  const hinted = (mimeTypeHint || '').toLowerCase();
  const mimeType = IMAGE_MIME_TO_EXT[hinted] ? hinted : 'image/jpeg';
  return { mimeType, buffer };
};

export const saveIncomingImageToWorkspace = (input: {
  rawImage: unknown;
  userId?: string;
  threadId: string;
  mimeTypeHint?: string;
}): string | undefined => {
  const { rawImage, userId, threadId, mimeTypeHint: topLevelMimeHint } = input;
  if (!rawImage) return undefined;

  if (typeof rawImage === 'object') {
    const objectImage = rawImage as Record<string, unknown>;
    const directPath = objectImage.imagePath ?? objectImage.image_path ?? objectImage.path;
    if (typeof directPath === 'string' && directPath.trim().length > 0) {
      return directPath.trim();
    }
  }

  let dataUrl: string | undefined;
  let mimeTypeHint: string | undefined;
  if (typeof rawImage === 'string') {
    dataUrl = rawImage;
  } else if (rawImage && typeof rawImage === 'object') {
    const objectImage = rawImage as Record<string, unknown>;
    const maybeDataUrl = objectImage.dataUrl ?? objectImage.data_url ?? objectImage.url ?? objectImage.src;
    const maybeBase64 = objectImage.base64 ?? objectImage.image_base64;
    const maybeMime = objectImage.mimeType ?? objectImage.mime_type ?? objectImage.type;
    if (typeof maybeMime === 'string') mimeTypeHint = maybeMime.toLowerCase();

    if (typeof maybeDataUrl === 'string' && maybeDataUrl.startsWith('data:image/')) {
      dataUrl = maybeDataUrl;
    } else if (typeof maybeBase64 === 'string' && maybeBase64.trim().length > 0) {
      const normalizedMime = mimeTypeHint && IMAGE_MIME_TO_EXT[mimeTypeHint] ? mimeTypeHint : 'image/jpeg';
      dataUrl = `data:${normalizedMime};base64,${maybeBase64.trim()}`;
    }
  }

  let parsed = dataUrl ? parseDataUrlImage(dataUrl) : null;
  if (!parsed && typeof rawImage === 'string') {
    parsed = parsePlainBase64Image(rawImage, topLevelMimeHint);
  }

  if (!parsed && rawImage && typeof rawImage === 'object') {
    const objectImage = rawImage as Record<string, unknown>;
    const maybeBase64 = objectImage.base64 ?? objectImage.image_base64;
    const nestedMimeHint =
      typeof objectImage.mimeType === 'string'
        ? objectImage.mimeType
        : typeof objectImage.mime_type === 'string'
          ? objectImage.mime_type
          : topLevelMimeHint;
    if (typeof maybeBase64 === 'string') {
      parsed = parsePlainBase64Image(maybeBase64, nestedMimeHint);
    }
  }

  if (!parsed) {
    throw new Error('Invalid image payload format. Expected data URL or base64 string.');
  }

  const normalizedMime = IMAGE_MIME_TO_EXT[parsed.mimeType] ? parsed.mimeType : 'image/jpeg';
  const ext = IMAGE_MIME_TO_EXT[normalizedMime];

  if (parsed.buffer.length === 0) {
    throw new Error('Empty image buffer.');
  }
  if (parsed.buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(
      `Image payload is too large (${parsed.buffer.length} bytes). Max allowed is ${MAX_IMAGE_BYTES} bytes.`
    );
  }

  const safeUserSegment = sanitizePathToken(userId || 'guest_user');
  const safeThreadSegment = sanitizePathToken(threadId || 'thread');
  const userDir = path.join(USERS_IMAGES_DIR, safeUserSegment);
  fs.mkdirSync(userDir, { recursive: true });

  const filename = `${safeThreadSegment}_${Date.now()}.${ext}`;
  const absolutePath = path.join(userDir, filename);
  fs.writeFileSync(absolutePath, parsed.buffer);

  return path.join('users_images', safeUserSegment, filename);
};
