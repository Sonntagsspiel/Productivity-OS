'use client'
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, dbLoad, dbUpsert, dbDelete, saveDailySummary, loadHistory, deleteOldCompletedTasks } from '@/lib/supabase'

// ── Types ────────────────────────────────────────────────
type Priority = 'high' | 'med' | 'low'
type HabitType = 'binary' | 'metric'
type ProjectStatus = 'on-track' | 'at-risk' | 'done' | 'paused'
type BrandColor = 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'teal'
type SortMode = 'prio' | 'due' | 'alpha'

interface Sub { t: string; d: boolean }
interface Habit { id: string; name: string; color: BrandColor; type: HabitType; active_days: number[]; done: boolean; pct: number; target?: number; unit?: string; current_val?: number }
interface Task { id: string; title: string; prio: Priority; rollover: boolean; done: boolean; done_at?: string; subs: Sub[]; due: string; showSub?: boolean }
interface ProjItem { t: string; d: boolean; subs: Sub[] }
interface Project { id: string; name: string; color: BrandColor; deadline: string; status: ProjectStatus; items: ProjItem[] }
interface DaySummary { date: string; life_score: number; habit_score: number; task_score: number }

// ── Constants ────────────────────────────────────────────
const COLORS: Record<BrandColor, string> = { green: '#00e87a', blue: '#3d7fff', purple: '#9b6dff', amber: '#ffb830', red: '#ff4d6a', teal: '#00d4c8' }
const CNAMES = Object.keys(COLORS) as BrandColor[]
const DSHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const PW: Record<Priority, number> = { high: 3, med: 2, low: 1 }

const DAILY_QUOTES = [
  "Disziplin ist die Brücke zwischen Zielen und Leistung.",
  "Kleine Fortschritte jeden Tag führen zu großen Ergebnissen.",
  "Du wirst nicht immer motiviert sein. Also lerne, diszipliniert zu sein.",
  "Der einzige schlechte Workout ist der, der nicht stattfand.",
  "Erfolg ist die Summe kleiner Anstrengungen, die täglich wiederholt werden.",
  "Wer aufhört, besser zu werden, hat aufgehört, gut zu sein.",
  "Dein zukünftiges Ich wird dir danken.",
  "Tu heute das, was andere nicht tun – damit du morgen das kannst, was andere nicht können.",
  "Fortschritt, nicht Perfektion.",
  "Jeder Tag ist eine neue Chance, die Person zu werden, die du sein möchtest.",
  "Es ist nie zu spät, das zu tun, was du heute noch nicht getan hast.",
  "Stark sein bedeutet, weiterzumachen, wenn alles in dir aufhören will.",
  "Die meisten Hindernisse lösen sich durch konsequentes Handeln.",
  "Vergleiche dich nur mit der Person, die du gestern warst.",
  "Wachstum beginnt am Ende deiner Komfortzone.",
]

const TODAY_DOW = (new Date().getDay() + 6) % 7
const STATUS_LABELS: Record<ProjectStatus, string> = { 'on-track': 'On Track', 'at-risk': 'At Risk', 'done': 'Fertig', 'paused': 'Pausiert' }
const STATUS_COLORS: Record<ProjectStatus, string> = { 'on-track': '#00e87a', 'at-risk': '#ffb830', 'done': '#3d7fff', 'paused': '#3d4f68' }

function dueDiff(due: string): number | null {
  if (!due) return null
  const n = new Date(); n.setHours(0, 0, 0, 0)
  const d = new Date(due); d.setHours(0, 0, 0, 0)
  return Math.round((d.getTime() - n.getTime()) / 864e5)
}

function scoreColor(s: number) {
  if (!s) return '#0f1420'
  return `rgb(${Math.round(5 + (s / 100) * 17)},${Math.round(30 + (s / 100) * 202)},${Math.round(20 + (s / 100) * 74)})`
}

function todayStr() { return new Date().toISOString().split('T')[0] }

const TOMORROW = new Date(Date.now() + 86400000).toISOString().split('T')[0]

const DEFAULT_HABITS: Habit[] = [
  { id: 'h1', name: 'Meditation', color: 'green', type: 'binary', active_days: [0,1,2,3,4,5,6], done: false, pct: 0 },
  { id: 'h2', name: 'Wasser trinken', color: 'blue', type: 'metric', active_days: [0,1,2,3,4,5,6], done: false, pct: 0, target: 2, unit: 'L', current_val: 0 },
  { id: 'h3', name: 'Sport', color: 'teal', type: 'binary', active_days: [0,2,4], done: false, pct: 0 },
  { id: 'h4', name: 'Journaling', color: 'amber', type: 'binary', active_days: [0,1,2,3,4,5,6], done: false, pct: 0 },
]
const DEFAULT_TASKS: Task[] = [
  { id: 't1', title: 'Q4 Report finalisieren', prio: 'high', rollover: true, done: false, subs: [{ t: 'Executive Summary', d: false }], due: '2025-03-20' },
  { id: 't2', title: 'Team Meeting vorbereiten', prio: 'high', rollover: false, done: false, subs: [], due: TOMORROW },
  { id: 't3', title: 'Inbox auf null', prio: 'med', rollover: false, done: false, subs: [], due: '' },
]
const DEFAULT_PROJECTS: Project[] = [
  { id: 'p1', name: 'Website Relaunch', color: 'blue', deadline: 'Q1 2026', status: 'on-track', items: [{ t: 'Design Mockups', d: true, subs: [] }, { t: 'Frontend', d: false, subs: [] }, { t: 'Launch', d: false, subs: [] }] },
]

// ── Animations CSS ───────────────────────────────────────
const ANIM_CSS = `
@keyframes popIn { 0%{transform:scale(0.5);opacity:0} 60%{transform:scale(1.15)} 100%{transform:scale(1);opacity:1} }
@keyframes checkBounce { 0%{transform:scale(1)} 30%{transform:scale(0.85)} 60%{transform:scale(1.25)} 80%{transform:scale(0.95)} 100%{transform:scale(1)} }
@keyframes slideInLeft { from{transform:translateX(-16px);opacity:0} to{transform:translateX(0);opacity:1} }
@keyframes slideInUp { from{transform:translateY(12px);opacity:0} to{transform:translateY(0);opacity:1} }
@keyframes slideOutRight { 0%{transform:translateX(0);opacity:1;max-height:80px;margin-bottom:8px} 60%{transform:translateX(20px);opacity:0.2} 100%{transform:translateX(40px);opacity:0;max-height:0;margin-bottom:0;padding-top:0;padding-bottom:0;border-width:0} }
@keyframes fadeIn { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes shimmer { 0%{transform:translateX(-100%)} 100%{transform:translateX(100%)} }
@keyframes flicker { from{opacity:.8;transform:scale(.97)} to{opacity:1;transform:scale(1.03)} }
@keyframes floatUp { 0%{transform:translateY(0) scale(1);opacity:1} 100%{transform:translateY(-60px) scale(0);opacity:0} }
@keyframes sparkRing { 0%{transform:scale(0.8);opacity:1} 100%{transform:scale(2.5);opacity:0} }
@keyframes confettiFall { 0%{transform:translateY(-20px) rotate(0deg);opacity:1} 100%{transform:translateY(80px) rotate(720deg);opacity:0} }
@keyframes pulseGlow { 0%,100%{box-shadow:0 0 0 0 rgba(0,232,122,0)} 50%{box-shadow:0 0 0 8px rgba(0,232,122,0.15)} }
@keyframes scoreCount { 0%{transform:translateY(4px);opacity:0} 100%{transform:translateY(0);opacity:1} }
@keyframes barFill { from{width:0%} to{width:var(--target-width)} }
@keyframes ringAppear { from{stroke-dashoffset:289} }
@keyframes float { 0%{transform:translateY(100%) rotate(0);opacity:1} 100%{transform:translateY(-120vh) rotate(720deg);opacity:0} }
@keyframes modalIn { from{transform:scale(0.92) translateY(12px);opacity:0} to{transform:scale(1) translateY(0);opacity:1} }
@keyframes tabSlide { from{opacity:0;transform:translateX(8px)} to{opacity:1;transform:translateX(0)} }
@keyframes habitComplete { 0%{background:var(--bg3)} 50%{background:rgba(0,232,122,0.15)} 100%{background:var(--bg3)} }
@keyframes numberTick { from{opacity:0;transform:translateY(6px)} to{opacity:1;transform:translateY(0)} }
@keyframes ringPulse { 0%,100%{opacity:1} 50%{opacity:0.7} }
`

