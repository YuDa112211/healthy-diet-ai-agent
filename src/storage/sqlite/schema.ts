export const SQLITE_BOOTSTRAP_SQL = `
create table if not exists users (
  id text primary key,
  nickname text,
  avatar_url text,
  height real,
  weight real,
  age real,
  gender text,
  taboo text,
  disease text,
  created_at text not null default (current_timestamp),
  updated_at text not null default (current_timestamp)
);

create table if not exists chat_rooms (
  room_id text not null,
  user_id text not null default '',
  title text,
  summary text,
  updated_at text,
  last_message_at text,
  primary key (room_id, user_id)
);

create table if not exists diet_chat_history (
  id text primary key,
  room_id text not null,
  user_id text,
  title text,
  user_message text,
  ai_analysis_report text,
  image_path text,
  summary text,
  diet_report text,
  record_type text not null default 'chat',
  created_at text not null default (current_timestamp)
);

create table if not exists knowledge_documents (
  id text primary key,
  title text not null,
  source_type text not null,
  file_name text not null,
  file_ext text not null,
  mime_type text,
  file_size_bytes integer not null,
  file_hash text not null unique,
  storage_path text not null,
  uploaded_by text not null,
  uploader_role text not null,
  tags text,
  status text not null,
  created_at text not null,
  updated_at text not null,
  parsed_md_path text,
  parse_method text,
  parsed_char_count integer,
  embedding_model text,
  error_message text
);

create table if not exists knowledge_ingestion_jobs (
  id text primary key,
  document_id text not null,
  status text not null,
  extractor text,
  parse_method text,
  parsed_md_path text,
  extracted_char_count integer,
  extracted_text_excerpt text,
  error_message text,
  started_at text,
  finished_at text,
  created_at text not null,
  updated_at text not null
);
`;
