# AGENT.md

This file defines the repository maintenance rules for Codex and other coding agents working in this project.

## Scope

These rules apply to any task that changes code, routes, prompts, knowledge flow, environment variables, database behavior, file structure, or project documentation.

## Required Documentation Updates

When you modify or add any feature, you must update all of the following in the same task when relevant:

- `README.md`
- `README_zh.md`
- `CHANGELOG_CODEX.md`

If the agent workflow itself changes, also update:

- `AGENT.md`

## Mandatory Rule

Do not finish a feature-only edit without also checking whether the documentation and change log must be updated.

If any of the following changed, documentation update is required:

- API route added, removed, renamed, or behavior changed
- request or response payload changed
- environment variable added, removed, renamed, or repurposed
- database table usage changed
- model routing behavior changed
- agent tool behavior changed
- knowledge source path changed
- file storage path changed
- admin workflow changed
- MOHW sync behavior changed
- RAG document ingestion behavior changed
- knowledge graph behavior changed
- user approval/profile update behavior changed

## Change Log File

Primary update history file:

- `CHANGELOG_CODEX.md`

Every implementation task that changes behavior should append one new entry to this file.

## Change Log Entry Format

Use this format for each new entry:

```md
## YYYY-MM-DD HH:MM TZ

- Summary: <short summary of the change>
- Author: Codex
- Scope:
  - <feature/module 1>
  - <feature/module 2>
- Files:
  - `<path/to/file>`
  - `<path/to/file>`
- API:
  - Added: `<route>` or `none`
  - Changed: `<route>` or `none`
  - Removed: `<route>` or `none`
- Env:
  - Added: `<ENV_NAME>` or `none`
  - Changed: `<ENV_NAME>` or `none`
  - Removed: `<ENV_NAME>` or `none`
- Notes:
  - <important migration, compatibility, or behavior note>
```

Keep entries concise but specific.

## README Update Expectations

When updating `README.md` or `README_zh.md`, keep them aligned on:

- project purpose
- major features
- API routes
- important environment variables
- important file paths
- storage paths
- knowledge paths
- operational constraints

The English and Chinese READMEs do not need to be literal translations, but they must describe the same current system.

## File Path Expectations

When documenting features, include the main implementation paths whenever possible. Prefer concrete paths such as:

- `src/index.ts`
- `src/serverHandlers.ts`
- `src/server/agentRuntime.ts`
- `src/server/ragDocuments.ts`
- `src/server/knowledgeGraph.ts`
- `agent_skills/file_tools.ts`

## Task Completion Checklist For Agents

Before completing a task, verify:

1. code changes are complete
2. relevant docs were updated
3. `CHANGELOG_CODEX.md` has a new entry if behavior changed
4. README English and Chinese remain consistent with current behavior
5. no removed or renamed route/env/file path is still documented incorrectly

## If Unsure

If you are unsure whether a change is documentation-worthy, treat it as documentation-worthy and update:

- `README.md`
- `README_zh.md`
- `CHANGELOG_CODEX.md`

Default to over-documenting rather than skipping updates.
