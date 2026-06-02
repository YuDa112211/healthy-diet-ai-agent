-- M1: Knowledge ingestion foundation tables
-- Run this in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  source_type text not null default 'manual_upload',
  file_name text not null,
  file_ext text not null,
  mime_type text,
  file_size_bytes bigint not null,
  file_hash text not null unique,
  storage_path text not null,
  uploaded_by text not null,
  uploader_role text not null check (uploader_role in ('admin', 'nutritionist')),
  tags jsonb not null default '[]'::jsonb,
  status text not null default 'uploaded' check (status in ('uploaded', 'ingested', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_knowledge_documents_status on public.knowledge_documents(status);
create index if not exists idx_knowledge_documents_created_at on public.knowledge_documents(created_at desc);

create table if not exists public.knowledge_ingestion_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.knowledge_documents(id) on delete cascade,
  status text not null check (status in ('processing', 'success', 'failed')),
  extractor text not null,
  extracted_char_count integer,
  extracted_text text,
  extracted_text_excerpt text,
  error_message text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_knowledge_ingestion_jobs_document_id on public.knowledge_ingestion_jobs(document_id);
create index if not exists idx_knowledge_ingestion_jobs_status on public.knowledge_ingestion_jobs(status);
create index if not exists idx_knowledge_ingestion_jobs_created_at on public.knowledge_ingestion_jobs(created_at desc);
