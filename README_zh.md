# Healthy Diet AI Agent

這是一個以 `Express + LangGraph + LangChain + Supabase` 建構的健康飲食 AI 後端，主要用途是處理食物圖片分析、飲食與營養問答、知識檢索、使用者資料更新審批，以及後台知識文件管理。

## 專案目的

這個專案希望提供一個能落地的飲食助理後端，支援以下情境：

- 分析使用者上傳的餐點圖片
- 推測菜色、食材與營養相關資訊
- 依據本地知識庫、MOHW 資料與上傳文件回答飲食問題
- 在更新使用者個人資料前，先走核准流程
- 管理員可上傳 PDF、DOCX、TXT、MD 文件做 RAG 使用
- 建立知識圖譜，讓後續檢索與關聯查詢更容易擴充

## 技術組成

- Runtime：`Bun`、`TypeScript`
- Web Server：`Express 5`
- Agent：`LangGraph`、`LangChain`
- 資料庫：`Supabase`
- 影像/文件處理：`sharp`、`mammoth`、`pdf-parse`、`cheerio`
- 模型來源：
  - 本地 OpenAI 相容端點：`AI_API_URL`
  - Google OpenAI 相容端點：`GOOGLE_BASE_URL`

## 重要連結與入口

- 主要聊天 API：`POST /api/chat`
- 健康檢查：`GET /ping`
- RAG 搜尋：`GET|POST /api/rag/search`
- RAG 文件 API 基底：`/api/rag/documents`
- 知識圖譜 API 基底：`/api/graph`
- MOHW 同步 API：`POST /api/news/sync`
- 圖片靜態路徑：`/images/...`

主要檔案路徑：

- 伺服器入口：`src/index.ts`
- API handlers：`src/serverHandlers.ts`
- Agent 執行流程：`src/server/agentRuntime.ts`
- 模型路由：`src/server/modelRouting.ts`
- RAG 文件管理：`src/server/ragDocuments.ts`
- 知識圖譜：`src/server/knowledgeGraph.ts`
- RAG 搜尋：`src/server/ragSearch.ts`
- MOHW 同步：`src/server/mohwNews.ts`
- MOHW 抓取腳本：`scripts/sync-mohw-clarifications.ts`
- 營養規則：`knowledge_base/NUTRITION_RULES.md`
- Agent 內部提示資料：
  - `knowledge_base/AGENT.md`
  - `knowledge_base/SKILL_INDEX.md`
- Codex 維護規範：`AGENT.md`
- Codex 版本紀錄：`CHANGELOG_CODEX.md`
- 英文文件：`README.md`

## 快速開始

### 安裝

```bash
npm install
```

或

```bash
bun install
```

### 環境變數

請將 `.env.example` 複製成 `.env`，再填入實際值。

核心變數：

- `PORT`：伺服器埠號，預設 `8001`
- `AI_API_URL`：本地 OpenAI 相容模型服務 URL
- `SUPABASE_URL`：Supabase 專案網址
- `SUPABASE_SERVICE_KEY`：Supabase service role key
- `GEMINI_AI_API`：Google 路由優先使用的 API key
- `GEMINI_API_KEY`：Google 路由備援 key
- `GOOGLE_CHAT_MODEL`：Google 路由使用的模型名稱，預設為 `gemma-4-31b-it`
- `GOOGLE_BASE_URL`：Google OpenAI 相容 base URL
- `MOHW_NEWS_SYNC_ENABLED`：是否開啟 MOHW 自動同步
- `MOHW_NEWS_SYNC_INTERVAL_MINUTES`：同步週期
- `MOHW_NEWS_SYNC_RUN_ON_START`：啟動時是否先同步一次
- `RAG_DOCS_ROOT`：文件根路徑提示
- `RAG_WORKER_*`：env example 已存在的 worker 相關參數

### 啟動

```bash
bun run dev
```

或

```bash
bun run start
```

預設會啟動在 `http://localhost:8001`。

## API 一覽

### 1. 聊天與對話相關 API

- `POST /api/chat`
  - 主要 SSE 聊天入口
  - 支援文字、圖片、網址驗證、使用者 profile context、tool call 與背景資料持久化
  - 檔案：`src/serverHandlers.ts`
- `POST /api/approve`
  - 核准或拒絕待寫入的使用者資料更新
  - 檔案：`src/serverHandlers.ts`
- `POST /api/generate_title`
  - 產生對話標題
  - 檔案：`src/serverHandlers.ts`
- `GET /ping`
  - 健康檢查
  - 檔案：`src/serverHandlers.ts`

`POST /api/chat` 範例：

```json
{
  "message": "請幫我分析這份午餐",
  "thread_id": "thread-1",
  "chat_history_id": "history-1",
  "user_id": "user-123",
  "model_source": "auto"
}
```

聊天流程特性：

- `model_source: "auto"`：若有 Google key，優先走 Google，失敗時可回退 local
- `model_source: "local"`：強制走 local
- 若只有圖片沒有文字，後端會自動補預設提示
- 若訊息中有多個 URL，只會驗證第一個
- 若偵測到明確個資更新，會先提出 proposal，再透過 `POST /api/approve` 寫入

目前預設聊天模型路由：

- local chat model：`gemma`
- Google chat model：`gemma-4-31b-it`

### 2. 知識搜尋 API

- `GET /api/rag/search`
- `POST /api/rag/search`

搜尋來源：

- `knowledge_base/NUTRITION_RULES.md`
- `knowledge_base/mohw_clarifications/articles/*.md`
- `knowledge_base/ingested_markdown/**/*.md`

實作檔案：

