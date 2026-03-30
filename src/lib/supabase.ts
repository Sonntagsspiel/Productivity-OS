import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
export const supabase = createClient(url, key)

export async function dbLoad(table: string) {
  const { data, error } = await supabase.from(table).select('*')
  if (error) { console.error('load', table, error); return null }
  return data
}

// Core upsert – always stringify JSON fields before sending
export async function dbUpsert(table: string, rows: any[]) {
  const safe = rows.map(r => {
    const out: any = { ...r }
    // Force JSON fields to be proper JSON strings for jsonb columns
    if (table === 'tasks') {
      out.subs = JSON.stringify(Array.isArray(r.subs) ? r.subs : [])
    }
    if (table === 'projects') {
      out.items = JSON.stringify(Array.isArray(r.items) ? r.items : [])
    }
    if (table === 'daily_summaries') {
      if (r.habits_snapshot) out.habits_snapshot = JSON.stringify(r.habits_snapshot)
      if (r.tasks_snapshot) out.tasks_snapshot = JSON.stringify(r.tasks_snapshot)
    }
    return out
  })
  const { error } = await supabase.from(table).upsert(safe, { onConflict: 'id' })
  if (error) {
    console.error('upsert error', table, error)
    throw error
  }
}

export async function dbDelete(table: string, id: string) {
  const { error } = await supabase.from(table).delete().eq('id', id)
  if (error) console.error('delete', table, error)
}

export async function saveDailySummary(
  date: string, lifeScore: number, habitScore: number, taskScore: number,
  habitsSnapshot: any[], tasksSnapshot: any[]
) {
  const { error } = await supabase.from('daily_summaries').upsert({
    date,
    life_score: lifeScore,
    habit_score: habitScore,
    task_score: taskScore,
    habits_snapshot: JSON.stringify(habitsSnapshot),
    tasks_snapshot: JSON.stringify(tasksSnapshot),
  }, { onConflict: 'date' })
  if (error) console.error('summary error', error)
}

export async function loadHistory(): Promise<{ date: string; life_score: number; habit_score: number; task_score: number }[]> {
  const { data, error } = await supabase
    .from('daily_summaries')
    .select('date, life_score, habit_score, task_score')
    .order('date', { ascending: true })
    .limit(365)
  if (error) { console.error('loadHistory', error); return [] }
  return data || []
}

export async function deleteOldCompletedTasks() {
  const cutoff = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  const { error } = await supabase
    .from('tasks')
    .delete()
    .eq('done', true)
    .lt('done_at', cutoff)
  if (error) console.error('deleteOld', error)
}
