# Rust Server Integration: News Sync + News Read + RAG Search

Last updated: 2026-06-02  
Related code:
- `src/index.ts`
- `src/server/mohwNews.ts`
- `src/server/ragSearch.ts`
- `agent_skills/file_tools.ts`

## 1) Purpose

This document describes the new Node.js endpoints that a Rust server can call for:

- triggering FDA news sync
- reading paginated local news titles
- reading a single local news markdown article
- running local RAG search over news and uploaded knowledge

Base URL (default local):

```text
http://localhost:8001
```

All routes below return JSON.

## 2) Route Summary

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/news/sync` | Crawl latest FDA clarification news and save to local markdown files |
| `GET` | `/api/news?page=1&pageSize=10` | Return paginated local news title list |
| `GET` | `/api/news/:id` | Return one local news article with full markdown content |
| `GET` | `/api/news-files` | Return local markdown filenames for debug/inspection |
| `GET` | `/api/rag/search` | Simple query search over local knowledge corpus |
| `POST` | `/api/rag/search` | Preferred RAG search endpoint when passing `source_types` array |

## 3) News Sync

### `POST /api/news/sync`

No request body is required.

Purpose:
- crawl `https://www.fda.gov.tw/tc/news.aspx?cid=5049`
- enter each detail page
- save title + content to local `.md`
- update local `manifest.json`

Success response:

```json
{
  "ok": true,
  "total": 42,
  "newCount": 3,
  "updatedCount": 1,
  "generatedAt": "2026-06-02T02:10:15.123Z"
}
```

Field meanings:
- `total`: total record count currently stored in `manifest.json`
- `newCount`: new articles created in this run
- `updatedCount`: existing articles refreshed in this run
- `generatedAt`: manifest generation time in UTC ISO format

Behavior notes:
- dedupe key is `id`
- repeated sync will not duplicate manifest records
- if the same `id` has changed title/date, that record is refreshed

## 4) News List

### `GET /api/news?page=1&pageSize=10`

Query params:

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `page` | integer | No | `1` | minimum `1` |
| `pageSize` | integer | No | `10` | minimum `1`, maximum `100` |

Success response:

```json
{
  "ok": true,
  "page": 1,
  "pageSize": 10,
  "total": 42,
  "totalPages": 5,
  "items": [
    {
      "id": "86333",
      "title": "Example title",
      "publishedDate": "2026-05-12"
    }
  ]
}
```

Use case:
- Rust server fetches a paginated title list for frontend display
- frontend clicks one item, then Rust server calls `/api/news/:id`

## 5) News Detail

### `GET /api/news/:id`

Path params:

| Name | Type | Required | Notes |
|---|---|---|---|
| `id` | string | Yes | article id from `/api/news` |

Success response:

```json
{
  "ok": true,
  "item": {
    "id": "86333",
    "title": "Example title",
    "publishedDate": "2026-05-12",
    "sourceUrl": "https://www.fda.gov.tw/TC/newsContent.aspx?id=86333",
    "content": "# Example title\n\n- id: 86333\n- date: 2026-05-12\n- source: ...\n- fetchedAt: ...\n\n## 內文\n..."
  }
}
```

Not found responses:

```json
{
  "ok": false,
  "error": "news_not_found"
}
```

or:

```json
{
  "ok": false,
  "error": "news_file_not_found"
}
```

Notes:
- `content` is the full local markdown file text
- if frontend wants plain text rendering, Rust can pass markdown through as-is or convert it

## 6) News Files Debug

### `GET /api/news-files`

Success response:

```json
{
  "ok": true,
  "files": [
    "2026-05-12_86333.md",
    "2026-05-05_86279.md"
  ]
}
```

Use case:
- debug local sync result
- verify markdown files really exist on disk

## 7) RAG Search

The RAG search endpoint searches over local markdown corpus from:

- `knowledge_base/mohw_clarifications/articles/*.md`
- `knowledge_base/ingested_markdown/**/*.md`
- `knowledge_base/NUTRITION_RULES.md`

### 7.1 `GET /api/rag/search`

Recommended for simple queries only.

Query params:

| Name | Type | Required | Default | Notes |
|---|---|---|---|---|
| `query` | string | Yes | - | cannot be empty |
| `top_k` | integer | No | `5` | range `1..12` |
| `force_refresh` | boolean | No | `false` | refresh cached local corpus |

Example:

```text
GET /api/rag/search?query=奶粉過甜謠言&top_k=5
```

### 7.2 `POST /api/rag/search`

Preferred endpoint if Rust needs source filtering.

Request JSON:

```json
{
  "query": "奶粉過甜謠言",
  "top_k": 5,
  "source_types": ["mohw_news", "uploaded_knowledge"],
  "force_refresh": false
}
```

Allowed `source_types`:
- `nutrition_rules`
- `mohw_news`
- `uploaded_knowledge`

Success response:

