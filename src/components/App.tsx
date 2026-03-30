'use client'
import { useState, useEffect, useCallback } from 'react'
import { dbLoad, dbUpsert, dbDelete, saveDailySummary, loadHistory, deleteOldCompletedTasks } from '@/lib/supabase'

// ── Types ────────────────────────────────────────────────
type Priority = 'high' | 'med' | 'low'
type HabitType = 'binary' | 'metric'
type ProjectStatus = 'on-track' | 'at-risk' | 'done' | 'paused'
type BrandColor = 'green' | 'blue' | 'purple' | 'amber' | 'red' | 'teal'
type SortMode = 'prio' | 'due' | 'alpha'
type MobileTab = 'home' | 'habits' | 'tasks' | 'projects' | 'analytics'

interface Sub { t: string; d: boolean }
interface Habit { id: string; name: string; color: BrandColor; type: HabitType; active_days: number[]; done: boolean; pct: number; target?: number; unit?: string; current_val?: number }
interface Task { id: string; title: string; prio: Priority; rollover: boolean; done: boolean; done_at?: string; subs: Sub[]; due: string }
interface ProjItem { t: string; d: boolean; subs: Sub[] }
interface Project { id: string; name: string; color: BrandColor; deadline: string; status: ProjectStatus; items: ProjItem[] }
interface DaySummary { date: string; life_score: number; habit_score: number; task_score: number }

// ── Constants ────────────────────────────────────────────
const COLORS: Record<BrandColor, string> = { green: '#00e87a', blue: '#3d7fff', purple: '#9b6dff', amber: '#ffb830', red: '#ff4d6a', teal: '#00d4c8' }
const CNAMES = Object.keys(COLORS) as BrandColor[]
const DSHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']
const PW: Record<Priority, number> = { high: 3, med: 2, low: 1 }
const STATUS_LABELS: Record<ProjectStatus, string> = { 'on-track': 'On Track', 'at-risk': 'At Risk', 'done': 'Fertig', 'paused': 'Pausiert' }
const STATUS_COLORS: Record<ProjectStatus, string> = { 'on-track': '#00e87a', 'at-risk': '#ffb830', 'done': '#3d7fff', 'paused': '#3d4f68' }
const DAILY_QUOTES = [
  "Disziplin ist die Brücke zwischen Zielen und Leistung.",
  "Kleine Fortschritte jeden Tag führen zu großen Ergebnissen.",
  "Du wirst nicht immer motiviert sein. Lerne, diszipliniert zu sein.",
  "Der einzige schlechte Workout ist der, der nicht stattfand.",
  "Erfolg ist die Summe kleiner Anstrengungen, täglich wiederholt.",
  "Wer aufhört, besser zu werden, hat aufgehört, gut zu sein.",
  "Dein zukünftiges Ich wird dir danken.",
  "Fortschritt, nicht Perfektion.",
  "Jeder Tag ist eine neue Chance.",
  "Stark sein bedeutet, weiterzumachen wenn alles aufhören will.",
  "Vergleiche dich nur mit der Person, die du gestern warst.",
  "Wachstum beginnt am Ende deiner Komfortzone.",
  "Heute ist der beste Tag, um anzufangen.",
  "Tu heute das, was andere nicht tun.",
  "Die meisten Hindernisse lösen sich durch konsequentes Handeln.",
]
const TODAY_DOW = (new Date().getDay() + 6) % 7
const TOMORROW = new Date(Date.now() + 86400000).toISOString().split('T')[0]

function todayStr() { return new Date().toISOString().split('T')[0] }
function dueDiff(due: string): number | null {
  if (!due) return null
  const n = new Date(); n.setHours(0,0,0,0)
  const d = new Date(due); d.setHours(0,0,0,0)
  return Math.round((d.getTime()-n.getTime())/864e5)
}
function scoreColor(s: number) {
  if (!s) return '#1c2235'
  return `rgb(${Math.round(5+(s/100)*17)},${Math.round(30+(s/100)*202)},${Math.round(20+(s/100)*74)})`
}

// Sparkle emitter
let _sc: HTMLDivElement|null=null
function emitSparkles(x?:number,y?:number) {
  if(typeof document==='undefined')return
  if(!_sc){_sc=document.createElement('div');_sc.style.cssText='position:fixed;inset:0;pointer-events:none;z-index:9999;overflow:hidden';document.body.appendChild(_sc)}
  const cx=x??window.innerWidth/2,cy=y??window.innerHeight/3
  const colors=['#00e87a','#3d7fff','#9b6dff','#ffb830','#00d4c8','#ff4d6a']
  for(let i=0;i<14;i++){
    const el=document.createElement('div'),sz=4+Math.random()*8
    const ang=(Math.PI*2*i)/14,dist=35+Math.random()*70
    el.style.cssText=`position:absolute;border-radius:50%;width:${sz}px;height:${sz}px;left:${cx}px;top:${cy}px;background:${colors[i%colors.length]};transform:translate(-50%,-50%);transition:transform .55s ease-out,opacity .55s ease-out`
    _sc.appendChild(el)
    requestAnimationFrame(()=>requestAnimationFrame(()=>{
      el.style.transform=`translate(calc(-50% + ${Math.cos(ang)*dist}px),calc(-50% + ${Math.sin(ang)*dist}px)) scale(0)`
      el.style.opacity='0'
    }))
    setTimeout(()=>el.remove(),650)
  }
}

// ── Row serializers – THE CRITICAL FIX ───────────────────
// subs/items MUST be plain arrays – dbUpsert will JSON.stringify them
function toHabitRow(h: Habit) {
  return {
    id: h.id, name: h.name, color: h.color, type: h.type,
    active_days: h.active_days, done: h.done, pct: h.pct,
    target: h.target??null, unit: h.unit??null, current_val: h.current_val??0
  }
}
function toTaskRow(t: Task) {
  return {
    id: t.id, title: t.title, prio: t.prio, rollover: t.rollover,
    done: t.done, done_at: t.done_at??null,
    subs: Array.isArray(t.subs) ? t.subs : [],   // always plain array
    due: t.due??''
  }
}
function toProjRow(p: Project) {
  return {
    id: p.id, name: p.name, color: p.color,
    deadline: p.deadline??'', status: p.status,
    items: Array.isArray(p.items) ? p.items : []  // always plain array
  }
}

// ── Score logic ───────────────────────────────────────────
function calcTaskScore(tasks: Task[]): number {
  const today = todayStr()
  const counted = tasks.filter(t => {
    if (!t.due) return true
    const diff = dueDiff(t.due)
    return diff===null || diff<=0
  })
  const bonus = tasks.filter(t => {
    if (!t.due) return false
    const diff = dueDiff(t.due)
    return (diff??0)>0 && t.done && t.done_at?.startsWith(today)
  })
  const maxP = counted.reduce((a,t)=>a+PW[t.prio],0)
  if (maxP===0) return 0
  const earnBase = counted.filter(t=>t.done&&t.done_at?.startsWith(today)).reduce((a,t)=>a+PW[t.prio],0)
  const earnBonus = bonus.reduce((a,t)=>a+PW[t.prio],0)
  return Math.min(100,Math.round(((earnBase+earnBonus)/maxP)*100))
}

// ── Default data ─────────────────────────────────────────
const DEFAULT_HABITS: Habit[] = [
  {id:'h1',name:'Meditation',color:'green',type:'binary',active_days:[0,1,2,3,4,5,6],done:false,pct:0},
  {id:'h2',name:'Wasser trinken',color:'blue',type:'metric',active_days:[0,1,2,3,4,5,6],done:false,pct:0,target:2,unit:'L',current_val:0},
  {id:'h3',name:'Sport',color:'teal',type:'binary',active_days:[0,2,4],done:false,pct:0},
  {id:'h4',name:'Journaling',color:'amber',type:'binary',active_days:[0,1,2,3,4,5,6],done:false,pct:0},
]
const DEFAULT_TASKS: Task[] = [
  {id:'t1',title:'Q4 Report finalisieren',prio:'high',rollover:true,done:false,subs:[{t:'Executive Summary',d:false}],due:'2025-03-20'},
  {id:'t2',title:'Team Meeting vorbereiten',prio:'high',rollover:false,done:false,subs:[],due:TOMORROW},
  {id:'t3',title:'Inbox auf null',prio:'med',rollover:false,done:false,subs:[],due:''},
]
const DEFAULT_PROJECTS: Project[] = [
  {id:'p1',name:'Website Relaunch',color:'blue',deadline:'Q1 2026',status:'on-track',items:[{t:'Design Mockups',d:true,subs:[]},{t:'Frontend',d:false,subs:[]},{t:'Launch',d:false,subs:[]}]},
]

// ── useIsMobile ───────────────────────────────────────────
function useIsMobile() {
  const [m,setM]=useState(false)
  useEffect(()=>{
    const c=()=>setM(window.innerWidth<768)
    c(); window.addEventListener('resize',c)
    return ()=>window.removeEventListener('resize',c)
  },[])
  return m
}

