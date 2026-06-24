# Healthy Diet AI Agent

An Express + LangGraph + LangChain + Supabase backend for a diet and nutrition assistant. The project focuses on food-image analysis, nutrition guidance, knowledge-grounded answers, user profile updates with approval flow, and admin-managed knowledge ingestion.

## Project Purpose

This project is designed to support a healthy-diet assistant that can:

- analyze uploaded food images
- estimate dish ingredients and nutrition-related context
- answer diet and health questions using local knowledge files and uploaded documents
- maintain user profile data with an approval step before database writes
- sync Taiwan MOHW clarification/news content into the local knowledge base
- expose backend APIs for chat, RAG, knowledge graph extraction, and admin knowledge ingestion

## Tech Stack

- Runtime: Bun + TypeScript
- Web server: Express 5
- Agent orchestration: LangGraph, LangChain, DeepAgents
- Model access:
  - local OpenAI-compatible endpoint via `AI_API_URL`
  - Google-compatible OpenAI endpoint via `GOOGLE_BASE_URL`
- Database: Supabase
- File processing: `sharp`, `mammoth`, `pdf-parse`, `cheerio`

## Key Links

- Main chat API: `POST /api/chat`
- Health check: `GET /ping`
- RAG search API: `GET|POST /api/rag/search`
- RAG documents API base: `/api/rag/documents`
- Knowledge graph API base: `/api/graph`
- MOHW sync API: `POST /api/news/sync`
- Local static image base: `/images/...`

Important project files:

- Server entry: `src/index.ts`
- Request handlers: `src/serverHandlers.ts`
- Agent runtime: `src/server/agentRuntime.ts`
- Model routing: `src/server/modelRouting.ts`
- RAG documents router: `src/server/ragDocuments.ts`
- Knowledge graph router: `src/server/knowledgeGraph.ts`
- RAG search handler: `src/server/ragSearch.ts`
- MOHW sync logic: `src/server/mohwNews.ts`
- MOHW sync script: `scripts/sync-mohw-clarifications.ts`
- Nutrition rules: `knowledge_base/NUTRITION_RULES.md`
- Agent prompt files:
  - `knowledge_base/AGENT.md`
  - `knowledge_base/SKILL_INDEX.md`
- Codex maintenance rules: `AGENT.md`
- Codex change log: `CHANGELOG_CODEX.md`
- Chinese documentation: `README_zh.md`

## Getting Started

### Install

```bash
npm install
```

or

```bash
bun install
```

### Environment

Copy `.env.example` to `.env` and fill in the required values.

Core variables:

- `PORT`: server port, default `8001`
- `AI_API_URL`: local OpenAI-compatible backend URL
- `SUPABASE_URL`: Supabase project URL
- `SUPABASE_SERVICE_KEY`: Supabase service role key
- `GEMINI_AI_API`: Google API key used first for Google routing
- `GEMINI_API_KEY`: fallback Google API key
- `GOOGLE_CHAT_MODEL`: Google-routed chat model name, default `gemma-4-31b-it`
- `GOOGLE_BASE_URL`: Google OpenAI-compatible base URL
- `MOHW_NEWS_SYNC_ENABLED`: enable periodic MOHW sync
- `MOHW_NEWS_SYNC_INTERVAL_MINUTES`: auto-sync interval
- `MOHW_NEWS_SYNC_RUN_ON_START`: sync on server startup
- `RAG_DOCS_ROOT`: uploaded docs root hint
- `RAG_WORKER_ENABLED` and related `RAG_WORKER_*` values: reserved worker-related settings already present in env example

### Run

```bash
bun run dev
```

or

```bash
bun run start
```

The server listens on `http://localhost:8001` by default.

## API Overview

### 1. Chat and conversation APIs

- `POST /api/chat`
  - Main SSE chat endpoint
  - Handles text, image input, URL verification cases, profile context, tool calls, and persistence
  - File: `src/serverHandlers.ts`
- `POST /api/approve`
  - Approves or rejects pending profile updates before DB write
  - File: `src/serverHandlers.ts`
- `POST /api/generate_title`
  - Generates a short conversation title
  - File: `src/serverHandlers.ts`
- `GET /ping`
  - Health check
  - File: `src/serverHandlers.ts`

Example `POST /api/chat` body:

```json
{
  "message": "Please analyze this lunch",
  "thread_id": "thread-1",
  "user_id": "user-123",
  "attachments": [
    {
      "kind": "image",
      "name": "lunch.png",
      "mime_type": "image/png",
      "data_url": "data:image/png;base64,..."
    }
  ],
  "model_source": "auto"
}
```

Chat behavior notes:

- the agent now creates the initial `diet_chat_history` row itself, so `chat_history_id` is no longer required from the caller
- `model_source: "auto"` prefers Google when a Google key exists, otherwise falls back to local
- `model_source: "local"` forces local model routing
- if an image is included without text, the backend creates a fallback prompt
- `attachments` may carry image metadata from the Rust proxy; the first image attachment is normalized into the existing image pipeline
- if multiple URLs are present, only the first URL is verified in that turn
- profile updates are proposed first, then written only after `POST /api/approve`

Current default chat model routing:

- local chat model: `gemma`
- Google chat model: `gemma-4-31b-it`

### 2. Knowledge search APIs

- `GET /api/rag/search`
- `POST /api/rag/search`

Purpose:

- search across:
  - `knowledge_base/NUTRITION_RULES.md`
  - `knowledge_base/mohw_clarifications/articles/*.md`
  - `knowledge_base/ingested_markdown/**/*.md`

Implementation:

- Handler: `src/server/ragSearch.ts`
- Search tool: `agent_skills/file_tools.ts`

### 3. RAG document management APIs