// ── Sparkle emitter ───────────────────────────────────────
let sparkleContainer: HTMLDivElement | null = null
function emitSparkles(x?: number, y?: number) {
  if (typeof document === 'undefined') return
  if (!sparkleContainer) {
    sparkleContainer = document.createElement('div')
    sparkleContainer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden'
    document.body.appendChild(sparkleContainer)
  }
  const cx = x ?? window.innerWidth / 2
  const cy = y ?? window.innerHeight / 2
  const colors = ['#00e87a','#3d7fff','#9b6dff','#ffb830','#00d4c8','#ff4d6a']
  for (let i = 0; i < 16; i++) {
    const el = document.createElement('div')
    const size = 5 + Math.random() * 9
    const angle = (Math.PI * 2 * i) / 16 + Math.random() * 0.5
    const dist = 40 + Math.random() * 80
    const tx = Math.cos(angle) * dist
    const ty = Math.sin(angle) * dist
    el.style.cssText = `position:absolute;border-radius:50%;width:${size}px;height:${size}px;left:${cx}px;top:${cy}px;background:${colors[i % colors.length]};transform:translate(-50%,-50%);animation:none;transition:transform 0.6s ease-out, opacity 0.6s ease-out;will-change:transform,opacity`
    sparkleContainer.appendChild(el)
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        el.style.transform = `translate(calc(-50% + ${tx}px), calc(-50% + ${ty}px)) scale(0)`
        el.style.opacity = '0'
      })
    })
    setTimeout(() => el.remove(), 700)
  }
}

