# Knowledge Graph API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a knowledge-graph extraction and query API on top of the existing RAG knowledge corpus, plus handoff docs for Rust and frontend integration.

**Architecture:** Reuse the existing Express/RAG document patterns and add a focused `knowledgeGraph` module that can discover source documents, extract graph triples into a local cache, and return query-friendly graph subgraphs. Keep frontend-facing stability by documenting Rust gateway contracts separately from the internal Node routes.

**Tech Stack:** Bun, TypeScript, Express, Bun test, local JSON cache under `knowledge_base/graph/`

---

### Task 1: Plan and file boundaries

**Files:**
- Create: `docs/superpowers/plans/2026-06-08-knowledge-graph-api.md`
- Create: `src/server/knowledgeGraph.ts`
- Create: `src/server/knowledgeGraph.test.ts`
- Modify: `src/index.ts`
- Create: `Doc/rust_server_knowledge_graph_api.md`
- Create: `Doc/frontend_knowledge_graph_api.md`

- [ ] **Step 1: Lock the module boundaries**

Use one server module for graph routing, extraction, cache, and query helpers so the new feature stays isolated from chat and ingestion code.

- [ ] **Step 2: Keep route naming aligned with existing RAG patterns**

Expose internal Node routes under `/api/graph/*` and document Rust-facing routes under `/api/knowledge-graph*`.

### Task 2: Add failing route contract tests

**Files:**
- Create: `src/server/knowledgeGraph.test.ts`

- [ ] **Step 1: Write failing tests for subgraph search, node detail, and extract-by-document**

Cover:
- public `POST /api/graph/search`
- public `GET /api/graph/nodes/:node_id`
- admin `POST /api/graph/documents/:document_id/extract`
- admin `GET /api/graph/documents/:document_id`

- [ ] **Step 2: Run the graph test file and verify failure**

Run: `bun test src/server/knowledgeGraph.test.ts`
Expected: FAIL because the module/router does not exist yet.

### Task 3: Implement minimal graph extraction and query flow

**Files:**
- Create: `src/server/knowledgeGraph.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement source discovery**

Support uploaded RAG documents from the existing repository plus local markdown knowledge sources.

- [ ] **Step 2: Implement deterministic extraction**

Use a constrained keyword/pattern extractor for MVP relation generation so the API works now without introducing another external dependency.

- [ ] **Step 3: Implement JSON cache persistence**

Persist extracted graph payloads below `knowledge_base/graph/` to avoid recomputing on every query.

- [ ] **Step 4: Implement query routes**

Return graph subgraphs, node detail, document detail, and evidence detail in frontend-friendly JSON.

- [ ] **Step 5: Wire the router into `src/index.ts`**

Mount the router without changing existing `/api/rag/*` behavior.

### Task 4: Write integration handoff docs

**Files:**
- Create: `Doc/rust_server_knowledge_graph_api.md`
- Create: `Doc/frontend_knowledge_graph_api.md`

- [ ] **Step 1: Write the Rust gateway doc**

Describe internal Node routes, recommended Rust public routes, auth expectations, and payload mapping.

- [ ] **Step 2: Write the frontend doc**

Describe the frontend page flow, expected response shapes from Rust, rendering guidance, and query lifecycle.

### Task 5: Verify and close out

**Files:**
- Test: `src/server/knowledgeGraph.test.ts`
- Test: `src/server/ragDocuments.test.ts`

- [ ] **Step 1: Run targeted graph tests**

Run: `bun test src/server/knowledgeGraph.test.ts`
Expected: PASS

- [ ] **Step 2: Run adjacent RAG router tests**

Run: `bun test src/server/ragDocuments.test.ts`
Expected: PASS

- [ ] **Step 3: Run type-check**

Run: `bun x tsc --noEmit`
Expected: PASS