Base implementation: `src/server/ragDocuments.ts`

Endpoints:

- `GET /api/rag/documents`
- `POST /api/rag/documents`
- `GET /api/rag/documents/:document_id`
- `DELETE /api/rag/documents/:document_id`
- `POST /api/rag/documents/:document_id/reindex`
- `GET /api/rag/documents/:document_id/file`
- `GET /api/rag/documents/:document_id/preview`
- `GET /api/rag/sources/:document_id/file`
- `GET /api/rag/sources/:document_id/preview`

Features:

- multipart upload support
- supported extensions: `pdf`, `docx`, `txt`, `md`
- duplicate detection by SHA-256 hash
- text extraction and markdown conversion
- Supabase-backed document metadata
- preview and file serving endpoints

Admin access:

- requires either:
  - `x-admin-user-id` with `x-admin-role: admin|nutritionist`
  - or an `Authorization` header

### 4. Knowledge graph APIs

Base implementation: `src/server/knowledgeGraph.ts`

Endpoints:

- `POST /api/graph/extract-all`
- `GET /api/graph/status`
- `POST /api/graph/documents/:document_id/extract`
- `GET /api/graph/documents/:document_id`
- `POST /api/graph/search`
- `GET /api/graph/nodes`
- `GET /api/graph/nodes/:node_id`
- `GET /api/graph/relations/:relation_id/evidence`

Features:

- extracts graph nodes, edges, and evidence from:
  - uploaded knowledge documents
  - nutrition rules
  - MOHW local markdown articles
- caches results in `knowledge_base/graph/graph-cache.json`

### 5. Admin knowledge ingestion APIs

Registered in `src/index.ts`, implemented in `src/server/knowledgeIngestion.ts`.

Endpoints:

- `POST /api/admin/knowledge/upload`
- `POST /api/admin/knowledge/ingest/:id`
- `GET /api/admin/knowledge/jobs/:jobId`

Related docs:

- `Doc/knowledge_ingestion_api_m1.md`
- `Doc/supabase_knowledge_ingestion_m1.sql`

### 6. MOHW news/clarification APIs

Implementation: `src/server/mohwNews.ts`

Endpoints:

- `POST /api/news/sync`
- `GET /api/news`
- `GET /api/news/:id`
- `GET /api/news-files`

Related script:

- `bun run sync:mohw`
- file: `scripts/sync-mohw-clarifications.ts`

Output location:

- `knowledge_base/mohw_clarifications/`

## Main Features by Module

### Agent runtime and orchestration

Files:

- `src/server/agentRuntime.ts`
- `src/server/modelRouting.ts`
- `src/server/chatPayload.ts`
- `src/server/profileApproval.ts`

What it does:

- builds the LangGraph workflow
- routes between Google and local models
- streams SSE responses
- tracks tool execution statuses
- injects runtime context, user profile, and nutrition knowledge into prompts
- forces image analysis tool usage when an image is attached
- handles profile update proposal flow

### Agent tools

Files:

- `agent_skills/file_tools.ts`
- `agent_skills/vision_model.ts`
- `agent_skills/calc_tools.ts`
- `agent_skills/db_tools.ts`
- `agent_skills/summarizer_tools.ts`
- `agent_skills/fetch_web.ts`

What they do:

- `file_tools.ts`: read, update, and search local knowledge markdown
- `vision_model.ts`: analyze food images and return dish/ingredient summary JSON
- `calc_tools.ts`: nutrition estimation helpers
- `db_tools.ts`: chat history, user profile read/write, diet log access
- `summarizer_tools.ts`: conversation compression
- `fetch_web.ts`: webpage reachability/content checks for URL verification scenarios

### Image handling

Files:

- `src/server/imageStorage.ts`
- `src/server/workspacePaths.ts`
- `users_images/`

What it does:

- accepts incoming image payloads
- stores files under workspace-managed user folders
- exposes them through `/images`

### Supabase integration

Files:

- `src/server/supabaseRuntime.ts`
- `agent_skills/db_tools.ts`

Tables referenced by code include:

- `diet_chat_history`
- `chat_rooms`
- `users`
- `knowledge_documents`

Conversation memory behavior:

- `chat_rooms.summary` now acts as a lightweight summary index for the room instead of a single opaque summary string.
- Each summary index entry stores a compact summary plus `source_chat_history_ids` and optional `source_summary_history_id` links back to `diet_chat_history`.
- `diet_chat_history` remains the source of truth for full user/assistant turns and archival summary rows.
- Legacy Supabase backfill SQL: `Doc/supabase/2026-06-22-chat-room-summary-index-migration.sql`

## Knowledge Sources

Primary knowledge content lives in:

- `knowledge_base/NUTRITION_RULES.md`
- `knowledge_base/SKILL_INDEX.md`
- `knowledge_base/AGENT.md`
- `knowledge_base/mohw_clarifications/`
- `knowledge_base/ingested_markdown/`
- `knowledge_base/graph/`

Supporting planning and implementation docs live in:

- `Doc/`
- `docs/`

## Known Constraints

- RAG search is keyword-scored local search, not vector retrieval
- uploaded PDF parsing depends on text extraction and does not provide OCR fallback here
- some existing files contain encoding issues from older content
- Google routing only works when a valid Google API key is configured
- Supabase-backed features degrade when `SUPABASE_URL` or `SUPABASE_SERVICE_KEY` are missing

## Documentation Policy

When changing features, routes, env vars, storage paths, or major behavior, also update:

- `README.md`
- `README_zh.md`
- `CHANGELOG_CODEX.md`
- `AGENT.md` if the maintenance workflow itself changes

For Codex-specific maintenance rules, see `AGENT.md`.
