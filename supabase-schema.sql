-- Run this once in your Supabase SQL editor
-- Dashboard → SQL Editor → New query → paste → Run

create table if not exists habits (
  id text primary key,
  name text not null,
  color text not null default 'green',
  type text not null default 'binary',
  active_days integer[] not null default '{0,1,2,3,4,5,6}',
  done boolean not null default false,
  pct integer not null default 0,
  target numeric,
  unit text,
  current_val numeric default 0,
  created_at timestamptz default now()
);

create table if not exists tasks (
  id text primary key,
  title text not null,
  prio text not null default 'med',
  rollover boolean not null default false,
  done boolean not null default false,
  subs jsonb not null default '[]',
  due text default '',
  created_at timestamptz default now()
);

create table if not exists projects (
  id text primary key,
  name text not null,
  color text not null default 'blue',
  deadline text default '',
  status text not null default 'on-track',
  items jsonb not null default '[]',
  created_at timestamptz default now()
);

create table if not exists daily_summaries (
  id uuid primary key default gen_random_uuid(),
  date date not null unique,
  life_score integer not null default 0,
  habit_score integer not null default 0,
  task_score integer not null default 0,
  created_at timestamptz default now()
);

-- Disable RLS for personal use (single user)
-- If you want auth later, enable RLS and add policies
alter table habits disable row level security;
alter table tasks disable row level security;
alter table projects disable row level security;
alter table daily_summaries disable row level security;
