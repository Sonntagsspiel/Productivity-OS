import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

// GET /api/cron/backfill
// Fills in all missing days of the current year with score 0
// so the heatmap shows every day (dark = no data / 0%, green = high score)
// Call this once manually after deploying
export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const today = new Date()
    today.setHours(0, 0, 0, 0)
    const year = today.getFullYear()
    const startOfYear = new Date(year, 0, 1)

    // Load existing summaries
    const { data: existing } = await supabase
      .from('daily_summaries')
      .select('date')
      .gte('date', `${year}-01-01`)
      .lte('date', today.toISOString().split('T')[0])

    const existingDates = new Set((existing || []).map((r: any) => r.date))

    // Build list of missing days
    const missing: string[] = []
    const cursor = new Date(startOfYear)
    while (cursor < today) {
      const ds = cursor.toISOString().split('T')[0]
      if (!existingDates.has(ds)) missing.push(ds)
      cursor.setDate(cursor.getDate() + 1)
    }

    if (missing.length === 0) {
      return NextResponse.json({ message: 'No missing days', filled: 0 })
    }

    // Insert missing days with score 0 (they show as dark on heatmap = no data)
    const rows = missing.map(date => ({
      date,
      life_score: 0,
      habit_score: 0,
      task_score: 0,
      habits_snapshot: [],
      tasks_snapshot: [],
    }))

    // Insert in batches of 50
    let filled = 0
    for (let i = 0; i < rows.length; i += 50) {
      const batch = rows.slice(i, i + 50)
      const { error } = await supabase
        .from('daily_summaries')
        .upsert(batch, { onConflict: 'date' })
      if (!error) filled += batch.length
    }

    return NextResponse.json({
      success: true,
      filled,
      total_missing: missing.length,
      first: missing[0],
      last: missing[missing.length - 1],
    })

  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
