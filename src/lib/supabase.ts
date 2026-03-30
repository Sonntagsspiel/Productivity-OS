import { createClient } from '@supabase/supabase-js'

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
export const supabase = createClient(url, key)

export async function dbLoad(table: string) {
  const { data, error } = await supabase.from(table).select('*')
  if (error) { console.error('load', table, error); return null }
  return data
}

// supabase-js handles jsonb columns natively as JS arrays/objects.
// DO NOT JSON.stringify – passing a string to a jsonb column breaks upsert silently.
export async function dbUpsert(table: string, rows: any[]) {
  const { error } = await supabase.from(table).upsert(rows, { onConflict: 'id' })
  if (error) console.error('upsert error', table, error)
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
    habits_snapshot: habitsSnapshot,   // native array, not stringified
    tasks_snapshot: tasksSnapshot,     // native array, not stringified
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