- handler：`src/server/ragSearch.ts`
- 搜尋工具：`agent_skills/file_tools.ts`

### 3. RAG 文件管理 API

實作：`src/server/ragDocuments.ts`

端點：

- `GET /api/rag/documents`
- `POST /api/rag/documents`
- `GET /api/rag/documents/:document_id`
- `DELETE /api/rag/documents/:document_id`
- `POST /api/rag/documents/:document_id/reindex`
- `GET /api/rag/documents/:document_id/file`
- `GET /api/rag/documents/:document_id/preview`
- `GET /api/rag/sources/:document_id/file`
- `GET /api/rag/sources/:document_id/preview`

功能：

- 支援 multipart 上傳
- 支援副檔名：`pdf`、`docx`、`txt`、`md`
- 以 SHA-256 判斷重複文件
- 抽取文字並轉成 markdown
- 文件 metadata 存放於 Supabase
- 提供檔案預覽與原檔下載/查看

管理權限：

- 需帶：
  - `x-admin-user-id` 與 `x-admin-role: admin|nutritionist`
  - 或 `Authorization` header

### 4. 知識圖譜 API

實作：`src/server/knowledgeGraph.ts`

端點：

- `POST /api/graph/extract-all`
- `GET /api/graph/status`
- `POST /api/graph/documents/:document_id/extract`
- `GET /api/graph/documents/:document_id`
- `POST /api/graph/search`
- `GET /api/graph/nodes`
- `GET /api/graph/nodes/:node_id`
- `GET /api/graph/relations/:relation_id/evidence`

功能：

- 從以下來源抽取節點、關係與證據：
  - 上傳知識文件
  - `NUTRITION_RULES.md`
  - MOHW 本地 markdown
- 快取檔案位置：`knowledge_base/graph/graph-cache.json`

### 5. 後台知識匯入 API

已在 `src/index.ts` 註冊，主要實作在 `src/server/knowledgeIngestion.ts`。

端點：

- `POST /api/admin/knowledge/upload`
- `POST /api/admin/knowledge/ingest/:id`
- `GET /api/admin/knowledge/jobs/:jobId`

相關文件：

- `Doc/knowledge_ingestion_api_m1.md`
- `Doc/supabase_knowledge_ingestion_m1.sql`

### 6. MOHW 新聞/澄清資料 API

實作：`src/server/mohwNews.ts`

端點：

- `POST /api/news/sync`
- `GET /api/news`
- `GET /api/news/:id`
- `GET /api/news-files`

相關腳本：

- `bun run sync:mohw`
- 檔案：`scripts/sync-mohw-clarifications.ts`

輸出位置：

- `knowledge_base/mohw_clarifications/`

## 主要功能模組

### Agent runtime 與協作流程

檔案：

- `src/server/agentRuntime.ts`
- `src/server/modelRouting.ts`
- `src/server/chatPayload.ts`
- `src/server/profileApproval.ts`

負責內容：

- 建立 LangGraph workflow
- 在 Google 與 local 模型之間做路由
- SSE 串流回應
- tool 執行狀態追蹤
- 將 user profile、對話摘要、營養規則注入 prompt
- 有圖片時強制先跑 `analyze_food_image`
- 偵測個資更新 proposal，並接上 approval flow

### Agent tools

檔案：

- `agent_skills/file_tools.ts`
- `agent_skills/vision_model.ts`
- `agent_skills/calc_tools.ts`
- `agent_skills/db_tools.ts`
- `agent_skills/summarizer_tools.ts`
- `agent_skills/fetch_web.ts`

用途：

- `file_tools.ts`：讀取、更新、搜尋本地知識 markdown
- `vision_model.ts`：分析食物圖片，回傳菜色/食材摘要
- `calc_tools.ts`：營養估算相關工具
- `db_tools.ts`：聊天紀錄、使用者資料與資料庫操作
- `summarizer_tools.ts`：對話壓縮
- `fetch_web.ts`：網址可達性與頁面內容檢查

### 圖片儲存與靜態服務

檔案：

- `src/server/imageStorage.ts`
- `src/server/workspacePaths.ts`
- `users_images/`

功能：

- 接收前端送來的圖片
- 儲存在 workspace 內的使用者資料夾
- 透過 `/images` 對外提供靜態路徑

### Supabase 整合

檔案：

- `src/server/supabaseRuntime.ts`
- `agent_skills/db_tools.ts`

程式中使用到的資料表包含：

- `diet_chat_history`
- `chat_rooms`
- `users`
- `knowledge_documents`

## 知識來源與文件位置

主要知識檔案：

- `knowledge_base/NUTRITION_RULES.md`
- `knowledge_base/SKILL_INDEX.md`
- `knowledge_base/AGENT.md`
- `knowledge_base/mohw_clarifications/`
- `knowledge_base/ingested_markdown/`
- `knowledge_base/graph/`

其他規劃/說明文件：

- `Doc/`
- `docs/`

## 已知限制

- 目前 RAG 搜尋是本地 keyword scoring，不是向量檢索
- PDF 抽取依賴文字層，這裡沒有 OCR fallback
- repo 中部分舊檔可能存在編碼歷史問題
- Google 路由只有在正確設定 API key 時才會生效
- 若缺少 `SUPABASE_URL` 或 `SUPABASE_SERVICE_KEY`，部分功能會降級或不可用

## 文件維護規則

只要變更以下內容，就必須同步更新：

- `README.md`
- `README_zh.md`
- `CHANGELOG_CODEX.md`
- 若流程規範本身改變，連 `AGENT.md` 也要一起更新

Codex 維護規則請看根目錄 `AGENT.md`。
