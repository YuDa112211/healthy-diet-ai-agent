-- 1) Add a dedicated summary column (safe to run multiple times)
alter table public.diet_chat_history
add column if not exists summary text;

-- 2) (Optional) Add a timestamp for summary updates only
alter table public.diet_chat_history
add column if not exists summary_updated_at timestamptz;

-- 3) (Optional) Create an index if you often query records with summaries
create index if not exists idx_diet_chat_history_summary_not_null
on public.diet_chat_history (created_at desc)
where summary is not null;