// ── Main App ─────────────────────────────────────────────
export default function App() {
  const [habits, setHabits] = useState<Habit[]>(DEFAULT_HABITS)
  const [tasks, setTasks] = useState<Task[]>(DEFAULT_TASKS)
  const [projects, setProjects] = useState<Project[]>(DEFAULT_PROJECTS)
  const [history, setHistory] = useState<DaySummary[]>([])
  const [streak, setStreak] = useState(0)
  const [loading, setLoading] = useState(true)
  const [taskSort, setTaskSort] = useState<SortMode>('prio')
  const [modal, setModal] = useState<{ open: boolean; type: 'task'|'habit'|'project'; editId?: string } | null>(null)
  const [analysisOpen, setAnalysisOpen] = useState(false)
  const [manageOpen, setManageOpen] = useState(false)
  const [showSubs, setShowSubs] = useState<Record<string, boolean>>({})
  const [completingTasks, setCompletingTasks] = useState<Set<string>>(new Set())
  const [lastReset, setLastReset] = useState<string>('')
  const [animKey, setAnimKey] = useState(0)

  // Load all data
  useEffect(() => {
    async function load() {
      try {
        await deleteOldCompletedTasks()
        const [h, t, p, hist] = await Promise.all([
          dbLoad('habits'), dbLoad('tasks'), dbLoad('projects'), loadHistory()
        ])
        if (h?.length) setHabits(h.map((r: any) => ({ ...r, active_days: r.active_days || [0,1,2,3,4,5,6], current_val: r.current_val || 0 })))
        if (t?.length) setTasks(t.map((r: any) => ({ ...r, subs: r.subs || [], due: r.due || '' })))
        if (p?.length) setProjects(p.map((r: any) => ({ ...r, items: r.items || [] })))
        if (hist?.length) {
          setHistory(hist)
          let s = 0
          for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].life_score >= 50) s++; else break }
          setStreak(s)
        }
        // Check last reset date
        const stored = localStorage.getItem('lastReset') || ''
        setLastReset(stored)
      } catch (e) { console.error('Load error:', e) }
      finally { setLoading(false) }
    }
    load()
  }, [])

  // Midnight reset check
  useEffect(() => {
    const check = async () => {
      const today = todayStr()
      if (lastReset === today) return
      if (lastReset && lastReset < today) {
        // New day! Save yesterday's data and reset
        await doMidnightReset()
      }
    }
    if (!loading) check()

    // Check every minute
    const interval = setInterval(async () => {
      const today = todayStr()
      const stored = localStorage.getItem('lastReset') || ''
      if (stored && stored < today) {
        await doMidnightReset()
      }
    }, 60000)
    return () => clearInterval(interval)
  }, [loading, lastReset])

  async function doMidnightReset() {
    const today = todayStr()
    const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
    const { hScore, tScore, life } = calcScores()
    // Save yesterday
    await saveDailySummary(yesterday, life, hScore, tScore, habits, tasks.filter(t => t.done))
    // Reset habits
    const resetHabits = habits.map(h => ({ ...h, done: false, pct: 0, current_val: 0 }))
    setHabits(resetHabits)
    await dbUpsert('habits', resetHabits.map(h => ({ id: h.id, name: h.name, color: h.color, type: h.type, active_days: h.active_days, done: false, pct: 0, target: h.target, unit: h.unit, current_val: 0 })))
    // Reload history
    const hist = await loadHistory()
    setHistory(hist)
    localStorage.setItem('lastReset', today)
    setLastReset(today)
    setAnimKey(k => k + 1)
  }

  // Initialize lastReset if never set
  useEffect(() => {
    if (!loading && !lastReset) {
      const today = todayStr()
      localStorage.setItem('lastReset', today)
      setLastReset(today)
    }
  }, [loading, lastReset])

  const calcScores = useCallback(() => {
    const todayH = habits.filter(h => h.active_days.includes(TODAY_DOW))
    const hScore = todayH.length ? Math.round(todayH.reduce((a, h) => a + h.pct, 0) / todayH.length) : 0
    const maxP = tasks.reduce((a, t) => a + PW[t.prio], 0)
    const earnP = tasks.filter(t => t.done).reduce((a, t) => a + PW[t.prio], 0)
    const tScore = maxP ? Math.round((earnP / maxP) * 100) : 0
    return { hScore, tScore, life: Math.round((hScore + tScore) / 2) }
  }, [habits, tasks])

  const { hScore, tScore, life } = calcScores()

  const historyScores = history.map(h => h.life_score)
  const avg7 = historyScores.length ? Math.round(historyScores.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, historyScores.slice(-7).length)) : 0
  const avg30 = historyScores.length ? Math.round(historyScores.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, historyScores.slice(-30).length)) : 0
  const delta = life - avg30

  const todayQuote = DAILY_QUOTES[Math.floor(Date.now() / 86400000) % DAILY_QUOTES.length]
  const hr = new Date().getHours()
  const greeting = hr < 12 ? 'Guten Morgen.' : hr < 17 ? 'Guten Tag.' : 'Guten Abend.'
  const dateStr = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  // ── Habit actions ───────────────────────────────────────
  async function toggleHabit(id: string, event?: React.MouseEvent) {
    if (event) emitSparkles(event.clientX, event.clientY)
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h
      const done = !h.done
      const updated = { ...h, done, pct: done ? 100 : 0 }
      dbUpsert('habits', [toHabitRow(updated)])
      return updated
    }))
  }

  async function updateMetric(id: string, val: number) {
    setHabits(prev => prev.map(h => {
      if (h.id !== id) return h
      const pct = h.target ? Math.min(100, Math.round((val / h.target) * 100)) : 0
      const updated = { ...h, current_val: val, pct }
      if (pct === 100) emitSparkles()
      dbUpsert('habits', [toHabitRow(updated)])
      return updated
    }))
  }

  // Draggable metric bar
  function handleBarDrag(id: string, e: React.MouseEvent<HTMLDivElement>) {
    const bar = e.currentTarget
    const rect = bar.getBoundingClientRect()
    const h = habits.find(x => x.id === id)
    if (!h || !h.target) return
    const update = (clientX: number) => {
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
      const val = Math.round(ratio * h.target! * 10) / 10
      updateMetric(id, val)
    }
    update(e.clientX)
    const onMove = (ev: MouseEvent) => update(ev.clientX)
    const onUp = () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ── Task actions ────────────────────────────────────────
  async function completeTask(id: string, event?: React.MouseEvent) {
    if (event) emitSparkles(event.clientX, event.clientY)
    setCompletingTasks(prev => new Set(prev).add(id))
    setTimeout(() => {
      setTasks(prev => prev.map(t => {
        if (t.id !== id) return t
        const updated = { ...t, done: true, done_at: new Date().toISOString() }
        dbUpsert('tasks', [toTaskRow(updated)])
        return updated
      }))
      setCompletingTasks(prev => { const n = new Set(prev); n.delete(id); return n })
    }, 400)
  }

  function toggleSubTask(taskId: string, si: number) {
    setTasks(prev => prev.map(t => {
      if (t.id !== taskId) return t
      const subs = t.subs.map((s, i) => i === si ? { ...s, d: !s.d } : s)
      const updated = { ...t, subs }
      dbUpsert('tasks', [toTaskRow(updated)])
      return updated
    }))
  }

  async function restoreTask(id: string) {
    setTasks(prev => prev.map(t => {
      if (t.id !== id) return t
      const updated = { ...t, done: false, done_at: undefined }
      dbUpsert('tasks', [toTaskRow(updated)])
      return updated
    }))
  }

  async function deleteTask(id: string) {
    setTasks(prev => prev.filter(t => t.id !== id))
    await dbDelete('tasks', id)
  }

  // ── Project actions ─────────────────────────────────────
  function toggleProjItem(pid: string, ii: number) {
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p
      const items = p.items.map((item, i) => i === ii ? { ...item, d: !item.d } : item)
      const updated = { ...p, items }
      dbUpsert('projects', [toProjRow(updated)])
      return updated
    }))
  }

  function toggleProjSub(pid: string, ii: number, si: number) {
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p
      const items = p.items.map((item, i) => {
        if (i !== ii) return item
        return { ...item, subs: item.subs.map((s, j) => j === si ? { ...s, d: !s.d } : s) }
      })
      const updated = { ...p, items }
      dbUpsert('projects', [toProjRow(updated)])
      return updated
    }))
  }

  function updateProjStatus(pid: string, status: ProjectStatus) {
    setProjects(prev => prev.map(p => {
      if (p.id !== pid) return p
      const updated = { ...p, status }
      dbUpsert('projects', [toProjRow(updated)])
      return updated
    }))
  }

  async function deleteProject(id: string) {
    setProjects(prev => prev.filter(p => p.id !== id))
    await dbDelete('projects', id)
  }

  // ── Analysis (was End Day) ──────────────────────────────
  async function saveAnalysis() {
    const { hScore, tScore, life } = calcScores()
    const today = todayStr()
    await saveDailySummary(today, life, hScore, tScore, habits, tasks.filter(t => t.done))
    const hist = await loadHistory()
    setHistory(hist)
    let s = 0
    for (let i = hist.length - 1; i >= 0; i--) { if (hist[i].life_score >= 50) s++; else break }
    setStreak(s)
    setAnalysisOpen(false)
  }

  // ── Row helpers ─────────────────────────────────────────
  function toHabitRow(h: Habit) { return { id: h.id, name: h.name, color: h.color, type: h.type, active_days: h.active_days, done: h.done, pct: h.pct, target: h.target, unit: h.unit, current_val: h.current_val } }
  function toTaskRow(t: Task) { return { id: t.id, title: t.title, prio: t.prio, rollover: t.rollover, done: t.done, done_at: t.done_at || null, subs: t.subs, due: t.due } }
  function toProjRow(p: Project) { return { id: p.id, name: p.name, color: p.color, deadline: p.deadline, status: p.status, items: p.items } }

  // ── Sorted tasks ────────────────────────────────────────
  const activeTasks = tasks.filter(t => !t.done)
  const doneTasks = tasks.filter(t => t.done)

  const sortedTasks = [...activeTasks].sort((a, b) => {
    const aO = a.rollover || (!!a.due && (dueDiff(a.due) ?? 0) < 0)
    const bO = b.rollover || (!!b.due && (dueDiff(b.due) ?? 0) < 0)
    if (aO && !bO) return -1; if (!aO && bO) return 1
    if (taskSort === 'prio') return PW[b.prio] - PW[a.prio]
    if (taskSort === 'due') { if (!a.due && !b.due) return 0; if (!a.due) return 1; if (!b.due) return -1; return new Date(a.due).getTime() - new Date(b.due).getTime() }
    return a.title.localeCompare(b.title)
  })

  if (loading) return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#090c12', color: '#3d4f68', fontFamily: 'var(--mono,monospace)', fontSize: 13 }}>
      <div style={{ textAlign: 'center', animation: 'fadeIn .5s ease' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⚡</div>
        <div>Verbinde mit Supabase…</div>
      </div>
    </div>
  )

  return (
    <div style={{ minHeight: '100vh', background: '#090c12', position: 'relative', overflowX: 'hidden' }}>
      <style>{ANIM_CSS}</style>

      {/* Blobs */}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0 }}>
        <div style={{ position: 'absolute', width: 500, height: 500, borderRadius: '50%', background: '#3d7fff', filter: 'blur(80px)', opacity: .1, top: -100, right: -100 }} />
        <div style={{ position: 'absolute', width: 400, height: 400, borderRadius: '50%', background: '#9b6dff', filter: 'blur(80px)', opacity: .1, bottom: 100, left: -150 }} />
        <div style={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%', background: '#00e87a', filter: 'blur(80px)', opacity: .08, top: '40%', right: '20%' }} />
      </div>

      <div style={{ maxWidth: 1140, margin: '0 auto', padding: '24px 20px 80px', position: 'relative', zIndex: 1 }}>

        {/* Motive bar */}
        <div style={{ position: 'relative', overflow: 'hidden', borderRadius: 18, border: '1px solid rgba(61,127,255,.25)', background: 'linear-gradient(135deg,rgba(61,127,255,.15),rgba(155,109,255,.1))', padding: '18px 24px', marginBottom: 20, display: 'flex', alignItems: 'center', justifyContent: 'space-between', animation: 'slideInUp .5s ease' }}>
          <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg,transparent,rgba(61,127,255,.05),transparent)', animation: 'shimmer 3s infinite' }} />
          <div style={{ position: 'relative' }}>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: '-.3px' }}>Productivity OS</div>
            <div style={{ fontSize: 12, color: '#7a88a8', marginTop: 3 }}>{streak > 0 && <span style={{ color: '#00e87a', fontWeight: 700, marginRight: 8 }}>🔥 {streak} Tage Streak</span>}7d: {avg7}% · vs Monat: <span style={{ color: delta >= 0 ? '#00e87a' : '#ff4d6a' }}>{delta >= 0 ? '+' : ''}{delta}%</span></div>
          </div>
          <div style={{ display: 'flex', gap: 12, position: 'relative' }}>
            <Btn onClick={() => setManageOpen(true)} ghost small>📋 Verwalten</Btn>
            <Btn onClick={() => setAnalysisOpen(true)} ghost small>📊 Tagesanalyse</Btn>
          </div>
        </div>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 24, paddingBottom: 20, borderBottom: '1px solid #1e2840', animation: 'fadeIn .6s ease .1s both' }}>
          <div>
            <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: -1, background: 'linear-gradient(135deg,#dce4f5,#7a88a8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>{greeting}</h1>
            <div style={{ fontSize: 12, color: '#3d4f68', marginTop: 2, fontFamily: 'monospace' }}>{dateStr}</div>
            <div style={{ fontSize: 13, color: '#7a88a8', marginTop: 6, fontStyle: 'italic', maxWidth: 420, animation: 'fadeIn 1s ease .3s both' }}>"{todayQuote}"</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <DualRing hScore={hScore} tScore={tScore} life={life} onClick={() => setAnalysisOpen(true)} animKey={animKey} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Btn onClick={() => setModal({ open: true, type: 'task' })}>
                <span style={{ fontSize: 16, lineHeight: 1 }}>+</span> Hinzufügen
              </Btn>
            </div>
          </div>
        </div>

        {/* Main grid */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
          {/* Habits */}
          <div style={{ background: '#0f1420', border: '1px solid #1e2840', borderRadius: 18, padding: 20, animation: 'slideInLeft .5s ease .2s both' }}>
            <SectionHeader title="Habits" score={hScore} scoreColor="#00e87a" animKey={animKey} />
            {habits.filter(h => h.active_days.includes(TODAY_DOW)).length === 0
              ? <Empty>Keine Habits für heute</Empty>
              : habits.filter(h => h.active_days.includes(TODAY_DOW)).map((h, idx) => (
                <HabitCard key={h.id} habit={h} idx={idx}
                  onToggle={(e) => toggleHabit(h.id, e)}
                  onMetric={(v) => updateMetric(h.id, v)}
                  onBarDrag={(e) => handleBarDrag(h.id, e)}
                  onEdit={() => setModal({ open: true, type: 'habit', editId: h.id })} />
              ))
            }
          </div>

          {/* Tasks */}
          <div style={{ background: '#0f1420', border: '1px solid #1e2840', borderRadius: 18, padding: 20, animation: 'slideInLeft .5s ease .3s both' }}>
            <SectionHeader title="Tasks" score={tScore} scoreColor="#3d7fff" animKey={animKey} />
            <SortBar sort={taskSort} onChange={setTaskSort} />
            {sortedTasks.length === 0 ? <Empty>Alle Tasks erledigt 🎉</Empty> : sortedTasks.map((t, idx) => (
              <TaskCard key={t.id} task={t} idx={idx}
                completing={completingTasks.has(t.id)}
                showSub={showSubs[t.id]}
                onComplete={(e) => completeTask(t.id, e)}
                onToggleSub={() => setShowSubs(p => ({ ...p, [t.id]: !showSubs[t.id] }))}
                onToggleSubItem={(si) => toggleSubTask(t.id, si)}
                onEdit={() => setModal({ open: true, type: 'task', editId: t.id })} />
            ))}

            {/* Done tasks tab */}
            {doneTasks.length > 0 && (
              <details style={{ marginTop: 12 }}>
                <summary style={{ fontSize: 11, color: '#3d4f68', cursor: 'pointer', padding: '6px 0', userSelect: 'none', listStyle: 'none', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontSize: 10 }}>▶</span> Erledigt ({doneTasks.length})
                  <span style={{ fontSize: 10, color: '#1e2840', marginLeft: 'auto' }}>auto-delete nach 3 Tagen</span>
                </summary>
                <div style={{ marginTop: 8, animation: 'fadeIn .3s ease' }}>
                  {doneTasks.map(t => (
                    <div key={t.id} style={{ background: '#141928', border: '1px solid #1e2840', borderRadius: 8, padding: '10px 12px', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 10, opacity: .7 }}>
                      <div style={{ width: 16, height: 16, borderRadius: 4, background: '#00b35c', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="2" strokeLinecap="round" /></svg>
                      </div>
                      <span style={{ fontSize: 12, color: '#3d4f68', textDecoration: 'line-through', flex: 1 }}>{t.title}</span>
                      <button onClick={() => restoreTask(t.id)} style={{ fontSize: 10, color: '#7a88a8', background: '#1c2235', border: '1px solid #2d3a55', borderRadius: 5, padding: '2px 7px', cursor: 'pointer' }}>↩ Restore</button>
                      <button onClick={() => deleteTask(t.id)} style={{ fontSize: 10, color: '#ff4d6a', background: 'rgba(255,77,106,.08)', border: '1px solid rgba(255,77,106,.2)', borderRadius: 5, padding: '2px 7px', cursor: 'pointer' }}>✕</button>
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        </div>

        {/* Projects */}
        <div style={{ background: '#0f1420', border: '1px solid #1e2840', borderRadius: 18, padding: 20, marginBottom: 16, animation: 'fadeIn .6s ease .4s both' }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: '#7a88a8' }}>Projekte</div>
            <Btn onClick={() => setModal({ open: true, type: 'project' })} small>+ Projekt</Btn>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
            {projects.map((p, idx) => (
              <ProjectCard key={p.id} project={p} idx={idx}
                onToggleItem={(ii) => toggleProjItem(p.id, ii)}
                onToggleSub={(ii, si) => toggleProjSub(p.id, ii, si)}
                onStatusChange={(s) => updateProjStatus(p.id, s)}
                onEdit={() => setModal({ open: true, type: 'project', editId: p.id })}
                onDelete={() => deleteProject(p.id)} />
            ))}
          </div>
        </div>

        {/* Analytics */}
        <Analytics history={history} />
      </div>

      {/* Modals */}
      {modal?.open && (
        <AddModal type={modal.type} editId={modal.editId} habits={habits} tasks={tasks} projects={projects}
          onClose={() => setModal(null)}
          onSaveHabit={async (h) => {
            if (modal.editId) setHabits(p => p.map(x => x.id === modal.editId ? h : x))
            else setHabits(p => [...p, h])
            await dbUpsert('habits', [toHabitRow(h)]); setModal(null)
          }}
          onSaveTask={async (t) => {
            if (modal.editId) setTasks(p => p.map(x => x.id === modal.editId ? t : x))
            else setTasks(p => [...p, t])
            await dbUpsert('tasks', [toTaskRow(t)]); setModal(null)
          }}
          onSaveProject={async (p) => {
            if (modal.editId) setProjects(prev => prev.map(x => x.id === modal.editId ? p : x))
            else setProjects(prev => [...prev, p])
            await dbUpsert('projects', [toProjRow(p)]); setModal(null)
          }} />
      )}

      {analysisOpen && (
        <AnalysisModal hScore={hScore} tScore={tScore} life={life} history={history} projects={projects} streak={streak}
          onClose={() => setAnalysisOpen(false)} onSave={saveAnalysis} />
      )}

      {manageOpen && (
        <ManageModal habits={habits} tasks={tasks}
          onClose={() => setManageOpen(false)}
          onEditHabit={(h) => { setManageOpen(false); setModal({ open: true, type: 'habit', editId: h.id }) }}
          onEditTask={(t) => { setManageOpen(false); setModal({ open: true, type: 'task', editId: t.id }) }}
          onDeleteHabit={async (id) => { setHabits(p => p.filter(h => h.id !== id)); await dbDelete('habits', id) }}
          onDeleteTask={deleteTask} />
      )}
    </div>
  )
}

// ── DualRing ─────────────────────────────────────────────
function DualRing({ hScore, tScore, life, onClick, animKey }: any) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div key={animKey} style={{ position: 'relative', width: 110, height: 110, cursor: 'pointer', animation: 'popIn .6s cubic-bezier(.34,1.56,.64,1)' }} onClick={onClick}>
        <svg width="110" height="110" viewBox="0 0 110 110" style={{ position: 'absolute', inset: 0 }}>
          <circle cx="55" cy="55" r="46" fill="none" stroke="rgba(0,232,122,.08)" strokeWidth="7" />
          <circle cx="55" cy="55" r="46" fill="none" stroke="#00e87a" strokeWidth="7" strokeLinecap="round"
            strokeDasharray="289" strokeDashoffset={289 - (hScore / 100) * 289} transform="rotate(-90 55 55)"
            style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(.34,1.4,.64,1)', filter: hScore > 0 ? 'drop-shadow(0 0 4px rgba(0,232,122,.5))' : 'none' }} />
          <circle cx="55" cy="55" r="33" fill="none" stroke="rgba(61,127,255,.08)" strokeWidth="7" />
          <circle cx="55" cy="55" r="33" fill="none" stroke="#3d7fff" strokeWidth="7" strokeLinecap="round"
            strokeDasharray="207" strokeDashoffset={207 - (tScore / 100) * 207} transform="rotate(-90 55 55)"
            style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(.34,1.4,.64,1) .1s', filter: tScore > 0 ? 'drop-shadow(0 0 4px rgba(61,127,255,.5))' : 'none' }} />
        </svg>
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', textAlign: 'center' }}>
          <span style={{ display: 'block', fontFamily: 'monospace', fontSize: 18, fontWeight: 500, color: '#dce4f5', animation: 'numberTick .3s ease' }} key={life}>{life}</span>
          <span style={{ display: 'block', fontSize: 8, color: '#3d4f68', textTransform: 'uppercase', letterSpacing: 1.5 }}>life</span>
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {[{ c: '#00e87a', l: 'H', v: hScore }, { c: '#3d7fff', l: 'T', v: tScore }].map(r => (
          <div key={r.l} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, fontFamily: 'monospace' }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: r.c, boxShadow: `0 0 6px ${r.c}` }} />
            <span style={{ color: '#7a88a8' }}>{r.l} <span style={{ color: '#dce4f5', animation: 'numberTick .3s ease' }} key={r.v}>{r.v}%</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── SectionHeader ────────────────────────────────────────
function SectionHeader({ title, score, scoreColor, animKey }: any) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: '#7a88a8' }}>{title}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 80, height: 5, background: '#1c2235', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{ height: '100%', borderRadius: 3, background: scoreColor, width: `${score}%`, transition: 'width 1s cubic-bezier(.34,1.2,.64,1)' }} key={animKey} />
        </div>
        <span style={{ fontFamily: 'monospace', fontSize: 13, fontWeight: 500, color: scoreColor, minWidth: 36, textAlign: 'right', animation: 'numberTick .4s ease' }} key={score + animKey}>{score}%</span>
      </div>
    </div>
  )
}

