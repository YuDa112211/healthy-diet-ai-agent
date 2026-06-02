# Knowledge Ingestion API (M1)

## 概要
M1 提供三個 admin API：
- `POST /api/admin/knowledge/upload`
- `POST /api/admin/knowledge/ingest/:id`
- `GET /api/admin/knowledge/jobs/:jobId`

目前先採 `JSON + base64` 上傳（先打通流程），後續可再補 `multipart/form-data`。
目前採「本地原始檔 + 本地解析 md + Supabase 輕量索引」模式，不把全文塞進 Supabase。

## 1) 上傳文件
`POST /api/admin/knowledge/upload`

Request JSON:
```json
{
  "file_name": "paper.docx",
  "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "file_base64": "<base64 or data:url>",
  "title": "糖尿病飲食文獻",
  "uploaded_by": "dietitian_a",
  "uploader_role": "nutritionist",
  "source_type": "manual_upload",
  "tags": ["diabetes", "guideline"]
}
```

Response:
- `201`：新文件建立成功
- `200`：重複文件（同 `file_hash`）直接回傳既有文件資訊

## 2) 啟動解析任務
`POST /api/admin/knowledge/ingest/:id`

說明：
- `:id` 為 `knowledge_documents.id`
- 會建立一筆 `knowledge_ingestion_jobs` 並同步跑抽取
- 目前支援：`pdf`, `docx`, `txt`, `md`
- 抽取成功後會產生本地 Markdown（`knowledge_base/ingested_markdown/...`）

Response:
- `200`：解析成功（含 `job_id`、`extracted_char_count`）
- `500`：解析失敗（會把 job 狀態標為 `failed`）
- 若 PDF 無文字層，可能會回傳 OCR 需求錯誤（目前尚未接 OCR 引擎）

## 3) 查詢任務狀態
`GET /api/admin/knowledge/jobs/:jobId`

Response:
- `200`：回傳 job 狀態與摘要
- `404`：找不到 job

## 限制與環境參數
- `KNOWLEDGE_MAX_UPLOAD_BYTES`（預設 `12MB`）
- `KNOWLEDGE_MAX_EXTRACTED_TEXT_CHARS`（預設 `350000`）

## 先決條件
先執行：
- [supabase_knowledge_ingestion_m1.sql](D:\GitHub\archie0732\healthy-diet-ai-agent\Doc\supabase_knowledge_ingestion_m1.sql)
- 若你已跑過舊版 M1，請再補跑：
- [supabase_knowledge_ingestion_local_storage_patch.sql](D:\GitHub\archie0732\healthy-diet-ai-agent\Doc\supabase_knowledge_ingestion_local_storage_patch.sql)

## 測試建議流程
1. 上傳 `txt` 文件驗證 API 流程
2. 上傳 `docx/pdf` 驗證抽取
3. 查 job 狀態確認 `processing -> success/failed`
