-- LeadLion — Supabase schema
-- Run this once in your Supabase project: SQL Editor → New query → paste → Run.

create table if not exists public.leads (
  id text primary key,              -- Google place id
  status text not null default 'new',
  notes text default '',
  data jsonb not null,              -- full lead snapshot (scores, findings, contact info)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists leads_touch on public.leads;
create trigger leads_touch before update on public.leads
  for each row execute function public.touch_updated_at();

-- Single-user setup: RLS on with an anon policy, so only people holding your
-- anon key (i.e. you, via the app) can touch rows. If you later add Supabase
-- Auth, replace this policy with per-user checks on auth.uid().
alter table public.leads enable row level security;

drop policy if exists "leadlion anon access" on public.leads;
create policy "leadlion anon access" on public.leads
  for all using (true) with check (true);
