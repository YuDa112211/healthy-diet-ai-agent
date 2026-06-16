# CHANGELOG_CODEX

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
