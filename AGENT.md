# Healthy Diet AI Agent Repo Guide

最後更新：2026-06-03

## 1. 專案目的

這個 repo 是一個以 `Express + LangGraph + LangChain tools + Supabase` 組成的飲食 AI Agent 後端。
目前的核心任務是：

- 接收使用者文字與圖片，產生飲食分析回覆
- 讓 Agent 能查詢本地知識庫、衛福部澄清新聞、上傳文件摘要
- 對聊天紀錄、對話標題、摘要、使用者 profile 做後端整合
- 用「提案 -> 使用者核准 -> 實際寫入」的方式更新個資

## 2. 先建立的心智模型

把專案拆成 4 個層次理解：

1. HTTP API 層
   `src/index.ts` 負責掛路由。
2. Chat / Agent orchestration 層
   `src/serverHandlers.ts` 與 `src/server/agentRuntime.ts` 負責 request 驗證、SSE 串流、工具調用、核准流程。
3. Domain tools / server modules 層
   `agent_skills/*.ts` 與 `src/server/*.ts` 負責圖片分析、營養估算、知識庫搜尋、新聞同步、RAG、文件匯入等功能。
4. Knowledge / docs / roadmap 層
   `knowledge_base/` 放 Agent 執行時會讀到的規則，`Doc/` 放 API、資料表、規劃與變更紀錄。

## 3. 主要入口與檔案地圖

### Server entry

- `src/index.ts`
  啟動 Express，掛載全部 API，也負責 MOHW news 自動同步排程。

### Chat 與核准流程

- `src/serverHandlers.ts`
  主要 handler：`chatHandler`、`approveHandler`、`generateTitleHandler`、`pingHandler`
- `src/server/agentRuntime.ts`
  Agent prompt 組裝、LangGraph workflow、tool registration、SSE tool traces
- `src/server/profileApproval.ts`
  個資提案欄位清理、proposal items 建立、pending approval 記憶體管理
- `src/server/httpRuntime.ts`
  timeout、body parser、request log、錯誤判斷
- `src/server/imageStorage.ts`
  接收 base64/data URL/直接 path，將圖片存進 `users_images/`

### Agent tools

- `agent_skills/file_tools.ts`
  本地知識庫讀取、更新、搜尋；也是目前 RAG 搜尋的核心
- `agent_skills/vision_model.ts`
  食物圖片分析，回傳 dish/ingredients 或 summary
- `agent_skills/calc_tools.ts`
  以簡化營養資料表估算熱量與三大營養素
- `agent_skills/db_tools.ts`
  chat history / user profile 的 Supabase 操作
- `agent_skills/summarizer_tools.ts`
  舊聊天摘要壓縮
- `agent_skills/fetch_web.ts`
  網頁可達性檢查與頁面摘要抓取

### Server feature modules

- `src/server/knowledgeIngestion.ts`
  Admin 上傳文件、建立 ingestion job、抽文字並輸出 markdown
- `src/server/ragSearch.ts`
  將搜尋 API 對接到 `searchKnowledgeTool`
- `src/server/mohwNews.ts`
  同步衛福部食藥署澄清新聞，寫入 `knowledge_base/mohw_clarifications/`
- `src/server/workspacePaths.ts`
  專案路徑常數與 runtime 讀取的知識檔位置
- `src/server/supabaseRuntime.ts`
  Supabase client 與 `AI_API_URL`

### Runtime knowledge files

這三份是 Agent 在執行時直接讀進 prompt 的檔案：

- `knowledge_base/AGENT.md`
- `knowledge_base/SKILL_INDEX.md`
- `knowledge_base/NUTRITION_RULES.md`

如果要改變模型回答規則、引用方式、知識優先序，先看這三份。

## 4. 路由總覽

目前 `src/index.ts` 已掛載的 API：

- `POST /api/chat`
- `POST /api/approve`
- `POST /api/generate_title`
- `POST /api/admin/knowledge/upload`
- `POST /api/admin/knowledge/ingest/:id`
- `GET /api/admin/knowledge/jobs/:jobId`
- `POST /api/news/sync`
- `GET /api/news`
- `GET /api/news/:id`
- `GET /api/news-files`
- `GET|POST /api/rag/search`
- `GET /ping`

API contract 文件：`Doc/api_route_input_output_spec.md`

## 5. 功能定位速查

### 使用者說「聊天回覆不對 / SSE 壞了 / tool 沒被叫到」

先看：

- `src/serverHandlers.ts`
- `src/server/agentRuntime.ts`
- `knowledge_base/AGENT.md`
- `knowledge_base/SKILL_INDEX.md`

### 使用者說「圖片上傳、圖片格式、圖片儲存位置有問題」

先看：

- `src/server/imageStorage.ts`
- `src/serverHandlers.ts`
- `src/server/workspacePaths.ts`

### 使用者說「食物辨識或熱量估算不準」

先看：

- `agent_skills/vision_model.ts`
- `agent_skills/calc_tools.ts`
- `knowledge_base/NUTRITION_RULES.md`

注意：`calc_tools.ts` 目前是簡化版本地資料表，不是完整營養資料庫。

