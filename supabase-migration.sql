-- Run this in Supabase SQL Editor to fix the missing columns
-- Dashboard → SQL Editor → New query → paste → Run

-- Add done_at column to tasks (if not exists)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS done_at timestamptz;

-- Make sure all other columns exist too
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS rollover boolean NOT NULL DEFAULT false;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS subs jsonb NOT NULL DEFAULT '[]';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS due text DEFAULT '';

-- Refresh schema cache (important!)
NOTIFY pgrst, 'reload schema';
