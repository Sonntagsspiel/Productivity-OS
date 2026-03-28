'use client'
import { useState, useEffect, useCallback } from 'react'
import { supabase, dbLoad, dbUpsert, dbDelete, saveSummary, loadHistory } from '@/lib/supabase'

// ── Types ────────────────────────────────────────────────
type Priority = 'high' | 'med' | 'low'
type HabitType = 'binary' | 'metric'
type ProjectStatus = 'on-track' | 'at-risk' | 'done' | 'paused'
type BrandColor = 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'teal'
type SortMode = 'prio' | 'due' | 'alpha'

interface Sub { t: string; d: boolean }
interface Habit { id: string; name: string; color: BrandColor; type: HabitType; active_days: number[]; done: boolean; pct: number; target?: number; unit?: string; current_val?: number }
interface Task { id: string; title: string; prio: Priority; rollover: boolean; done: boolean; subs: Sub[]; due: string; showSub?: boolean }
interface ProjItem { t: string; d: boolean; subs: Sub[] }
interface Project { id: string; name: string; color: BrandColor; deadline: string; status: ProjectStatus; items: ProjItem[] }

// ── Constants ────────────────────────────────────────────
const COLORS: Record<BrandColor, string> = { green: '#00e87a', blue: '#3d7fff', purple: '#9b6dff', amber: '#ffb830', red: '#ff4d6a', teal: '#00d4c8' }
const CNAMES = Object.keys(COLORS) as BrandColor[]
const DSHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const PW: Record<Priority, number> = { high: 3, med: 2, low: 1 }
const QUOTES = [
  ['Disziplin schlägt Motivation jeden Tag.', 'Zeig heute, wer du wirklich bist.'],
  ['Kleine Schritte. Großes Leben.', 'Jede Task ist ein Versprechen, das du dir hältst.'],
  ['Du bist nicht derselbe wie gestern.', 'Wachstum passiert still – aber es passiert.'],
  ['Perfektion ist der Feind des Fortschritts.', 'Erledigt schlägt perfekt.'],
  ['Fokus ist deine stärkste Währung.', 'Investiere sie weise.'],
]
const TODAY_DOW = (new Date().getDay() + 6) % 7
const STATUS_LABELS: Record<ProjectStatus, string> = { 'on-track': 'On Track', 'at-risk': 'At Risk', 'done': 'Fertig', 'paused': 'Pausiert' }
const STATUS_COLORS: Record<ProjectStatus, string> = { 'on-track': 'var(--green)', 'at-risk': 'var(--amber)', 'done': 'var(--blue)', 'paused': 'var(--tx3)' }

function dueDiff(due: string): number | null {
  if (!due) return null
  const n = new Date(); n.setHours(0, 0, 0, 0)
  const d = new Date(due); d.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - n.getTime()) / 864e5)
}

function scoreColor(s: number) {
  if (!s) return '#090c12'
  return `rgb(${Math.round(5 + (s / 100) * 17)},${Math.round(30 + (s / 100) * 202)},${Math.round(20 + (s / 100) * 74)})`
}

// ── Default data ─────────────────────────────────────────
const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0]
const DEFAULT_HABITS: Habit[] = [
  { id: 'h1', name: 'Meditation', color: 'green', type: 'binary', active_days: [0,1,2,3,4,5,6], done: false, pct: 0 },
  { id: 'h2', name: 'Wasser trinken', color: 'blue', type: 'metric', active_days: [0,1,2,3,4,5,6], done: false, pct: 0, target: 2, unit: 'L', current_val: 0 },
  { id: 'h3', name: 'Sport', color: 'teal', type: 'binary', active_days: [0,2,4], done: false, pct: 0 },
  { id: 'h4', name: 'Journaling', color: 'amber', type: 'binary', active_days: [0,1,2,3,4,5,6], done: false, pct: 0 },
]
const DEFAULT_TASKS: Task[] = [
  { id: 't1', title: 'Q4 Report finalisieren', prio: 'high', rollover: true, done: false, subs: [{ t: 'Executive Summary', d: false }, { t: 'Charts prüfen', d: false }], due: '2025-03-20' },
  { id: 't2', title: 'Team Meeting vorbereiten', prio: 'high', rollover: false, done: false, subs: [], due: tomorrow },
  { id: 't3', title: 'Inbox auf null', prio: 'med', rollover: false, done: false, subs: [], due: '' },
  { id: 't4', title: 'Side-Project Roadmap', prio: 'med', rollover: false, done: false, subs: [{ t: 'Features', d: false }], due: '' },
  { id: 't5', title: 'Groceries updaten', prio: 'low', rollover: false, done: false, subs: [], due: '' },
]
const DEFAULT_PROJECTS: Project[] = [
  { id: 'p1', name: 'Website Relaunch', color: 'blue', deadline: 'Q1 2026', status: 'on-track', items: [{ t: 'Design Mockups', d: true, subs: [{ t: 'Homepage', d: true }, { t: 'Blog', d: false }] }, { t: 'Frontend', d: false, subs: [] }, { t: 'Launch', d: false, subs: [] }] },
  { id: 'p2', name: 'App MVP', color: 'purple', deadline: 'Q2 2026', status: 'on-track', items: [{ t: 'Auth System', d: true, subs: [] }, { t: 'Dashboard UI', d: true, subs: [] }, { t: 'API', d: false, subs: [] }] },
]