// ── HabitCard ────────────────────────────────────────────
function HabitCard({ habit: h, idx, onToggle, onMetric, onBarDrag, onEdit }: any) {
  const c = COLORS[h.color as BrandColor] || '#00e87a'
  const pct = h.type === 'metric' && h.target ? Math.min(100, Math.round(((h.current_val || 0) / h.target) * 100)) : h.pct
  const pctColor = pct >= 100 ? '#00e87a' : pct >= 50 ? '#ffb830' : '#7a88a8'
  const daysLabel = h.active_days.length === 7 ? 'täglich' : h.active_days.map((d: number) => DSHORT[d]).join(', ')

  return (
    <div style={{ background: h.done ? 'rgba(0,232,122,.04)' : '#141928', border: `1px solid ${h.done ? 'rgba(0,232,122,.2)' : '#1e2840'}`, borderRadius: 12, padding: 14, marginBottom: 8, transition: 'all .3s ease', animation: `slideInLeft .4s ease ${idx * 0.05}s both` }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 9, flex: 1, minWidth: 0 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: c, boxShadow: `0 0 ${h.done ? '12px' : '6px'} ${c}`, flexShrink: 0, transition: 'box-shadow .3s' }} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: h.done ? 'none' : 'none', color: h.done ? '#dce4f5' : '#dce4f5' }}>{h.name}</div>
            <div style={{ fontSize: 9, color: '#3d4f68', fontFamily: 'monospace' }}>{daysLabel}</div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <span style={{ fontFamily: 'monospace', fontSize: 12, color: pctColor, animation: 'numberTick .3s ease', transition: 'color .3s' }} key={pct}>{pct}%</span>
          <EditBtn onClick={onEdit} />
          {h.type === 'binary' && (
            <div onClick={onToggle}
              style={{ width: 20, height: 20, borderRadius: 5, border: `1.5px solid ${h.done ? '#00e87a' : '#3d4f70'}`, background: h.done ? '#00e87a' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, boxShadow: h.done ? '0 0 14px rgba(0,232,122,.5)' : 'none', transition: 'all .25s cubic-bezier(.34,1.56,.64,1)', animation: h.done ? 'checkBounce .4s ease' : 'none' }}>
              {h.done && <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>}
            </div>
          )}
        </div>
      </div>

      {/* Progress bar – draggable for metric */}
      <div onMouseDown={h.type === 'metric' ? onBarDrag : undefined}
        onClick={h.type === 'binary' ? onToggle : undefined}
        style={{ height: 5, background: '#232c42', borderRadius: 3, marginTop: 10, overflow: 'hidden', cursor: h.type === 'metric' ? 'ew-resize' : 'pointer', position: 'relative', userSelect: 'none' }}>
        <div style={{ height: '100%', borderRadius: 3, background: `linear-gradient(90deg,${c}aa,${c})`, width: `${pct}%`, transition: h.type === 'binary' ? 'width .5s cubic-bezier(.34,1.2,.64,1)' : 'width .1s', position: 'relative' }}>
          {h.type === 'metric' && pct > 0 && (
            <div style={{ position: 'absolute', right: 0, top: '50%', transform: 'translateY(-50%)', width: 9, height: 9, borderRadius: '50%', background: c, boxShadow: `0 0 6px ${c}`, border: '1.5px solid #141928' }} />
          )}
        </div>
      </div>

      {h.type === 'metric' && (
        <div style={{ marginTop: 10, background: '#1c2235', border: '1px solid #2d3a55', borderRadius: 8, padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10, transition: 'border-color .2s' }}>
          <input type="number" min={0} max={(h.target || 1) * 2} step={0.1} value={h.current_val || 0}
            onChange={e => onMetric(parseFloat(e.target.value) || 0)}
            style={{ background: 'transparent', border: 'none', color: '#dce4f5', fontFamily: 'monospace', fontSize: 14, fontWeight: 500, width: 55, textAlign: 'right', outline: 'none' }} />
          <span style={{ fontSize: 11, color: '#3d4f68', flex: 1 }}>/ {h.target} {h.unit}</span>
          <span style={{ fontFamily: 'monospace', fontSize: 11, padding: '2px 7px', borderRadius: 5, background: '#232c42', color: pctColor, transition: 'color .3s' }} key={pct}>{pct}%</span>
        </div>
      )}
    </div>
  )
}

