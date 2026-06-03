import { load } from 'cheerio';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';

const LIST_URL = 'https://www.fda.gov.tw/tc/news.aspx?cid=5049';
const OUTPUT_DIR = path.resolve(process.cwd(), 'knowledge_base/mohw_clarifications');
const ARTICLES_DIR = path.join(OUTPUT_DIR, 'articles');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');
const ERROR_PAGE_MARKERS = [
  'The Resource cannot be found.',
  'The Resource you are lookingfor could haven been removed',
];
const NON_CONTENT_PATTERNS = [
  /^瀏覽人次[:：]/,
  /^資訊內容對您是否有幫助[:：]/,
  /^驗證碼[:：]/,
  /^寄發驗證碼至信箱/,
  /^送出評分$/,
  /^回上一頁$/,
];

type ArticleRecord = {
  id: string;
  title: string;
  sourceUrl: string;
  publishedDate: string | null;
  localPath: string;
  fetchedAt: string;
};

type Manifest = {
  generatedAt: string;
  source: string;
  records: ArticleRecord[];
};

export type MohwSyncResult = {
  total: number;
  newCount: number;
  updatedCount: number;
  generatedAt: string;
};

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim();
const normalizeContentText = (value: string): string =>
  normalizeWhitespace(value.replace(/\u00a0/g, ' '));

const isFdaHost = (url: URL): boolean => /(^|\.)fda\.gov\.tw$/i.test(url.hostname);

const normalizeFdaUrl = (url: URL): URL => {
  if (!isFdaHost(url)) return url;

  const pathname = url.pathname.toLowerCase();
  if ((pathname === '/news.aspx' || pathname === '/newscontent.aspx') && !pathname.startsWith('/tc/')) {
    url.pathname = `/tc${url.pathname}`;
  }

  return url;
};

const toAbsoluteUrl = (href: string): string => {
  try {
    return normalizeFdaUrl(new URL(href, LIST_URL)).toString();
  } catch {
    return href;
  }
};

const fetchHtml = async (url: string): Promise<string> => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const contentType = response.headers.get('content-type') || '';
  const resolvedUrl = response.url || url;

  let charset = 'utf-8';
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  if (charsetMatch?.[1]) {
    charset = charsetMatch[1].trim().toLowerCase();
  } else {
    try {
      const parsedUrl = new URL(resolvedUrl);
      if (isFdaHost(parsedUrl)) charset = 'big5';
    } catch {
      // Keep the UTF-8 default when the URL cannot be parsed.
    }
  }

  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
};

const parseList = (
  html: string,
): Array<{ id: string; title: string; sourceUrl: string; publishedDate: string | null }> => {
  const $ = load(html);
  const items: Array<{ id: string; title: string; sourceUrl: string; publishedDate: string | null }> = [];

  $('a[href*="newsContent.aspx"], a[href*="NewsContent.aspx"], a[href*="newscontent.aspx"]').each((_, el) => {
    const anchor = $(el);
    const href = (anchor.attr('href') || '').trim();
    const title = normalizeWhitespace(anchor.text());
    if (!href || !title) return;

    const sourceUrl = toAbsoluteUrl(href);
    const idMatch = sourceUrl.match(/[?&]id=(\d+)/i);
    const id = idMatch?.[1] || Buffer.from(sourceUrl).toString('base64url').slice(0, 16);
    const surroundingText = normalizeWhitespace(anchor.closest('li,tr,div').text());
    const dateMatch = surroundingText.match(/(20\d{2}[/-]\d{1,2}[/-]\d{1,2})/);
    const publishedDate = dateMatch ? dateMatch[1]!.replace(/\//g, '-') : null;

    items.push({ id, title, sourceUrl, publishedDate });
  });

  const dedup = new Map<string, { id: string; title: string; sourceUrl: string; publishedDate: string | null }>();
  for (const item of items) dedup.set(item.id, item);
  return Array.from(dedup.values());
};

const isUsefulContentBlock = (text: string): boolean =>
  text.length > 0 && !NON_CONTENT_PATTERNS.some((pattern) => pattern.test(text));

const sanitizeContentBlock = (text: string): string => {
  return normalizeContentText(
    text
      .replace(/瀏覽人次[:：]\s*\d+.*$/g, '')
      .replace(/資訊內容對您是否有幫助[:：].*$/g, '')
      .replace(/驗證碼[:：].*$/g, ''),
  );
};

const collectLeafText = ($: ReturnType<typeof load>, selector: string): string[] => {
  const blocks = $(selector)
    .toArray()
    .map((node) => {
      const element = $(node);
      if (element.children('p,div,li,td,span').length > 0) return '';
      return sanitizeContentBlock(element.text());
    })
    .filter((text) => isUsefulContentBlock(text));

  return Array.from(new Set(blocks));
};

const extractContent = (html: string): string => {
  const $ = load(html);

  const structuredBlocks = [
    ...collectLeafText(
      $,
      '#ContentPlaceHolder1_PageContentUC_PnlCms p, #ContentPlaceHolder1_PageContentUC_PnlCms div, #ContentPlaceHolder1_PageContentUC_PnlCms li, #ContentPlaceHolder1_PageContentUC_PnlCms td, #ContentPlaceHolder1_PageContentUC_PnlCms span',
    ),
    ...collectLeafText($, '.marginBot p, .marginBot div, .marginBot li, .marginBot td, .marginBot span'),
    ...collectLeafText($, '.edit p, .edit div, .edit li, .edit td, .edit span'),
  ];
  if (structuredBlocks.length > 0) {
    return Array.from(new Set(structuredBlocks)).join('\n\n');
  }

  const paragraphs = $('p')
    .toArray()
    .map((p) => sanitizeContentBlock($(p).text()))
    .filter((text) => isUsefulContentBlock(text));
  if (paragraphs.length > 0) return paragraphs.join('\n\n');

  const body = sanitizeContentBlock($('body').text());
  return body || '(content unavailable)';
};

const createMarkdown = (record: ArticleRecord, content: string): string => {
  return [`# ${record.title}`, '', '## 內文', content, ''].join('\n');
};

const looksLikeErrorPage = (content: string): boolean =>
  ERROR_PAGE_MARKERS.some((marker) => content.includes(marker));

const looksLikeLowValueContent = (content: string): boolean => {
  const normalized = normalizeContentText(content);
  if (normalized.length === 0) return true;
  if (looksLikeErrorPage(normalized)) return true;
  if (normalized.includes('## 內文 瀏覽人次：') || normalized.endsWith('## 內文 瀏覽人次')) {
    return true;
  }
  return false;
};

const hasLegacyMetadataBlock = (content: string): boolean =>
  /^- id:\s*/m.test(content) ||
  /^- date:\s*/m.test(content) ||
  /^- source:\s*/m.test(content) ||
  /^- fetchedAt:\s*/m.test(content);

const hasUsableLocalContent = async (record: ArticleRecord): Promise<boolean> => {
  try {
    const absPath = path.resolve(process.cwd(), record.localPath);
    const content = await readFile(absPath, 'utf8');
    return !looksLikeLowValueContent(content) && !hasLegacyMetadataBlock(content);
  } catch {
    return false;
  }
};

const readManifest = async (): Promise<Manifest> => {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return { generatedAt: '', source: LIST_URL, records: [] };
  }
};

