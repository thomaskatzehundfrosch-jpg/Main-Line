-- ============================================================
-- Chess Repertoire — Supabase Schema
-- Run this in the Supabase SQL Editor for your project:
-- https://supabase.com/dashboard → SQL Editor → New query
-- ============================================================

-- ── Repertoire Files ─────────────────────────────────────────

create table if not exists public.repertoire_files (
  id           text        not null,
  user_id      uuid        not null references auth.users(id) on delete cascade,
  name         text        not null,
  tree         jsonb       not null default '{}',
  node_count   integer     not null default 0,
  imported_games jsonb,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (id, user_id)
);

alter table public.repertoire_files enable row level security;

create policy "Users manage their own repertoire files"
  on public.repertoire_files
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Spaced Repetition Cards ───────────────────────────────────

create table if not exists public.sr_cards (
  id       text  not null,
  user_id  uuid  not null references auth.users(id) on delete cascade,
  data     jsonb not null,
  primary key (id, user_id)
);

alter table public.sr_cards enable row level security;

create policy "Users manage their own SR cards"
  on public.sr_cards
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- ── Spaced Repetition Lifetime Stats ─────────────────────────

create table if not exists public.sr_stats (
  user_id         uuid    not null references auth.users(id) on delete cascade,
  total_reviewed  integer not null default 0,
  total_correct   integer not null default 0,
  primary key (user_id)
);

alter table public.sr_stats enable row level security;

create policy "Users manage their own SR stats"
  on public.sr_stats
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);
