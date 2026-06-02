import { load } from 'cheerio';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LIST_URL = 'https://www.mohw.gov.tw/lp-17-1.html';
const SITE_ORIGIN = 'https://www.mohw.gov.tw';

type ListItem = {
  id: string;
  title: string;
  sourceUrl: string;
  publishedRoc: string | null;
  publishedDate: string | null;
};

type ArticleRecord = {
  id: string;
  title: string;
  sourceUrl: string;
  publishedRoc: string | null;
  publishedDate: string | null;
  summary: string;
  localPath: string;
  fetchedAt: string;
};

type Manifest = {
  generatedAt: string;
  source: string;
  records: ArticleRecord[];
};

const nowIso = (): string => new Date().toISOString();

const normalizeWhitespace = (value: string): string =>
  value.replace(/\s+/g, ' ').trim();

const toAbsoluteUrl = (href: string): string => {
  try {
    return new URL(href, SITE_ORIGIN).toString();
  } catch {
    return href;
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const parsePositiveInt = (raw: string | undefined): number | null => {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
};

const parseCliArg = (name: string): string | undefined => {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
};

const toIsoDateFromRoc = (raw: string): string | null => {
  const normalized = raw.trim().replace(/\//g, '-').replace(/\./g, '-');
  const match = normalized.match(/^(\d{2,3})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;

  const rocYear = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(rocYear) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  const adYear = rocYear + 1911;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${adYear}-${mm}-${dd}`;
};

const detectTotalPages = (html: string): number => {
  const $ = load(html);
  const pageNumbers = new Set<number>();

  $('a[href]').each((_, element) => {
    const href = ($(element).attr('href') || '').trim();
    const match = href.match(/lp-17-1-(\d+)-20\.html/i);
    if (!match) return;

    const page = Number(match[1]);
    if (Number.isFinite(page) && page >= 1) {
      pageNumbers.add(page);
    }
  });

  const maxPage = Math.max(...Array.from(pageNumbers), 1);
  return maxPage;
};

const parseListItems = (html: string): ListItem[] => {
  const $ = load(html);
  const items: ListItem[] = [];

  $('.list ul li').each((_, li) => {
    const node = $(li);
    const anchor = node.find('a').first();
    const href = (anchor.attr('href') || '').trim();
    const sourceUrl = toAbsoluteUrl(href);
    const title = normalizeWhitespace(anchor.text());

    if (!href || !title) return;

    const idMatch = sourceUrl.match(/cp-\d+-(\d+)-\d+\.html/i);
    const id = idMatch?.[1] || Buffer.from(sourceUrl).toString('base64url').slice(0, 12);

    const rawDate =
      normalizeWhitespace(node.find('time').first().text()) ||
      normalizeWhitespace(node.text()).match(/(\d{2,3}[-/.]\d{1,2}[-/.]\d{1,2})$/)?.[1] ||
      null;

    items.push({
      id,
      title,
      sourceUrl,
      publishedRoc: rawDate,
      publishedDate: rawDate ? toIsoDateFromRoc(rawDate) : null
    });
  });

  return items;
};

const fetchHtml = async (url: string, timeoutMs: number): Promise<string> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
};

const extractSummary = (articleHtml: string): string => {
  const $ = load(articleHtml);
  const paragraphs = $('.cp p')
    .toArray()
    .map((p) => normalizeWhitespace($(p).text()))
    .filter((text) => text.length > 0);

  if (paragraphs.length > 0) {
    return paragraphs[0]!.slice(0, 220);
  }

  const blockText = normalizeWhitespace($('.cp').first().text());
  if (blockText.length > 0) return blockText.slice(0, 220);

  const bodyText = normalizeWhitespace($('body').text());
  return bodyText.slice(0, 220);
};

const writeArticleMarkdown = async (
  record: Omit<ArticleRecord, 'localPath'>,
  articleHtml: string,
  articleAbsPath: string,
  articleRelativePath: string
): Promise<void> => {
  const $ = load(articleHtml);
  const allParagraphs = $('.cp p')
    .toArray()
    .map((p) => normalizeWhitespace($(p).text()))
    .filter((text) => text.length > 0)
    .slice(0, 8);

  const paragraphBlock =
    allParagraphs.length > 0
      ? allParagraphs.map((p) => `- ${p}`).join('\n')
      : '- (無法擷取段落，請改看原始連結)';

  const content = [
    `# ${record.title}`,
    '',
    `- 公布時間（民國）: ${record.publishedRoc || 'N/A'}`,
    `- 公布時間（西元）: ${record.publishedDate || 'N/A'}`,
    `- 抓取時間（UTC）: ${record.fetchedAt}`,
    `- 原始連結: ${record.sourceUrl}`,
    `- 本地路徑: ${articleRelativePath}`,
    '',
    '## 大概',
    record.summary || '(無摘要)',
    '',
    '## 內容摘錄',
    paragraphBlock,
    ''
  ].join('\n');

  await writeFile(articleAbsPath, content, 'utf8');
};

const createBookmarksMarkdown = (records: ArticleRecord[], generatedAt: string): string => {
  const rows = records
    .slice()
    .sort((a, b) => {
      const ad = a.publishedDate || '0000-00-00';
      const bd = b.publishedDate || '0000-00-00';
      if (ad !== bd) return ad < bd ? 1 : -1;
      return a.id < b.id ? 1 : -1;
    })
    .map((item) => {
      const safeTitle = item.title.replace(/\|/g, '\\|');
      const safeSummary = item.summary.replace(/\|/g, '\\|');
      const safePath = item.localPath.replace(/\\/g, '/').replace(/\|/g, '\\|');
      return `| ${item.publishedDate || 'N/A'} | ${safeTitle} | ${safeSummary} | ${safePath} | ${item.sourceUrl} | ${item.fetchedAt} |`;
    });

  return [
    '# 衛福部即時新聞澄清書籤',
    '',
    `- 資料來源頁面: ${LIST_URL}`,
    `- 索引更新時間（UTC）: ${generatedAt}`,
    `- 總筆數: ${records.length}`,
    '',
    '| 公布日期(西元) | 標題 | 大概 | 本地路徑 | 原始連結 | 抓取時間(UTC) |',
    '| --- | --- | --- | --- | --- | --- |',
    ...rows,
    ''
  ].join('\n');
};

const main = async (): Promise<void> => {
  const configuredOutput = parseCliArg('outputDir') || process.env.MOHW_OUTPUT_DIR;
  const outputDir = path.resolve(
    process.cwd(),
    configuredOutput || 'knowledge_base/mohw_clarifications'
  );
  const articlesDir = path.join(outputDir, 'articles');
  const manifestPath = path.join(outputDir, 'manifest.json');
  const bookmarksPath = path.join(outputDir, 'BOOKMARKS.md');

  const maxPagesArg = parsePositiveInt(parseCliArg('maxPages'));
  const maxPagesEnv = parsePositiveInt(process.env.MOHW_MAX_PAGES);
  const timeoutMs = parsePositiveInt(process.env.MOHW_TIMEOUT_MS) || 12000;
  const delayMs = parsePositiveInt(process.env.MOHW_REQUEST_DELAY_MS) || 150;

  await mkdir(articlesDir, { recursive: true });

  let existing: Manifest = {
    generatedAt: '',
    source: LIST_URL,
    records: []
  };
  try {
    const raw = await readFile(manifestPath, 'utf8');
    existing = JSON.parse(raw) as Manifest;
  } catch {
    // First run without manifest is expected.
  }

  const existingMap = new Map(existing.records.map((item) => [item.id, item]));
  const firstPageHtml = await fetchHtml(LIST_URL, timeoutMs);
  const detectedPages = detectTotalPages(firstPageHtml);
  const pageLimit = maxPagesArg || maxPagesEnv || detectedPages;
  const totalPages = Math.max(1, Math.min(detectedPages, pageLimit));

  console.log(`[MOHW] Detected pages: ${detectedPages}, syncing pages: ${totalPages}`);

  const listItemsMap = new Map<string, ListItem>();
  for (let page = 1; page <= totalPages; page += 1) {
    const pageUrl =
      page === 1 ? LIST_URL : `${SITE_ORIGIN}/lp-17-1-${page}-20.html`;
    const html = page === 1 ? firstPageHtml : await fetchHtml(pageUrl, timeoutMs);
    const items = parseListItems(html);
    for (const item of items) {
      listItemsMap.set(item.id, item);
    }

    console.log(`[MOHW] Page ${page}/${totalPages}: ${items.length} entries`);
    if (page < totalPages && delayMs > 0) {
      await sleep(delayMs);
    }
  }

  const merged: ArticleRecord[] = [];
  const fetchedAt = nowIso();
  let newCount = 0;
  let updatedCount = 0;

  for (const listItem of listItemsMap.values()) {
    const existingItem = existingMap.get(listItem.id);
    const shouldRefresh =
      !existingItem ||
      existingItem.title !== listItem.title ||
      existingItem.publishedRoc !== listItem.publishedRoc;

    if (!shouldRefresh && existingItem) {
      merged.push(existingItem);
      continue;
    }

    const detailHtml = await fetchHtml(listItem.sourceUrl, timeoutMs);
    const summary = extractSummary(detailHtml);
    const fileName = `${listItem.publishedDate || 'unknown-date'}_${listItem.id}.md`;
    const articleAbsPath = path.join(articlesDir, fileName);
    const articleRelativePath = path
      .relative(process.cwd(), articleAbsPath)
      .replace(/\\/g, '/');

    const record: ArticleRecord = {
      id: listItem.id,
      title: listItem.title,
      sourceUrl: listItem.sourceUrl,
      publishedRoc: listItem.publishedRoc,
      publishedDate: listItem.publishedDate,
      summary,
      localPath: articleRelativePath,
      fetchedAt
    };

    await writeArticleMarkdown(
      {
        id: record.id,
        title: record.title,
        sourceUrl: record.sourceUrl,
        publishedRoc: record.publishedRoc,
        publishedDate: record.publishedDate,
        summary: record.summary,
        fetchedAt: record.fetchedAt
      },
      detailHtml,
      articleAbsPath,
      articleRelativePath
    );

    merged.push(record);
    if (existingItem) {
      updatedCount += 1;
    } else {
      newCount += 1;
    }

    if (delayMs > 0) {
      await sleep(delayMs);
    }
  }

  for (const item of existing.records) {
    if (listItemsMap.has(item.id)) continue;
    merged.push(item);
  }

  const byId = new Map<string, ArticleRecord>();
  for (const item of merged) {
    byId.set(item.id, item);
  }
  const deduped = Array.from(byId.values());

  const manifest: Manifest = {
    generatedAt: nowIso(),
    source: LIST_URL,
    records: deduped
  };

  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(bookmarksPath, createBookmarksMarkdown(deduped, manifest.generatedAt), 'utf8');

  console.log(`[MOHW] Sync done. total=${deduped.length}, new=${newCount}, updated=${updatedCount}`);
  console.log(`[MOHW] Manifest: ${path.relative(process.cwd(), manifestPath).replace(/\\/g, '/')}`);
  console.log(`[MOHW] Bookmarks: ${path.relative(process.cwd(), bookmarksPath).replace(/\\/g, '/')}`);
};

main().catch((error) => {
  console.error('[MOHW] Sync failed:', error);
  process.exitCode = 1;
});