export const syncMohwNews = async (): Promise<MohwSyncResult> => {
  await mkdir(ARTICLES_DIR, { recursive: true });

  const oldManifest = await readManifest();
  const oldMap = new Map(oldManifest.records.map((record) => [record.id, record]));
  const listHtml = await fetchHtml(LIST_URL);
  const list = parseList(listHtml);
  const fetchedAt = new Date().toISOString();

  const records: ArticleRecord[] = [];
  let newCount = 0;
  let updatedCount = 0;

  for (const item of list) {
    const prev = oldMap.get(item.id);
    const prevHasUsableContent = prev ? await hasUsableLocalContent(prev) : false;
    const shouldRefresh =
      !prev ||
      prev.title !== item.title ||
      prev.publishedDate !== item.publishedDate ||
      prev.sourceUrl !== item.sourceUrl ||
      !prevHasUsableContent;

    if (!shouldRefresh && prev) {
      records.push(prev);
      continue;
    }

    const detailHtml = await fetchHtml(item.sourceUrl);
    const content = extractContent(detailHtml);
    if (looksLikeErrorPage(content)) {
      throw new Error(`Fetched error page instead of article content for ${item.sourceUrl}`);
    }

    const fileName = `${item.publishedDate || 'unknown-date'}_${item.id}.md`;
    const absPath = path.join(ARTICLES_DIR, fileName);
    const relPath = path.relative(process.cwd(), absPath).replace(/\\/g, '/');
    const record: ArticleRecord = {
      id: item.id,
      title: item.title,
      sourceUrl: item.sourceUrl,
      publishedDate: item.publishedDate,
      localPath: relPath,
      fetchedAt,
    };

    await writeFile(absPath, createMarkdown(record, content), 'utf8');
    records.push(record);
    if (prev) updatedCount += 1;
    else newCount += 1;
  }

  const byId = new Map(records.map((record) => [record.id, record]));
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    source: LIST_URL,
    records: Array.from(byId.values()),
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    total: manifest.records.length,
    newCount,
    updatedCount,
    generatedAt: manifest.generatedAt,
  };
};

export const syncMohwNewsHandler = async (_req: Request, res: Response): Promise<void> => {
  const result = await syncMohwNews();
  res.json({ ok: true, ...result });
};

export const listMohwNewsHandler = async (req: Request, res: Response): Promise<void> => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 10));
  const manifest = await readManifest();
  const sorted = manifest.records
    .slice()
    .sort((a, b) => (a.publishedDate || '').localeCompare(b.publishedDate || '') * -1);
  const total = sorted.length;
  const start = (page - 1) * pageSize;
  const items = sorted.slice(start, start + pageSize).map((item) => ({
    id: item.id,
    title: item.title,
    publishedDate: item.publishedDate,
  }));

  res.json({
    ok: true,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items,
  });
};

export const getMohwNewsByIdHandler = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || '').trim();
  const manifest = await readManifest();
  const record = manifest.records.find((item) => item.id === id);
  if (!record) {
    res.status(404).json({ ok: false, error: 'news_not_found' });
    return;
  }

  const absPath = path.resolve(process.cwd(), record.localPath);
  let content = '';
  try {
    content = await readFile(absPath, 'utf8');
  } catch {
    res.status(404).json({ ok: false, error: 'news_file_not_found' });
    return;
  }

  res.json({
    ok: true,
    item: {
      id: record.id,
      title: record.title,
      publishedDate: record.publishedDate,
      sourceUrl: record.sourceUrl,
      content,
    },
  });
};

export const listLocalMohwFilesHandler = async (_req: Request, res: Response): Promise<void> => {
  await mkdir(ARTICLES_DIR, { recursive: true });
  const files = await readdir(ARTICLES_DIR);
  res.json({ ok: true, files: files.filter((file) => file.endsWith('.md')) });
};
