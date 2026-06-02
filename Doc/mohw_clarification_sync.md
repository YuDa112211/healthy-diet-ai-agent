# 衛福部即時新聞澄清自動同步

## 功能
- 抓取頁面：`https://www.mohw.gov.tw/lp-17-1.html`（含分頁）
- 下載每篇澄清內文摘要到本地 Markdown
- 產生一份可檢索的書籤索引 Markdown（時間、標題、大概、路徑、原始連結）
- 維護 `manifest.json`，下次同步時只更新新增或異動資料

## 一鍵執行
```bash
bun run sync:mohw
```

## 輸出路徑
- `knowledge_base/mohw_clarifications/manifest.json`
- `knowledge_base/mohw_clarifications/BOOKMARKS.md`
- `knowledge_base/mohw_clarifications/articles/*.md`

## 可調參數
- `--maxPages=3`：只同步前 3 頁（啟動/測試時建議）
- `--outputDir=knowledge_base/mohw_clarifications`：自訂輸出目錄
- `MOHW_MAX_PAGES`：同 `--maxPages`
- `MOHW_TIMEOUT_MS`：單次請求 timeout（預設 12000）
- `MOHW_REQUEST_DELAY_MS`：每次請求間隔 ms（預設 150）

範例：
```bash
bun run sync:mohw --maxPages=2
```

## Windows 自動排程（每日 08:30）
```powershell
schtasks /Create /SC DAILY /TN "mohw-clarification-sync" /TR "powershell -NoProfile -Command \"cd D:\GitHub\archie0732\healthy-diet-ai-agent; bun run sync:mohw\"" /ST 08:30
```

## 備註
- 來源站若改版，可能需要調整 selector（目前使用 `.list ul li` 與 `.cp p`）。
- 日期欄位為民國年，腳本會同時轉成西元（例如 `115-05-12 -> 2026-05-12`）。
