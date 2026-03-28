import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(url, key)

// ── Generic helpers ──────────────────────────────────────

export async function dbLoad(table: string) {
  const { data, error } = await supabase.from(table).select('*')
  if (error) { console.error('load', table, error); return null }
  return data
}

export async function dbUpsert(table: string, rows: any[]) {
  const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' })
  if (error) console.error('upsert', table, error)
}

export async function dbDelete(table: string, id: string) {
  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) console.error('delete', table, error)
}

export async function saveSummary(date: string, lifeScore: number, habitScore: number, taskScore: number) {
  const { error } = await supabase.from('daily_summaries').upsert(
    { date, life_score: lifeScore, habit_score: habitScore, task_score: taskScore },
    { onConflict: 'date' }
  )
  if (error) console.error('summary', error)
}

export async function loadHistory(): Promise<number[]> {
  const { data } = await supabase
    .from('daily_summaries')
    .select('life_score')
    .order('date', { ascending: true })
    .limit(365)
  return (data || []).map((r: any) => r.life_score)
}