// ── TaskCard ─────────────────────────────────────────────
function TaskCard({ task: t, idx, completing, showSub, onComplete, onToggleSub, onToggleSubItem, onEdit }: any) {
  const isOver = t.rollover || (!!t.due && (dueDiff(t.due) ?? 0) < 0)
  const diff = dueDiff(t.due)

  return (
    <div style={{ background: isOver ? 'rgba(255,77,106,.06)' : '#141928', border: `1px solid ${isOver ? 'rgba(255,77,106,.3)' : '#1e2840'}`, borderRadius: 10, padding: '13px 14px', marginBottom: 8, display: 'flex', alignItems: 'flex-start', gap: 10, transition: 'all .2s', animation: completing ? 'slideOutRight .4s ease forwards' : `slideInLeft .4s ease ${idx * 0.04}s both`, overflow: 'hidden' }}>
      <div onClick={onComplete}
        style={{ width: 20, height: 20, borderRadius: 5, border: '1.5px solid #3d4f70', background: 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 2, flexShrink: 0, transition: 'all .2s' }}
        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#00e87a'; (e.currentTarget as HTMLElement).style.background = 'rgba(0,232,122,.1)' }}
        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#3d4f70'; (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="rgba(255,255,255,.2)" strokeWidth="2" strokeLinecap="round" /></svg>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 6, flexWrap: 'wrap' }}>
          <PrioBadge prio={t.prio} />
          {isOver && <span style={{ fontSize: 10, color: '#ff4d6a', fontFamily: 'monospace', animation: 'pulseGlow .5s ease infinite' }}>⚠ überfällig</span>}
          {t.due && diff !== null && (
            <span style={{ fontSize: 10, fontFamily: 'monospace', padding: '2px 7px', borderRadius: 4, border: '1px solid', color: diff < 0 ? '#ff4d6a' : diff <= 3 ? '#ffb830' : '#3d4f68', borderColor: diff < 0 ? 'rgba(255,77,106,.25)' : diff <= 3 ? 'rgba(255,184,48,.25)' : '#1e2840', background: diff < 0 ? 'rgba(255,77,106,.06)' : diff <= 3 ? 'rgba(255,184,48,.06)' : 'transparent' }}>
              📅 {diff < 0 ? `${Math.abs(diff)}d überfällig` : diff === 0 ? 'heute' : `in ${diff}d`}
            </span>
          )}
          {t.subs.length > 0 && (
            <button onClick={onToggleSub} style={{ fontSize: 10, color: '#3d4f68', padding: '2px 6px', background: '#1c2235', borderRadius: 4, border: '1px solid #1e2840', cursor: 'pointer', transition: 'all .15s' }}>
              {showSub ? '▲' : '▼'} {t.subs.length}
            </button>
          )}
        </div>
        {showSub && t.subs.length > 0 && (
          <div style={{ marginTop: 8, marginLeft: 30, borderLeft: '2px solid #1e2840', paddingLeft: 10, animation: 'fadeIn .2s ease' }}>
            {t.subs.map((s: Sub, si: number) => (
              <div key={si} onClick={() => onToggleSubItem(si)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', fontSize: 12, color: s.d ? '#3d4f68' : '#7a88a8', textDecoration: s.d ? 'line-through' : 'none', cursor: 'pointer', transition: 'color .2s' }}>
                <div style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${s.d ? '#00b35c' : '#2d3a55'}`, background: s.d ? '#00b35c' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 8, color: 'white', transition: 'all .2s' }}>{s.d ? '✓' : ''}</div>
                {s.t}
              </div>
            ))}
          </div>
        )}
      </div>
      <EditBtn onClick={onEdit} />
    </div>
  )
}

// ── ProjectCard ───────────────────────────────────────────
function ProjectCard({ project: p, idx, onToggleItem, onToggleSub, onStatusChange, onEdit, onDelete }: any) {
  const c = COLORS[p.color as BrandColor] || '#3d7fff'
  const total = p.items.length; const done = p.items.filter((i: ProjItem) => i.d).length
  const pct = total ? Math.round((done / total) * 100) : 0
  const circ = 2 * Math.PI * 22; const offset = circ - (pct / 100) * circ

  return (
    <div style={{ background: '#141928', border: '1px solid #1e2840', borderRadius: 12, padding: 16, transition: 'border-color .2s, transform .15s', animation: `fadeIn .5s ease ${idx * 0.08}s both` }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#2d3a55'; (e.currentTarget as HTMLElement).style.transform = 'translateY(-2px)' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#1e2840'; (e.currentTarget as HTMLElement).style.transform = 'translateY(0)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{p.name}</div>
          <div style={{ fontSize: 11, color: '#3d4f68', marginTop: 3, fontFamily: 'monospace' }}>{p.deadline}</div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
          <div style={{ fontSize: 9, padding: '2px 7px', borderRadius: 4, fontFamily: 'monospace', border: '1px solid', color: c, borderColor: c + '30', background: c + '12' }}>{pct}%</div>
          <select value={p.status} onChange={e => onStatusChange(e.target.value)}
            style={{ fontSize: 10, padding: '3px 8px', borderRadius: 5, border: '1px solid #2d3a55', background: '#1c2235', fontFamily: 'monospace', cursor: 'pointer', outline: 'none', color: STATUS_COLORS[p.status as ProjectStatus] }}>
            {(Object.keys(STATUS_LABELS) as ProjectStatus[]).map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <div style={{ display: 'flex', gap: 4 }}>
            <button onClick={onEdit} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '4px 9px', background: 'rgba(61,127,255,.08)', border: '1px solid rgba(61,127,255,.2)', borderRadius: 6, color: '#3d7fff', cursor: 'pointer', fontSize: 10, fontWeight: 600 }}>✏ Edit</button>
            <button onClick={onDelete} style={{ padding: '4px 8px', background: 'rgba(255,77,106,.08)', border: '1px solid rgba(255,77,106,.2)', borderRadius: 6, color: '#ff4d6a', cursor: 'pointer', fontSize: 10 }}>🗑</button>
          </div>
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, paddingTop: 10, borderTop: '1px solid #1e2840' }}>
        <div style={{ position: 'relative', flexShrink: 0 }}>
          <svg width="52" height="52" viewBox="0 0 52 52">
            <circle cx="26" cy="26" r="22" fill="none" stroke={c + '20'} strokeWidth="5" />
            <circle cx="26" cy="26" r="22" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round"
              strokeDasharray={circ} strokeDashoffset={offset} transform="rotate(-90 26 26)"
              style={{ transition: 'stroke-dashoffset .8s cubic-bezier(.34,1.2,.64,1)' }} />
          </svg>
          <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%,-50%)', fontFamily: 'monospace', fontSize: 10, fontWeight: 500, color: c }}>{pct}%</div>
        </div>
        <div style={{ flex: 1, fontSize: 11 }}>
          {[['Erledigt', `${done}/${total}`], ['Status', STATUS_LABELS[p.status as ProjectStatus]]].map(([k, v]) => (
            <div key={k} style={{ display: 'flex', justifyContent: 'space-between', color: '#7a88a8', marginBottom: 3 }}>
              <span>{k}</span><span style={{ fontFamily: 'monospace', color: k === 'Status' ? STATUS_COLORS[p.status as ProjectStatus] : '#dce4f5' }}>{v}</span>
            </div>
          ))}
        </div>
      </div>
      <div style={{ marginTop: 10 }}>
        {p.items.map((item: ProjItem, ii: number) => (
          <div key={ii}>
            <div onClick={() => onToggleItem(ii)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 0', fontSize: 12, color: item.d ? '#3d4f68' : '#7a88a8', textDecoration: item.d ? 'line-through' : 'none', borderBottom: '1px solid #1e2840', cursor: 'pointer', transition: 'color .2s' }}>
              <div style={{ width: 14, height: 14, borderRadius: 3, border: `1px solid ${item.d ? '#00b35c' : '#2d3a55'}`, background: item.d ? '#00b35c' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 8, color: 'white', transition: 'all .25s' }}>{item.d ? '✓' : ''}</div>
              {item.t}
            </div>
            {item.subs.map((s: Sub, si: number) => (
              <div key={si} onClick={() => onToggleSub(ii, si)} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '4px 0 4px 20px', fontSize: 11, color: s.d ? '#3d4f68' : '#3d4f68', textDecoration: s.d ? 'line-through' : 'none', cursor: 'pointer' }}>
                <div style={{ width: 11, height: 11, borderRadius: 2, border: `1px solid ${s.d ? '#00b35c' : '#1e2840'}`, background: s.d ? '#00b35c' : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontSize: 7, color: 'white' }}>{s.d ? '✓' : ''}</div>
                {s.t}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Analytics (real Supabase data) ───────────────────────
function Analytics({ history }: { history: DaySummary[] }) {
  const now = new Date(); const year = now.getFullYear()
  const start = new Date(year, 0, 1)
  const days: Date[] = []
  for (let i = 0; i < 364; i++) { const d = new Date(start); d.setDate(d.getDate() + i); days.push(d) }

  const scores = days.map(d => {
    const dateStr = d.toISOString().split('T')[0]
    const entry = history.find(h => h.date === dateStr)
    return entry ? entry.life_score : (d <= now ? null : null)
  })

  const realScores = scores.filter(s => s !== null) as number[]
  const avg7 = realScores.length >= 1 ? Math.round(realScores.slice(-7).reduce((a, b) => a + b, 0) / Math.min(7, realScores.slice(-7).length)) : 0
  const avg30 = realScores.length >= 1 ? Math.round(realScores.slice(-30).reduce((a, b) => a + b, 0) / Math.min(30, realScores.slice(-30).length)) : 0
  const avgY = realScores.length ? Math.round(realScores.reduce((a, b) => a + b, 0) / realScores.length) : 0
  let cur = 0; let maxStr = 0
  realScores.forEach(s => { if (s > 70) { cur++; maxStr = Math.max(maxStr, cur) } else cur = 0 })
  const delta = avg7 - avg30

  const MONTHS = ['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez']
  const lblArr = new Array(52).fill(''); let lastM = -1
  days.forEach((d, i) => { if (d.getMonth() !== lastM) { const col = Math.floor(i / 7); if (col < 52) lblArr[col] = MONTHS[d.getMonth()]; lastM = d.getMonth() } })

  const isEmpty = realScores.length === 0

  return (
    <div style={{ background: '#0f1420', border: '1px solid #1e2840', borderRadius: 18, padding: 20, animation: 'fadeIn .6s ease .5s both' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 2, color: '#7a88a8' }}>Analytics — {year}</div>
        <div style={{ fontSize: 11, color: '#3d4f68', fontFamily: 'monospace' }}>
          {isEmpty ? 'Noch keine Daten – beende deinen ersten Tag!' : '0% dunkel → 100% grün'}
        </div>
      </div>

      {isEmpty ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#3d4f68' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
          <div style={{ fontSize: 13 }}>Deine Analytics erscheinen hier nachdem du deinen ersten Tag abgeschlossen hast.</div>
          <div style={{ fontSize: 11, marginTop: 8 }}>Klicke oben auf "Tagesanalyse" → "Speichern"</div>
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            {[{ lbl: '7-Tage Avg', val: avg7 + '%', delta: (delta >= 0 ? '+' : '') + delta + '% vs 30d', pos: delta >= 0 }, { lbl: '30-Tage Avg', val: avg30 + '%' }, { lbl: 'Bester Streak', val: String(maxStr), delta: 'Tage über 70%', pos: true }, { lbl: 'Jahr Avg', val: avgY + '%' }].map(s => (
              <div key={s.lbl} style={{ flex: 1, background: '#141928', borderRadius: 8, padding: 12, border: '1px solid #1e2840' }}>
                <div style={{ fontSize: 11, color: '#7a88a8', textTransform: 'uppercase', letterSpacing: '.8px' }}>{s.lbl}</div>
                <div style={{ fontFamily: 'monospace', fontSize: 20, fontWeight: 500, marginTop: 4, animation: 'numberTick .5s ease' }}>{s.val}</div>
                {s.delta && <div style={{ fontSize: 11, fontFamily: 'monospace', marginTop: 3, color: s.pos ? '#00e87a' : '#ff4d6a' }}>{s.delta}</div>}
              </div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(52, 1fr)', gap: 2, marginBottom: 4 }}>
            {lblArr.map((l, i) => <span key={i} style={{ fontSize: 9, color: '#3d4f68', fontFamily: 'monospace' }}>{l}</span>)}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(52, 1fr)', gap: 2 }}>
            {scores.map((s, i) => (
              <div key={i} title={`${days[i]?.toLocaleDateString('de-DE')} — ${s !== null ? s + '%' : 'kein Eintrag'}`}
                style={{ aspectRatio: '1', borderRadius: 2, background: s !== null && s > 0 ? scoreColor(s) : '#1c2235', cursor: 'pointer', transition: 'transform .1s, opacity .2s', opacity: s === null ? 0.3 : 1, animation: s !== null && s > 0 ? `fadeIn .3s ease ${(i % 52) * 0.005}s both` : 'none' }}
                onMouseEnter={e => (e.target as HTMLElement).style.transform = 'scale(1.5)'}
                onMouseLeave={e => (e.target as HTMLElement).style.transform = 'scale(1)'} />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Analysis Modal (was End Day) ──────────────────────────
function AnalysisModal({ hScore, tScore, life, history, projects, streak, onClose, onSave }: any) {
  const yesterday = history.length ? history[history.length - 1]?.life_score ?? 0 : 0
  const delta = life - yesterday
  const pdone = projects.length ? Math.round(projects.reduce((a: number, p: Project) => { const t = p.items.length; const d = p.items.filter((i: ProjItem) => i.d).length; return a + (t ? d / t : 0) }, 0) / projects.length * 100) : 0
  const TITLES: Record<number, string> = { 100: 'Legendärer Tag! 🏆', 80: 'Starke Leistung! 💪', 60: 'Solider Fortschritt 👍', 40: 'Gut angefangen ✊', 0: 'Weiter so! 🌱' }
  const lvl = life >= 100 ? 100 : life >= 80 ? 80 : life >= 60 ? 60 : life >= 40 ? 40 : 0
  const PCOLS = ['#00e87a','#3d7fff','#9b6dff','#ffb830','#ff4d6a','#00d4c8']

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.85)', backdropFilter: 'blur(12px)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#0f1420', border: '1px solid #2d3a55', borderRadius: 28, width: 580, maxWidth: '94vw', padding: 40, textAlign: 'center', position: 'relative', overflow: 'hidden', animation: 'modalIn .4s cubic-bezier(.34,1.4,.64,1)' }}>
        <div style={{ position: 'absolute', width: 300, height: 300, borderRadius: '50%', background: 'radial-gradient(circle,rgba(0,232,122,.12),transparent 70%)', top: -80, left: '50%', transform: 'translateX(-50%)', pointerEvents: 'none' }} />
        <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
          {PCOLS.map((c, i) => <div key={i} style={{ position: 'absolute', width: 6, height: 6, borderRadius: '50%', background: c, left: `${10 + i * 16}%`, bottom: 0, animation: `float ${2 + i * 0.3}s ease-in ${i * 0.4}s infinite` }} />)}
        </div>
        <div style={{ position: 'relative' }}>
          <div style={{ fontSize: 13, color: '#3d4f68', textTransform: 'uppercase', letterSpacing: 2, fontWeight: 600 }}>Tagesanalyse</div>
          <div style={{ fontFamily: 'monospace', fontSize: 72, fontWeight: 500, background: 'linear-gradient(135deg,#00e87a,#00d4c8)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', lineHeight: 1, margin: '16px 0 8px', animation: 'popIn .6s cubic-bezier(.34,1.56,.64,1)' }}>{life}%</div>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: -1, marginBottom: 4 }}>{TITLES[lvl]}</div>
          {streak > 0 && <div style={{ fontSize: 13, color: '#00e87a', marginBottom: 8, animation: 'slideInUp .4s ease .2s both' }}>🔥 {streak} Tage Streak!</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, margin: '20px 0' }}>
            {[{ val: hScore + '%', lbl: 'Habits', col: '#00e87a' }, { val: tScore + '%', lbl: 'Tasks', col: '#3d7fff' }, { val: pdone + '%', lbl: 'Projekte', col: '#9b6dff' }].map((s, i) => (
              <div key={s.lbl} style={{ background: '#141928', borderRadius: 12, padding: 14, border: '1px solid #1e2840', animation: `popIn .5s ease ${i * 0.1}s both` }}>
                <div style={{ fontFamily: 'monospace', fontSize: 22, fontWeight: 500, marginBottom: 4, color: s.col }}>{s.val}</div>
                <div style={{ fontSize: 10, color: '#7a88a8', textTransform: 'uppercase', letterSpacing: 1 }}>{s.lbl}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 13, color: '#7a88a8', padding: 12, background: '#141928', borderRadius: 10, marginBottom: 20, border: '1px solid #1e2840' }}>
            Gestern: <strong style={{ color: '#dce4f5' }}>{yesterday}%</strong> → Heute: <strong style={{ color: '#dce4f5' }}>{life}%</strong> —{' '}
            {delta >= 0 ? <strong style={{ color: '#00e87a' }}>+{delta}% besser 📈</strong> : <span style={{ color: '#ffb830' }}>{delta}% – morgen wieder angreifen</span>}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
            <button onClick={onSave} style={{ padding: '12px 28px', background: 'linear-gradient(135deg,#2563d4,#7c4fd4)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'transform .2s' }}
              onMouseEnter={e => (e.currentTarget.style.transform = 'translateY(-2px)')}
              onMouseLeave={e => (e.currentTarget.style.transform = 'translateY(0)')}>
              💾 In Supabase speichern
            </button>
            <button onClick={onClose} style={{ padding: '12px 28px', background: 'transparent', border: '1px solid #2d3a55', borderRadius: 10, color: '#7a88a8', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
              Schließen
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#3d4f68', marginTop: 12 }}>Der automatische Reset erfolgt um Mitternacht.</div>
        </div>
      </div>
    </div>
  )
}

// ── Manage Modal ─────────────────────────────────────────
function ManageModal({ habits, tasks, onClose, onEditHabit, onEditTask, onDeleteHabit, onDeleteTask }: any) {
  const [tab, setTab] = useState<'habits' | 'tasks'>('habits')

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#0f1420', border: '1px solid #2d3a55', borderRadius: 24, width: 560, maxWidth: '94vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', animation: 'modalIn .35s cubic-bezier(.34,1.4,.64,1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>Verwalten</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: '#1c2235', border: '1px solid #2d3a55', color: '#7a88a8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>✕</button>
        </div>
        <div style={{ display: 'flex', gap: 8, padding: '16px 24px 0' }}>
          {(['habits', 'tasks'] as const).map(t => (
            <button key={t} onClick={() => setTab(t)} style={{ flex: 1, padding: '9px', borderRadius: 9, border: `1px solid ${tab === t ? '#3d7fff' : '#1e2840'}`, background: tab === t ? 'rgba(61,127,255,.15)' : '#141928', color: tab === t ? '#dce4f5' : '#7a88a8', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s' }}>
              {t === 'habits' ? `Habits (${habits.length})` : `Tasks (${tasks.length})`}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px 24px' }}>
          {tab === 'habits' && (
            <div style={{ animation: 'tabSlide .2s ease' }}>
              {habits.map((h: Habit, i: number) => (
                <div key={h.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#141928', borderRadius: 10, marginBottom: 8, border: '1px solid #1e2840', animation: `slideInLeft .3s ease ${i * 0.03}s both` }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: COLORS[h.color], flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{h.name}</div>
                    <div style={{ fontSize: 10, color: '#3d4f68', fontFamily: 'monospace' }}>{h.type} · {h.active_days.length === 7 ? 'täglich' : h.active_days.map(d => DSHORT[d]).join(', ')}</div>
                  </div>
                  <button onClick={() => onEditHabit(h)} style={{ padding: '4px 9px', background: 'rgba(61,127,255,.08)', border: '1px solid rgba(61,127,255,.2)', borderRadius: 6, color: '#3d7fff', cursor: 'pointer', fontSize: 10 }}>✏ Edit</button>
                  <button onClick={() => onDeleteHabit(h.id)} style={{ padding: '4px 8px', background: 'rgba(255,77,106,.08)', border: '1px solid rgba(255,77,106,.2)', borderRadius: 6, color: '#ff4d6a', cursor: 'pointer', fontSize: 10 }}>🗑</button>
                </div>
              ))}
            </div>
          )}
          {tab === 'tasks' && (
            <div style={{ animation: 'tabSlide .2s ease' }}>
              {tasks.map((t: Task, i: number) => (
                <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: '#141928', borderRadius: 10, marginBottom: 8, border: '1px solid #1e2840', opacity: t.done ? 0.6 : 1, animation: `slideInLeft .3s ease ${i * 0.03}s both` }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: t.done ? '#3d4f68' : { high: '#ff4d6a', med: '#ffb830', low: '#3d4f68' }[t.prio], flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, textDecoration: t.done ? 'line-through' : 'none', color: t.done ? '#3d4f68' : '#dce4f5' }}>{t.title}</div>
                    <div style={{ fontSize: 10, color: '#3d4f68', fontFamily: 'monospace' }}>{t.prio} · {t.done ? '✓ erledigt' : t.due ? `fällig: ${t.due}` : 'kein Datum'}</div>
                  </div>
                  {!t.done && <button onClick={() => onEditTask(t)} style={{ padding: '4px 9px', background: 'rgba(61,127,255,.08)', border: '1px solid rgba(61,127,255,.2)', borderRadius: 6, color: '#3d7fff', cursor: 'pointer', fontSize: 10 }}>✏ Edit</button>}
                  <button onClick={() => onDeleteTask(t.id)} style={{ padding: '4px 8px', background: 'rgba(255,77,106,.08)', border: '1px solid rgba(255,77,106,.2)', borderRadius: 6, color: '#ff4d6a', cursor: 'pointer', fontSize: 10 }}>🗑</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Add/Edit Modal ───────────────────────────────────────
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
    if (!editId) return
    if (initType === 'habit') { const h = habits.find((x: Habit) => x.id === editId); if (h) { setTitle(h.name); setColor(h.color); setHType(h.type); setActiveDays(h.active_days); setTarget(h.target?.toString() || ''); setUnit(h.unit || '') } }
    if (initType === 'task') { const t = tasks.find((x: Task) => x.id === editId); if (t) { setTitle(t.title); setPrio(t.prio); setDue(t.due || ''); setSubsRaw(t.subs.map((s: Sub) => s.t).join(', ')) } }
    if (initType === 'project') { const p = projects.find((x: Project) => x.id === editId); if (p) { setTitle(p.name); setColor(p.color); setDeadline(p.deadline); setProjItems([...p.items.map((i: ProjItem) => i.t), '']) } }
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

  const IS = (s: React.CSSProperties): React.CSSProperties => ({ width: '100%', background: '#141928', border: '1px solid #2d3a55', borderRadius: 8, color: '#dce4f5', fontFamily: 'inherit', fontSize: 14, padding: '10px 12px', outline: 'none', ...s })

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.75)', backdropFilter: 'blur(8px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 200 }} onClick={e => e.target === e.currentTarget && onClose()}>
      <div style={{ background: '#0f1420', border: '1px solid #2d3a55', borderRadius: 24, width: 520, maxWidth: '94vw', maxHeight: '90vh', overflowY: 'auto', padding: 28, animation: 'modalIn .35s cubic-bezier(.34,1.4,.64,1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <span style={{ fontSize: 18, fontWeight: 800, letterSpacing: -0.5 }}>{editId ? 'Bearbeiten' : 'Neu erstellen'}</span>
          <button onClick={onClose} style={{ width: 28, height: 28, borderRadius: 7, background: '#1c2235', border: '1px solid #2d3a55', color: '#7a88a8', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>✕</button>
        </div>

        {!editId && (
          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {(['task', 'habit', 'project'] as const).map(t => (
              <button key={t} onClick={() => setType(t)} style={{ flex: 1, padding: 9, borderRadius: 9, border: `1px solid ${type === t ? '#3d7fff' : '#1e2840'}`, background: type === t ? 'rgba(61,127,255,.15)' : '#141928', color: type === t ? '#dce4f5' : '#7a88a8', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s' }}>
                {{ task: 'Task', habit: 'Habit', project: 'Projekt' }[t]}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <MF label="Titel"><input autoFocus value={title} onChange={e => setTitle(e.target.value)} placeholder={type === 'task' ? 'Was willst du erledigen?' : type === 'habit' ? 'Habit-Name…' : 'Projektname…'} style={IS({})} onFocus={e => (e.target.style.borderColor = '#3d7fff')} onBlur={e => (e.target.style.borderColor = '#2d3a55')} /></MF>

          {type === 'task' && <>
            <MF label="Priorität">
              <div style={{ display: 'flex', gap: 7 }}>
                {(['high', 'med', 'low'] as Priority[]).map(p => {
                  const cols: Record<Priority, string> = { high: '#ff4d6a', med: '#ffb830', low: '#3d4f68' }
                  const active = prio === p
                  return <button key={p} onClick={() => setPrio(p)} style={{ flex: 1, padding: '7px 13px', borderRadius: 7, border: `1px solid ${active ? cols[p] : '#1e2840'}`, background: active ? cols[p] + '18' : '#141928', color: active ? cols[p] : '#7a88a8', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s' }}>
                    {{ high: '🔴 High', med: '🟡 Med', low: '⚪ Low' }[p]}
                  </button>
                })}
              </div>
            </MF>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <MF label="Fälligkeitsdatum"><input type="date" value={due} onChange={e => setDue(e.target.value)} style={IS({})} /></MF>
              <MF label="Sub-Tasks (Komma)"><input value={subsRaw} onChange={e => setSubsRaw(e.target.value)} placeholder="Recherche, Entwurf" style={IS({})} /></MF>
            </div>
          </>}

          {type === 'habit' && <>
            <MF label="Typ">
              <div style={{ display: 'flex', gap: 7 }}>
                {(['binary', 'metric'] as HabitType[]).map(t => (
                  <button key={t} onClick={() => setHType(t)} style={{ flex: 1, padding: '7px 13px', borderRadius: 7, border: `1px solid ${hType === t ? '#3d7fff' : '#1e2840'}`, background: hType === t ? 'rgba(61,127,255,.1)' : '#141928', color: hType === t ? '#3d7fff' : '#7a88a8', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s' }}>
                    {t === 'binary' ? '✓ Binary' : '📊 Metrisch'}
                  </button>
                ))}
              </div>
            </MF>
            {hType === 'metric' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <MF label="Zielwert"><input type="number" value={target} onChange={e => setTarget(e.target.value)} placeholder="2" style={IS({})} /></MF>
                <MF label="Einheit"><input value={unit} onChange={e => setUnit(e.target.value)} placeholder="L, km, min" style={IS({})} /></MF>
              </div>
            )}
            <MF label="Aktive Tage">
              <div style={{ display: 'flex', gap: 5 }}>
                {DSHORT.map((d, i) => (
                  <button key={i} onClick={() => setActiveDays(prev => prev.includes(i) ? prev.filter(x => x !== i) : [...prev, i])}
                    style={{ width: 32, height: 32, borderRadius: 7, border: `1px solid ${activeDays.includes(i) ? '#3d7fff' : '#1e2840'}`, background: activeDays.includes(i) ? 'rgba(61,127,255,.15)' : '#141928', color: activeDays.includes(i) ? '#3d7fff' : '#3d4f68', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .15s' }}>{d}</button>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 5, marginTop: 6 }}>
                {[['Alle', [0,1,2,3,4,5,6]], ['Mo–Fr', [0,1,2,3,4]], ['WE', [5,6]]].map(([l, d]) => (
                  <button key={l as string} onClick={() => setActiveDays(d as number[])} style={{ padding: '4px 9px', background: '#141928', border: '1px solid #1e2840', borderRadius: 6, fontSize: 10, color: '#7a88a8', cursor: 'pointer', fontFamily: 'inherit' }}>{l as string}</button>
                ))}
              </div>
            </MF>
            <MF label="Farbe">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {CNAMES.map(cn => (
                  <button key={cn} onClick={() => setColor(cn)} style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 10px', borderRadius: 7, border: `1px solid ${color === cn ? COLORS[cn] : '#1e2840'}`, background: color === cn ? COLORS[cn] + '18' : '#141928', color: color === cn ? COLORS[cn] : '#7a88a8', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', transition: 'all .2s' }}>
                    <div style={{ width: 9, height: 9, borderRadius: '50%', background: COLORS[cn] }} />{cn}
                  </button>
                ))}
              </div>
            </MF>
          </>}

          {type === 'project' && <>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <MF label="Deadline"><input value={deadline} onChange={e => setDeadline(e.target.value)} placeholder="Q2 2026" style={IS({})} /></MF>
              <MF label="Farbe">
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                  {CNAMES.map(cn => <div key={cn} onClick={() => setColor(cn)} style={{ width: 20, height: 20, borderRadius: '50%', background: COLORS[cn], border: `2px solid ${color === cn ? '#dce4f5' : 'transparent'}`, cursor: 'pointer', transform: color === cn ? 'scale(1.2)' : 'scale(1)', transition: 'all .15s' }} />)}
                </div>
              </MF>
            </div>
            <MF label="Items">
              {projItems.map((item, i) => (
                <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
                  <input value={item} onChange={e => { const arr = [...projItems]; arr[i] = e.target.value; setProjItems(arr) }} placeholder={`Item ${i + 1}…`} style={IS({ fontSize: 12, padding: '6px 10px' })} />
                  {projItems.length > 1 && <button onClick={() => setProjItems(projItems.filter((_, j) => j !== i))} style={{ padding: '4px 9px', background: 'rgba(127,29,29,.5)', border: '1px solid rgba(204,41,64,.5)', color: '#ff4d6a', borderRadius: 6, cursor: 'pointer', fontSize: 11 }}>✕</button>}
                </div>
              ))}
              <button onClick={() => setProjItems([...projItems, ''])} style={{ width: '100%', padding: 8, background: '#1c2235', border: '1px solid #2d3a55', borderRadius: 7, color: '#7a88a8', cursor: 'pointer', fontSize: 12, fontFamily: 'inherit' }}>+ Item</button>
            </MF>
          </>}

          <button onClick={submit} style={{ width: '100%', padding: 13, background: 'linear-gradient(135deg,#2563d4,#7c4fd4)', border: 'none', borderRadius: 10, color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', marginTop: 4, transition: 'transform .2s, box-shadow .2s' }}
            onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.boxShadow = '0 6px 24px rgba(61,127,255,.35)' }}
            onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.boxShadow = 'none' }}>
            {editId ? 'Änderungen speichern' : type === 'task' ? 'Task erstellen' : type === 'habit' ? 'Habit hinzufügen' : 'Projekt erstellen'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Micro-components ─────────────────────────────────────
function MF({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label style={{ display: 'block', fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1.5, color: '#3d4f68', marginBottom: 6 }}>{label}</label>{children}</div>
}

function EditBtn({ onClick }: { onClick: () => void }) {
  return (
    <button onClick={onClick} style={{ width: 22, height: 22, borderRadius: 5, border: '1px solid #1e2840', background: 'transparent', color: '#3d4f68', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0, transition: 'all .15s' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#3d7fff'; (e.currentTarget as HTMLElement).style.color = '#3d7fff' }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#1e2840'; (e.currentTarget as HTMLElement).style.color = '#3d4f68' }}>✏</button>
  )
}

function PrioBadge({ prio }: { prio: Priority }) {
  const s: Record<Priority, React.CSSProperties> = {
    high: { background: 'rgba(255,77,106,.15)', color: '#ff4d6a', border: '1px solid rgba(255,77,106,.2)' },
    med: { background: 'rgba(255,184,48,.12)', color: '#ffb830', border: '1px solid rgba(255,184,48,.18)' },
    low: { background: '#1c2235', color: '#3d4f68', border: '1px solid #1e2840' },
  }
  return <span style={{ fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4, textTransform: 'uppercase', letterSpacing: '.8px', ...s[prio] }}>{prio}</span>
}

function SortBar({ sort, onChange }: { sort: SortMode; onChange: (s: SortMode) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, color: '#3d4f68', textTransform: 'uppercase', letterSpacing: 1 }}>Sort:</span>
      {(['prio', 'due', 'alpha'] as SortMode[]).map(s => (
        <button key={s} onClick={() => onChange(s)} style={{ padding: '4px 10px', background: sort === s ? 'rgba(61,127,255,.12)' : '#141928', border: `1px solid ${sort === s ? '#3d7fff' : '#1e2840'}`, borderRadius: 6, fontSize: 10, fontWeight: 700, color: sort === s ? '#3d7fff' : '#3d4f68', cursor: 'pointer', fontFamily: 'monospace', transition: 'all .15s' }}>
          {{ prio: 'Priorität', due: 'Fälligkeit', alpha: 'A–Z' }[s]}
        </button>
      ))}
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: '#3d4f68', textAlign: 'center', padding: '24px 0', animation: 'fadeIn .4s ease' }}>{children}</div>
}

function Btn({ onClick, children, ghost, small, disabled }: any) {
  return (
    <button onClick={onClick} disabled={disabled}
      style={{ display: 'flex', alignItems: 'center', gap: 6, padding: small ? '6px 12px' : '10px 18px', background: ghost ? 'rgba(255,255,255,.04)' : 'linear-gradient(135deg,#2563d4,#7c4fd4)', border: ghost ? '1px solid #2d3a55' : 'none', borderRadius: 10, color: ghost ? '#7a88a8' : '#fff', fontSize: small ? 12 : 13, fontWeight: 700, cursor: disabled ? 'not-allowed' : 'pointer', fontFamily: 'inherit', opacity: disabled ? .4 : 1, transition: 'all .2s', boxShadow: ghost ? 'none' : '0 4px 16px rgba(61,127,255,.2)' }}
      onMouseEnter={e => { if (!disabled) { e.currentTarget.style.transform = 'translateY(-1px)'; e.currentTarget.style.opacity = '0.9' } }}
      onMouseLeave={e => { e.currentTarget.style.transform = 'translateY(0)'; e.currentTarget.style.opacity = disabled ? '0.4' : '1' }}>
      {children}
    </button>
  )
}
