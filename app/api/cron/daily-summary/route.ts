import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// Use service role key for server-side full access
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const PW: Record<string, number> = { high: 3, med: 2, low: 1 }

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function getTodayDow() {
  return (new Date().getDay() + 6) % 7 // 0=Mo ... 6=So
}

function dueDiff(due: string): number | null {
  if (!due) return null
  const n = new Date(); n.setHours(0, 0, 0, 0)
  const d = new Date(due); d.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - n.getTime()) / 864e5)
}

export async function GET(req: NextRequest) {
  // Verify this is called by Vercel Cron (not a random visitor)
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const today = todayStr()
    const todayDow = getTodayDow()

    // Check if we already saved today
    const { data: existing } = await supabase
      .from('daily_summaries')
      .select('date')
      .eq('date', today)
      .single()

    if (existing) {
      return NextResponse.json({ message: `Already saved for ${today}`, skipped: true })
    }

    // Load habits and tasks
    const [{ data: habits }, { data: tasks }] = await Promise.all([
      supabase.from('habits').select('*'),
      supabase.from('tasks').select('*'),
    ])

    if (!habits || !tasks) {
      return NextResponse.json({ error: 'Failed to load data' }, { status: 500 })
    }

    // ── Calculate Habit Score ────────────────────────────
    const todayHabits = habits.filter((h: any) => {
      const days = Array.isArray(h.active_days) ? h.active_days : [0,1,2,3,4,5,6]
      return days.includes(todayDow)
    })
    const hScore = todayHabits.length
      ? Math.round(todayHabits.reduce((a: number, h: any) => a + (h.pct || 0), 0) / todayHabits.length)
      : 0

    // ── Calculate Task Score ─────────────────────────────
    // Active today = no due date OR due today or overdue
    const isActiveToday = (t: any) => {
      if (!t.due) return true
      const diff = dueDiff(t.due)
      return diff !== null && diff <= 0
    }
    const activeTasks = tasks.filter(isActiveToday)
    const doneToday = activeTasks.filter((t: any) =>
      t.done && t.done_at && t.done_at.substring(0, 10) === today
    )
    const notDone = activeTasks.filter((t: any) => !t.done)
    const denominator = [...doneToday, ...notDone]
    const maxP = denominator.reduce((a: number, t: any) => a + (PW[t.prio] || 1), 0)
    const earnP = doneToday.reduce((a: number, t: any) => a + (PW[t.prio] || 1), 0)
    const tScore = maxP > 0 ? Math.min(100, Math.round((earnP / maxP) * 100)) : 0

    // ── Life Score ───────────────────────────────────────
    const lifeScore = Math.round((hScore + tScore) / 2)

    // ── Save to daily_summaries ──────────────────────────
    const { error } = await supabase.from('daily_summaries').upsert({
      date: today,
      life_score: lifeScore,
      habit_score: hScore,
      task_score: tScore,
      habits_snapshot: habits,
      tasks_snapshot: tasks.filter((t: any) => t.done && t.done_at?.startsWith(today)),
    }, { onConflict: 'date' })

    if (error) {
      console.error('Save error:', error)
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    console.log(`✅ Daily summary saved: ${today} | Life: ${lifeScore}% | Habits: ${hScore}% | Tasks: ${tScore}%`)

    return NextResponse.json({
      success: true,
      date: today,
      life_score: lifeScore,
      habit_score: hScore,
      task_score: tScore,
      habits_counted: todayHabits.length,
      tasks_active: activeTasks.length,
      tasks_done_today: doneToday.length,
    })

  } catch (err: any) {
    console.error('Cron error:', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
