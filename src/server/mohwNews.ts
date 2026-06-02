import { load } from 'cheerio';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Request, Response } from 'express';

const LIST_URL = 'https://www.fda.gov.tw/tc/news.aspx?cid=5049';
const SITE_ORIGIN = 'https://www.fda.gov.tw';
const OUTPUT_DIR = path.resolve(process.cwd(), 'knowledge_base/mohw_clarifications');
const ARTICLES_DIR = path.join(OUTPUT_DIR, 'articles');
const MANIFEST_PATH = path.join(OUTPUT_DIR, 'manifest.json');

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

const toAbsoluteUrl = (href: string): string => {
  try {
    return new URL(href, SITE_ORIGIN).toString();
  } catch {
    return href;
  }
};

const fetchHtml = async (url: string): Promise<string> => {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return await response.text();
};

const parseList = (html: string): Array<{ id: string; title: string; sourceUrl: string; publishedDate: string | null }> => {
  const $ = load(html);
  const items: Array<{ id: string; title: string; sourceUrl: string; publishedDate: string | null }> = [];

  $('a[href*="newsContent.aspx"], a[href*="NewsContent.aspx"], a[href*="newscontent.aspx"]').each((_, el) => {
    const a = $(el);
    const href = (a.attr('href') || '').trim();
    const title = normalizeWhitespace(a.text());
    if (!href || !title) return;
    const sourceUrl = toAbsoluteUrl(href);
    const idMatch = sourceUrl.match(/[?&]id=(\d+)/i);
    const id = idMatch?.[1] || Buffer.from(sourceUrl).toString('base64url').slice(0, 16);
    const liText = normalizeWhitespace(a.closest('li,tr,div').text());
    const dateMatch = liText.match(/(20\d{2}[\/-]\d{1,2}[\/-]\d{1,2})/);
    const publishedDate = dateMatch ? dateMatch[1]!.replace(/\//g, '-') : null;
    items.push({ id, title, sourceUrl, publishedDate });
  });

  const dedup = new Map<string, { id: string; title: string; sourceUrl: string; publishedDate: string | null }>();
  for (const item of items) dedup.set(item.id, item);
  return Array.from(dedup.values());
};

const extractContent = (html: string): string => {
  const $ = load(html);
  const paragraphs = $('p')
    .toArray()
    .map((p) => normalizeWhitespace($(p).text()))
    .filter((t) => t.length > 0);
  if (paragraphs.length > 0) return paragraphs.join('\n\n');
  const body = normalizeWhitespace($('body').text());
  return body || '(無法擷取內文)';
};

const createMarkdown = (record: ArticleRecord, content: string): string => {
  return [
    `# ${record.title}`,
    '',
    `- id: ${record.id}`,
    `- date: ${record.publishedDate || 'N/A'}`,
    `- source: ${record.sourceUrl}`,
    `- fetchedAt: ${record.fetchedAt}`,
    '',
    '## 內文',
    content,
    ''
  ].join('\n');
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
  const oldMap = new Map(oldManifest.records.map((r) => [r.id, r]));
  const listHtml = await fetchHtml(LIST_URL);
  const list = parseList(listHtml);
  const fetchedAt = new Date().toISOString();

  const records: ArticleRecord[] = [];
  let newCount = 0;
  let updatedCount = 0;

  for (const item of list) {
    const prev = oldMap.get(item.id);
    const shouldRefresh = !prev || prev.title !== item.title || prev.publishedDate !== item.publishedDate;
    if (!shouldRefresh && prev) {
      records.push(prev);
      continue;
    }

    const detailHtml = await fetchHtml(item.sourceUrl);
    const content = extractContent(detailHtml);
    const fileName = `${item.publishedDate || 'unknown-date'}_${item.id}.md`;
    const absPath = path.join(ARTICLES_DIR, fileName);
    const relPath = path.relative(process.cwd(), absPath).replace(/\\/g, '/');
    const record: ArticleRecord = {
      id: item.id,
      title: item.title,
      sourceUrl: item.sourceUrl,
      publishedDate: item.publishedDate,
      localPath: relPath,
      fetchedAt
    };
    await writeFile(absPath, createMarkdown(record, content), 'utf8');
    records.push(record);
    if (prev) updatedCount += 1;
    else newCount += 1;
  }

  const byId = new Map(records.map((r) => [r.id, r]));
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    source: LIST_URL,
    records: Array.from(byId.values())
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    total: manifest.records.length,
    newCount,
    updatedCount,
    generatedAt: manifest.generatedAt
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
    publishedDate: item.publishedDate
  }));

  res.json({
    ok: true,
    page,
    pageSize,
    total,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
    items
  });
};

export const getMohwNewsByIdHandler = async (req: Request, res: Response): Promise<void> => {
  const id = String(req.params.id || '').trim();
  const manifest = await readManifest();
  const record = manifest.records.find((r) => r.id === id);
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
      content
    }
  });
};

export const listLocalMohwFilesHandler = async (_req: Request, res: Response): Promise<void> => {
  await mkdir(ARTICLES_DIR, { recursive: true });
  const files = await readdir(ARTICLES_DIR);
  res.json({ ok: true, files: files.filter((f) => f.endsWith('.md')) });
};