```json
{
  "ok": true,
  "query": "奶粉過甜謠言",
  "total_hits": 2,
  "hits": [
    {
      "id": "mohw_news:2025-08-28_83629.md:0",
      "source_type": "mohw_news",
      "title": "嬰兒配方食品皆嚴格規範 守護嬰兒健康114-08-28",
      "source_path": "knowledge_base/mohw_clarifications/articles/2025-08-28_83629.md",
      "published_date": "2025-08-28",
      "score": 12,
      "snippet": "..."
    }
  ]
}
```

Validation error response:

```json
{
  "ok": false,
  "error": "invalid_payload",
  "details": {
    "formErrors": [],
    "fieldErrors": {}
  }
}
```

Notes:
- this is currently local keyword-based retrieval, not vector embedding retrieval
- `score` is an internal relevance score for ranking only
- `snippet` is a truncated text segment suitable for preview or grounding

## 8) Auto Sync Environment Variables

The Node server can also auto-sync FDA news on an interval.

Environment variables:

```env
MOHW_NEWS_SYNC_ENABLED=true
MOHW_NEWS_SYNC_INTERVAL_MINUTES=360
MOHW_NEWS_SYNC_RUN_ON_START=true
```

Meaning:
- `MOHW_NEWS_SYNC_ENABLED`: enable interval sync
- `MOHW_NEWS_SYNC_INTERVAL_MINUTES`: sync interval in minutes
- `MOHW_NEWS_SYNC_RUN_ON_START`: perform one sync at server startup

Important:
- manual sync route `POST /api/news/sync` still exists even when auto-sync is enabled
- the server prevents overlapping sync jobs in the same process

## 9) Local Storage Paths

Files written by news sync:

- articles: `knowledge_base/mohw_clarifications/articles/*.md`
- index manifest: `knowledge_base/mohw_clarifications/manifest.json`

Files searched by RAG:

- `knowledge_base/mohw_clarifications/articles/*.md`
- `knowledge_base/ingested_markdown/**/*.md`
- `knowledge_base/NUTRITION_RULES.md`

## 10) Suggested Rust Data Structures

These `serde` structs match the current API shape.

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub struct NewsSyncResponse {
    pub ok: bool,
    pub total: usize,
    #[serde(rename = "newCount")]
    pub new_count: usize,
    #[serde(rename = "updatedCount")]
    pub updated_count: usize,
    #[serde(rename = "generatedAt")]
    pub generated_at: String,
}

#[derive(Debug, Deserialize)]
pub struct NewsListItem {
    pub id: String,
    pub title: String,
    #[serde(rename = "publishedDate")]
    pub published_date: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct NewsListResponse {
    pub ok: bool,
    pub page: usize,
    #[serde(rename = "pageSize")]
    pub page_size: usize,
    pub total: usize,
    #[serde(rename = "totalPages")]
    pub total_pages: usize,
    pub items: Vec<NewsListItem>,
}

#[derive(Debug, Deserialize)]
pub struct NewsDetailItem {
    pub id: String,
    pub title: String,
    #[serde(rename = "publishedDate")]
    pub published_date: Option<String>,
    #[serde(rename = "sourceUrl")]
    pub source_url: String,
    pub content: String,
}

#[derive(Debug, Deserialize)]
pub struct NewsDetailResponse {
    pub ok: bool,
    pub item: NewsDetailItem,
}

#[derive(Debug, Serialize)]
pub struct RagSearchRequest {
    pub query: String,
    pub top_k: usize,
    pub source_types: Option<Vec<String>>,
    pub force_refresh: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct RagHit {
    pub id: String,
    pub source_type: String,
    pub title: String,
    pub source_path: String,
    pub published_date: Option<String>,
    pub score: i32,
    pub snippet: String,
}

#[derive(Debug, Deserialize)]
pub struct RagSearchResponse {
    pub ok: bool,
    pub query: String,
    pub total_hits: usize,
    pub hits: Vec<RagHit>,
}
```

## 11) Suggested Rust Call Flow

Recommended backend flow:

1. Rust calls `POST /api/news/sync` manually when admin triggers sync.
2. Rust calls `GET /api/news?page=1&pageSize=...` for news list.
3. Rust calls `GET /api/news/:id` for detail page.
4. Rust calls `POST /api/rag/search` when it wants grounded retrieval results before composing its own answer.
5. If Rust only proxies Node chat, it can still call `POST /api/chat`; the Node agent already has access to `search_knowledge_tool`.

## 12) Compatibility Notes

- `GET /api/rag/search` is fine for simple query-only calls.
- If you need `source_types`, prefer `POST /api/rag/search` with JSON body.
- Current RAG is retrieval-only over local markdown files. It is not yet embedding-based vector search.
- Existing knowledge upload APIs remain unchanged:
  - `POST /api/admin/knowledge/upload`
  - `POST /api/admin/knowledge/ingest/:id`
  - `GET /api/admin/knowledge/jobs/:jobId`