// ── Main App ──────────────────────────────────────────────
export default function App() {
  const isMobile = useIsMobile()
  const [habits,setHabits]=useState<Habit[]>(DEFAULT_HABITS)
  const [tasks,setTasks]=useState<Task[]>(DEFAULT_TASKS)
  const [projects,setProjects]=useState<Project[]>(DEFAULT_PROJECTS)
  const [history,setHistory]=useState<DaySummary[]>([])
  const [streak,setStreak]=useState(0)
  const [loading,setLoading]=useState(true)
  const [taskSort,setTaskSort]=useState<SortMode>('prio')
  const [mobileTab,setMobileTab]=useState<MobileTab>('home')
  const [modal,setModal]=useState<{type:'task'|'habit'|'project';editId?:string}|null>(null)
  const [analysisOpen,setAnalysisOpen]=useState(false)
  const [manageOpen,setManageOpen]=useState(false)
  const [showSubs,setShowSubs]=useState<Record<string,boolean>>({})
  const [completing,setCompleting]=useState<Set<string>>(new Set())
  const [lastReset,setLastReset]=useState('')
  const [animKey,setAnimKey]=useState(0)

  useEffect(()=>{
    async function load(){
      try{
        await deleteOldCompletedTasks()
        const [h,t,p,hist]=await Promise.all([dbLoad('habits'),dbLoad('tasks'),dbLoad('projects'),loadHistory()])
        if(h?.length) setHabits(h.map((r:any)=>({
          ...r,
          active_days: Array.isArray(r.active_days)?r.active_days:[0,1,2,3,4,5,6],
          current_val: r.current_val??0
        })))
        if(t?.length) setTasks(t.map((r:any)=>({
          ...r,
          // subs might come back as parsed JSON array from Supabase, or as string
          subs: Array.isArray(r.subs)?r.subs:(typeof r.subs==='string'?JSON.parse(r.subs):[]),
          due: r.due??''
        })))
        if(p?.length) setProjects(p.map((r:any)=>({
          ...r,
          items: Array.isArray(r.items)?r.items:(typeof r.items==='string'?JSON.parse(r.items):[])
        })))
        if(hist?.length){
          setHistory(hist)
          let s=0; for(let i=hist.length-1;i>=0;i--){if(hist[i].life_score>=50)s++;else break}
          setStreak(s)
        }
        setLastReset(localStorage.getItem('lastReset')||'')
      }catch(e){console.error(e)}finally{setLoading(false)}
    }
    load()
  },[])

  useEffect(()=>{
    if(loading)return
    const today=todayStr()
    if(!lastReset){localStorage.setItem('lastReset',today);setLastReset(today);return}
    if(lastReset<today)doMidnightReset()
    const iv=setInterval(()=>{
      const t=todayStr(),s=localStorage.getItem('lastReset')||''
      if(s&&s<t)doMidnightReset()
    },60000)
    return()=>clearInterval(iv)
  },[loading,lastReset])

  const calcScores=useCallback(()=>{
    const th=habits.filter(h=>h.active_days.includes(TODAY_DOW))
    const hScore=th.length?Math.round(th.reduce((a,h)=>a+h.pct,0)/th.length):0
    const tScore=calcTaskScore(tasks)
    return{hScore,tScore,life:Math.round((hScore+tScore)/2)}
  },[habits,tasks])

  async function doMidnightReset(){
    const today=todayStr()
    const yesterday=new Date(Date.now()-86400000).toISOString().split('T')[0]
    const{hScore,tScore,life}=calcScores()
    await saveDailySummary(yesterday,life,hScore,tScore,habits,tasks.filter(t=>t.done))
    const rH=habits.map(h=>({...h,done:false,pct:0,current_val:0}))
    setHabits(rH)
    await dbUpsert('habits',rH.map(toHabitRow))
    const hist=await loadHistory()
    setHistory(hist)
    localStorage.setItem('lastReset',today)
    setLastReset(today)
    setAnimKey(k=>k+1)
  }

  const{hScore,tScore,life}=calcScores()
  const histScores=history.map(h=>h.life_score)
  const avg7=histScores.length?Math.round(histScores.slice(-7).reduce((a,b)=>a+b,0)/Math.min(7,histScores.slice(-7).length)):0
  const avg30=histScores.length?Math.round(histScores.slice(-30).reduce((a,b)=>a+b,0)/Math.min(30,histScores.slice(-30).length)):0
  const todayQuote=DAILY_QUOTES[Math.floor(Date.now()/86400000)%DAILY_QUOTES.length]
  const hr=new Date().getHours()
  const greeting=hr<12?'Guten Morgen.':hr<17?'Guten Tag.':'Guten Abend.'
  const dateStr=new Date().toLocaleDateString('de-DE',{weekday:'long',day:'numeric',month:'long',year:'numeric'})

  // ── Habit actions ─────────────────────────────────────
  async function toggleHabit(id:string,e?:React.MouseEvent|React.TouchEvent){
    if(e&&'clientX'in e)emitSparkles(e.clientX,e.clientY);else emitSparkles()
    setHabits(prev=>prev.map(h=>{
      if(h.id!==id)return h
      const done=!h.done,updated={...h,done,pct:done?100:0}
      dbUpsert('habits',[toHabitRow(updated)])
      return updated
    }))
  }
  async function updateMetric(id:string,val:number){
    setHabits(prev=>prev.map(h=>{
      if(h.id!==id)return h
      const pct=h.target?Math.min(100,Math.round((val/h.target)*100)):0
      if(pct===100)emitSparkles()
      const updated={...h,current_val:val,pct}
      dbUpsert('habits',[toHabitRow(updated)])
      return updated
    }))
  }
  function handleBarDrag(id:string,e:React.MouseEvent<HTMLDivElement>|React.TouchEvent<HTMLDivElement>){
    e.preventDefault();e.stopPropagation()
    const bar=e.currentTarget,rect=bar.getBoundingClientRect()
    const h=habits.find(x=>x.id===id)
    if(!h?.target)return
    const getX=(ev:MouseEvent|TouchEvent)=>'touches'in ev?(ev.touches[0]?.clientX??ev.changedTouches[0]?.clientX??0):(ev as MouseEvent).clientX
    const update=(clientX:number)=>{
      const ratio=Math.max(0,Math.min(1,(clientX-rect.left)/rect.width))
      updateMetric(id,Math.round(ratio*h.target!*10)/10)
    }
    update(getX(e.nativeEvent as any))
    const onMove=(ev:MouseEvent|TouchEvent)=>{ev.preventDefault();update(getX(ev))}
    const onEnd=()=>{window.removeEventListener('mousemove',onMove);window.removeEventListener('touchmove',onMove);window.removeEventListener('mouseup',onEnd);window.removeEventListener('touchend',onEnd)}
    window.addEventListener('mousemove',onMove,{passive:false})
    window.addEventListener('touchmove',onMove,{passive:false})
    window.addEventListener('mouseup',onEnd)
    window.addEventListener('touchend',onEnd)
  }

  // ── Task actions ──────────────────────────────────────
  async function completeTask(id:string,e?:React.MouseEvent|React.TouchEvent){
    if(e&&'clientX'in e)emitSparkles(e.clientX,e.clientY);else emitSparkles()
    setCompleting(prev=>new Set(prev).add(id))
    setTimeout(()=>{
      setTasks(prev=>prev.map(t=>{
        if(t.id!==id)return t
        const updated={...t,done:true,done_at:new Date().toISOString()}
        dbUpsert('tasks',[toTaskRow(updated)])
        return updated
      }))
      setCompleting(prev=>{const n=new Set(prev);n.delete(id);return n})
    },380)
  }
  function toggleSubTask(taskId:string,si:number){
    setTasks(prev=>prev.map(t=>{
      if(t.id!==taskId)return t
      const subs=t.subs.map((s,i)=>i===si?{...s,d:!s.d}:s)
      const updated={...t,subs}
      dbUpsert('tasks',[toTaskRow(updated)])
      return updated
    }))
  }
  async function restoreTask(id:string){
    setTasks(prev=>prev.map(t=>{
      if(t.id!==id)return t
      const updated={...t,done:false,done_at:undefined}
      dbUpsert('tasks',[toTaskRow(updated)])
      return updated
    }))
  }
  async function deleteTask(id:string){setTasks(p=>p.filter(t=>t.id!==id));await dbDelete('tasks',id)}
  async function deleteHabit(id:string){setHabits(p=>p.filter(h=>h.id!==id));await dbDelete('habits',id)}
  async function deleteProject(id:string){setProjects(p=>p.filter(x=>x.id!==id));await dbDelete('projects',id)}

  // ── Project actions ───────────────────────────────────
  function toggleProjItem(pid:string,ii:number){
    setProjects(prev=>prev.map(p=>{
      if(p.id!==pid)return p
      const items=p.items.map((item,i)=>i===ii?{...item,d:!item.d}:item)
      const u={...p,items};dbUpsert('projects',[toProjRow(u)]);return u
    }))
  }
  function toggleProjSub(pid:string,ii:number,si:number){
    setProjects(prev=>prev.map(p=>{
      if(p.id!==pid)return p
      const items=p.items.map((item,i)=>i!==ii?item:{...item,subs:item.subs.map((s,j)=>j===si?{...s,d:!s.d}:s)})
      const u={...p,items};dbUpsert('projects',[toProjRow(u)]);return u
    }))
  }
  function updateProjStatus(pid:string,status:ProjectStatus){
    setProjects(prev=>prev.map(p=>{if(p.id!==pid)return p;const u={...p,status};dbUpsert('projects',[toProjRow(u)]);return u}))
  }

  async function saveAnalysis(){
    const{hScore,tScore,life}=calcScores()
    await saveDailySummary(todayStr(),life,hScore,tScore,habits,tasks.filter(t=>t.done))
    const hist=await loadHistory()
    setHistory(hist)
    let s=0;for(let i=hist.length-1;i>=0;i--){if(hist[i].life_score>=50)s++;else break}
    setStreak(s)
    setAnalysisOpen(false)
  }

  // ── Save handlers ─────────────────────────────────────
  async function handleSaveHabit(h:Habit){
    if(modal?.editId)setHabits(p=>p.map(x=>x.id===modal.editId?h:x));else setHabits(p=>[...p,h])
    await dbUpsert('habits',[toHabitRow(h)])
    setModal(null)
  }
  async function handleSaveTask(t:Task){
    // Ensure subs is always a clean array before save
    const clean={...t,subs:Array.isArray(t.subs)?t.subs:[]}
    if(modal?.editId)setTasks(p=>p.map(x=>x.id===modal.editId?clean:x));else setTasks(p=>[...p,clean])
    await dbUpsert('tasks',[toTaskRow(clean)])
    setModal(null)
  }
  async function handleSaveProject(p:Project){
    if(modal?.editId)setProjects(prev=>prev.map(x=>x.id===modal.editId?p:x));else setProjects(prev=>[...prev,p])
    await dbUpsert('projects',[toProjRow(p)])
    setModal(null)
  }

  // ── Derived lists ─────────────────────────────────────
  const activeTasks=tasks.filter(t=>!t.done).sort((a,b)=>{
    const aO=a.rollover||(!!a.due&&(dueDiff(a.due)??0)<0)
    const bO=b.rollover||(!!b.due&&(dueDiff(b.due)??0)<0)
    if(aO&&!bO)return-1;if(!aO&&bO)return 1
    if(taskSort==='prio')return PW[b.prio]-PW[a.prio]
    if(taskSort==='due'){if(!a.due&&!b.due)return 0;if(!a.due)return 1;if(!b.due)return-1;return new Date(a.due).getTime()-new Date(b.due).getTime()}
    return a.title.localeCompare(b.title)
  })
  const doneTasks=tasks.filter(t=>t.done)
  const todayHabits=habits.filter(h=>h.active_days.includes(TODAY_DOW))

  if(loading) return(
    <div style={{minHeight:'100vh',display:'flex',alignItems:'center',justifyContent:'center',background:'#090c12',flexDirection:'column',gap:16}}>
      <div style={{width:48,height:48,borderRadius:'50%',border:'3px solid #1e2840',borderTopColor:'#00e87a',animation:'spin .8s linear infinite'}}/>
      <div style={{color:'#3d4f68',fontFamily:'monospace',fontSize:12}}>Verbinde mit Supabase…</div>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )

  // ── Shared content blocks ─────────────────────────────
  const habitsBlock=(
    <div>
      <SH title="Habits" score={hScore} color="#00e87a" ak={animKey}/>
      {todayHabits.length===0?<Empty>Keine Habits für heute</Empty>
        :todayHabits.map((h,idx)=>(
          <HabitCard key={h.id} habit={h} idx={idx}
            onToggle={e=>toggleHabit(h.id,e)}
            onMetric={v=>updateMetric(h.id,v)}
            onBarDrag={e=>handleBarDrag(h.id,e)}
            onEdit={()=>setModal({type:'habit',editId:h.id})}/>
        ))}
    </div>
  )

  const tasksBlock=(
    <div>
      <SH title="Tasks" score={tScore} color="#3d7fff" ak={animKey}/>
      <SortBar sort={taskSort} onChange={setTaskSort}/>
      {activeTasks.length===0?<Empty>Alle Tasks erledigt 🎉</Empty>
        :activeTasks.map((t,idx)=>(
          <TaskCard key={t.id} task={t} idx={idx} isCompleting={completing.has(t.id)} showSub={showSubs[t.id]}
            onComplete={e=>completeTask(t.id,e)}
            onToggleSub={()=>setShowSubs(p=>({...p,[t.id]:!showSubs[t.id]}))}
            onToggleSubItem={si=>toggleSubTask(t.id,si)}
            onEdit={()=>setModal({type:'task',editId:t.id})}/>
        ))}
      {doneTasks.length>0&&(
        <details style={{marginTop:12}}>
          <summary style={{fontSize:11,color:'#3d4f68',cursor:'pointer',padding:'8px 0',userSelect:'none',display:'flex',alignItems:'center',gap:6,listStyle:'none'}}>
            <span>▶</span> Erledigt ({doneTasks.length})
            <span style={{marginLeft:'auto',fontSize:10,color:'#1e2840'}}>auto-delete 3 Tage</span>
          </summary>
          <div style={{marginTop:8}}>
            {doneTasks.map(t=>(
              <div key={t.id} style={{background:'#141928',border:'1px solid #1e2840',borderRadius:8,padding:'10px 12px',marginBottom:6,display:'flex',alignItems:'center',gap:8}}>
                <div style={{width:16,height:16,borderRadius:4,background:'#00b35c',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="2" strokeLinecap="round"/></svg>
                </div>
                <span style={{fontSize:12,color:'#3d4f68',textDecoration:'line-through',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.title}</span>
                <button onClick={()=>restoreTask(t.id)} style={GBS}>↩</button>
                <button onClick={()=>deleteTask(t.id)} style={{...GBS,color:'#ff4d6a',borderColor:'rgba(255,77,106,.2)',background:'rgba(255,77,106,.06)'}}>✕</button>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  )

  const projectsBlock=(
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:2,color:'#7a88a8'}}>Projekte</div>
        <Btn onClick={()=>setModal({type:'project'})} small>+ Projekt</Btn>
      </div>
      {projects.length===0?<Empty>Noch keine Projekte</Empty>
        :projects.map((p,idx)=>(
          <ProjectCard key={p.id} project={p} idx={idx}
            onToggleItem={ii=>toggleProjItem(p.id,ii)}
            onToggleSub={(ii,si)=>toggleProjSub(p.id,ii,si)}
            onStatusChange={s=>updateProjStatus(p.id,s)}
            onEdit={()=>setModal({type:'project',editId:p.id})}
            onDelete={()=>deleteProject(p.id)}/>
        ))}
    </div>
  )

  const modalsEl=(
    <Modals modal={modal} setModal={setModal}
      analysisOpen={analysisOpen} setAnalysisOpen={setAnalysisOpen}
      manageOpen={manageOpen} setManageOpen={setManageOpen}
      habits={habits} tasks={tasks} projects={projects}
      hScore={hScore} tScore={tScore} life={life} history={history} streak={streak}
      onSaveHabit={handleSaveHabit} onSaveTask={handleSaveTask} onSaveProject={handleSaveProject}
      onEditHabit={h=>{setManageOpen(false);setModal({type:'habit',editId:h.id})}}
      onEditTask={t=>{setManageOpen(false);setModal({type:'task',editId:t.id})}}
      onDeleteHabit={deleteHabit} onDeleteTask={deleteTask}
      onSaveAnalysis={saveAnalysis}/>
  )

  // ── DESKTOP ───────────────────────────────────────────
  if(!isMobile) return(
    <div style={{minHeight:'100vh',background:'#090c12',position:'relative',overflowX:'hidden'}}>
      <Blobs/>
      <div style={{maxWidth:1140,margin:'0 auto',padding:'24px 20px 80px',position:'relative',zIndex:1}}>
        {/* Top bar */}
        <div style={{position:'relative',overflow:'hidden',borderRadius:18,border:'1px solid rgba(61,127,255,.25)',background:'linear-gradient(135deg,rgba(61,127,255,.15),rgba(155,109,255,.1))',padding:'14px 24px',marginBottom:20,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
          <div style={{position:'absolute',inset:0,background:'linear-gradient(90deg,transparent,rgba(61,127,255,.05),transparent)',animation:'shimmer 3s infinite'}}/>
          <div style={{position:'relative',fontSize:13,color:'#7a88a8'}}>
            {streak>0&&<span style={{color:'#00e87a',fontWeight:700,marginRight:12}}>🔥 {streak}d Streak</span>}
            7d: <b style={{color:'#dce4f5'}}>{avg7}%</b> · vs Monat: <b style={{color:avg7-avg30>=0?'#00e87a':'#ff4d6a'}}>{avg7-avg30>=0?'+':''}{avg7-avg30}%</b>
          </div>
          <div style={{display:'flex',gap:8,position:'relative'}}>
            <Btn onClick={()=>setManageOpen(true)} ghost small>📋 Verwalten</Btn>
            <Btn onClick={()=>setAnalysisOpen(true)} ghost small>📊 Tagesanalyse</Btn>
            <Btn onClick={()=>setModal({type:'task'})} small>+ Hinzufügen</Btn>
          </div>
        </div>
        {/* Header */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:24,paddingBottom:20,borderBottom:'1px solid #1e2840'}}>
          <div>
            <h1 style={{fontSize:28,fontWeight:800,letterSpacing:-1,background:'linear-gradient(135deg,#dce4f5,#7a88a8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>{greeting}</h1>
            <div style={{fontSize:12,color:'#3d4f68',marginTop:2,fontFamily:'monospace'}}>{dateStr}</div>
            <div style={{fontSize:13,color:'#7a88a8',marginTop:8,fontStyle:'italic',maxWidth:420}}>"{todayQuote}"</div>
          </div>
          <DualRing hScore={hScore} tScore={tScore} life={life} onClick={()=>setAnalysisOpen(true)} ak={animKey}/>
        </div>
        <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:16,marginBottom:16}}>
          <Card>{habitsBlock}</Card>
          <Card>{tasksBlock}</Card>
        </div>
        <Card style={{marginBottom:16}}>{projectsBlock}</Card>
        <Analytics history={history}/>
      </div>
      {modalsEl}
    </div>
  )

  // ── MOBILE ────────────────────────────────────────────
  return(
    <div style={{minHeight:'100vh',background:'#090c12',position:'relative',display:'flex',flexDirection:'column'}}>
      <Blobs/>

      {/* Mobile header */}
      <div style={{position:'sticky',top:0,zIndex:50,background:'rgba(9,12,18,.97)',backdropFilter:'blur(16px)',borderBottom:'1px solid #1e2840',padding:'10px 16px',flexShrink:0}}>

        {/* Row 1: greeting/date left | quote right */}
        <div style={{display:'flex',alignItems:'flex-start',gap:12,marginBottom:8}}>
          <div style={{flexShrink:0}}>
            <div style={{fontSize:16,fontWeight:800,letterSpacing:-.5,background:'linear-gradient(135deg,#dce4f5,#7a88a8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent'}}>{greeting}</div>
            <div style={{fontSize:10,color:'#3d4f68',fontFamily:'monospace',marginTop:1}}>{new Date().toLocaleDateString('de-DE',{weekday:'short',day:'numeric',month:'short'})}</div>
          </div>
          <div style={{flex:1,fontSize:11,color:'#7a88a8',fontStyle:'italic',lineHeight:1.4,textAlign:'right'}}>"{todayQuote}"</div>
        </div>

        {/* Row 2: Verwalten + Analyse buttons */}
        <div style={{display:'flex',gap:8,marginBottom:8}}>
          <button onClick={()=>setManageOpen(true)} style={{flex:1,padding:'7px 10px',background:'rgba(255,255,255,.04)',border:'1px solid #2d3a55',borderRadius:9,color:'#7a88a8',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>📋 Verwalten</button>
          <button onClick={()=>setAnalysisOpen(true)} style={{flex:1,padding:'7px 10px',background:'rgba(61,127,255,.08)',border:'1px solid rgba(61,127,255,.2)',borderRadius:9,color:'#3d7fff',fontSize:11,fontWeight:600,cursor:'pointer',fontFamily:'inherit'}}>📊 Analyse</button>
        </div>

        {/* Row 3: Score circles left | + button right */}
        <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:10}}>
          <div style={{display:'flex',alignItems:'center',gap:10}}>
            <MobileRing life={life} hScore={hScore} tScore={tScore} onClick={()=>setAnalysisOpen(true)}/>
            {streak>0&&<div style={{fontSize:11,color:'#00e87a',fontWeight:700,background:'rgba(0,232,122,.1)',padding:'3px 8px',borderRadius:20,border:'1px solid rgba(0,232,122,.2)'}}>🔥 {streak}d</div>}
          </div>
          <button onClick={()=>setModal({type:mobileTab==='habits'?'habit':mobileTab==='projects'?'project':'task'})}
            style={{padding:'10px 22px',background:'linear-gradient(135deg,#2563d4,#7c4fd4)',border:'none',borderRadius:11,color:'#fff',fontSize:14,fontWeight:700,cursor:'pointer',boxShadow:'0 4px 16px rgba(37,99,212,.4)'}}>
            + Hinzufügen
          </button>
        </div>
      </div>

      {/* Scrollable content area */}
      <div style={{flex:1,overflowY:'auto',padding:'16px 16px 8px',position:'relative',zIndex:1}}>

        {/* HOME tab */}
        {mobileTab==='home'&&(
          <div>
            {/* Big score numbers centered */}
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:10,marginBottom:14}}>
              {[{label:'Life',val:life,color:life>=70?'#00e87a':life>=40?'#ffb830':'#ff4d6a'},{label:'Habits',val:hScore,color:'#00e87a'},{label:'Tasks',val:tScore,color:'#3d7fff'}].map(s=>(
                <div key={s.label} style={{background:'#0f1420',border:'1px solid #1e2840',borderRadius:16,padding:'16px 8px',textAlign:'center'}}>
                  <div style={{fontFamily:'monospace',fontSize:30,fontWeight:700,color:s.color,lineHeight:1}} key={s.val+animKey}>{s.val}%</div>
                  <div style={{fontSize:10,color:'#3d4f68',textTransform:'uppercase',letterSpacing:1,marginTop:5}}>{s.label}</div>
                  <div style={{height:3,background:'#1c2235',borderRadius:2,marginTop:8,overflow:'hidden'}}>
                    <div style={{height:'100%',background:s.color,width:`${s.val}%`,borderRadius:2,transition:'width 1s ease'}}/>
                  </div>
                </div>
              ))}
            </div>

            {/* Habits preview */}
            <div style={{background:'#0f1420',border:'1px solid #1e2840',borderRadius:16,padding:14,marginBottom:12}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:1.5,color:'#7a88a8'}}>Habits heute</div>
                <button onClick={()=>setMobileTab('habits')} style={{fontSize:11,color:'#3d7fff',background:'none',border:'none',cursor:'pointer'}}>Alle →</button>
              </div>
              {todayHabits.slice(0,4).map(h=>{
                const c=COLORS[h.color],pct=h.type==='metric'&&h.target?Math.min(100,Math.round(((h.current_val||0)/h.target)*100)):h.pct
                return(
                  <div key={h.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
                    <div style={{width:7,height:7,borderRadius:'50%',background:c,flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,marginBottom:4,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.name}</div>
                      <div style={{height:4,background:'#1c2235',borderRadius:2,overflow:'hidden'}}>
                        <div style={{height:'100%',background:c,width:`${pct}%`,borderRadius:2,transition:'width .5s'}}/>
                      </div>
                    </div>
                    <span style={{fontSize:11,fontFamily:'monospace',color:pct>=100?'#00e87a':'#7a88a8',minWidth:32,textAlign:'right'}}>{pct}%</span>
                    {h.type==='binary'&&(
                      <div onClick={e=>toggleHabit(h.id,e)} style={{width:28,height:28,borderRadius:7,border:`2px solid ${h.done?'#00e87a':'#3d4f70'}`,background:h.done?'#00e87a':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,cursor:'pointer',transition:'all .2s'}}>
                        {h.done&&<svg width="13" height="13" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="2.2" strokeLinecap="round"/></svg>}
                      </div>
                    )}
                  </div>
                )
              })}
              {todayHabits.length>4&&<div style={{fontSize:11,color:'#3d4f68',textAlign:'center',marginTop:4}}>+{todayHabits.length-4} weitere</div>}
            </div>

            {/* Tasks preview */}
            <div style={{background:'#0f1420',border:'1px solid #1e2840',borderRadius:16,padding:14,marginBottom:12}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:1.5,color:'#7a88a8'}}>Tasks</div>
                <button onClick={()=>setMobileTab('tasks')} style={{fontSize:11,color:'#3d7fff',background:'none',border:'none',cursor:'pointer'}}>Alle →</button>
              </div>
              {activeTasks.slice(0,4).map(t=>{
                const isOver=t.rollover||(!!t.due&&(dueDiff(t.due)??0)<0)
                return(
                  <div key={t.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:9}}>
                    <div onClick={e=>completeTask(t.id,e)} style={{width:22,height:22,borderRadius:6,border:`1.5px solid ${isOver?'rgba(255,77,106,.5)':'#3d4f70'}`,background:'transparent',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0}}>
                      <svg width="10" height="10" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="rgba(255,255,255,.15)" strokeWidth="2" strokeLinecap="round"/></svg>
                    </div>
                    <span style={{fontSize:12,flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',color:isOver?'#ff4d6a':'#dce4f5'}}>{t.title}</span>
                    <div style={{width:7,height:7,borderRadius:'50%',background:{high:'#ff4d6a',med:'#ffb830',low:'#3d4f68'}[t.prio],flexShrink:0}}/>
                  </div>
                )
              })}
              {activeTasks.length>4&&<div style={{fontSize:11,color:'#3d4f68',textAlign:'center',marginTop:4}}>+{activeTasks.length-4} weitere</div>}
            </div>

            {/* Projects preview */}
            <div style={{background:'#0f1420',border:'1px solid #1e2840',borderRadius:16,padding:14,marginBottom:12}}>
              <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:10}}>
                <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:1.5,color:'#7a88a8'}}>Projekte</div>
                <button onClick={()=>setMobileTab('projects')} style={{fontSize:11,color:'#3d7fff',background:'none',border:'none',cursor:'pointer'}}>Alle →</button>
              </div>
              {projects.slice(0,3).map(p=>{
                const c=COLORS[p.color],done=p.items.filter(i=>i.d).length,total=p.items.length
                const pct=total?Math.round((done/total)*100):0
                return(
                  <div key={p.id} style={{display:'flex',alignItems:'center',gap:10,marginBottom:8}}>
                    <div style={{width:7,height:7,borderRadius:'50%',background:c,flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',marginBottom:3}}>{p.name}</div>
                      <div style={{height:3,background:'#1c2235',borderRadius:2,overflow:'hidden'}}>
                        <div style={{height:'100%',background:c,width:`${pct}%`,borderRadius:2,transition:'width .5s'}}/>
                      </div>
                    </div>
                    <span style={{fontSize:11,fontFamily:'monospace',color:c,minWidth:32,textAlign:'right'}}>{pct}%</span>
                  </div>
                )
              })}
              {projects.length===0&&<div style={{fontSize:12,color:'#3d4f68',textAlign:'center',padding:'8px 0'}}>Noch keine Projekte</div>}
              {projects.length>3&&<div style={{fontSize:11,color:'#3d4f68',textAlign:'center',marginTop:4}}>+{projects.length-3} weitere</div>}
            </div>
          </div>
        )}

        {mobileTab==='habits'&&<Card>{habitsBlock}</Card>}
        {mobileTab==='tasks'&&<Card>{tasksBlock}</Card>}
        {mobileTab==='projects'&&<Card>{projectsBlock}</Card>}
        {mobileTab==='analytics'&&<Analytics history={history} compact/>}
      </div>

      {/* Bottom nav – fixed to bottom, full width */}
      <nav style={{
        position:'fixed',bottom:0,left:0,right:0,
        height:`calc(58px + env(safe-area-inset-bottom,0px))`,
        paddingBottom:'env(safe-area-inset-bottom,0px)',
        background:'rgba(9,12,18,.98)',
        backdropFilter:'blur(20px)',
        borderTop:'1px solid #1e2840',
        display:'flex',alignItems:'stretch',
        zIndex:50
      }}>
        {([
          {key:'home',icon:'⊞',label:'Home'},
          {key:'habits',icon:'◎',label:'Habits'},
          {key:'tasks',icon:'✓',label:'Tasks'},
          {key:'projects',icon:'◈',label:'Projekte'},
          {key:'analytics',icon:'▦',label:'Stats'},
        ] as {key:MobileTab;icon:string;label:string}[]).map(item=>{
          const active=mobileTab===item.key
          return(
            <button key={item.key} onClick={()=>setMobileTab(item.key)}
              style={{flex:1,display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',gap:3,background:'none',border:'none',cursor:'pointer',padding:'6px 0'}}>
              <div style={{width:34,height:26,borderRadius:9,background:active?'rgba(61,127,255,.2)':'transparent',display:'flex',alignItems:'center',justifyContent:'center',transition:'all .2s',border:active?'1px solid rgba(61,127,255,.3)':'1px solid transparent'}}>
                <span style={{fontSize:15,color:active?'#3d7fff':'#3d4f68',transition:'color .2s'}}>{item.icon}</span>
              </div>
              <span style={{fontSize:9,color:active?'#3d7fff':'#3d4f68',fontWeight:active?700:400,transition:'all .2s'}}>{item.label}</span>
            </button>
          )
        })}
      </nav>

      {/* Spacer so content isn't hidden behind fixed nav */}
      <div style={{height:`calc(58px + env(safe-area-inset-bottom,0px))`,flexShrink:0}}/>

      {modalsEl}
    </div>
  )
}

// ── Shared components ─────────────────────────────────────

function Blobs(){return(
  <div style={{position:'fixed',inset:0,pointerEvents:'none',zIndex:0}}>
    <div style={{position:'absolute',width:400,height:400,borderRadius:'50%',background:'#3d7fff',filter:'blur(80px)',opacity:.08,top:-80,right:-80}}/>
    <div style={{position:'absolute',width:350,height:350,borderRadius:'50%',background:'#9b6dff',filter:'blur(80px)',opacity:.08,bottom:80,left:-100}}/>
  </div>
)}

function Card({children,style}:{children:React.ReactNode;style?:React.CSSProperties}){
  return<div style={{background:'#0f1420',border:'1px solid #1e2840',borderRadius:18,padding:20,...style}}>{children}</div>
}

function SH({title,score,color,ak}:any){
  return(
    <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:2,color:'#7a88a8'}}>{title}</div>
      <div style={{display:'flex',alignItems:'center',gap:8}}>
        <div style={{width:72,height:4,background:'#1c2235',borderRadius:2,overflow:'hidden'}}>
          <div style={{height:'100%',borderRadius:2,background:color,width:`${score}%`,transition:'width 1s cubic-bezier(.34,1.2,.64,1)'}} key={ak}/>
        </div>
        <span style={{fontFamily:'monospace',fontSize:13,fontWeight:500,color,minWidth:32,textAlign:'right'}} key={score+ak}>{score}%</span>
      </div>
    </div>
  )
}

function DualRing({hScore,tScore,life,onClick,ak}:any){
  return(
    <div style={{display:'flex',alignItems:'center',gap:8}}>
      <div key={ak} style={{position:'relative',width:100,height:100,cursor:'pointer'}} onClick={onClick}>
        <svg width="100" height="100" viewBox="0 0 110 110" style={{position:'absolute',inset:0,width:'100%',height:'100%'}}>
          <circle cx="55" cy="55" r="46" fill="none" stroke="rgba(0,232,122,.08)" strokeWidth="7"/>
          <circle cx="55" cy="55" r="46" fill="none" stroke="#00e87a" strokeWidth="7" strokeLinecap="round"
            strokeDasharray="289" strokeDashoffset={289-(hScore/100)*289} transform="rotate(-90 55 55)"
            style={{transition:'stroke-dashoffset 1.4s cubic-bezier(.34,1.4,.64,1)'}}/>
          <circle cx="55" cy="55" r="33" fill="none" stroke="rgba(61,127,255,.08)" strokeWidth="7"/>
          <circle cx="55" cy="55" r="33" fill="none" stroke="#3d7fff" strokeWidth="7" strokeLinecap="round"
            strokeDasharray="207" strokeDashoffset={207-(tScore/100)*207} transform="rotate(-90 55 55)"
            style={{transition:'stroke-dashoffset 1.4s cubic-bezier(.34,1.4,.64,1) .1s'}}/>
        </svg>
        <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',textAlign:'center'}}>
          <span style={{display:'block',fontFamily:'monospace',fontSize:17,fontWeight:500}} key={life+ak}>{life}</span>
          <span style={{display:'block',fontSize:8,color:'#3d4f68',textTransform:'uppercase',letterSpacing:1.5}}>life</span>
        </div>
      </div>
      <div style={{display:'flex',flexDirection:'column',gap:4}}>
        {[{c:'#00e87a',l:'H',v:hScore},{c:'#3d7fff',l:'T',v:tScore}].map(r=>(
          <div key={r.l} style={{display:'flex',alignItems:'center',gap:4,fontSize:11,fontFamily:'monospace'}}>
            <div style={{width:6,height:6,borderRadius:'50%',background:r.c,boxShadow:`0 0 5px ${r.c}`}}/>
            <span style={{color:'#7a88a8'}}>{r.l} <span style={{color:'#dce4f5'}} key={r.v}>{r.v}%</span></span>
          </div>
        ))}
      </div>
    </div>
  )
}

function MobileRing({life,hScore,tScore,onClick}:any){
  return(
    <div onClick={onClick} style={{position:'relative',width:56,height:56,cursor:'pointer',flexShrink:0}}>
      <svg width="56" height="56" viewBox="0 0 56 56" style={{position:'absolute',inset:0}}>
        <circle cx="28" cy="28" r="23" fill="none" stroke="rgba(0,232,122,.08)" strokeWidth="5"/>
        <circle cx="28" cy="28" r="23" fill="none" stroke="#00e87a" strokeWidth="5" strokeLinecap="round"
          strokeDasharray="144" strokeDashoffset={144-(hScore/100)*144} transform="rotate(-90 28 28)"
          style={{transition:'stroke-dashoffset 1s ease'}}/>
        <circle cx="28" cy="28" r="14" fill="none" stroke="rgba(61,127,255,.08)" strokeWidth="4"/>
        <circle cx="28" cy="28" r="14" fill="none" stroke="#3d7fff" strokeWidth="4" strokeLinecap="round"
          strokeDasharray="88" strokeDashoffset={88-(tScore/100)*88} transform="rotate(-90 28 28)"
          style={{transition:'stroke-dashoffset 1s ease .1s'}}/>
      </svg>
      <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',fontFamily:'monospace',fontSize:13,fontWeight:700,color:'#dce4f5'}}>{life}</div>
    </div>
  )
}

function HabitCard({habit:h,idx,onToggle,onMetric,onBarDrag,onEdit}:any){
  const c=COLORS[h.color as BrandColor]||'#00e87a'
  const pct=h.type==='metric'&&h.target?Math.min(100,Math.round(((h.current_val||0)/h.target)*100)):h.pct
  const pctColor=pct>=100?'#00e87a':pct>=50?'#ffb830':'#7a88a8'
  const daysLabel=h.active_days.length===7?'täglich':h.active_days.map((d:number)=>DSHORT[d]).join(', ')
  return(
    <div style={{background:h.done?'rgba(0,232,122,.04)':'#141928',border:`1px solid ${h.done?'rgba(0,232,122,.2)':'#1e2840'}`,borderRadius:12,padding:'12px 14px',marginBottom:8,transition:'all .3s',animation:`slideInLeft .4s ease ${idx*.05}s both`}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',gap:8}}>
        <div style={{display:'flex',alignItems:'center',gap:8,flex:1,minWidth:0}}>
          <div style={{width:8,height:8,borderRadius:'50%',background:c,boxShadow:`0 0 ${h.done?'10px':'5px'} ${c}`,flexShrink:0,transition:'box-shadow .3s'}}/>
          <div style={{minWidth:0}}>
            <div style={{fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.name}</div>
            <div style={{fontSize:9,color:'#3d4f68',fontFamily:'monospace'}}>{daysLabel}</div>
          </div>
        </div>
        <div style={{display:'flex',alignItems:'center',gap:6,flexShrink:0}}>
          <span style={{fontFamily:'monospace',fontSize:12,color:pctColor,transition:'color .3s'}} key={pct}>{pct}%</span>
          <EditBtn onClick={onEdit}/>
          {h.type==='binary'&&(
            <div onClick={onToggle} onTouchEnd={onToggle}
              style={{width:28,height:28,borderRadius:7,border:`2px solid ${h.done?'#00e87a':'#3d4f70'}`,background:h.done?'#00e87a':'transparent',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,boxShadow:h.done?'0 0 14px rgba(0,232,122,.5)':'none',transition:'all .25s cubic-bezier(.34,1.56,.64,1)'}}>
              {h.done&&<svg width="13" height="13" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="white" strokeWidth="2.2" strokeLinecap="round"/></svg>}
            </div>
          )}
        </div>
      </div>
      {/* Draggable bar – tall touch target for mobile */}
      <div onMouseDown={h.type==='metric'?onBarDrag:undefined} onTouchStart={h.type==='metric'?onBarDrag:undefined}
        onClick={h.type==='binary'?onToggle:undefined}
        style={{height:h.type==='metric'?22:6,background:'#232c42',borderRadius:h.type==='metric'?11:3,marginTop:10,overflow:'hidden',cursor:h.type==='metric'?'ew-resize':'pointer',position:'relative',userSelect:'none',touchAction:'none',display:'flex',alignItems:'center'}}>
        <div style={{height:'100%',borderRadius:h.type==='metric'?11:3,background:`linear-gradient(90deg,${c}88,${c})`,width:`${pct}%`,transition:h.type==='binary'?'width .5s cubic-bezier(.34,1.2,.64,1)':'none',position:'relative'}}>
          {h.type==='metric'&&pct>0&&<div style={{position:'absolute',right:-1,top:'50%',transform:'translateY(-50%)',width:16,height:16,borderRadius:'50%',background:c,boxShadow:`0 0 8px ${c}`,border:'2px solid #141928'}}/>}
        </div>
      </div>
      {h.type==='metric'&&(
        <div style={{marginTop:8,background:'#1c2235',border:'1px solid #2d3a55',borderRadius:8,padding:'8px 12px',display:'flex',alignItems:'center',gap:8}}>
          <input type="number" inputMode="decimal" min={0} max={(h.target||1)*2} step={0.1} value={h.current_val||0}
            onChange={e=>onMetric(parseFloat(e.target.value)||0)}
            style={{background:'transparent',border:'none',color:'#dce4f5',fontFamily:'monospace',fontSize:15,fontWeight:500,width:52,textAlign:'right',outline:'none'}}/>
          <span style={{fontSize:11,color:'#3d4f68',flex:1}}>/ {h.target} {h.unit}</span>
          <span style={{fontFamily:'monospace',fontSize:11,padding:'2px 6px',borderRadius:4,background:'#232c42',color:pctColor}}>{pct}%</span>
        </div>
      )}
    </div>
  )
}

function TaskCard({task:t,idx,isCompleting,showSub,onComplete,onToggleSub,onToggleSubItem,onEdit}:any){
  const isOver=t.rollover||(!!t.due&&(dueDiff(t.due)??0)<0)
  const diff=dueDiff(t.due)
  const isFuture=t.due&&(diff??0)>0
  return(
    <div style={{background:isOver?'rgba(255,77,106,.06)':'#141928',border:`1px solid ${isOver?'rgba(255,77,106,.3)':'#1e2840'}`,borderRadius:10,padding:'12px 14px',marginBottom:8,display:'flex',alignItems:'flex-start',gap:10,transition:'all .2s',animation:isCompleting?'slideOutRight .4s ease forwards':`slideInLeft .4s ease ${idx*.04}s both`,overflow:'hidden'}}>
      <div onClick={onComplete} onTouchEnd={onComplete}
        style={{width:24,height:24,borderRadius:6,border:`1.5px solid ${isOver?'rgba(255,77,106,.4)':'#3d4f70'}`,background:'transparent',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',marginTop:1,flexShrink:0,minWidth:24,transition:'all .2s'}}>
        <svg width="11" height="11" viewBox="0 0 12 12" fill="none"><polyline points="2,6 5,9 10,3" stroke="rgba(255,255,255,.15)" strokeWidth="2" strokeLinecap="round"/></svg>
      </div>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontSize:13,fontWeight:500,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{t.title}</div>
        <div style={{display:'flex',alignItems:'center',gap:6,marginTop:5,flexWrap:'wrap'}}>
          <PrioBadge prio={t.prio}/>
          {isOver&&<span style={{fontSize:10,color:'#ff4d6a',fontFamily:'monospace'}}>⚠ überfällig</span>}
          {t.due&&diff!==null&&(
            <span style={{fontSize:10,fontFamily:'monospace',padding:'2px 6px',borderRadius:4,border:'1px solid',color:diff<0?'#ff4d6a':diff===0?'#ffb830':diff<=3?'#ffb830':'#3d4f68',borderColor:diff<0?'rgba(255,77,106,.25)':diff<=3?'rgba(255,184,48,.25)':'#1e2840',background:diff<0?'rgba(255,77,106,.06)':diff<=3?'rgba(255,184,48,.06)':'transparent'}}>
              📅 {diff<0?`${Math.abs(diff)}d`:diff===0?'heute':`+${diff}d`}
            </span>
          )}
          {isFuture&&<span style={{fontSize:9,color:'#ffb830',fontFamily:'monospace',padding:'1px 5px',borderRadius:3,background:'rgba(255,184,48,.08)',border:'1px solid rgba(255,184,48,.15)'}}>bonus</span>}
          {t.subs.length>0&&<button onClick={onToggleSub} onTouchEnd={onToggleSub} style={{fontSize:10,color:'#3d4f68',padding:'2px 6px',background:'#1c2235',borderRadius:4,border:'1px solid #1e2840',cursor:'pointer'}}>{showSub?'▲':'▼'} {t.subs.length}</button>}
        </div>
        {showSub&&t.subs.length>0&&(
          <div style={{marginTop:8,borderLeft:'2px solid #1e2840',paddingLeft:10}}>
            {t.subs.map((s:Sub,si:number)=>(
              <div key={si} onClick={()=>onToggleSubItem(si)} onTouchEnd={()=>onToggleSubItem(si)}
                style={{display:'flex',alignItems:'center',gap:7,padding:'6px 0',fontSize:12,color:s.d?'#3d4f68':'#7a88a8',textDecoration:s.d?'line-through':'none',cursor:'pointer'}}>
                <div style={{width:14,height:14,borderRadius:3,border:`1px solid ${s.d?'#00b35c':'#2d3a55'}`,background:s.d?'#00b35c':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,fontSize:8,color:'white',transition:'all .2s'}}>{s.d?'✓':''}</div>
                {s.t}
              </div>
            ))}
          </div>
        )}
      </div>
      <EditBtn onClick={onEdit}/>
    </div>
  )
}

function ProjectCard({project:p,idx,onToggleItem,onToggleSub,onStatusChange,onEdit,onDelete}:any){
  const c=COLORS[p.color as BrandColor]||'#3d7fff'
  const total=p.items.length,done=p.items.filter((i:ProjItem)=>i.d).length
  const pct=total?Math.round((done/total)*100):0
  const circ=2*Math.PI*22
  return(
    <div style={{background:'#141928',border:'1px solid #1e2840',borderRadius:12,padding:16,marginBottom:12,animation:`fadeIn .4s ease ${idx*.07}s both`}}>
      <div style={{display:'flex',alignItems:'flex-start',justifyContent:'space-between',marginBottom:12}}>
        <div style={{flex:1,minWidth:0,marginRight:8}}>
          <div style={{fontSize:14,fontWeight:700,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{p.name}</div>
          <div style={{fontSize:11,color:'#3d4f68',marginTop:3,fontFamily:'monospace'}}>{p.deadline}</div>
        </div>
        <div style={{display:'flex',flexDirection:'column',alignItems:'flex-end',gap:5,flexShrink:0}}>
          <div style={{fontSize:9,padding:'2px 7px',borderRadius:4,fontFamily:'monospace',border:'1px solid',color:c,borderColor:c+'30',background:c+'12'}}>{pct}%</div>
          <select value={p.status} onChange={e=>onStatusChange(e.target.value)} style={{fontSize:10,padding:'4px 8px',borderRadius:5,border:'1px solid #2d3a55',background:'#1c2235',fontFamily:'monospace',cursor:'pointer',outline:'none',color:STATUS_COLORS[p.status as ProjectStatus]}}>
            {(Object.keys(STATUS_LABELS) as ProjectStatus[]).map(s=><option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
          </select>
          <div style={{display:'flex',gap:4}}>
            <button onClick={onEdit} style={EBS}>✏</button>
            <button onClick={onDelete} style={DBS}>🗑</button>
          </div>
        </div>
      </div>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12,paddingBottom:12,borderBottom:'1px solid #1e2840'}}>
        <div style={{position:'relative',flexShrink:0}}>
          <svg width="48" height="48" viewBox="0 0 52 52">
            <circle cx="26" cy="26" r="22" fill="none" stroke={c+'20'} strokeWidth="5"/>
            <circle cx="26" cy="26" r="22" fill="none" stroke={c} strokeWidth="5" strokeLinecap="round" strokeDasharray={circ} strokeDashoffset={circ-(pct/100)*circ} transform="rotate(-90 26 26)" style={{transition:'stroke-dashoffset .8s'}}/>
          </svg>
          <div style={{position:'absolute',top:'50%',left:'50%',transform:'translate(-50%,-50%)',fontFamily:'monospace',fontSize:10,fontWeight:500,color:c}}>{pct}%</div>
        </div>
        <div style={{flex:1,fontSize:11}}>
          <div style={{display:'flex',justifyContent:'space-between',color:'#7a88a8',marginBottom:3}}><span>Erledigt</span><span style={{fontFamily:'monospace',color:'#dce4f5'}}>{done}/{total}</span></div>
          <div style={{display:'flex',justifyContent:'space-between',color:'#7a88a8'}}><span>Status</span><span style={{color:STATUS_COLORS[p.status as ProjectStatus]}}>{STATUS_LABELS[p.status as ProjectStatus]}</span></div>
        </div>
      </div>
      {p.items.map((item:ProjItem,ii:number)=>(
        <div key={ii}>
          <div onClick={()=>onToggleItem(ii)} onTouchEnd={()=>onToggleItem(ii)} style={{display:'flex',alignItems:'center',gap:8,padding:'7px 0',fontSize:13,color:item.d?'#3d4f68':'#7a88a8',textDecoration:item.d?'line-through':'none',borderBottom:ii<p.items.length-1?'1px solid #1e2840':'none',cursor:'pointer',transition:'color .2s'}}>
            <div style={{width:16,height:16,borderRadius:4,border:`1.5px solid ${item.d?'#00b35c':'#2d3a55'}`,background:item.d?'#00b35c':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,fontSize:9,color:'white',transition:'all .25s'}}>{item.d?'✓':''}</div>
            {item.t}
          </div>
          {item.subs.map((s:Sub,si:number)=>(
            <div key={si} onClick={()=>onToggleSub(ii,si)} onTouchEnd={()=>onToggleSub(ii,si)} style={{display:'flex',alignItems:'center',gap:7,padding:'5px 0 5px 24px',fontSize:12,color:'#3d4f68',textDecoration:s.d?'line-through':'none',cursor:'pointer'}}>
              <div style={{width:12,height:12,borderRadius:2,border:`1px solid ${s.d?'#00b35c':'#1e2840'}`,background:s.d?'#00b35c':'transparent',display:'flex',alignItems:'center',justifyContent:'center',flexShrink:0,fontSize:7,color:'white'}}>{s.d?'✓':''}</div>
              {s.t}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

// ── Analytics ─────────────────────────────────────────────
function Analytics({history,compact}:{history:DaySummary[];compact?:boolean}){
  const now=new Date(),year=now.getFullYear()
  const startOfYear=new Date(year,0,1)
  const days:Date[]=[]
  for(let i=0;i<364;i++){const d=new Date(startOfYear);d.setDate(startOfYear.getDate()+i);days.push(d)}
  const scoreMap:Record<string,number>={}
  history.forEach(h=>{scoreMap[h.date]=h.life_score})
  const scores:(number|null)[]=days.map(d=>{
    const ds=d.toISOString().split('T')[0]
    return scoreMap[ds]!==undefined?scoreMap[ds]:null
  })
  const real=scores.filter(s=>s!==null) as number[]
  const avg7=real.length?Math.round(real.slice(-7).reduce((a,b)=>a+b,0)/Math.min(7,real.slice(-7).length)):0
  const avg30=real.length?Math.round(real.slice(-30).reduce((a,b)=>a+b,0)/Math.min(30,real.slice(-30).length)):0
  const avgY=real.length?Math.round(real.reduce((a,b)=>a+b,0)/real.length):0
  let cur=0,maxStr=0;real.forEach(s=>{if(s>70){cur++;maxStr=Math.max(maxStr,cur)}else cur=0})
  const delta=avg7-avg30
  const MONTHS=['Jan','Feb','Mär','Apr','Mai','Jun','Jul','Aug','Sep','Okt','Nov','Dez']
  const lblArr=new Array(52).fill('');let lastM=-1
  days.forEach((d,i)=>{
    const col=Math.floor(i/7)
    if(d.getMonth()!==lastM&&col<52){lblArr[col]=MONTHS[d.getMonth()];lastM=d.getMonth()}
  })
  const isEmpty=real.length===0
  return(
    <div style={{background:'#0f1420',border:'1px solid #1e2840',borderRadius:18,padding:compact?16:20}}>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:16}}>
        <div style={{fontSize:11,fontWeight:700,textTransform:'uppercase',letterSpacing:2,color:'#7a88a8'}}>Analytics {year}</div>
        {isEmpty&&<div style={{fontSize:10,color:'#3d4f68'}}>Noch keine Daten</div>}
      </div>
      {isEmpty?(
        <div style={{textAlign:'center',padding:'24px 0',color:'#3d4f68'}}>
          <div style={{fontSize:28,marginBottom:10}}>📊</div>
          <div style={{fontSize:12}}>Analytics erscheinen nach dem ersten gespeicherten Tag.</div>
        </div>
      ):(
        <>
          <div style={{display:'grid',gridTemplateColumns:compact?'1fr 1fr':'repeat(4,1fr)',gap:compact?8:12,marginBottom:16}}>
            {[{lbl:'7-Tage Avg',val:avg7+'%',extra:(delta>=0?'+':'')+delta+'% vs 30d',pos:delta>=0},{lbl:'30-Tage Avg',val:avg30+'%'},{lbl:'Streak',val:maxStr+'d',extra:'Tage über 70%',pos:true},{lbl:'Jahr Avg',val:avgY+'%'}].map(s=>(
              <div key={s.lbl} style={{background:'#141928',borderRadius:10,padding:'12px 10px',border:'1px solid #1e2840'}}>
                <div style={{fontSize:10,color:'#7a88a8',textTransform:'uppercase',letterSpacing:'.5px'}}>{s.lbl}</div>
                <div style={{fontFamily:'monospace',fontSize:compact?16:20,fontWeight:500,marginTop:3}}>{s.val}</div>
                {s.extra&&<div style={{fontSize:10,fontFamily:'monospace',marginTop:2,color:s.pos?'#00e87a':'#ff4d6a'}}>{s.extra}</div>}
              </div>
            ))}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(52,1fr)',gap:2,marginBottom:3}}>
            {lblArr.map((l,i)=><span key={i} style={{fontSize:8,color:'#3d4f68',fontFamily:'monospace',overflow:'hidden'}}>{l}</span>)}
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(52,1fr)',gap:2}}>
            {scores.map((s,i)=>(
              <div key={i} title={`${days[i]?.toLocaleDateString('de-DE')} ${s!==null?'— '+s+'%':'— kein Eintrag'}`}
                style={{aspectRatio:'1',borderRadius:2,background:s!==null&&s>0?scoreColor(s):'#141928',opacity:s===null?.2:1,cursor:'pointer',transition:'transform .1s',border:'1px solid rgba(255,255,255,.02)'}}
                onMouseEnter={e=>(e.target as HTMLElement).style.transform='scale(1.6)'}
                onMouseLeave={e=>(e.target as HTMLElement).style.transform='scale(1)'}/>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── Modals wrapper ────────────────────────────────────────
function Modals({modal,setModal,analysisOpen,setAnalysisOpen,manageOpen,setManageOpen,habits,tasks,projects,hScore,tScore,life,history,streak,onSaveHabit,onSaveTask,onSaveProject,onEditHabit,onEditTask,onDeleteHabit,onDeleteTask,onSaveAnalysis}:any){
  return(
    <>
      {modal&&<AddModal type={modal.type} editId={modal.editId} habits={habits} tasks={tasks} projects={projects} onClose={()=>setModal(null)} onSaveHabit={onSaveHabit} onSaveTask={onSaveTask} onSaveProject={onSaveProject}/>}
      {analysisOpen&&<AnalysisModal hScore={hScore} tScore={tScore} life={life} history={history} projects={projects} streak={streak} onClose={()=>setAnalysisOpen(false)} onSave={onSaveAnalysis}/>}
      {manageOpen&&<ManageModal habits={habits} tasks={tasks} onClose={()=>setManageOpen(false)} onEditHabit={onEditHabit} onEditTask={onEditTask} onDeleteHabit={onDeleteHabit} onDeleteTask={onDeleteTask}/>}
    </>
  )
}

function AnalysisModal({hScore,tScore,life,history,projects,streak,onClose,onSave}:any){
  const yesterday=history.length?history[history.length-1]?.life_score??0:0
  const delta=life-yesterday
  const pdone=projects.length?Math.round(projects.reduce((a:number,p:Project)=>{const t=p.items.length,d=p.items.filter((i:ProjItem)=>i.d).length;return a+(t?d/t:0)},0)/projects.length*100):0
  const TITLES:Record<number,string>={100:'Legendärer Tag! 🏆',80:'Starke Leistung! 💪',60:'Solider Fortschritt 👍',40:'Gut angefangen ✊',0:'Weiter so! 🌱'}
  const lvl=life>=100?100:life>=80?80:life>=60?60:life>=40?40:0
  return(
    <MW onClose={onClose}>
      <div style={{textAlign:'center'}}>
        <div style={{fontSize:11,color:'#3d4f68',textTransform:'uppercase',letterSpacing:2,fontWeight:600}}>Tagesanalyse</div>
        <div style={{fontFamily:'monospace',fontSize:60,fontWeight:700,background:'linear-gradient(135deg,#00e87a,#00d4c8)',WebkitBackgroundClip:'text',WebkitTextFillColor:'transparent',lineHeight:1.1,margin:'12px 0 6px'}}>{life}%</div>
        <div style={{fontSize:22,fontWeight:800,letterSpacing:-1,marginBottom:4}}>{TITLES[lvl]}</div>
        {streak>0&&<div style={{fontSize:13,color:'#00e87a',marginBottom:12}}>🔥 {streak} Tage Streak!</div>}
        <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:10,margin:'16px 0'}}>
          {[{val:hScore+'%',lbl:'Habits',col:'#00e87a'},{val:tScore+'%',lbl:'Tasks',col:'#3d7fff'},{val:pdone+'%',lbl:'Projekte',col:'#9b6dff'}].map((s,i)=>(
            <div key={s.lbl} style={{background:'#141928',borderRadius:10,padding:12,border:'1px solid #1e2840'}}>
              <div style={{fontFamily:'monospace',fontSize:20,fontWeight:500,marginBottom:3,color:s.col}}>{s.val}</div>
              <div style={{fontSize:10,color:'#7a88a8',textTransform:'uppercase',letterSpacing:1}}>{s.lbl}</div>
            </div>
          ))}
        </div>
        <div style={{fontSize:13,color:'#7a88a8',padding:12,background:'#141928',borderRadius:10,marginBottom:16,border:'1px solid #1e2840'}}>
          Gestern: <b style={{color:'#dce4f5'}}>{yesterday}%</b> → Heute: <b style={{color:'#dce4f5'}}>{life}%</b> —{' '}
          {delta>=0?<b style={{color:'#00e87a'}}>+{delta}% besser 📈</b>:<span style={{color:'#ffb830'}}>{delta}% – morgen!</span>}
        </div>
        <div style={{display:'flex',gap:8,justifyContent:'center',flexWrap:'wrap'}}>
          <Btn onClick={onSave}>💾 In Supabase speichern</Btn>
          <Btn onClick={onClose} ghost>Schließen</Btn>
        </div>
        <div style={{fontSize:11,color:'#3d4f68',marginTop:12}}>Auto-Reset um Mitternacht.</div>
      </div>
    </MW>
  )
}

function ManageModal({habits,tasks,onClose,onEditHabit,onEditTask,onDeleteHabit,onDeleteTask}:any){
  const [tab,setTab]=useState<'habits'|'tasks'>('habits')
  return(
    <MW onClose={onClose} noPad>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',padding:'20px 24px 0'}}>
        <span style={{fontSize:18,fontWeight:800,letterSpacing:-.5}}>Verwalten</span>
        <button onClick={onClose} style={{width:28,height:28,borderRadius:7,background:'#1c2235',border:'1px solid #2d3a55',color:'#7a88a8',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:15}}>✕</button>
      </div>
      <div style={{display:'flex',gap:8,padding:'14px 24px 0'}}>
        {(['habits','tasks'] as const).map(t=>(
          <button key={t} onClick={()=>setTab(t)} style={{flex:1,padding:'9px',borderRadius:9,border:`1px solid ${tab===t?'#3d7fff':'#1e2840'}`,background:tab===t?'rgba(61,127,255,.15)':'#141928',color:tab===t?'#dce4f5':'#7a88a8',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .2s'}}>
            {t==='habits'?`Habits (${habits.length})`:`Tasks (${tasks.length})`}
          </button>
        ))}
      </div>
      <div style={{flex:1,overflowY:'auto',padding:'14px 24px 24px',maxHeight:'60vh'}}>
        {tab==='habits'&&habits.map((h:Habit,i:number)=>(
          <div key={h.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'#141928',borderRadius:10,marginBottom:8,border:'1px solid #1e2840'}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:COLORS[h.color],flexShrink:0}}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{h.name}</div>
              <div style={{fontSize:10,color:'#3d4f68',fontFamily:'monospace'}}>{h.type} · {h.active_days.length===7?'täglich':h.active_days.map((d:number)=>DSHORT[d]).join(', ')}</div>
            </div>
            <button onClick={()=>onEditHabit(h)} style={EBS}>✏</button>
            <button onClick={()=>onDeleteHabit(h.id)} style={DBS}>🗑</button>
          </div>
        ))}
        {tab==='tasks'&&tasks.map((t:Task,i:number)=>(
          <div key={t.id} style={{display:'flex',alignItems:'center',gap:10,padding:'10px 12px',background:'#141928',borderRadius:10,marginBottom:8,border:'1px solid #1e2840',opacity:t.done?.7:1}}>
            <div style={{width:8,height:8,borderRadius:'50%',background:{high:'#ff4d6a',med:'#ffb830',low:'#3d4f68'}[t.prio],flexShrink:0}}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:13,fontWeight:600,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',textDecoration:t.done?'line-through':'none',color:t.done?'#3d4f68':'#dce4f5'}}>{t.title}</div>
              <div style={{fontSize:10,color:'#3d4f68',fontFamily:'monospace'}}>{t.prio}{t.done?' · ✓':t.due?` · ${t.due}`:''}</div>
            </div>
            {!t.done&&<button onClick={()=>onEditTask(t)} style={EBS}>✏</button>}
            <button onClick={()=>onDeleteTask(t.id)} style={DBS}>🗑</button>
          </div>
        ))}
      </div>
    </MW>
  )
}

function AddModal({type:initType,editId,habits,tasks,projects,onClose,onSaveHabit,onSaveTask,onSaveProject}:any){
  const isMobile=useIsMobile()
  const [type,setType]=useState(initType)
  const [title,setTitle]=useState('')
  const [prio,setPrio]=useState<Priority>('med')
  const [due,setDue]=useState('')
  const [subsRaw,setSubsRaw]=useState('')
  const [hType,setHType]=useState<HabitType>('binary')
  const [target,setTarget]=useState('')
  const [unit,setUnit]=useState('')
  const [color,setColor]=useState<BrandColor>('green')
  const [activeDays,setActiveDays]=useState([0,1,2,3,4,5,6])
  const [deadline,setDeadline]=useState('')
  const [projItems,setProjItems]=useState([''])

  useEffect(()=>{
    if(!editId)return
    if(initType==='habit'){const h=habits.find((x:Habit)=>x.id===editId);if(h){setTitle(h.name);setColor(h.color);setHType(h.type);setActiveDays(h.active_days);setTarget(h.target?.toString()||'');setUnit(h.unit||'')}}
    if(initType==='task'){const t=tasks.find((x:Task)=>x.id===editId);if(t){setTitle(t.title);setPrio(t.prio);setDue(t.due||'');setSubsRaw(Array.isArray(t.subs)?t.subs.map((s:Sub)=>s.t).join(', '):'')}}
    if(initType==='project'){const p=projects.find((x:Project)=>x.id===editId);if(p){setTitle(p.name);setColor(p.color);setDeadline(p.deadline);setProjItems([...p.items.map((i:ProjItem)=>i.t),''])}}
  },[editId])

  function submit(){
    if(!title.trim())return
    if(type==='task'){
      const subs=subsRaw.split(',').map(s=>s.trim()).filter(Boolean).map(t=>({t,d:false}))
      onSaveTask({id:editId||Date.now().toString(),title:title.trim(),prio,rollover:false,done:false,subs,due:due||''})
    } else if(type==='habit'){
      const days=activeDays.length?activeDays:[0,1,2,3,4,5,6]
      onSaveHabit({id:editId||Date.now().toString(),name:title.trim(),color,type:hType,active_days:days,done:false,pct:0,target:hType==='metric'?parseFloat(target)||1:undefined,unit:hType==='metric'?unit:undefined,current_val:0})
    } else {
      const items=projItems.filter(s=>s.trim()).map(t=>({t:t.trim(),d:false,subs:[]}))
      onSaveProject({id:editId||Date.now().toString(),name:title.trim(),color,deadline,status:'on-track' as ProjectStatus,items})
    }
  }

  const IS:React.CSSProperties={width:'100%',background:'#141928',border:'1px solid #2d3a55',borderRadius:8,color:'#dce4f5',fontFamily:'inherit',fontSize:15,padding:'11px 12px',outline:'none'}
  const content=(
    <div>
      <div style={{display:'flex',alignItems:'center',justifyContent:'space-between',marginBottom:20}}>
        <span style={{fontSize:18,fontWeight:800,letterSpacing:-.5}}>{editId?'Bearbeiten':'Neu erstellen'}</span>
        <button onClick={onClose} style={{width:32,height:32,borderRadius:8,background:'#1c2235',border:'1px solid #2d3a55',color:'#7a88a8',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:16}}>✕</button>
      </div>
      {!editId&&(
        <div style={{display:'flex',gap:8,marginBottom:20}}>
          {(['task','habit','project'] as const).map(t=>(
            <button key={t} onClick={()=>setType(t)} style={{flex:1,padding:'10px 6px',borderRadius:9,border:`1px solid ${type===t?'#3d7fff':'#1e2840'}`,background:type===t?'rgba(61,127,255,.15)':'#141928',color:type===t?'#dce4f5':'#7a88a8',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'inherit',transition:'all .2s'}}>
              {{task:'Task',habit:'Habit',project:'Projekt'}[t]}
            </button>
          ))}
        </div>
      )}
      <div style={{display:'flex',flexDirection:'column',gap:16}}>
        <MF label="Titel"><input autoFocus value={title} onChange={e=>setTitle(e.target.value)} placeholder={type==='task'?'Was willst du erledigen?':type==='habit'?'Habit-Name…':'Projektname…'} style={IS} onFocus={e=>(e.target.style.borderColor='#3d7fff')} onBlur={e=>(e.target.style.borderColor='#2d3a55')}/></MF>
        {type==='task'&&<>
          <MF label="Priorität">
            <div style={{display:'flex',gap:8}}>
              {(['high','med','low'] as Priority[]).map(p=>{
                const cols:Record<Priority,string>={high:'#ff4d6a',med:'#ffb830',low:'#3d4f68'}
                return<button key={p} onClick={()=>setPrio(p)} style={{flex:1,padding:'10px 8px',borderRadius:8,border:`1px solid ${prio===p?cols[p]:'#1e2840'}`,background:prio===p?cols[p]+'18':'#141928',color:prio===p?cols[p]:'#7a88a8',fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',transition:'all .2s'}}>
                  {{high:'🔴 High',med:'🟡 Med',low:'⚪ Low'}[p]}
                </button>
              })}
            </div>
          </MF>
          <MF label="Fälligkeitsdatum"><input type="date" value={due} onChange={e=>setDue(e.target.value)} style={IS}/></MF>
          <MF label="Sub-Tasks (Komma)"><input value={subsRaw} onChange={e=>setSubsRaw(e.target.value)} placeholder="Recherche, Entwurf" style={IS}/></MF>
        </>}
        {type==='habit'&&<>
          <MF label="Typ">
            <div style={{display:'flex',gap:8}}>
              {(['binary','metric'] as HabitType[]).map(t=>(
                <button key={t} onClick={()=>setHType(t)} style={{flex:1,padding:'10px 8px',borderRadius:8,border:`1px solid ${hType===t?'#3d7fff':'#1e2840'}`,background:hType===t?'rgba(61,127,255,.1)':'#141928',color:hType===t?'#3d7fff':'#7a88a8',fontSize:13,fontWeight:600,cursor:'pointer',fontFamily:'inherit',transition:'all .2s'}}>
                  {t==='binary'?'✓ Binary':'📊 Metrisch'}
                </button>
              ))}
            </div>
          </MF>
          {hType==='metric'&&<div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:12}}>
            <MF label="Zielwert"><input type="number" inputMode="decimal" value={target} onChange={e=>setTarget(e.target.value)} placeholder="2" style={IS}/></MF>
            <MF label="Einheit"><input value={unit} onChange={e=>setUnit(e.target.value)} placeholder="L, km, min" style={IS}/></MF>
          </div>}
          <MF label="Aktive Tage">
            <div style={{display:'flex',gap:5}}>
              {DSHORT.map((d,i)=>(
                <button key={i} onClick={()=>setActiveDays(prev=>prev.includes(i)?prev.filter(x=>x!==i):[...prev,i])}
                  style={{flex:1,height:38,borderRadius:7,border:`1px solid ${activeDays.includes(i)?'#3d7fff':'#1e2840'}`,background:activeDays.includes(i)?'rgba(61,127,255,.15)':'#141928',color:activeDays.includes(i)?'#3d7fff':'#3d4f68',fontSize:11,fontWeight:700,cursor:'pointer',transition:'all .15s'}}>{d}</button>
              ))}
            </div>
            <div style={{display:'flex',gap:6,marginTop:8}}>
              {[['Alle',[0,1,2,3,4,5,6]],['Mo–Fr',[0,1,2,3,4]],['WE',[5,6]]].map(([l,d])=>(
                <button key={l as string} onClick={()=>setActiveDays(d as number[])} style={{padding:'6px 10px',background:'#141928',border:'1px solid #1e2840',borderRadius:6,fontSize:11,color:'#7a88a8',cursor:'pointer'}}>{l as string}</button>
              ))}
            </div>
          </MF>
          <MF label="Farbe">
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {CNAMES.map(cn=>(
                <button key={cn} onClick={()=>setColor(cn)} style={{display:'flex',alignItems:'center',gap:5,padding:'7px 12px',borderRadius:8,border:`1px solid ${color===cn?COLORS[cn]:'#1e2840'}`,background:color===cn?COLORS[cn]+'18':'#141928',color:color===cn?COLORS[cn]:'#7a88a8',fontSize:12,fontWeight:600,cursor:'pointer',transition:'all .2s'}}>
                  <div style={{width:9,height:9,borderRadius:'50%',background:COLORS[cn]}}/>{cn}
                </button>
              ))}
            </div>
          </MF>
        </>}
        {type==='project'&&<>
          <MF label="Deadline"><input value={deadline} onChange={e=>setDeadline(e.target.value)} placeholder="Q2 2026" style={IS}/></MF>
          <MF label="Farbe">
            <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
              {CNAMES.map(cn=><div key={cn} onClick={()=>setColor(cn)} style={{width:28,height:28,borderRadius:'50%',background:COLORS[cn],border:`2.5px solid ${color===cn?'#dce4f5':'transparent'}`,cursor:'pointer',transform:color===cn?'scale(1.2)':'scale(1)',transition:'all .15s'}}/>)}
            </div>
          </MF>
          <MF label="Items">
            {projItems.map((item,i)=>(
              <div key={i} style={{display:'flex',gap:8,marginBottom:8}}>
                <input value={item} onChange={e=>{const arr=[...projItems];arr[i]=e.target.value;setProjItems(arr)}} placeholder={`Item ${i+1}…`} style={{...IS,fontSize:13,padding:'9px 12px'}}/>
                {projItems.length>1&&<button onClick={()=>setProjItems(projItems.filter((_,j)=>j!==i))} style={{padding:'0 12px',background:'rgba(127,29,29,.5)',border:'1px solid rgba(204,41,64,.5)',color:'#ff4d6a',borderRadius:7,cursor:'pointer',fontSize:13,flexShrink:0}}>✕</button>}
              </div>
            ))}
            <button onClick={()=>setProjItems([...projItems,''])} style={{width:'100%',padding:10,background:'#1c2235',border:'1px solid #2d3a55',borderRadius:8,color:'#7a88a8',cursor:'pointer',fontSize:13,fontFamily:'inherit'}}>+ Item</button>
          </MF>
        </>}
        <button onClick={submit} style={{width:'100%',padding:14,background:'linear-gradient(135deg,#2563d4,#7c4fd4)',border:'none',borderRadius:11,color:'#fff',fontSize:15,fontWeight:700,cursor:'pointer',fontFamily:'inherit',marginTop:4}}>
          {editId?'Änderungen speichern':type==='task'?'Task erstellen':type==='habit'?'Habit hinzufügen':'Projekt erstellen'}
        </button>
      </div>
    </div>
  )

  if(isMobile) return(
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',flexDirection:'column',justifyContent:'flex-end'}}>
      <div style={{background:'rgba(0,0,0,.5)',position:'absolute',inset:0}} onClick={onClose}/>
      <div style={{background:'#0f1420',borderRadius:'20px 20px 0 0',borderTop:'1px solid #2d3a55',padding:'16px 20px',paddingBottom:`calc(20px + env(safe-area-inset-bottom,0px))`,maxHeight:'94vh',overflowY:'auto',position:'relative',zIndex:1,animation:'sheetIn .3s cubic-bezier(.34,1.2,.64,1)'}}>
        <div style={{width:36,height:4,borderRadius:2,background:'#2d3a55',margin:'0 auto 20px'}}/>
        {content}
      </div>
    </div>
  )
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',backdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:200}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'#0f1420',border:'1px solid #2d3a55',borderRadius:22,width:520,maxWidth:'94vw',maxHeight:'90vh',overflowY:'auto',padding:28,animation:'modalIn .35s cubic-bezier(.34,1.4,.64,1)'}}>
        {content}
      </div>
    </div>
  )
}

function MW({children,onClose,noPad}:{children:React.ReactNode;onClose:()=>void;noPad?:boolean}){
  const isMobile=useIsMobile()
  if(isMobile) return(
    <div style={{position:'fixed',inset:0,zIndex:200,display:'flex',flexDirection:'column',justifyContent:'flex-end'}}>
      <div style={{background:'rgba(0,0,0,.5)',position:'absolute',inset:0}} onClick={onClose}/>
      <div style={{background:'#0f1420',borderRadius:'20px 20px 0 0',borderTop:'1px solid #2d3a55',padding:noPad?0:'20px',paddingBottom:`calc(${noPad?0:20}px + env(safe-area-inset-bottom,0px))`,maxHeight:'88vh',overflowY:'auto',position:'relative',zIndex:1,animation:'sheetIn .3s ease'}}>
        {!noPad&&<div style={{width:36,height:4,borderRadius:2,background:'#2d3a55',margin:'0 auto 20px'}}/>}
        {children}
      </div>
    </div>
  )
  return(
    <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,.75)',backdropFilter:'blur(8px)',display:'flex',alignItems:'center',justifyContent:'center',zIndex:200}} onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div style={{background:'#0f1420',border:'1px solid #2d3a55',borderRadius:22,width:560,maxWidth:'94vw',maxHeight:'85vh',overflowY:'auto',padding:noPad?0:28,animation:'modalIn .3s ease'}}>
        {children}
      </div>
    </div>
  )
}

// ── Micro ─────────────────────────────────────────────────
function MF({label,children}:{label:string;children:React.ReactNode}){
  return<div><label style={{display:'block',fontSize:10,fontWeight:700,textTransform:'uppercase',letterSpacing:1.5,color:'#3d4f68',marginBottom:6}}>{label}</label>{children}</div>
}
function EditBtn({onClick}:{onClick:()=>void}){
  return<button onClick={onClick} style={{width:24,height:24,borderRadius:5,border:'1px solid #1e2840',background:'transparent',color:'#3d4f68',cursor:'pointer',display:'flex',alignItems:'center',justifyContent:'center',fontSize:11,flexShrink:0,transition:'all .15s'}} onMouseEnter={e=>{(e.currentTarget as HTMLElement).style.borderColor='#3d7fff';(e.currentTarget as HTMLElement).style.color='#3d7fff'}} onMouseLeave={e=>{(e.currentTarget as HTMLElement).style.borderColor='#1e2840';(e.currentTarget as HTMLElement).style.color='#3d4f68'}}>✏</button>
}
function PrioBadge({prio}:{prio:Priority}){
  const s:Record<Priority,React.CSSProperties>={high:{background:'rgba(255,77,106,.15)',color:'#ff4d6a',border:'1px solid rgba(255,77,106,.2)'},med:{background:'rgba(255,184,48,.12)',color:'#ffb830',border:'1px solid rgba(255,184,48,.18)'},low:{background:'#1c2235',color:'#3d4f68',border:'1px solid #1e2840'}}
  return<span style={{fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:4,textTransform:'uppercase',letterSpacing:'.8px',...s[prio]}}>{prio}</span>
}
function SortBar({sort,onChange}:{sort:SortMode;onChange:(s:SortMode)=>void}){
  return(
    <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:12,flexWrap:'wrap'}}>
      <span style={{fontSize:10,color:'#3d4f68',textTransform:'uppercase',letterSpacing:1}}>Sort:</span>
      {(['prio','due','alpha'] as SortMode[]).map(s=>(
        <button key={s} onClick={()=>onChange(s)} style={{padding:'4px 9px',background:sort===s?'rgba(61,127,255,.12)':'#141928',border:`1px solid ${sort===s?'#3d7fff':'#1e2840'}`,borderRadius:6,fontSize:10,fontWeight:700,color:sort===s?'#3d7fff':'#3d4f68',cursor:'pointer',fontFamily:'monospace',transition:'all .15s'}}>
          {{prio:'Priorität',due:'Fälligkeit',alpha:'A–Z'}[s]}
        </button>
      ))}
    </div>
  )
}
function Btn({onClick,children,ghost,small,disabled}:any){
  return<button onClick={onClick} disabled={disabled} style={{display:'flex',alignItems:'center',gap:6,padding:small?'7px 14px':'11px 20px',background:ghost?'rgba(255,255,255,.04)':'linear-gradient(135deg,#2563d4,#7c4fd4)',border:ghost?'1px solid #2d3a55':'none',borderRadius:10,color:ghost?'#7a88a8':'#fff',fontSize:small?12:13,fontWeight:700,cursor:disabled?'not-allowed':'pointer',fontFamily:'inherit',opacity:disabled?.4:1,transition:'all .2s',whiteSpace:'nowrap'}}>{children}</button>
}
function Empty({children}:{children:React.ReactNode}){
  return<div style={{fontSize:12,color:'#3d4f68',textAlign:'center',padding:'20px 0'}}>{children}</div>
}

const GBS:React.CSSProperties={fontSize:11,color:'#7a88a8',background:'#1c2235',border:'1px solid #2d3a55',borderRadius:5,padding:'3px 8px',cursor:'pointer',flexShrink:0}
const EBS:React.CSSProperties={padding:'5px 10px',background:'rgba(61,127,255,.08)',border:'1px solid rgba(61,127,255,.2)',borderRadius:6,color:'#3d7fff',cursor:'pointer',fontSize:11,fontWeight:600,flexShrink:0}
const DBS:React.CSSProperties={padding:'5px 10px',background:'rgba(255,77,106,.08)',border:'1px solid rgba(255,77,106,.2)',borderRadius:6,color:'#ff4d6a',cursor:'pointer',fontSize:11,flexShrink:0}
