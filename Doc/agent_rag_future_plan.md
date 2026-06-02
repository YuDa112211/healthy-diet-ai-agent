# Agent RAG 文件上傳與知識庫建置未來規劃

## 1) 目標與價值
- 讓前端角色（管理員、營養師）可以上傳文獻檔（PDF、DOCX、圖片），由 Agent 自動解析後寫入 RAG 知識庫。
- 建立可追溯、可驗證、可維護的知識管理流程，支援論文研究、問答系統、臨床/營養建議查詢。
- 讓最終回答具備來源引用（檔名、頁碼、段落、上傳時間、版本）。

## 2) 你提出的方案評估
- 結論：非常值得做，且與你現有專案方向一致。
- 補充建議：不要所有檔案都直接 OCR。
- 先做「文字可抽取優先」，OCR 當 fallback，可大幅降低成本與錯誤率。

建議解析策略：
1. `DOCX`：直接抽取文字與標題層級（通常準確度最高）。
2. `PDF`：先嘗試文字層抽取；若內容為掃描圖再啟用 OCR。
3. `Image`：直接 OCR。
4. 任何格式都保留原檔 metadata（檔名、大小、hash、上傳者、時間、版本）。

## 3) 系統架構（建議）
- 前端：
  - 新增管理頁面：`Knowledge Ingestion`
  - 提供上傳、任務狀態、錯誤重試、版本查看
- 後端 API：
  - `POST /api/admin/knowledge/upload`：上傳檔案與 metadata
  - `POST /api/admin/knowledge/ingest/:id`：啟動解析任務（可同步或背景）
  - `GET /api/admin/knowledge/jobs/:jobId`：查詢任務進度
  - `GET /api/admin/knowledge/documents`：文件與版本清單
- Agent/Worker：
  - 文本抽取模組（docx/pdf）
  - OCR 模組（僅 fallback）
  - chunking + embedding + upsert 向量庫
  - 引用欄位產生（source_id, page, chunk_id）
- 儲存層（建議）：
  - Object storage：存原始檔
  - PostgreSQL：存文件 metadata、任務狀態、版本
  - Vector store（可先用 Supabase pgvector）

## 4) 路由或 flag 設計（對應你的需求）
- 方案 A（推薦）：新增明確 admin 路由
  - 優點：語意清晰、權限隔離容易、後續擴展方便
- 方案 B：沿用現有聊天路由 + 特殊 flag
  - 例如 `mode: "ingest_knowledge"`
  - 優點：改動小；缺點：長期維護性較差

建議採用：
1. 上傳走 admin 專用 API（A）
2. Chat API 僅負責查詢與回答，不直接接收大檔

## 5) 資料流程（MVP）
1. 前端上傳檔案（含角色/標籤/來源類型）
2. 後端建立 `ingestion_job`
3. Parser 抽文字；必要時 OCR
4. 清洗與切塊（chunk）
5. 產生 embedding 並寫入向量庫
6. 建立可引用索引（文件、頁碼、段落）
7. 任務完成並回寫狀態（success / partial / failed）

## 6) Chunk 與檢索策略（可直接寫進論文方法）
- Chunk size：500~1000 tokens
- Overlap：80~150 tokens
- 混合檢索：BM25 + 向量檢索（hybrid）
- Reranker：可在第二階段加入
- 引用格式：至少顯示 `文件名 + 頁碼 + chunk_id`

## 7) 安全與治理（很重要）
- 僅 `admin`、`nutritionist` 可上傳；一般使用者唯讀查詢
- 檔案類型與大小白名單（PDF/DOCX/JPG/PNG）
- 上傳檔案做 hash，避免重複 ingest
- PII 掃描與遮罩（電話、身分證、地址）
- 審計日誌：誰在何時上傳了什麼、是否成功

## 8) 觀測與品質指標（論文可用）
- Ingestion 成功率
- OCR 字元錯誤率（CER）或人工抽樣正確率
- 檢索命中率（Recall@k）
- 最終回答引用覆蓋率（有來源比例）
- 幻覺率（回答無來源或來源不一致）

## 9) 里程碑（建議）
1. `M1`：API + 檔案儲存 + metadata 表
2. `M2`：PDF/DOCX 文字抽取 + chunk + embedding
3. `M3`：OCR fallback + 任務佇列 + 進度頁
4. `M4`：引用格式標準化 + 評估儀表板
5. `M5`：混合檢索與 reranker 優化

## 10) 建議的資料表（草案）
- `knowledge_documents`
  - `id`, `title`, `source_type`, `file_path`, `file_hash`, `version`, `uploaded_by`, `created_at`
- `knowledge_ingestion_jobs`
  - `id`, `document_id`, `status`, `error_message`, `started_at`, `finished_at`
- `knowledge_chunks`
  - `id`, `document_id`, `page`, `chunk_index`, `text`, `token_count`, `embedding`, `created_at`

## 11) 與目前專案的銜接建議
- 將既有 `knowledge_base/mohw_clarifications` 當第一批 seed corpus。
- 新增「外部上傳文獻」為第二來源，兩者共用相同 chunk schema。
- 在回答層加上 citation formatter，確保每段結論都可回溯。

## 12) 實作優先順序（務實版）
1. 先做 admin 上傳路由（不含 OCR）
2. 做 PDF/DOCX 文字抽取與入庫
3. 做查詢時引用顯示
4. 再補 OCR、重排與更完整評估

---

這份規劃是給「可上線 + 可寫論文」雙目標使用；建議先做 MVP，把資料閉環跑通，再做模型與檢索優化。