// ── Main App ─────────────────────────────────────────────
export default function App() {
  const [habits, setHabits] = useState<Habit[]>(DEFAULT_HABITS)
  const [tasks, setTasks] = useState<Task[]>(DEFAULT_TASKS)
  const [projects, setProjects] = useState<Project[]>(DEFAULT_PROJECTS)
  const [history, setHistory] = useState<number[]>([])
  const [streak, setStreak] = useState(0)
  const [dayLocked, setDayLocked] = useState(false)
  const [loading, setLoading] = useState(true)
  const [taskSort, setTaskSort] = useState<SortMode>('prio')
  const [modal, setModal] = useState<{ open: boolean; type: 'task'|'habit'|'project'; editId?: string } | null>(null)
  const [endDayOpen, setEndDayOpen] = useState(false)
  const [showSubs, setShowSubs] = useState<Record<string, boolean>>({})

  // Load from Supabase
  useEffect(() => {
    async function load() {
      try {
        const [h, t, p, hist] = await Promise.all([
          dbLoad('habits'), dbLoad('tasks'), dbLoad('projects'), loadHistory()
        ])
        if (h?.length) setHabits(h.map((r: any) => ({ ...r, active_days: r.active_days || [0,1,2,3,4,5,6], current_val: r.current_val || 0 })))
        if (t?.length) setTasks(t.map((r: any) => ({ ...r, subs: r.subs || [], due: r.due || '' })))
        if (p?.length) setProjects(p.map((r: any) => ({ ...r, items: r.items || [] })))
        if (hist?.length) setHistory(hist)

        // Check if today is locked
        const today = new Date().toISOString().split('T')[0]
        const { data } = await supabase.from('daily_summaries').select('date').eq('date', today).single()
        if (data) setDayLocked(true)

        // Streak
        if (hist.length > 0) {
          let s = 0
          for (let i = hist.length - 1; i >= 0; i--) { if (hist[i] >= 50) s++; else break }
          setStreak(s)
        }
      } catch (e) {
        console.error('Load error:', e)
      } finally {
        setLoading(false)
      }
    }
    load()
  }, [])

  // Scores
  const calcScores = useCallback(() => {
    const todayH = habits.filter(h => h.active_days.includes(TODAY_DOW))
    const hScore = todayH.length ? Math.round(todayH.reduce((a, h) => a + h.pct, 0) / todayH.length) : 0
    const maxP = tasks.reduce((a, t) => a + PW[t.prio], 0)
    const earnP = tasks.filter(t => t.done).reduce((a, t) => a + PW[t.prio], 0)
    const tScore = maxP ? Math.round((earnP / maxP) * 100) : 0
    return { hScore, tScore, life: Math.round((hScore + tScore) / 2) }
  }, [habits, tasks])

  const { hScore, tScore, life } = calcScores()
  const quote = QUOTES[Math.floor(Date.now() / 86400000) % QUOTES.length]
  const avg7 = history.length ? Math.round(history.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, history.slice(-7).length)) : life
  const avg30 = history.length ? Math.round(history.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, history.slice(-30).length)) : life
  const delta = life - avg30

  // Habit actions
  async function toggleHabit(id: string) {
    if (dayLocked) return
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h
      const done = !h.done
      const updated = { ...h, done, pct: done ? 100 : 0 }
      dbUpsert('habits', [{ id: updated.id, name: updated.name, color: updated.color, type: updated.type, active_days: updated.active_days, done: updated.done, pct: updated.pct, target: updated.target, unit: updated.unit, current_val: updated.current_val }])
      return updated
    }))
  }

  async function updateMetric(id: string, val: number) {
    if (dayLocked) return
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h
      const pct = h.target ? Math.min(100, Math.round((val / h.target) * 100)) : 0
      const updated = { ...h, current_val: val, pct }
      dbUpsert('habits', [{ id: updated.id, name: updated.name, color: updated.color, type: updated.type, active_days: updated.active_days, done: updated.done, pct: updated.pct, target: updated.target, unit: updated.unit, current_val: updated.current_val }])
      return updated
    }))
  }

  // Task actions
  async function completeTask(id: string) {
    if (dayLocked) return
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t
      const updated = { ...t, done: true }
      dbUpsert('tasks', [{ id: updated.id, title: updated.title, prio: updated.prio, rollover: updated.rollover, done: true, subs: updated.subs, due: updated.due }])
      return updated
    }))
  }

  function toggleSubTask(taskId: string, si: number) {
    if (dayLocked) return
    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t
      const subs = t.subs.map((s, i) => i === si ? { ...s, d: !s.d } : s)
      const updated = { ...t, subs }
      dbUpsert('tasks', [{ id: updated.id, title: updated.title, prio: updated.prio, rollover: updated.rollover, done: updated.done, subs: updated.subs, due: updated.due }])
      return updated
    }))
  }

  // Project actions
  function toggleProjItem(pid: string, ii: number) {
    if (dayLocked) return
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p
      const items = p.items.map((item, i) => i === ii ? { ...item, d: !item.d } : item)
      const updated = { ...p, items }
      dbUpsert('projects', [{ id: updated.id, name: updated.name, color: updated.color, deadline: updated.deadline, status: updated.status, items: updated.items }])
      return updated
    }))
  }

  function toggleProjSub(pid: string, ii: number, si: number) {
    if (dayLocked) return
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p
      const items = p.items.map((item, i) => {
        if (i !== ii) return item
        const subs = item.subs.map((s, j) => j === si ? { ...s, d: !s.d } : s)
        return { ...item, subs }
      })
      const updated = { ...p, items }
      dbUpsert('projects', [{ id: updated.id, name: updated.name, color: updated.color, deadline: updated.deadline, status: updated.status, items: updated.items }])
      return updated
    }))
  }

  function updateProjStatus(pid: string, status: ProjectStatus) {
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p
      const updated = { ...p, status }
      dbUpsert('projects', [{ id: updated.id, name: updated.name, color: updated.color, deadline: updated.deadline, status: updated.status, items: updated.items }])
      return updated
    }))
  }

  // End day
  async function confirmEndDay() {
    const { hScore, tScore, life } = calcScores()
    const today = new Date().toISOString().split('T')[0]
    await saveSummary(today, life, hScore, tScore)
    setHistory(prev => [...prev, life].slice(-365))
    setStreak(prev => life >= 50 ? prev + 1 : 0)
    setDayLocked(true)
    setEndDayOpen(false)
  }

  // Sorted tasks
  const sortedTasks = [...tasks].filter(t => !t.done).sort((a, b) => {
    const aO = a.rollover || (!!a.due && (dueDiff(a.due) ?? 0) < 0)
    const bO = b.rollover || (!!b.due && (dueDiff(b.due) ?? 0) < 0)
    if (aO && !bO) return -1; if (!aO && bO) return 1
    if (taskSort === 'prio') return PW[b.prio] - PW[a.prio]
    if (taskSort === 'due') { if (!a.due && !b.due) return 0; if (!a.due) return 1; if (!b.due) return -1; return new Date(a.due).getTime() - new Date(b.due).getTime() }
    return a.title.localeCompare(b.title)
  })

  const hr = new Date().getHours()
  const greeting = hr < 12 ? 'Guten Morgen.' : hr < 17 ? 'Guten Tag.' : 'Guten Abend.'
  const dateStr = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)', color: 'var(--tx3)', fontFamily: 'var(--mono)', fontSize: 13 }}>
      Verbinde mit Supabase…
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', position: 'relative', overflowX: 'hidden' }}>
      {/* Background */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: 'var(--blue)', filter: 'blur(80px)', opacity: .11, top: -100, right: -100 }} />
        <div style={{ position: 'absolute', width: 400, height: 400, borderRadius: '50%', background: 'var(--purple)', filter: 'blur(80px)', opacity: .11, bottom: 100, left: -150 }} />
        <div style={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%', background: 'var(--green)', filter: 'blur(80px)', opacity: .09, top: '40%', right: '20%' }} />
      </div>

      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '24px 20px 80px', position: 'relative', zIndex: 1 }}>

        {/* Motive bar */}
        <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 18, border: '1px solid rgba(61,127,255,.25)', background: 'linear-gradient(135deg,rgba(61,127,255,.15),rgba(155,109,255,.1))', padding: '18px 24px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg,transparent,rgba(61,127,255,.05),transparent)', animation: 'shimmer 3s infinite' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.3px' }}>{quote[0]}</div>
            <div style={{ fontSize: 12, color: 'var(--tx2)', marginTop: 3 }}>{quote[1]}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, position: 'relative' }}>
            {[{ val: streak + 'd', lbl: 'Streak' }, { val: avg7 + '%', lbl: '7d Avg' }, { val: (delta >= 0 ? '+' : '') + delta + '%', lbl: 'vs Monat' }].map(s => (
              <div key={s.lbl} style={{ textAlign: 'center' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500, color: 'var(--green)' }}>{s.val}</div>
                <div style={{ fontSize: 10, color: 'var(--tx3)', textTransform: 'uppercase', letterSpacing: 1 }}>{s.lbl}</div>
              </div>
            ))}
            <span style={{ fontSize: 24, animation: 'flicker 1.5s infinite alternate' }}>🔥</span>
          </div>
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid var(--bd)' }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -1, background: 'linear-gradient(135deg,var(--tx),var(--tx2))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{greeting}</h1>
            <div style={{ fontSize: 12, color: 'var(--tx3)', marginTop: 4, fontFamily: 'var(--mono)' }}>{dateStr}</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            {/* Dual Ring */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ position: 'relative', width: 110, height: 110, cursor: 'pointer' }} onClick={() => setEndDayOpen(true)}>
                <svg width="110" height="110" viewBox="0 0 110 110" style={{ position: 'absolute', inset: 0 }}>
                  <circle cx="55" cy="55" r="46" fill="none" stroke="rgba(0,232,122,.08)" strokeWidth="7" />
                  <circle cx="55" cy="55" r="46" fill="none" stroke="var(--green)" strokeWidth="7" strokeLinecap="round"
                    strokeDasharray="289" strokeDashoffset={289 - (hScore / 100) * 289} transform="rotate(-90 55 55)"
                    style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.34,1.4,.64,1)' }} />
                  <circle cx="55" cy="55" r="33" fill="none" stroke="rgba(61,127,255,.08)" strokeWidth="7" />
                  <circle cx="55" cy="55" r="33" fill="none" stroke="var(--blue)" strokeWidth="7" strokeLinecap="round"
                    strokeDasharray="207" strokeDashoffset={207 - (tScore / 100) * 207} transform="rotate(-90 55 55)"
                    style={{ transition: 'stroke-dashoffset 1.2s cubic-bezier(.34,1.4,.64,1) .1s' }} />
                </svg>
                <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
                  <span style={{ display: 'block', fontFamily: 'var(--mono)', fontSize: 18, fontWeight: 500 }}>{life}</span>
                  <span style={{ display: 'block', fontSize: 8, color: 'var(--tx3)', textTransform: 'uppercase', letterSpacing: 1.5 }}>life</span>
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {[{ c: 'var(--green)', l: 'H', v: hScore }, { c: 'var(--blue)', l: 'T', v: tScore }].map(r => (
                  <div key={r.l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'var(--mono)' }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: r.c }} />
                    <span style={{ color: 'var(--tx2)' }}>{r.l} <span style={{ color: 'var(--tx)' }}>{r.v}%</span></span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn onClick={() => !dayLocked && setModal({ open: true, type: 'task' })} disabled={dayLocked}>
                <PlusIcon /> Hinzufügen
              </Btn>
              <button onClick={() => setEndDayOpen(true)} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 18px', background: 'linear-gradient(135deg,rgba(255,77,106,.15),rgba(155,109,255,.1))', border: '1px solid rgba(255,77,106,.3)', borderRadius: 10, color: 'var(--tx)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                ⏱ Tag beenden
              </button>
            </div>
          </div>
        </div>

        {/* Main grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {/* Habits */}
          <Section title="Habits" score={hScore} scoreColor="var(--green)" locked={dayLocked}>
            {habits.filter(h => h.active_days.includes(TODAY_DOW)).length === 0
              ? <Empty>Keine Habits für heute</Empty>
              : habits.filter(h => h.active_days.includes(TODAY_DOW)).map(h => {
                  const c = COLORS[h.color]
                  const pct = h.type === 'metric' && h.target ? Math.min(100, Math.round(((h.current_val || 0) / h.target) * 100)) : h.pct
                  return (
                    <div key={h.id} style={{ background: 'var(--bg3)', border: '1px solid var(--bd)', borderRadius: 12, padding: 14, marginBottom: 8, animation: 'fadeIn .3s ease' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 9, fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0 }}>
                          <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 8px ${c}`, flexShrink: 0 }} />
                          <div style={{ minWidth: 0 }}>
                            <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{h.name}</div>
                            <div style={{ fontSize: 9, color: 'var(--tx3)', fontFamily: 'var(--mono)' }}>{h.active_days.length === 7 ? 'täglich' : h.active_days.map(d => DSHORT[d]).join(', ')}</div>
                          </div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: pct >= 100 ? 'var(--green)' : 'var(--tx2)' }}>{pct}%</span>
                          <EditBtn onClick={() => !dayLocked && setModal({ open: true, type: 'habit', editId: h.id })} />
                          {h.type === 'binary' && (
                            <Checkbox checked={h.done} onChange={() => toggleHabit(h.id)} />
                          )}
                        </div>
                      </div>
                      <div style={{ height: 5, background: 'var(--bg5)', borderRadius: 3, marginTop: 10, overflow: 'hidden', cursor: h.type === 'binary' ? 'pointer' : 'default' }} onClick={() => h.type === 'binary' && toggleHabit(h.id)}>
                        <div style={{ height: '100%', borderRadius: 3, background: c, width: `${pct}%`, transition: 'width .4s cubic-bezier(.34,1.2,.64,1)' }} />
                      </div>
                      {h.type === 'metric' && (
                        <div style={{ marginTop: 10, background: 'var(--bg4)', border: '1px solid var(--bd2)', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10 }}>
                          <input type="number" min={0} max={(h.target || 1) * 2} step={0.1} value={h.current_val || 0} disabled={dayLocked}
                            onChange={e => updateMetric(h.id, parseFloat(e.target.value) || 0)}
                            style={{ background: 'transparent', border: 'none', color: 'var(--tx)', fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 500, width: 55, textAlign: 'right', outline: 'none' }} />
                          <span style={{ fontSize: 11, color: 'var(--tx3)', flex: 1 }}>/ {h.target} {h.unit}</span>
                          <span style={{ fontFamily: 'var(--mono)', fontSize: 11, padding: '2px 7px', borderRadius: 5, background: 'var(--bg5)', color: pct >= 100 ? 'var(--green)' : pct >= 50 ? 'var(--amber)' : 'var(--tx2)' }}>{pct}%</span>
                        </div>
                      )}
                    </div>
                  )
                })
            }
          </Section>

          {/* Tasks */}
          <Section title="Tasks" score={tScore} scoreColor="var(--blue)" locked={dayLocked}>
            {/* Sort bar */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10, color: 'var(--tx3)', textTransform: 'uppercase', letterSpacing: 1 }}>Sort:</span>
              {(['prio', 'due', 'alpha'] as SortMode[]).map(s => (
                <button key={s} onClick={() => setTaskSort(s)} style={{ padding: '4px 10px', background: taskSort === s ? 'rgba(61,127,255,.12)' : 'var(--bg3)', border: `1px solid ${taskSort === s ? 'var(--blue)' : 'var(--bd)'}`, borderRadius: 6, fontSize: 10, fontWeight: 700, color: taskSort === s ? 'var(--blue)' : 'var(--tx3)', cursor: 'pointer', fontFamily: 'var(--mono)' }}>
                  {{ prio: 'Priorität', due: 'Fälligkeit', alpha: 'A–Z' }[s]}
                </button>
              ))}
            </div>
            {sortedTasks.length === 0 ? <Empty>Alle Tasks erledigt 🎉</Empty> : sortedTasks.map(t => {
              const isOver = t.rollover || (!!t.due && (dueDiff(t.due) ?? 0) < 0)
              const diff = dueDiff(t.due)
              const showSub = showSubs[t.id]
              return (
                <div key={t.id} style={{ background: isOver ? 'rgba(255,77,106,.06)' : 'var(--bg3)', border: `1px solid ${isOver ? 'rgba(255,77,106,.3)' : 'var(--bd)'}`, borderRadius: 10, padding: '13px 14px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 10, animation: 'fadeIn .3s ease' }}>
                  <Checkbox checked={false} onChange={() => completeTask(t.id)} style={{ marginTop: 2 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, flexWrap: 'wrap' }}>
                      <PrioBadge prio={t.prio} />
                      {isOver && <span style={{ fontSize: 10, color: 'var(--red)', fontFamily: 'var(--mono)' }}>⚠ überfällig</span>}
                      {t.due && diff !== null && (
                        <span style={{ fontSize: 10, fontFamily: 'var(--mono)', padding: '2px 7px', borderRadius: 4, border: '1px solid', color: diff < 0 ? 'var(--red)' : diff <= 3 ? 'var(--amber)' : 'var(--tx3)', borderColor: diff < 0 ? 'rgba(255,77,106,.25)' : diff <= 3 ? 'rgba(255,184,48,.25)' : 'var(--bd)', background: diff < 0 ? 'rgba(255,77,106,.06)' : diff <= 3 ? 'rgba(255,184,48,.06)' : 'transparent' }}>
                          📅 {diff < 0 ? `${Math.abs(diff)}d überfällig` : diff === 0 ? 'heute' : `in ${diff}d`}
                        </span>
                      )}
                      {t.subs.length > 0 && (
                        <button onClick={() => setShowSubs(p => ({ ...p, [t.id]: !showSub }))} style={{ fontSize: 10, color: 'var(--tx3)', padding: '2px 6px', background: 'var(--bg4)', borderRadius: 4, border: '1px solid var(--bd)', cursor: 'pointer' }}>
                          {showSub ? '▲' : '▼'} {t.subs.length}
                        </button>
                      )}
                    </div>
                    {showSub && t.subs.length > 0 && (
                      <div style={{ marginTop: 8, marginLeft: 30, borderLeft: '2px solid var(--bd)', paddingLeft: 10 }}>
                        {t.subs.map((s, si) => (
                          <div key={si} onClick={() => toggleSubTask(t.id, si)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', fontSize: 12, color: s.d ? 'var(--tx3)' : 'var(--tx2)', textDecoration: s.d ? 'line-through' : 'none', cursor: 'pointer' }}>
                            <div style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid', borderColor: s.d ? 'var(--green2)' : 'var(--bd2)', background: s.d ? 'var(--green2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 8, color: 'white' }}>{s.d ? '✓' : ''}</div>
                            {s.t}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <EditBtn onClick={() => !dayLocked && setModal({ open: true, type: 'task', editId: t.id })} />
                </div>
              )
            })}
          </Section>
        </div>

        {/* Projects */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 18, padding: 20, marginBottom: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: 'var(--tx2)' }}>Projekte</div>
            <Btn onClick={() => setModal({ open: true, type: 'project' })} small>+ Projekt</Btn>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            {projects.map(p => {
              const c = COLORS[p.color]
              const total = p.items.length; const done = p.items.filter(i => i.d).length
              const pct = total ? Math.round((done / total) * 100) : 0
              const circ = 2 * Math.PI * 22; const offset = circ - (pct / 100) * circ
              return (
                <div key={p.id} style={{ background: 'var(--bg3)', border: '1px solid var(--bd)', borderRadius: 12, padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
                      <div style={{ fontSize: 11, color: 'var(--tx3)', marginTop: 3, fontFamily: 'var(--mono)' }}>{p.deadline}</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
                      <div style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, fontFamily: 'var(--mono)', border: '1px solid', color: c, borderColor: c + '20', background: c + '12' }}>{pct}%</div>
                      <select value={p.status} onChange={e => updateProjStatus(p.id, e.target.value as ProjectStatus)}
                        style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, border: '1px solid var(--bd2)', background: 'var(--bg4)', fontFamily: 'var(--mono)', cursor: 'pointer', outline: 'none', color: STATUS_COLORS[p.status] }}>
                        {(Object.keys(STATUS_LABELS) as ProjectStatus[]).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
                      </select>
                      <button onClick={() => setModal({ open: true, type: 'project', editId: p.id })}
                        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '5px 10px', background: 'rgba(61,127,255,.08)', border: '1px solid rgba(61,127,255,.2)', borderRadius: 6, color: 'var(--blue)', cursor: 'pointer', fontSize: 10, fontWeight: 600, fontFamily: 'inherit' }}>
                        ✏ Bearbeiten
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--bd)' }}>
                    <div style={{ position: 'relative', flexShrink: 0 }}>
                      <svg width="52" height="52" viewBox="0 0 52 52">
                        <circle cx="26" cy="26" r="22" fill="none" stroke={c + '20'} strokeWidth="5" />
                        <circle cx="26" cy="26" r="22" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round"
                          strokeDasharray={circ} strokeDashoffset={offset} transform="rotate(-90 26 26)"
                          style={{ transition: 'stroke-dashoffset .8s' }} />
                      </svg>
                      <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', fontFamily: 'var(--mono)', fontSize: 10, fontWeight: 500, color: c }}>{pct}%</div>
                    </div>
                    <div style={{ flex: 1, fontSize: 11 }}>
                      {[['Erledigt', `${done}/${total}`], ['Sub-Items', p.items.reduce((a, i) => a + i.subs.length, 0)], ['Status', STATUS_LABELS[p.status]]].map(([k, v]) => (
                        <div key={k as string} style={{ display: 'flex', justifyContent: 'space-between', color: 'var(--tx2)', marginBottom: 3 }}>
                          <span>{k}</span><span style={{ fontFamily: 'var(--mono)', color: k === 'Status' ? STATUS_COLORS[p.status] : 'var(--tx)' }}>{v as string}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    {p.items.map((item, ii) => (
                      <div key={ii}>
                        <div onClick={() => toggleProjItem(p.id, ii)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', fontSize: 12, color: item.d ? 'var(--tx3)' : 'var(--tx2)', textDecoration: item.d ? 'line-through' : 'none', borderBottom: '1px solid var(--bd)', cursor: 'pointer' }}>
                          <div style={{ width: 14, height: 14, borderRadius: 3, border: '1px solid', borderColor: item.d ? 'var(--green2)' : 'var(--bd2)', background: item.d ? 'var(--green2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 8, color: 'white' }}>{item.d ? '✓' : ''}</div>
                          {item.t}
                        </div>
                        {item.subs.map((s, si) => (
                          <div key={si} onClick={() => toggleProjSub(p.id, ii, si)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 0 4px 20px', fontSize: 11, color: s.d ? 'var(--tx3)' : 'var(--tx3)', textDecoration: s.d ? 'line-through' : 'none', cursor: 'pointer' }}>
                            <div style={{ width: 11, height: 11, borderRadius: 2, border: '1px solid', borderColor: s.d ? 'var(--green2)' : 'var(--bd)', background: s.d ? 'var(--green2)' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 7, color: 'white' }}>{s.d ? '✓' : ''}</div>
                            {s.t}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        </div>

        {/* Analytics */}
        <Analytics history={history} />
      </div>

      {/* Modals */}
      {modal?.open && (
        <AddModal
          type={modal.type}
          editId={modal.editId}
          habits={habits} tasks={tasks} projects={projects}
          onClose={() => setModal(null)}
          onSaveHabit={async (h) => {
            if (modal.editId) { setHabits(p => p.map(x => x.id === modal.editId ? h : x)) }
            else { setHabits(p => [...p, h]) }
            await dbUpsert('habits', [{ id: h.id, name: h.name, color: h.color, type: h.type, active_days: h.active_days, done: h.done, pct: h.pct, target: h.target, unit: h.unit, current_val: h.current_val }])
            setModal(null)
          }}
          onSaveTask={async (t) => {
            if (modal.editId) { setTasks(p => p.map(x => x.id === modal.editId ? t : x)) }
            else { setTasks(p => [...p, t]) }
            await dbUpsert('tasks', [{ id: t.id, title: t.title, prio: t.prio, rollover: t.rollover, done: t.done, subs: t.subs, due: t.due }])
            setModal(null)
          }}
          onSaveProject={async (p) => {
            if (modal.editId) { setProjects(prev => prev.map(x => x.id === modal.editId ? p : x)) }
            else { setProjects(prev => [...prev, p]) }
            await dbUpsert('projects', [{ id: p.id, name: p.name, color: p.color, deadline: p.deadline, status: p.status, items: p.items }])
            setModal(null)
          }}
        />
      )}

      {endDayOpen && (
        <EndDayModal hScore={hScore} tScore={tScore} life={life} history={history} projects={projects}
          onClose={() => setEndDayOpen(false)} onConfirm={confirmEndDay} />
      )}
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────

function Section({ title, score, scoreColor, locked, children }: any) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 18, padding: 20, position: 'relative' }}>
      {locked && (
        <div style={{ position: 'absolute', inset: 0, background: 'rgba(9,12,18,.85)', borderRadius: 18, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, zIndex: 10 }}>
          <div style={{ fontSize: 28, opacity: .5 }}>🔒</div>
          <div style={{ fontSize: 11, color: 'var(--tx3)', textTransform: 'uppercase', letterSpacing: 1.5 }}>Tag abgeschlossen</div>
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: 'var(--tx2)' }}>{title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 80, height: 5, background: 'var(--bg4)', borderRadius: 3, overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: 3, background: scoreColor, width: `${score}%`, transition: 'width .8s cubic-bezier(.34,1.2,.64,1)' }} />
          </div>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 500, color: scoreColor, minWidth: 36, textAlign: 'right' }}>{score}%</span>
        </div>
      </div>
      {children}
    </div>
  )
}

function Checkbox({ checked, onChange, style }: any) {
  return (
    <div onClick={onChange} style={{ width: 20, height: 20, borderRadius: 5, border: `1.5px solid ${checked ? 'var(--green)' : 'var(--bd3)'}`, background: checked ? 'var(--green)' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: checked ? '0 0 12px rgba(0,232,122,.4)' : 'none', transition: 'all .2s', ...style }}>
      {checked && <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
    </div>
  )
}

function EditBtn({ onClick }: any) {
  return (
    <button onClick={onClick} style={{ width: 22, height: 22, borderRadius: 5, border: '1px solid var(--bd)', background: 'transparent', color: 'var(--tx3)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0, transition: 'all .15s' }}
      onMouseEnter={e => { (e.target as any).style.borderColor = 'var(--blue)'; (e.target as any).style.color = 'var(--blue)' }}
      onMouseLeave={e => { (e.target as any).style.borderColor = 'var(--bd)'; (e.target as any).style.color = 'var(--tx3)' }}>✏</button>
  )
}

function PrioBadge({ prio }: { prio: Priority }) {
  const styles: Record<Priority, any> = {
    high: { background: 'rgba(255,77,106,.15)', color: 'var(--red)', border: '1px solid rgba(255,77,106,.2)' },
    med: { background: 'rgba(255,184,48,.12)', color: 'var(--amber)', border: '1px solid rgba(255,184,48,.18)' },
    low: { background: 'var(--bg4)', color: 'var(--tx3)', border: '1px solid var(--bd)' },
  }
  return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '.8px', ...styles[prio] }}>{prio}</span>
}

function Btn({ onClick, children, disabled, small }: any) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: small ? '7px 13px' : '10px 18px', background: 'linear-gradient(135deg,var(--blue2),var(--purple2))', border: 'none', borderRadius: 10, color: '#fff', fontSize: small ? 12 : 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: disabled ? .4 : 1, boxShadow: '0 4px 20px rgba(61,127,255,.25)', letterSpacing: '.3px' }}>
      {children}
    </button>
  )
}

function PlusIcon() {
  return <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><line x1="7" y1="1" x2="7" y2="13" stroke="white" strokeWidth="2" strokeLinecap="round" /><line x1="1" y1="7" x2="13" y2="7" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
}

function Empty({ children }: any) {
  return <div style={{ fontSize: 12, color: 'var(--tx3)', textAlign: 'center', padding: '24px 0' }}>{children}</div>
}

// ── Analytics ────────────────────────────────────────────
function Analytics({ history }: { history: number[] }) {
  const now = new Date(); const year = now.getFullYear()
  const start = new Date(year, 0, 1)
  const days: Date[] = []; const scores: number[] = []
  for (let i = 0; i < 364; i++) { const d = new Date(start); d.setDate(d.getDate() + i); days.push(d) }
  let cur = 0; let maxStr = 0
  days.forEach((d, i) => {
    const isPast = d < now
    const hi = history.length - (days.filter(dd => dd <= now).length - i)
    const s = isPast ? (hi >= 0 && hi < history.length ? history[hi] : Math.round(20 + Math.random() * 80)) : 0
    if (s > 70) { cur++; maxStr = Math.max(maxStr, cur) } else cur = 0
    scores.push(s)
  })
  const past = scores.filter(s => s > 0)
  const avg7 = past.length ? Math.round(past.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, past.slice(-7).length)) : 0
  const avg30 = past.length ? Math.round(past.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, past.slice(-30).length)) : 0
  const avgY = past.length ? Math.round(past.reduce((a, b) => a + b, 0) / past.length) : 0
  const delta = avg7 - avg30
  const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez']
  const lblArr = new Array(52).fill(''); let lastM = -1
  days.forEach((d, i) => { if (d.getMonth() !== lastM) { const col = Math.floor(i / 7); if (col < 52) lblArr[col] = MONTHS[d.getMonth()]; lastM = d.getMonth() } })

  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--bd)', borderRadius: 18, padding: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: 'var(--tx2)' }}>Analytics — Jahr</div>
        <div style={{ fontSize: 11, color: 'var(--tx3)', fontFamily: 'var(--mono)' }}>0% schwarz → 100% grün</div>
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        {[{ lbl: '7-Tage Avg', val: avg7 + '%', delta: (delta >= 0 ? '+' : '') + delta + '% vs 30d', pos: delta >= 0 }, { lbl: '30-Tage Avg', val: avg30 + '%' }, { lbl: 'Bester Streak', val: String(maxStr), delta: 'Tage über 70%', pos: true }, { lbl: 'Jahr Avg', val: avgY + '%' }].map(s => (
          <div key={s.lbl} style={{ flex: 1, background: 'var(--bg3)', borderRadius: 8, padding: 12, border: '1px solid var(--bd)' }}>
            <div style={{ fontSize: 11, color: 'var(--tx2)', textTransform: 'uppercase', letterSpacing: '.8px' }}>{s.lbl}</div>
            <div style={{ fontFamily: 'var(--mono)', fontSize: 20, fontWeight: 500, marginTop: 4 }}>{s.val}</div>
            {s.delta && <div style={{ fontSize: 11, fontFamily: 'var(--mono)', marginTop: 3, color: s.pos ? 'var(--green)' : 'var(--red)' }}>{s.delta}</div>}
          </div>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(52, 1fr)', gap: 2, marginBottom: 4 }}>
        {lblArr.map((l, i) => <span key={i} style={{ fontSize: 9, color: 'var(--tx3)', fontFamily: 'var(--mono)' }}>{l}</span>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(52, 1fr)', gap: 2 }}>
        {scores.map((s, i) => (
          <div key={i} title={days[i]?.toLocaleDateString('de-DE') + ' — ' + (s ? s + '%' : 'kein Eintrag')}
            style={{ aspectRatio: '1', borderRadius: 2, background: s > 0 ? scoreColor(s) : 'var(--bg3)', cursor: 'pointer', transition: 'transform .1s' }}
            onMouseEnter={e => (e.target as HTMLElement).style.transform = 'scale(1.4)'}
            onMouseLeave={e => (e.target as HTMLElement).style.transform = 'scale(1)'} />
        ))}
      </div>
    </div>
  )
}

// ── Add / Edit Modal ─────────────────────────────────────
function AddModal({ type: initType, editId, habits, tasks, projects, onClose, onSaveHabit, onSaveTask, onSaveProject }: any) {
  const [type, setType] = useState(initType)
  const [title, setTitle] = useState('')
  const [prio, setPrio] = useState<Priority>('med')
  const [due, setDue] = useState('')
  const [subsRaw, setSubsRaw] = useState('')
  const [hType, setHType] = useState<HabitType>('binary')
  const [target, setTarget] = useState('')
  const [unit, setUnit] = useState('')
  const [color, setColor] = useState<BrandColor>('green')
  const [activeDays, setActiveDays] = useState([0,1,2,3,4,5,6])
  const [deadline, setDeadline] = useState('')
  const [projItems, setProjItems] = useState([''])

  useEffect(() => {
    if (editId) {
      if (initType === 'habit') { const h = habits.find((x: Habit) => x.id === editId); if (h) { setTitle(h.name); setColor(h.color); setHType(h.type); setActiveDays(h.active_days); setTarget(h.target?.toString() || ''); setUnit(h.unit || '') } }
      if (initType === 'task') { const t = tasks.find((x: Task) => x.id === editId); if (t) { setTitle(t.title); setPrio(t.prio); setDue(t.due || ''); setSubsRaw(t.subs.map((s: Sub) => s.t).join(', ')) } }
      if (initType === 'project') { const p = projects.find((x: Project) => x.id === editId); if (p) { setTitle(p.name); setColor(p.color); setDeadline(p.deadline); setProjItems([...p.items.map((i: ProjItem) => i.t), '']) } }
    }
  }, [editId])

  function submit() {
    if (!title.trim()) return
    if (type === 'task') {
      const subs = subsRaw.split(',').map(s => s.trim()).filter(Boolean).map(t => ({ t, d: false }))
      onSaveTask({ id: editId || Date.now().toString(), title: title.trim(), prio, rollover: false, done: false, subs, due })
    } else if (type === 'habit') {
      const days = activeDays.length ? activeDays : [0,1,2,3,4,5,6]
      onSaveHabit({ id: editId || Date.now().toString(), name: title.trim(), color, type: hType, active_days: days, done: false, pct: 0, target: hType === 'metric' ? parseFloat(target) || 1 : undefined, unit: hType === 'metric' ? unit : undefined, current_val: 0 })
    } else {
      const items = projItems.filter(s => s.trim()).map(t => ({ t: t.trim(), d: false, subs: [] }))
      onSaveProject({ id: editId || Date.now().toString(), name: title.trim(), color, deadline, status: 'on-track' as ProjectStatus, items })
    }
  }

  const isEdit = !!editId
  const mStyle: React.CSSProperties = { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }
  const bStyle: React.CSSProperties = { background: 'var(--bg2)', border: '1px solid var(--bd2)', borderRadius: 24, width: 520, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', padding: 28 }

  return (
    <div style={mStyle} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={bStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>{isEdit ? 'Bearbeiten' : 'Neu erstellen'}</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: 'var(--bg4)', border: '1px solid var(--bd2)', color: 'var(--tx2)', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>✕</button>
        </div>
        {!isEdit && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {(['task', 'habit', 'project'] as const).map(t => (
              <button key={t} onClick={() => setType(t)} style={{ flex: 1, padding: 9, borderRadius: 9, border: `1px solid ${type === t ? 'var(--blue)' : 'var(--bd)'}`, background: type === t ? 'rgba(61,127,255,.15)' : 'var(--bg3)', color: type === t ? 'var(--tx)' : 'var(--tx2)', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                {{ task: 'Task', habit: 'Habit', project: 'Projekt' }[t]}
              </button>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <ModalField label="Titel"><input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={type === 'task' ? 'Was willst du erledigen?' : type === 'habit' ? 'Habit-Name…' : 'Projektname…'} style={inputStyle} /></ModalField>
          {type === 'task' && <>
            <ModalField label="Priorität">
              <div style={{ display: 'flex', gap: 7 }}>
                {(['high', 'med', 'low'] as Priority[]).map(p => {
                  const active = prio === p
                  const colors: Record<Priority, string> = { high: 'var(--red)', med: 'var(--amber)', low: 'var(--tx3)' }
                  return <button key={p} onClick={() => setPrio(p)} style={{ flex: 1, padding: '7px 13px', borderRadius: 7, border: `1px solid ${active ? colors[p] : 'var(--bd)'}`, background: active ? colors[p] + '18' : 'var(--bg3)', color: active ? colors[p] : 'var(--tx2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {{ high: '🔴 High', med: '🟡 Med', low: '⚪ Low' }[p]}
                  </button>
                })}
              </div>
            </ModalField>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label="Fälligkeitsdatum"><input type="date" value={due} onChange={e => setDue(e.target.value)} style={inputStyle} /></ModalField>
              <ModalField label="Sub-Tasks (Komma)"><input value={subsRaw} onChange={e => setSubsRaw(e.target.value)} placeholder="Recherche, Entwurf" style={inputStyle} /></ModalField>
            </div>
          </>}
          {type === 'habit' && <>
            <ModalField label="Typ">
              <div style={{ display: 'flex', gap: 7 }}>
                {(['binary', 'metric'] as HabitType[]).map(t => (
                  <button key={t} onClick={() => setHType(t)} style={{ flex: 1, padding: '7px 13px', borderRadius: 7, border: `1px solid ${hType === t ? 'var(--blue)' : 'var(--bd)'}`, background: hType === t ? 'rgba(61,127,255,.1)' : 'var(--bg3)', color: hType === t ? 'var(--blue)' : 'var(--tx2)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {t === 'binary' ? '✓ Binary' : '📊 Metrisch'}
                  </button>
                ))}
              </div>
            </ModalField>
            {hType === 'metric' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <ModalField label="Zielwert"><input type="number" value={target} onChange={e => setTarget(e.target.value)} placeholder="2" style={inputStyle} /></ModalField>
                <ModalField label="Einheit"><input value={unit} onChange={e => setUnit(e.target.value)} placeholder="L, km, min" style={inputStyle} /></ModalField>
              </div>
            )}
            <ModalField label="Aktive Tage">
              <div style={{ display: 'flex', gap: 5 }}>
                {DSHORT.map((d, i) => (
                  <button key={i} onClick={() => setActiveDays(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                    style={{ width: 32, height: 32, borderRadius: 7, border: `1px solid ${activeDays.includes(i) ? 'var(--blue)' : 'var(--bd)'}`, background: activeDays.includes(i) ? 'rgba(61,127,255,.15)' : 'var(--bg3)', color: activeDays.includes(i) ? 'var(--blue)' : 'var(--tx3)', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>{d}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                {[['Alle', [0,1,2,3,4,5,6]], ['Mo–Fr', [0,1,2,3,4]], ['Wochenende', [5,6]]].map(([l, d]) => (
                  <button key={l as string} onClick={() => setActiveDays(d as number[])} style={{ padding: '4px 9px', background: 'var(--bg3)', border: '1px solid var(--bd)', borderRadius: 6, fontSize: 10, color: 'var(--tx2)', cursor: 'pointer', fontFamily: 'inherit' }}>{l as string}</button>
                ))}
              </div>
            </ModalField>
            <ModalField label="Farbe">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {CNAMES.map(cn => (
                  <button key={cn} onClick={() => setColor(cn)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7, border: `1px solid ${color === cn ? COLORS[cn] : 'var(--bd)'}`, background: color === cn ? COLORS[cn] + '18' : 'var(--bg3)', color: color === cn ? COLORS[cn] : 'var(--tx2)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS[cn] }} />{cn}
                  </button>
                ))}
              </div>
            </ModalField>
          </>}
          {type === 'project' && <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <ModalField label="Deadline"><input value={deadline} onChange={e => setDeadline(e.target.value)} placeholder="Q2 2026" style={inputStyle} /></ModalField>
              <ModalField label="Farbe">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {CNAMES.map(cn => (
                    <div key={cn} onClick={() => setColor(cn)} style={{ width: 20, height: 20, borderRadius: '50%', background: COLORS[cn], border: `2px solid ${color === cn ? 'var(--tx)' : 'transparent'}`, cursor: 'pointer', transform: color === cn ? 'scale(1.2)' : 'scale(1)', transition: 'all .15s' }} />
                  ))}
                </div>
              </ModalField>
            </div>
            <ModalField label="Items">
              {projItems.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input value={item} onChange={e => { const arr = [...projItems]; arr[i] = e.target.value; setProjItems(arr) }} placeholder={`Item ${i + 1}…`} style={{ ...inputStyle, fontSize: 12, padding: '6px 10px' }} />
                  {projItems.length > 1 && <button onClick={() => setProjItems(projItems.filter((_, j) => j !== i))} style={{ padding: '4px 9px', background: 'rgba(127,29,29,.5)', border: '1px solid rgba(204,41,64,.5)', color: 'var(--red)', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>✕</button>}
                </div>
              ))}
              <button onClick={() => setProjItems([...projItems, ''])} style={{ width: '100%', padding: 8, background: 'var(--bg4)', border: '1px solid var(--bd2)', borderRadius: 7, color: 'var(--tx2)', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>+ Item hinzufügen</button>
            </ModalField>
          </>}
          <button onClick={submit} style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg,var(--blue2),var(--purple2))', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4 }}>
            {isEdit ? 'Änderungen speichern' : type === 'task' ? 'Task erstellen' : type === 'habit' ? 'Habit hinzufügen' : 'Projekt erstellen'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ModalField({ label, children }: any) {
  return <div><label style={{ display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: 'var(--tx3)', marginBottom: 6 }}>{label}</label>{children}</div>
}

const inputStyle: React.CSSProperties = { width: '100%', background: 'var(--bg3)', border: '1px solid var(--bd2)', borderRadius: 8, color: 'var(--tx)', fontFamily: 'inherit', fontSize: 14, padding: '10px 12px', outline: 'none' }

// ── End Day Modal ────────────────────────────────────────
function EndDayModal({ hScore, tScore, life, history, projects, onClose, onConfirm }: any) {
  const yesterday = history[history.length - 1] ?? 0
  const delta = life - yesterday
  const pdone = projects.length ? Math.round(projects.reduce((a: number, p: Project) => { const t = p.items.length; const d = p.items.filter((i: ProjItem) => i.d).length; return a + (t ? d / t : 0) }, 0) / projects.length * 100) : 0
  const TITLES: Record<number, string> = { 100: 'Legendärer Tag! 🏆', 80: 'Starke Leistung! 💪', 60: 'Solider Fortschritt 👍', 40: 'Gut angefangen ✊', 0: 'Morgen besser! 🌱' }
  const SUBS: Record<number, string> = { 100: 'Du hast heute alles gegeben.', 80: 'Das war ein richtig produktiver Tag.', 60: 'Du bewegst dich in die richtige Richtung.', 40: 'Jeder Tag zählt.', 0: 'Der erste Schritt ist der wichtigste.' }
  const lvl = life >= 100 ? 100 : life >= 80 ? 80 : life >= 60 ? 60 : life >= 40 ? 40 : 0
  const PCOLS = ['#00e87a','#3d7fff','#9b6dff','#ffb830','#ff4d6a','#00d4c8']

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.9)', backdropFilter: 'blur(12px)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--bd2)', borderRadius: 28, width: 580, maxWidth: '94vw', padding: 40, textAlign: 'center', position: 'relative', overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle,rgba(0,232,122,.15),transparent 70%)', top: -80, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          {PCOLS.map((c, i) => <div key={i} style={{ position: 'absolute', width: 6, height: 6, borderRadius: '50%', background: c, left: `${Math.random() * 100}%`, bottom: 0, animation: `float ${2 + i * 0.3}s ease-in ${i * 0.3}s infinite` }} />)}
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 13, color: 'var(--tx3)', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>Tages-Abschluss</div>
          <div style={{ fontFamily: 'var(--mono)', fontSize: 72, fontWeight: 500, background: 'linear-gradient(135deg,var(--green),var(--teal))', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', lineHeight: 1, margin: '16px 0 8px' }}>{life}%</div>
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: -1, marginBottom: 4 }}>{TITLES[lvl]}</div>
          <div style={{ fontSize: 14, color: 'var(--tx2)', marginBottom: 24 }}>{SUBS[lvl]}</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 16 }}>
            {[{ val: hScore + '%', lbl: 'Habits', col: 'var(--green)' }, { val: tScore + '%', lbl: 'Tasks', col: 'var(--blue)' }, { val: pdone + '%', lbl: 'Projekte', col: 'var(--purple)' }].map(s => (
              <div key={s.lbl} style={{ background: 'var(--bg3)', borderRadius: 12, padding: 14, border: '1px solid var(--bd)' }}>
                <div style={{ fontFamily: 'var(--mono)', fontSize: 22, fontWeight: 500, marginBottom: 4, color: s.col }}>{s.val}</div>
                <div style={{ fontSize: 10, color: 'var(--tx2)', textTransform: 'uppercase', letterSpacing: 1 }}>{s.lbl}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, color: 'var(--tx2)', padding: 12, background: 'var(--bg3)', borderRadius: 10, marginBottom: 20, border: '1px solid var(--bd)' }}>
            Gestern: <strong style={{ color: 'var(--tx)' }}>{yesterday}%</strong> → Heute: <strong style={{ color: 'var(--tx)' }}>{life}%</strong> —{' '}
            {delta >= 0 ? <strong style={{ color: 'var(--green)' }}>+{delta}% besser 📈</strong> : <span style={{ color: 'var(--amber)' }}>{delta}% – morgen wieder angreifen</span>}
          </div>
          <div>
            <button onClick={onConfirm} style={{ padding: '12px 28px', background: 'linear-gradient(135deg,var(--blue2),var(--purple2))', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', margin: 4 }}>Tag abschließen & sichern</button>
            <button onClick={onClose} style={{ padding: '12px 28px', background: 'transparent', border: '1px solid var(--bd2)', borderRadius: 10, color: 'var(--tx2)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', margin: 4 }}>Weiter arbeiten</button>
          </div>
        </div>
      </div>
    </div>
  )
}