### 使用者說「個資更新流程、核准流程、users table 更新有問題」

先看：

- `src/server/profileApproval.ts`
- `src/serverHandlers.ts`
- `src/server/agentRuntime.ts`
- `agent_skills/db_tools.ts`

規則重點：模型不能直接寫入 profile，必須走 `/api/approve`。

### 使用者說「知識庫搜尋 / RAG / citation 有問題」

先看：

- `agent_skills/file_tools.ts`
- `src/server/ragSearch.ts`
- `knowledge_base/`
- `Doc/agent_rag_future_plan.md`

### 使用者說「上傳 PDF / DOCX / TXT / MD 後沒有被 ingest」

先看：

- `src/server/knowledgeIngestion.ts`
- `Doc/knowledge_ingestion_api_m1.md`
- `Doc/supabase_knowledge_ingestion_m1.sql`

### 使用者說「衛福部澄清新聞沒有更新 / 格式錯亂 / 本地文章缺失」

先看：

- `src/server/mohwNews.ts`
- `scripts/sync-mohw-clarifications.ts`
- `knowledge_base/mohw_clarifications/`
- `Doc/mohw_clarification_sync.md`

## 6. 當前能力與限制

### 已有能力

- 文字與圖片聊天分析
- SSE 串流回覆
- 對話標題生成與摘要保存
- 使用者 profile 核准式更新
- 本地 markdown knowledge search
- 文件上傳與文字抽取 ingestion
- MOHW news 本地同步

### 目前限制

- 部分舊檔有編碼污染，改中文內容時要確認 UTF-8
- `calc_tools.ts` 的營養資料表很小，只適合 MVP
- knowledge ingestion 目前以文字抽取為主，OCR 不是完整主流程
- `file_tools.ts` 目前是簡單 keyword scoring，不是完整 vector retrieval
- approval state 目前在記憶體中，重啟程序後不保留

## 7. 未來方向

依目前 `Doc/` 文件，專案接下來的合理演進方向是：

- 把 knowledge ingestion 從 M1 文字抽取，擴充到 chunking、embedding、vector retrieval
- 提升 MOHW / uploaded knowledge / nutrition rules 的統一 citation 與檢索品質
- 把營養估算從簡化字典升級成更可靠資料源
- 補齊 OCR fallback、job 狀態觀測、失敗重試
- 強化個人化推薦，讓 profile / taboo / disease 更穩定參與回答

優先參考文件：

- `Doc/agent_rag_future_plan.md`
- `Doc/knowledge_ingestion_api_m1.md`
- `Doc/memory_summarizer.md`
- `Doc/rust_server_news_rag_api.md`

## 8. 修改時的工作習慣

1. 改路由時，同步更新 `src/index.ts` 與對應 server module。
2. 改 request/response contract 時，同步更新 `Doc/api_route_input_output_spec.md`。
3. 改 Agent 能力時，確認是否要同步改：
   - `src/server/agentRuntime.ts`
   - `agent_skills/*.ts`
   - `knowledge_base/AGENT.md`
   - `knowledge_base/SKILL_INDEX.md`
   - `knowledge_base/NUTRITION_RULES.md`
4. 改資料表或 ingestion 流程時，同步補 `Doc/*.sql` 或設計文件。
5. 遇到中文亂碼，先確認檔案與終端都用 UTF-8。

## 9. 給未來 Codex 的最短閱讀順序

如果時間很少，先依序讀：

1. `README.md`
2. `AGENT.md`（本檔）
3. `SKILL.md`
4. `src/index.ts`
5. `src/serverHandlers.ts`
6. `src/server/agentRuntime.ts`
7. 與任務最相關的 `agent_skills/*.ts` 或 `src/server/*.ts`

## 10. 文件紀錄規則（每次完成後都要做）

本 repo 目前實際文件資料夾名稱是 `Doc/`。
如果有人口頭寫 `/doc`，在本專案請一律對應成 `Doc/`。

每次 Codex 完成修改後，必須：

1. 建立或更新 `Doc/YYYY-MM-DD_codex.md`
2. 在檔案中記錄：
   - 本次修改目的
   - 修改了哪些檔案
   - 每個檔案大致用途或變更重點
   - 是否有 API / DB / prompt / route / env 影響
   - 是否有測試或尚未驗證的項目

### 待辦檔命名規則

若使用者把想新增的內容放在：

- `Doc/to_do_YYYY-MM-DD_not_yet.md`

表示那是一份尚未完成的待辦需求。

### 待辦完成後的處理規則

如果該待辦在本次工作中已完成，Codex 必須：

1. 把檔名改成 `Doc/to_do_YYYY-MM-DD_done.md`
2. 把檔內狀態標記從 `not_yet` 改成 `done`
3. 若標題含有 `[NOT_YET]`，改成 `[DONE]`
4. 在該檔案底部補上：
   - 完成日期
   - 對應的 `Doc/YYYY-MM-DD_codex.md`
   - 本次完成了哪些內容

如果只完成部分項目，保留 `not_yet` 檔名，但要在內容中標記已完成與未完成項目。
