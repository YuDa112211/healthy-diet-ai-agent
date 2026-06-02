-- Patch: switch to local markdown storage mode
-- Use this if you've already applied M1 tables.

alter table if exists public.knowledge_documents
  add column if not exists parsed_md_path text,
  add column if not exists parse_method text,
  add column if not exists parsed_char_count integer;

alter table if exists public.knowledge_ingestion_jobs
  add column if not exists parsed_md_path text,
  add column if not exists parse_method text;

create index if not exists idx_knowledge_documents_parsed_md_path
  on public.knowledge_documents(parsed_md_path);

create index if not exists idx_knowledge_ingestion_jobs_parsed_md_path
  on public.knowledge_ingestion_jobs(parsed_md_path);

-- Optional: clear heavy extracted_text payloads to save DB storage.
-- Uncomment if needed.
-- update public.knowledge_ingestion_jobs
-- set extracted_text = null
-- where extracted_text is not null;
