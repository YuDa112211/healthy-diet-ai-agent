# CHANGELOG_CODEX

## 2026-06-22 22:10 Asia/Taipei

- Summary: Reworked conversation memory so `chat_rooms.summary` stores a traceable summary index before falling back to raw `diet_chat_history` turns.
- Author: Codex
- Scope:
  - conversation memory persistence
  - summary retrieval formatting
  - repository documentation
- Files:
  - `src/serverHandlers.ts`
  - `src/server/roomSummaryIndex.ts`
  - `src/server/roomSummaryIndex.test.ts`
  - `agent_skills/db_tools.ts`
  - `src/server/serverHandlers.test.ts`
  - `src/server/dbTools.test.ts`
  - `Doc/supabase/2026-06-22-chat-room-summary-index-migration.sql`
  - `README.md`
  - `README_zh.md`
  - `CHANGELOG_CODEX.md`
- API:
  - Added: `none`
  - Changed: `chat_rooms.summary` payload shape now supports structured summary index entries
  - Removed: `none`
- Env:
  - Added: `none`
  - Changed: `none`
  - Removed: `none`
- Notes:
  - Runtime context now feeds a room summary index first, and each summary entry can point back to raw chat rows and archival summary rows.
  - Added a Supabase backfill migration that converts legacy `chat_rooms.summary` text into JSONB summary index arrays.

## 2026-06-16 16:40 Asia/Taipei

- Summary: Changed the default Google chat model from Gemma 3 31B to Gemma 4 31B and synchronized the related documentation.
- Author: Codex
- Scope:
  - model routing
  - repository documentation
- Files:
  - `src/server/modelRouting.ts`
  - `.env.example`
  - `README.md`
  - `README_zh.md`
  - `CHANGELOG_CODEX.md`
- API:
  - Added: `none`
  - Changed: `none`
  - Removed: `none`
- Env:
  - Added: `none`
  - Changed: `GOOGLE_CHAT_MODEL`
  - Removed: `none`
- Notes:
  - Default Google chat model is now `gemma-4-31b-it`; `.env` can still override it explicitly.

## 2026-06-16 16:30 Asia/Taipei

- Summary: Rewrote the project documentation in English and Chinese, and added explicit Codex maintenance rules for future versioned updates.
- Author: Codex
- Scope:
  - repository documentation
  - agent maintenance workflow
- Files:
  - `README.md`
  - `README_zh.md`
  - `AGENT.md`
  - `CHANGELOG_CODEX.md`
- API:
  - Added: `none`
  - Changed: `none`
  - Removed: `none`
- Env:
  - Added: `none`
  - Changed: `none`
  - Removed: `none`
- Notes:
  - Future feature work must update both READMEs and append a new change entry here when behavior changes.
