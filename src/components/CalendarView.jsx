import { memo,  useState, useMemo, useEffect, useCallback, useRef } from 'react';
import DateInput from './DateInput';
import TimeInput from './TimeInput';
import { motion, AnimatePresence } from 'framer-motion';
import { logActivity } from '../utils/activityLog';
import { useSyncApplied } from '../utils/useSyncApplied';
import {
  isGCalConnected,
  getCalendarToken, fetchGCalEvents, createGCalEvent, gcalColor,
  queueGCalPush, flushGCalPushQueue,
} from '../utils/googleCalendarSync';
import Select from './Select';
import { localDateStr as toISO } from '../utils/date';
import { genId } from '../utils/id';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const HOURS = [];
for (let i = 0; i < 24; i++) {
  const label = i === 0 ? '12 AM' : i < 12 ? `${i} AM` : i === 12 ? '12 PM' : `${i - 12} PM`;
  HOURS.push({ hour: i, label });
}

const HOUR_PX = 64;
const PX_PER_MIN = HOUR_PX / 60;

function GCalIcon({ size = 16 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <rect x="3" y="4" width="18" height="17" rx="2" stroke="#4285f4" strokeWidth="1.5"/>
      <path d="M16 2v4M8 2v4M3 9h18" stroke="#4285f4" strokeWidth="1.5" strokeLinecap="round"/>
      <text x="12" y="18" textAnchor="middle" fontSize="8" fontWeight="700" fill="#4285f4">G</text>
    </svg>
  );
}

function DragHandleIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="9" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/>
      <circle cx="15" cy="6" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="15" cy="18" r="1.5"/>
    </svg>
  );
}

function parseTime(t) {
  if (!t) return 0;
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

function formatTime(mins) {
  const m = Math.max(0, Math.min(1439, mins));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function addHour(timeStr) {
  const h = parseInt((timeStr || '10:00').split(':')[0], 10);
  const min = (timeStr || '10:00').split(':')[1] || '00';
  return `${String(Math.min(23, h + 1)).padStart(2, '0')}:${min}`;
}

const LABEL_STYLE = { display: 'block', fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.08em', marginBottom: 6 };
const INPUT_STYLE = { width: '100%', padding: '11px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 11, color: 'var(--text-primary)', fontSize: '0.92rem', boxSizing: 'border-box' };

const CATEGORY_OPTIONS = [
  { value: 'work', label: 'Work' }, { value: 'learning', label: 'Learning' }, { value: 'fitness', label: 'Fitness' },
  { value: 'mental', label: 'Mental' }, { value: 'finance', label: 'Finance' }, { value: 'growth', label: 'Growth' },
];

export default memo(function CalendarView({ tasks, onAddTask, onUpdateTask }) {
  const [currentDate,   setCurrentDate]   = useState(() => new Date());
  const [viewMode,      setViewMode]      = useState('day');
  const [showAddModal,  setShowAddModal]  = useState(false);
  const [modalSubmitting, setModalSubmitting] = useState(false);
  const [modalDate,     setModalDate]     = useState(toISO(new Date()));
  const [modalTitle,    setModalTitle]    = useState('');
  const [modalCategory, setModalCategory] = useState('work');
  const [modalTime,     setModalTime]     = useState('10:00');
  const [modalEndTime,  setModalEndTime]  = useState('11:00');
  const [modalNotes,    setModalNotes]    = useState('');
  const [pushToGCal,    setPushToGCal]    = useState(true);
  const [detailEvent,   setDetailEvent]   = useState(null);
  const [showUnscheduled, setShowUnscheduled] = useState(false);
  const [resizing,      setResizing]      = useState(null);
  const [dragOverHour,  setDragOverHour]  = useState(null);
  const [isDragging,    setIsDragging]    = useState(false);

  // Ref-based now-indicator: mutates DOM directly — no grid re-render every 60s
  const nowLineRef  = useRef(null);
  const nowLabelRef = useRef(null);

  const updateNowLine = useCallback(() => {
    const n = new Date();
    const mins = n.getHours() * 60 + n.getMinutes();
    const top  = Math.round(mins * PX_PER_MIN);
    if (nowLineRef.current)  nowLineRef.current.style.top = `${top}px`;
    if (nowLabelRef.current) {
      const h = n.getHours(), m = n.getMinutes();
      const ampm = h >= 12 ? 'PM' : 'AM';
      nowLabelRef.current.textContent = `${h % 12 || 12}:${String(m).padStart(2,'0')} ${ampm}`;
    }
  }, []);

  useEffect(() => {
    updateNowLine();
    const t = setInterval(updateNowLine, 60000);
    return () => clearInterval(t);
  }, [updateNowLine]);

  const [gcalConnected, setGcalConnected] = useState(() => isGCalConnected());
  const [gcalEvents,    setGcalEvents]    = useState([]);
  const [gcalSyncing,   setGcalSyncing]   = useState(false);
  const [gcalError,     setGcalError]     = useState(null);

  const [customEvents, setCustomEvents] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nook-calendar-events') || '[]'); } catch { return []; }
  });
  useSyncApplied(['calendar_events'], () => {   // another device's change, merged into storage
    try { setCustomEvents(JSON.parse(localStorage.getItem('nook-calendar-events') || '[]')); } catch {}
  });

  const saveCustomEvent = ev => {
    const u = [...customEvents, ev];
    setCustomEvents(u);
    localStorage.setItem('nook-calendar-events', JSON.stringify(u));
  };

  const fetchGCalRange = useCallback(async () => {
    if (!isGCalConnected()) return;
    setGcalSyncing(true); setGcalError(null);
    try {
      const token = await getCalendarToken();
      if (!token) { setGcalConnected(false); return; }
      const base = new Date(currentDate);
      const tMin = new Date(base.getFullYear(), base.getMonth() - 1, 1);
      const tMax = new Date(base.getFullYear(), base.getMonth() + 2, 0, 23, 59, 59);
      setGcalEvents(await fetchGCalEvents(token, tMin, tMax));
    } catch { setGcalError('Failed to load events'); } finally { setGcalSyncing(false); }
  }, [currentDate]);

  useEffect(() => { if (gcalConnected) fetchGCalRange(); }, [gcalConnected, fetchGCalRange]);

  // Retry any event pushes that failed (offline, transient API error) —
  // mirrors Tasks' focus-triggered sync, minus the debounce/queue-mutex
  // machinery Tasks needs (Calendar only ever pushes on create, one op at a
  // time, so there's no cross-tab read-modify-write race to guard here).
  useEffect(() => {
    if (!gcalConnected) return;
    const flush = () => { flushGCalPushQueue().then(succeeded => { if (succeeded) fetchGCalRange(); }); };
    flush();
    window.addEventListener('focus', flush);
    return () => window.removeEventListener('focus', flush);
  }, [gcalConnected, fetchGCalRange]);

  const eventsByDate = useMemo(() => {
    const map = {};
    const add = (ds, item) => { if (!ds) return; (map[ds] = map[ds] || []).push(item); };
    tasks?.forEach(t => { if (t.dueDate) add(t.dueDate, { id: t.id, title: t.name || t.text, time: t.time, endTime: t.endTime, isAllDay: t.isAllDay, type: 'task', completed: t.completed, category: t.category || 'work', description: t.description }); });
    customEvents?.forEach(e => { if (e.date) add(e.date, { id: e.id, title: e.title, time: e.time, endTime: e.endTime, isAllDay: e.isAllDay, type: 'event', category: e.category || 'growth' }); });
    gcalEvents.forEach(e => { if (e.date) add(e.date, { id: e.gcalId, title: e.title, time: e.time, endTime: e.endTime, type: 'gcal', colorId: e.colorId, description: e.description, location: e.location, htmlLink: e.htmlLink }); });
    return map;
  }, [tasks, customEvents, gcalEvents]);

  const unscheduledTasks = useMemo(() =>
    (tasks || []).filter(t => !t.time && !t.isAllDay && (!t.dueDate || t.dueDate === toISO(currentDate)))
      .map(t => ({ id: t.id, title: t.name || t.text, type: 'task', completed: t.completed, category: t.category || 'work' }))
  , [tasks, currentDate]);

  const updateEventSchedule = useCallback((id, type, newDate, newTime, newEndTime, isAllDay) => {
    if (type === 'task') {
      const task = tasks?.find(t => t.id === id);
      if (task && onUpdateTask) onUpdateTask({ ...task, dueDate: newDate, time: newTime, endTime: newEndTime, isAllDay });
    } else if (type === 'event') {
      // A custom event with a null date is unreachable in the UI (eventsByDate skips
      // it), so never write one — callers that "unschedule" an event should delete it.
      if (!newDate) return;
      const ev = customEvents.find(e => e.id === id);
      const u = customEvents.map(e => e.id === id ? { ...e, date: newDate, time: newTime, endTime: newEndTime, isAllDay } : e);
      setCustomEvents(u); localStorage.setItem('nook-calendar-events', JSON.stringify(u));
      if (ev) logActivity({ module: 'calendar', entity_type: 'calendar_event', entity_id: id, action: 'updated', title: ev.title });
    }
  }, [tasks, customEvents, onUpdateTask]);

  const handlePrev = () => { const n = new Date(currentDate); if (viewMode === 'month') n.setMonth(n.getMonth()-1); else if (viewMode === 'week') n.setDate(n.getDate()-7); else n.setDate(n.getDate()-1); setCurrentDate(n); };
  const handleNext = () => { const n = new Date(currentDate); if (viewMode === 'month') n.setMonth(n.getMonth()+1); else if (viewMode === 'week') n.setDate(n.getDate()+7); else n.setDate(n.getDate()+1); setCurrentDate(n); };
  const handleToday = () => setCurrentDate(new Date());

  const monthGrid = useMemo(() => {
    const yr = currentDate.getFullYear(), mo = currentDate.getMonth();
    const first = new Date(yr, mo, 1), last = new Date(yr, mo+1, 0), prevLast = new Date(yr, mo, 0).getDate();
    const days = [];
    for (let i = first.getDay()-1; i >= 0; i--) { const d = new Date(yr, mo-1, prevLast-i); days.push({ date: d, isCurrentMonth: false, dateStr: toISO(d) }); }
    for (let i = 1; i <= last.getDate(); i++) { const d = new Date(yr, mo, i); days.push({ date: d, isCurrentMonth: true, dateStr: toISO(d) }); }
    const rem = (Math.ceil(days.length/7)*7) - days.length;
    for (let i = 1; i <= rem; i++) { const d = new Date(yr, mo+1, i); days.push({ date: d, isCurrentMonth: false, dateStr: toISO(d) }); }
    return days;
  }, [currentDate]);

  const weekDays = useMemo(() => {
    const d = new Date(currentDate), s = new Date(d);
    s.setDate(d.getDate() - d.getDay());
    return Array.from({ length: 7 }, (_, i) => { const c = new Date(s); c.setDate(s.getDate()+i); return { date: c, dateStr: toISO(c) }; });
  }, [currentDate]);

  const todayStr = toISO(new Date());

  // Hoisted at component level (not inside a conditional) to obey Rules of Hooks
  const dayDateStr = toISO(currentDate);
  const dayEvs     = eventsByDate[dayDateStr] || [];
  const timedEvs   = dayEvs.filter(e => e.time);
  const allDayEvs  = dayEvs.filter(e => e.isAllDay || (e.type !== 'task' && !e.time));

  const timedWithGeometry = useMemo(() => {
    const list = timedEvs.map(ev => {
      const sM = parseTime(ev.time), eM = ev.endTime ? parseTime(ev.endTime) : sM + 60;
      return { ...ev, startMin: sM, endMin: eM, colIdx: 0 };
    }).sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
    const cols = [];
    list.forEach(ev => {
      let placed = false;
      for (let i = 0; i < cols.length; i++) {
        if (!cols[i].some(o => ev.startMin < o.endMin && ev.endMin > o.startMin)) { cols[i].push(ev); ev.colIdx = i; placed = true; break; }
      }
      if (!placed) { ev.colIdx = cols.length; cols.push([ev]); }
    });
    const tc = cols.length || 1;
    return list.map(ev => ({ ...ev, left: ev.colIdx * (100 / tc), width: 100 / tc }));
  }, [timedEvs]); // eslint-disable-line react-hooks/exhaustive-deps

  const openAddModal = (dateStr, timeStr = '10:00') => {
    setModalDate(dateStr); setModalTime(timeStr); setModalEndTime(addHour(timeStr)); setModalNotes(''); setModalTitle(''); setShowAddModal(true);
  };

  const handleModalSubmit = async e => {
    e.preventDefault();
    if (!modalTitle.trim() || modalSubmitting) return;
    setModalSubmitting(true);
    // genId() (timestamp+random), not Date.now().toString() — the modal stays
    // mounted through the GCal await below, so a fast double-submit during that
    // window used to be able to fire twice within the same millisecond and
    // create two events sharing one id, corrupting every future id-keyed
    // edit/delete for either of them.
    const endTime = modalEndTime || addHour(modalTime);
    const ev = { id: genId(), title: modalTitle.trim(), date: modalDate, time: modalTime, endTime, isAllDay: !modalTime, category: modalCategory, notes: modalNotes };
    // Store as a calendar event ONLY. Previously this also called onAddTask with the
    // same id, so the item was persisted twice (customEvents + tasks) and rendered
    // twice in eventsByDate. Google sync for events goes through the Calendar API
    // (pushToGCal below), not Google Tasks.
    saveCustomEvent(ev);
    logActivity({ module: 'calendar', entity_type: 'calendar_event', entity_id: ev.id, action: 'created', title: ev.title });
    if (gcalConnected && pushToGCal) {
      const payload = { title: ev.title, date: ev.date, time: ev.time, endTime: ev.endTime };
      try {
        const tok = await getCalendarToken();
        if (tok) { await createGCalEvent(tok, payload); await fetchGCalRange(); }
        else queueGCalPush(payload); // couldn't get a token right now — retry on next focus/mount
      } catch {
        queueGCalPush(payload); // offline / transient API error — was previously dropped silently
      }
    }
    setModalSubmitting(false);
    setModalTitle(''); setModalNotes(''); setShowAddModal(false);
  };

  const getCategoryColor = cat => {
    const M = { learning: { bg: 'rgba(59,130,246,.15)', text: 'var(--color-blue)', border: 'var(--color-blue)' }, fitness: { bg: 'rgba(16,185,129,.15)', text: '#34d399', border: 'var(--color-green)' }, mental: { bg: 'rgba(168,85,247,.15)', text: 'var(--color-purple)', border: '#a855f7' }, work: { bg: 'var(--accent-glow)', text: 'var(--accent-light)', border: 'var(--accent)' }, finance: { bg: 'rgba(245,158,11,.15)', text: '#fbbf24', border: 'var(--color-amber)' } };
    return M[cat] || { bg: 'rgba(236,72,153,.15)', text: '#f472b6', border: '#ec4899' };
  };
  const getEventStyle = ev => ev.type === 'gcal' ? (c => ({ bg: `${c}1a`, text: c, border: c }))(gcalColor(ev.colorId)) : getCategoryColor(ev.category);

  // gcal events open their source in Google Calendar; everything else opens the detail modal.
  const openEvent = ev => { ev.htmlLink ? window.open(ev.htmlLink, '_blank') : setDetailEvent(ev); };

  const renderChip = (ev, compact = false) => {
    const c = getEventStyle(ev);
    return (
      <div key={ev.id} title={ev.title + (ev.location ? ` · ${ev.location}` : '')}
        onClick={e2 => { e2.stopPropagation(); openEvent(ev); }}
        style={{ background: c.bg, borderLeft: `3px solid ${c.border}`, color: c.text, padding: compact ? '3px 7px' : '5px 9px', borderRadius: '0 6px 6px 0', fontSize: '0.74rem', fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,.08)' }}>
        {ev.type === 'gcal' && <GCalIcon size={11}/>}
        {ev.time && <span style={{ opacity: .7, fontSize: '0.67rem', fontWeight: 700 }}>{ev.time}</span>}
        <span style={{ textDecoration: ev.completed ? 'line-through' : 'none', color: 'var(--text-primary)' }}>{ev.title}</span>
      </div>
    );
  };

  // Tracks the window-level drag listeners so an unmount mid-resize can tear them down.
  const resizeListenersRef = useRef(null);

  const handleResizeStart = (e, ev, startMin, endMin, edge) => {
    e.stopPropagation(); e.preventDefault();
    const iy = e.clientY, iS = startMin, iE = endMin, ds = toISO(currentDate);
    const onMove = mv => {
      const dm = Math.round((mv.clientY - iy) / PX_PER_MIN / 15) * 15;
      if (edge === 'bottom') setResizing({ id: ev.id, type: ev.type, startMin: iS, endMin: Math.max(iS+15, Math.min(1440, iE+dm)) });
      else setResizing({ id: ev.id, type: ev.type, startMin: Math.min(iE-15, Math.max(0, iS+dm)), endMin: iE });
    };
    const onUp = up => {
      window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp);
      resizeListenersRef.current = null;
      const dm = Math.round((up.clientY - iy) / PX_PER_MIN / 15) * 15;
      if (edge === 'bottom') updateEventSchedule(ev.id, ev.type, ds, formatTime(iS), formatTime(Math.max(iS+15, Math.min(1440, iE+dm))), false);
      else updateEventSchedule(ev.id, ev.type, ds, formatTime(Math.min(iE-15, Math.max(0, iS+dm))), formatTime(iE), false);
      setResizing(null);
    };
    // Tracked so an unmount mid-drag can tear these down (see cleanup effect below).
    resizeListenersRef.current = { onMove, onUp };
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp);
  };

  // Remove any drag listeners still attached if the view unmounts mid-resize.
  useEffect(() => () => {
    const l = resizeListenersRef.current;
    if (l) { window.removeEventListener('mousemove', l.onMove); window.removeEventListener('mouseup', l.onUp); }
  }, []);

  const dropOnHour = (e, dateStr, hour) => {
    e.preventDefault(); setDragOverHour(null); setIsDragging(false);
    try {
      const data = JSON.parse(e.dataTransfer.getData('text/plain'));
      const ts = `${String(hour).padStart(2,'0')}:00`;
      updateEventSchedule(data.id, data.type, dateStr, ts, addHour(ts), false);
    } catch {}
  };

  const dragStart = (e, id, type) => {
    e.dataTransfer.setData('text/plain', JSON.stringify({ id, type }));
    setIsDragging(true);
    setTimeout(() => { if (e.target) e.target.style.opacity = '0.45'; }, 0);
  };
  const dragEnd = e => { setIsDragging(false); setDragOverHour(null); if (e.target) e.target.style.opacity = '1'; };

  // ── Auto-scroll Day view to current hour on mount / when day changes ──
  const dayScrollRef = useRef(null);
  useEffect(() => {
    if (viewMode !== 'day' || dayDateStr !== todayStr) return;
    const el = dayScrollRef.current;
    if (!el) return;
    const n = new Date();
    const mins = n.getHours() * 60 + n.getMinutes();
    // Sit ~1 hour above current time in the viewport
    el.scrollTop = Math.max(0, Math.round(mins * PX_PER_MIN) - HOUR_PX);
  }, [viewMode, dayDateStr, todayStr]);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="calendar-view" style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--bg-base)', overflow: 'hidden', position: 'relative' }}>

      {/* ── Toolbar ─────────────────────────────────────────────────── */}
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 20px', borderBottom: '1px solid var(--border)', background: 'var(--bg-surface)', flexShrink: 0, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button onClick={handleToday} style={{ padding: '6px 13px', background: 'var(--bg-input)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer' }}>Today</button>
          <div style={{ display: 'flex', gap: 2 }}>
            {[handlePrev, handleNext].map((fn, i) => (
              <button key={i} onClick={fn} aria-label={i === 0 ? 'Previous month' : 'Next month'} style={{ padding: 6, background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', borderRadius: 6 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  {i === 0 ? <polyline points="15 18 9 12 15 6"/> : <polyline points="9 18 15 12 9 6"/>}
                </svg>
              </button>
            ))}
          </div>
          <h2 style={{ fontSize: '1.07rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0, letterSpacing: '-0.01em' }}>
            {viewMode === 'month' && `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getFullYear()}`}
            {viewMode === 'week'  && `${MONTH_NAMES[weekDays[0].date.getMonth()]} ${weekDays[0].date.getDate()} – ${weekDays[6].date.getDate()}, ${weekDays[0].date.getFullYear()}`}
            {viewMode === 'day'   && `${MONTH_NAMES[currentDate.getMonth()]} ${currentDate.getDate()}, ${currentDate.getFullYear()}`}
          </h2>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {/* GCal status indicator — read-only; connect/disconnect lives in Settings */}
          {gcalConnected && (
            <div
              title={gcalError ? 'Sync error — open Settings to reconnect' : gcalSyncing ? 'Syncing Google Calendar…' : 'Google Calendar connected'}
              style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 9px', background: 'rgba(66,133,244,.07)', border: '1px solid rgba(66,133,244,.2)', borderRadius: 8, cursor: 'default' }}
            >
              <GCalIcon size={12}/>
              {/* Status dot */}
              <span style={{
                width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                background: gcalError ? 'var(--color-red)' : gcalSyncing ? 'var(--color-amber)' : 'var(--color-green)',
                boxShadow: gcalSyncing ? '0 0 4px rgba(245,158,11,.6)' : gcalError ? '0 0 4px rgba(239,68,68,.6)' : '0 0 4px rgba(34,197,94,.5)',
              }}/>
              {gcalSyncing && (
                <span style={{ fontSize: '0.7rem', fontWeight: 600, color: '#4285f4' }}>Syncing…</span>
              )}
            </div>
          )}


          <div style={{ display: 'flex', background: 'var(--bg-input)', padding: 3, borderRadius: 10, border: '1px solid var(--border)' }}>
            {['month','week','day'].map(m => (
              <button key={m} onClick={() => setViewMode(m)} style={{ padding: '5px 11px', borderRadius: 8, border: 'none', background: viewMode === m ? 'var(--accent)' : 'transparent', color: viewMode === m ? '#fff' : 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600, textTransform: 'capitalize', cursor: 'pointer', transition: 'all .15s ease' }}>{m}</button>
            ))}
          </div>

          <button onClick={() => openAddModal(todayStr, '12:00')} style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 10, fontSize: '0.82rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, boxShadow: '0 2px 8px rgba(120,105,252,.3)', transition: 'all .15s ease' }}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Create Event
          </button>

          <button onClick={() => setShowUnscheduled(s => !s)} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', background: showUnscheduled ? 'var(--accent-glow)' : 'var(--bg-input)', border: `1px solid ${showUnscheduled ? 'rgba(99,102,241,.4)' : 'var(--border)'}`, borderRadius: 10, cursor: 'pointer', color: showUnscheduled ? 'var(--accent)' : 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600, transition: 'all .15s ease' }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
            Inbox
            {unscheduledTasks.length > 0 && <span style={{ background: 'var(--accent)', color: '#fff', padding: '1px 7px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 700 }}>{unscheduledTasks.length}</span>}
          </button>
        </div>
      </header>

      {/* ── Calendar Grid (full width) ─────────────────────────────── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0, background: 'var(--bg-surface)' }}>

        {/* Month */}
        {viewMode === 'month' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              {DAY_NAMES.map(d => <div key={d} style={{ padding: '9px 0', textAlign: 'center', fontSize: '0.73rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{d}</div>)}
            </div>
            <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gridAutoRows: '1fr', background: 'var(--border)', gap: 1, overflow: 'auto' }}>
              {monthGrid.map((cell, i) => {
                const isToday = cell.dateStr === todayStr;
                const evs = eventsByDate[cell.dateStr] || [];
                return (
                  <div key={i} onClick={() => openAddModal(cell.dateStr, '12:00')}
                    style={{ background: cell.isCurrentMonth ? 'var(--bg-surface)' : 'var(--bg-input)', padding: 8, display: 'flex', flexDirection: 'column', cursor: 'pointer', overflow: 'hidden', minHeight: 90 }}
                    onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                    onMouseLeave={e => e.currentTarget.style.background = cell.isCurrentMonth ? 'var(--bg-surface)' : 'var(--bg-input)'}>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 5 }}>
                      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 24, height: 24, borderRadius: '50%', fontSize: '0.82rem', fontWeight: isToday ? 700 : 600, background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? '#fff' : cell.isCurrentMonth ? 'var(--text-primary)' : 'var(--text-muted)', boxShadow: isToday ? '0 2px 6px rgba(120,105,252,.4)' : 'none' }}>{cell.date.getDate()}</span>
                      {evs.some(e => e.type === 'gcal') && <GCalIcon size={10}/>}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, overflowY: 'auto', flex: 1 }}>
                      {evs.slice(0,4).map(ev => renderChip(ev, true))}
                      {evs.length > 4 && <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)', paddingLeft: 4 }}>+{evs.length-4} more</span>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Week */}
        {viewMode === 'week' && (
          <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, overflow: 'hidden' }}>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ width: 64, borderRight: '1px solid var(--border)', flexShrink: 0 }}/>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                {weekDays.map((cell, ci) => {
                  const isToday = cell.dateStr === todayStr;
                  return (
                    <div key={cell.dateStr} style={{ padding: '10px 0', textAlign: 'center', borderRight: ci < 6 ? '1px solid var(--border)' : 'none' }}>
                      <div style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 4 }}>{DAY_NAMES[cell.date.getDay()]}</div>
                      <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: '50%', fontSize: '0.95rem', fontWeight: isToday ? 700 : 600, background: isToday ? 'var(--accent)' : 'transparent', color: isToday ? '#fff' : 'var(--text-primary)' }}>{cell.date.getDate()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
              <div style={{ width: 64, padding: '6px 10px', borderRight: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase' }}>All Day</div>
              <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                {weekDays.map((cell, ci) => (
                  <div key={cell.dateStr} style={{ padding: 4, borderRight: ci < 6 ? '1px solid var(--border)' : 'none', display: 'flex', flexDirection: 'column', gap: 4, minHeight: 36 }}
                    onDragOver={e => e.preventDefault()}
                    onDrop={e => { e.preventDefault(); try { const d = JSON.parse(e.dataTransfer.getData('text/plain')); updateEventSchedule(d.id, d.type, cell.dateStr, null, null, true); setIsDragging(false); } catch {} }}
                    onClick={() => openAddModal(cell.dateStr, '12:00')}>
                    {(eventsByDate[cell.dateStr]||[]).filter(e=>!e.time).map(ev=>renderChip(ev,true))}
                  </div>
                ))}
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {HOURS.map(({ hour, label }) => (
                <div key={hour} style={{ display: 'flex', borderBottom: '1px solid var(--border)', minHeight: HOUR_PX }}>
                  <div style={{ width: 64, padding: '8px 10px', borderRight: '1px solid var(--border)', flexShrink: 0, textAlign: 'right', color: 'var(--text-muted)', fontSize: '0.7rem', fontWeight: 700, boxSizing: 'border-box' }}>{label}</div>
                  <div style={{ flex: 1, display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)' }}>
                    {weekDays.map((cell, ci) => {
                      const hrEvs = (eventsByDate[cell.dateStr]||[]).filter(e => e.time && parseInt(e.time.split(':')[0],10) === hour);
                      return (
                        <div key={cell.dateStr} onClick={() => openAddModal(cell.dateStr, `${String(hour).padStart(2,'0')}:00`)}
                          style={{ borderRight: ci < 6 ? '1px solid var(--border)' : 'none', padding: 5, display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer', transition: 'background .1s ease' }}
                          onDragOver={e => e.preventDefault()}
                          onDrop={e => dropOnHour(e, cell.dateStr, hour)}
                          onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                          onMouseLeave={e => e.currentTarget.style.background = 'transparent'}>
                          {hrEvs.map(ev => {
                            const c = getEventStyle(ev);
                            return (
                              <div key={ev.id} style={{ background: c.bg, border: `1px solid ${c.border}`, borderLeft: `4px solid ${c.border}`, padding: '5px 8px', borderRadius: 6, cursor: 'pointer' }}
                                onClick={e2 => { e2.stopPropagation(); openEvent(ev); }}>
                                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: 'var(--text-primary)', textDecoration: ev.completed?'line-through':'none', display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{ev.title}</span>
                                <span style={{ fontSize: '0.68rem', color: c.text, fontWeight: 600 }}>{ev.time}{ev.endTime ? ` – ${ev.endTime}` : ''}</span>
                              </div>
                            );
                          })}
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Day */}
        {viewMode === 'day' && (
            <div ref={dayScrollRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', overflowY: 'auto', minHeight: 0 }}>

              {/* Sticky All-Day Row */}
              <div
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); try { const d = JSON.parse(e.dataTransfer.getData('text/plain')); updateEventSchedule(d.id, d.type, dayDateStr, null, null, true); } catch {} setIsDragging(false); }}
                style={{ display: 'flex', alignItems: 'center', borderBottom: `2px solid ${isDragging ? 'rgba(99,102,241,.4)' : 'var(--border)'}`, background: isDragging ? 'rgba(99,102,241,.03)' : 'var(--bg-surface)', minHeight: 46, flexShrink: 0, position: 'sticky', top: 0, zIndex: 10, boxShadow: '0 2px 6px rgba(0,0,0,.04)', transition: 'all .15s ease' }}
              >
                <div style={{ width: 64, padding: '8px 10px', borderRight: '1px solid var(--border)', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', fontSize: '0.67rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em', boxSizing: 'border-box', height: '100%' }}>All Day</div>
                <div style={{ flex: 1, padding: '8px 14px', display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', minHeight: 46 }}>
                  {allDayEvs.length === 0 ? (
                    <span style={{ fontSize: '0.8rem', color: 'var(--text-faint)', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 6, opacity: isDragging ? 1 : 0.6 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={isDragging ? 'var(--accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                      {isDragging ? 'Drop here to make all-day' : 'All-day events appear here'}
                    </span>
                  ) : allDayEvs.map(ev => {
                    const c = getEventStyle(ev);
                    return (
                      <div key={ev.id} draggable={ev.type !== 'gcal'}
                        onDragStart={e => dragStart(e, ev.id, ev.type)} onDragEnd={dragEnd}
                        onClick={e => { e.stopPropagation(); openEvent(ev); }}
                        style={{ background: c.bg, border: `1px solid ${c.border}`, borderLeft: `3px solid ${c.border}`, padding: '5px 12px', borderRadius: 7, fontSize: '0.82rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,.06)' }}>
                        {ev.type === 'gcal' && <GCalIcon size={12}/>}
                        <span style={{ textDecoration: ev.completed?'line-through':'none', color: 'var(--text-primary)' }}>{ev.title}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* 24-Hour Timeline */}
              <div style={{ position: 'relative', height: HOUR_PX * 24, width: '100%', flexShrink: 0, overflow: 'hidden' }}>

                {/* Empty-day prompt — inline near current hour, only when today has no timed events */}
                {dayDateStr === todayStr && timedEvs.length === 0 && (() => {
                  const nowHour = new Date().getHours();
                  return (
                    <div style={{ position: 'absolute', top: nowHour * HOUR_PX + HOUR_PX / 2 - 14, left: 72, right: 16, zIndex: 5, pointerEvents: 'none' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: '0.75rem', color: 'var(--text-secondary)', fontWeight: 500, background: 'var(--bg-surface)', border: '1px dashed var(--border-strong)', borderRadius: 8, padding: '4px 12px', opacity: 0.85 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        Nothing scheduled — add something?
                      </span>
                    </div>
                  );
                })()}

                {HOURS.map(({ hour, label }) => (
                  <div key={hour}
                    onClick={() => openAddModal(dayDateStr, `${String(hour).padStart(2,'0')}:00`)}
                    onDragOver={e => { e.preventDefault(); setDragOverHour(hour); }}
                    onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragOverHour(null); }}
                    onDrop={e => dropOnHour(e, dayDateStr, hour)}
                    style={{ position: 'absolute', top: hour * HOUR_PX, left: 0, right: 0, height: HOUR_PX, borderBottom: `1px solid ${dragOverHour === hour ? 'rgba(99,102,241,.45)' : 'var(--border)'}`, display: 'flex', boxSizing: 'border-box', cursor: 'pointer', background: dragOverHour === hour ? 'rgba(99,102,241,.07)' : 'transparent', transition: 'background .1s ease, border-color .1s ease' }}
                    onMouseEnter={e => {
                      if (dragOverHour !== hour) e.currentTarget.style.background = 'rgba(255,255,255,0.018)';
                      const hint = e.currentTarget.querySelector('.cal-plus-hint');
                      if (hint) hint.style.opacity = '1';
                    }}
                    onMouseLeave={e => {
                      if (dragOverHour !== hour) e.currentTarget.style.background = 'transparent';
                      const hint = e.currentTarget.querySelector('.cal-plus-hint');
                      if (hint) hint.style.opacity = '0';
                    }}
                  >
                    {/* A11y: color upgraded from --text-muted (#424d5e) to --text-secondary (#8b96aa) for WCAG AA contrast */}
                    <div style={{ width: 64, padding: '8px 10px', borderRight: '1px solid var(--border)', flexShrink: 0, textAlign: 'right', color: dragOverHour === hour ? 'var(--accent)' : 'var(--text-secondary)', fontSize: '0.7rem', fontWeight: 700, boxSizing: 'border-box', userSelect: 'none', transition: 'color .1s ease' }}>{label}</div>
                    <div style={{ flex: 1, display: 'flex', alignItems: 'center', paddingLeft: 10 }}>
                      {/* Hover "+" affordance — prefills create-event at this hour */}
                      <span className="cal-plus-hint" style={{ opacity: 0, transition: 'opacity .15s ease', fontSize: '0.7rem', color: 'var(--text-secondary)', display: 'inline-flex', alignItems: 'center', gap: 4, pointerEvents: 'none', userSelect: 'none' }}>
                        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                        Add event
                      </span>
                    </div>
                  </div>
                ))}

                {/* Current time indicator — DOM-mutated via ref, no re-render on 60s tick */}
                {dayDateStr === todayStr && (
                  <div
                    ref={nowLineRef}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 0, zIndex: 40, pointerEvents: 'none' }}
                  >
                    {/* Time label */}
                    <span
                      ref={nowLabelRef}
                      style={{ position: 'absolute', left: 2, top: -9, fontSize: '0.6rem', fontWeight: 700, color: 'var(--color-red)', whiteSpace: 'nowrap', background: 'var(--bg-surface)', padding: '1px 4px', borderRadius: 3, lineHeight: 1.4 }}
                    />
                    {/* Dot at the column boundary */}
                    <div style={{ position: 'absolute', left: 59, top: -5, width: 10, height: 10, borderRadius: '50%', background: 'var(--color-red)', boxShadow: '0 0 8px rgba(239,68,68,.6)' }}/>
                    {/* Horizontal line */}
                    <div style={{ position: 'absolute', left: 64, right: 0, top: 0, height: 2, background: 'var(--color-red)' }}/>
                  </div>
                )}


                {/* Event blocks */}
                <div style={{ position: 'absolute', top: 0, left: 64, right: 0, height: HOUR_PX * 24, pointerEvents: 'none' }}>
                  {timedWithGeometry.map(ev => {
                    const isR = resizing?.id === ev.id;
                    const sM = isR ? resizing.startMin : ev.startMin;
                    const eM = isR ? resizing.endMin   : ev.endMin;
                    const top = Math.round(sM * PX_PER_MIN);
                    const ht  = Math.max(22, Math.round((eM - sM) * PX_PER_MIN));
                    const c   = getEventStyle(ev);
                    return (
                      <div key={ev.id}
                        draggable={ev.type !== 'gcal'}
                        onDragStart={e => dragStart(e, ev.id, ev.type)} onDragEnd={dragEnd}
                        onClick={e => { e.stopPropagation(); openEvent(ev); }}
                        style={{ position: 'absolute', top: `${top}px`, height: `${ht}px`, left: `calc(${ev.left}% + 3px)`, width: `calc(${ev.width}% - 6px)`, background: c.bg, border: `1px solid ${c.border}`, borderLeft: `4px solid ${c.border}`, borderRadius: 8, padding: '7px 10px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', overflow: 'hidden', cursor: 'grab', boxShadow: '0 2px 8px rgba(0,0,0,.07)', zIndex: isR ? 50 : 10, pointerEvents: 'auto', transition: isR ? 'none' : 'box-shadow .15s ease' }}
                        onMouseEnter={e => e.currentTarget.style.boxShadow = '0 4px 16px rgba(0,0,0,.15)'}
                        onMouseLeave={e => e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,.07)'}
                      >
                        {ev.type !== 'gcal' && <div onMouseDown={e => handleResizeStart(e,ev,sM,eM,'top')} style={{ position:'absolute',top:0,left:0,right:0,height:7,cursor:'ns-resize',zIndex:20 }}/>}
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          {ev.type === 'gcal' && <GCalIcon size={11}/>}
                          <span style={{ fontSize: '0.82rem', fontWeight: 700, color: 'var(--text-primary)', textDecoration: ev.completed?'line-through':'none', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{ev.title}</span>
                          {ev.completed && <span style={{ color: 'var(--color-green)', fontSize: '0.68rem', marginLeft: 'auto' }}>✓</span>}
                        </div>
                        {ht >= 38 && <span style={{ fontSize: '0.7rem', color: 'var(--text-secondary)', fontWeight: 600, marginTop: 3 }}>{formatTime(sM)} – {formatTime(eM)}</span>}
                        {ev.type !== 'gcal' && <div onMouseDown={e => handleResizeStart(e,ev,sM,eM,'bottom')} style={{ position:'absolute',bottom:0,left:0,right:0,height:7,cursor:'ns-resize',zIndex:20 }}/>}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
        )}
      </div>

      {/* ── Fixed Unscheduled Drawer ───────────────────────────────── */}
      <AnimatePresence>
        {showUnscheduled && (
          <motion.div
            initial={{ x: 340, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 340, opacity: 0 }}
            transition={{ duration: 0.22, ease: [0.2, 0, 0, 1] }}
            style={{ position: 'fixed', top: 56, right: 0, bottom: 0, width: 320, background: 'var(--bg-elevated)', borderLeft: '1px solid var(--border)', zIndex: 40, display: 'flex', flexDirection: 'column', boxShadow: '-6px 0 32px rgba(0,0,0,.12)', boxSizing: 'border-box' }}
          >
            {/* Drawer header */}
            <div style={{ padding: '0 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 50, flexShrink: 0, background: 'var(--bg-surface)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="15" y1="3" x2="15" y2="21"/></svg>
                <span style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>Inbox</span>
                <span style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', padding: '2px 7px', borderRadius: 8, fontSize: '0.7rem', fontWeight: 700 }}>{unscheduledTasks.length}</span>
              </div>
              <button onClick={() => setShowUnscheduled(false)} style={{ background: 'transparent', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', width: 28, height: 28, borderRadius: 6, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.05rem', transition: 'all .1s ease' }}
                onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-muted)'; }}>✕</button>
            </div>

            {/* Hint bar */}
            <div style={{ padding: '10px 14px 6px', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 11px', background: 'rgba(99,102,241,.06)', border: '1px solid rgba(99,102,241,.15)', borderRadius: 8 }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                <span style={{ fontSize: '0.73rem', color: 'var(--text-secondary)', fontWeight: 500, lineHeight: 1.4 }}>Drag cards onto the timeline to schedule</span>
              </div>
            </div>

            {/* Task list */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '6px 14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
              {unscheduledTasks.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '52px 16px', color: 'var(--text-muted)' }}>
                  <div style={{ fontSize: '1.8rem', marginBottom: 10 }}>✨</div>
                  <div style={{ fontSize: '0.88rem', fontWeight: 600, marginBottom: 4 }}>All clear!</div>
                  <div style={{ fontSize: '0.76rem', color: 'var(--text-faint)' }}>No unscheduled tasks.</div>
                </div>
              ) : unscheduledTasks.map(t => {
                const c = getCategoryColor(t.category);
                return (
                  <div key={t.id}
                    draggable
                    onDragStart={e => dragStart(e, t.id, t.type)}
                    onDragEnd={dragEnd}
                    onClick={() => setDetailEvent(t)}
                    style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderLeft: `5px solid ${c.border}`, padding: '13px 13px 13px 11px', borderRadius: '0 10px 10px 0', display: 'flex', alignItems: 'center', gap: 9, cursor: 'grab', boxShadow: '0 1px 3px rgba(0,0,0,.05)', transition: 'box-shadow .15s ease, transform .1s ease' }}
                    onMouseEnter={e => { e.currentTarget.style.boxShadow = '0 4px 14px rgba(0,0,0,.1)'; e.currentTarget.style.transform = 'translateX(-2px)'; }}
                    onMouseLeave={e => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,.05)'; e.currentTarget.style.transform = 'none'; }}
                  >
                    <span style={{ color: 'var(--text-faint)', flexShrink: 0, display: 'flex', alignItems: 'center' }}><DragHandleIcon/></span>
                    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4, overflow: 'hidden' }}>
                      <span style={{ fontSize: '0.87rem', fontWeight: 700, color: 'var(--text-primary)', textDecoration: t.completed?'line-through':'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                      <span style={{ background: c.bg, color: c.text, padding: '2px 8px', borderRadius: 20, fontSize: '0.66rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', width: 'fit-content' }}>{t.category}</span>
                    </div>
                    <button
                      title="Schedule for 12 PM"
                      onClick={e => { e.stopPropagation(); updateEventSchedule(t.id, t.type, toISO(currentDate), '12:00', '13:00', false); }}
                      style={{ background: 'var(--bg-hover)', border: '1px solid var(--border)', color: 'var(--text-secondary)', cursor: 'pointer', width: 30, height: 30, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, transition: 'all .15s ease' }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--accent)'; e.currentTarget.style.color = '#fff'; e.currentTarget.style.borderColor = 'var(--accent)'; }}
                      onMouseLeave={e => { e.currentTarget.style.background = 'var(--bg-hover)'; e.currentTarget.style.color = 'var(--text-secondary)'; e.currentTarget.style.borderColor = 'var(--border)'; }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="12" y1="14" x2="12" y2="18"/><line x1="10" y1="16" x2="14" y2="16"/></svg>
                    </button>
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Create Event Modal ─────────────────────────────────────── */}
      <AnimatePresence>
        {showAddModal && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
            onClick={() => setShowAddModal(false)}>
            <motion.div initial={{ opacity: 0, y: 18, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .97 }} transition={{ duration: .2, ease: 'easeOut' }}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 22, padding: '26px 28px 30px', width: '100%', maxWidth: 500, boxShadow: '0 24px 48px rgba(0,0,0,.4)' }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 22 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round"><rect x="3" y="4" width="18" height="17" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                  </div>
                  <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>New Event</h3>
                </div>
                <button onClick={() => setShowAddModal(false)} style={{ background: 'var(--bg-hover)', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.05rem' }}>✕</button>
              </div>
              <form onSubmit={handleModalSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={LABEL_STYLE}>Title</label>
                  <input type="text" value={modalTitle} onChange={e => setModalTitle(e.target.value)} placeholder="What's the event?" autoFocus required style={INPUT_STYLE} onFocus={e => e.target.style.borderColor = 'var(--accent)'} onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
                  <div>
                    <label style={LABEL_STYLE}>Date</label>
                    <DateInput value={modalDate} onChange={e => setModalDate(e.target.value)} required style={{ ...INPUT_STYLE, fontSize: '0.85rem', padding: '10px 12px', colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>Start</label>
                    <TimeInput value={modalTime} onChange={e => setModalTime(e.target.value)} style={{ ...INPUT_STYLE, fontSize: '0.85rem', padding: '10px 12px', colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>End</label>
                    <TimeInput value={modalEndTime} onChange={e => setModalEndTime(e.target.value)} style={{ ...INPUT_STYLE, fontSize: '0.85rem', padding: '10px 12px', colorScheme: 'dark' }} />
                  </div>
                </div>
                <div>
                  <label style={LABEL_STYLE}>Category</label>
                  <Select value={modalCategory} onChange={e => setModalCategory(e.target.value)}
                    options={CATEGORY_OPTIONS}
                    style={INPUT_STYLE} />
                </div>
                <div>
                  <label style={LABEL_STYLE}>Notes</label>
                  <textarea value={modalNotes} onChange={e => setModalNotes(e.target.value)} placeholder="Add notes…" rows={3} spellCheck="true" autoCorrect="on" style={{ ...INPUT_STYLE, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} onFocus={e => e.target.style.borderColor = 'var(--accent)'} onBlur={e => e.target.style.borderColor = 'var(--border)'} />
                </div>
                {gcalConnected && (
                  <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '9px 13px', background: 'rgba(66,133,244,.08)', border: '1px solid rgba(66,133,244,.2)', borderRadius: 10 }}>
                    <input type="checkbox" checked={pushToGCal} onChange={e => setPushToGCal(e.target.checked)} style={{ width: 16, height: 16, accentColor: '#4285f4' }} />
                    <GCalIcon size={13}/>
                    <span style={{ fontSize: '0.85rem', fontWeight: 600, color: '#4285f4' }}>Add to Google Calendar</span>
                  </label>
                )}
                <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
                  <button type="button" onClick={() => setShowAddModal(false)} disabled={modalSubmitting} style={{ flex: 1, padding: 12, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 13, color: 'var(--text-secondary)', fontWeight: 600, cursor: modalSubmitting ? 'default' : 'pointer', opacity: modalSubmitting ? 0.6 : 1 }}>Cancel</button>
                  <button type="submit" disabled={modalSubmitting} style={{ flex: 2, padding: 12, background: 'var(--accent)', border: 'none', borderRadius: 13, color: '#fff', fontWeight: 700, cursor: modalSubmitting ? 'default' : 'pointer', opacity: modalSubmitting ? 0.6 : 1, boxShadow: '0 4px 14px rgba(120,105,252,.35)' }}>{modalSubmitting ? 'Saving…' : 'Save Event'}</button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Detail Modal ───────────────────────────────────────────── */}
      <AnimatePresence>
        {detailEvent && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
            onClick={() => setDetailEvent(null)}>
            <motion.div initial={{ opacity: 0, y: 18, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 18, scale: .97 }} transition={{ duration: .2, ease: 'easeOut' }}
              style={{ background: 'var(--bg-elevated)', border: '1px solid var(--border)', borderRadius: 22, padding: 28, width: '100%', maxWidth: 460, boxShadow: '0 24px 48px rgba(0,0,0,.4)', display: 'flex', flexDirection: 'column', gap: 18 }}
              onClick={e => e.stopPropagation()}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <h3 style={{ fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>Event Details</h3>
                <button onClick={() => setDetailEvent(null)} style={{ background: 'var(--bg-hover)', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.05rem' }}>✕</button>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div>
                  <label style={LABEL_STYLE}>Title</label>
                  <input type="text" value={detailEvent.title || ''} onChange={e => setDetailEvent({ ...detailEvent, title: e.target.value })} style={INPUT_STYLE} />
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                  <div>
                    <label style={LABEL_STYLE}>Start Time</label>
                    <TimeInput value={detailEvent.time || ''} onChange={e => setDetailEvent({ ...detailEvent, time: e.target.value, isAllDay: !e.target.value })} style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
                  </div>
                  <div>
                    <label style={LABEL_STYLE}>End Time</label>
                    <TimeInput value={detailEvent.endTime || ''} onChange={e => setDetailEvent({ ...detailEvent, endTime: e.target.value })} style={{ ...INPUT_STYLE, colorScheme: 'dark' }} />
                  </div>
                </div>
                <div>
                  <label style={LABEL_STYLE}>Category</label>
                  <Select value={detailEvent.category || 'work'} onChange={e => setDetailEvent({ ...detailEvent, category: e.target.value })}
                    options={CATEGORY_OPTIONS}
                    style={INPUT_STYLE} />
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '11px 14px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 11 }}>
                  <input type="checkbox" checked={!!detailEvent.completed} onChange={e => setDetailEvent({ ...detailEvent, completed: e.target.checked })} style={{ width: 17, height: 17, accentColor: 'var(--color-green)' }} />
                  <span style={{ fontSize: '0.92rem', fontWeight: 600, color: 'var(--text-primary)' }}>Mark as Completed</span>
                </label>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button type="button" onClick={() => {
                    if (detailEvent.type === 'event') {
                      // Custom events have no "unscheduled" state and no other delete path,
                      // so removing them from the calendar means deleting the record.
                      if (!confirm(`Delete "${detailEvent.title || 'this event'}"?`)) return;
                      const u = customEvents.filter(e => e.id !== detailEvent.id);
                      setCustomEvents(u); localStorage.setItem('nook-calendar-events', JSON.stringify(u));
                      logActivity({ module: 'calendar', entity_type: 'calendar_event', entity_id: detailEvent.id, action: 'deleted', title: detailEvent.title });
                    } else if (detailEvent.type === 'task') {
                      updateEventSchedule(detailEvent.id, 'task', null, null, null, false);
                    }
                    // gcal events are read-only in Nook — nothing to unschedule locally
                    setDetailEvent(null);
                  }} style={{ flex: 1, padding: 12, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 13, color: 'var(--color-red)', fontWeight: 600, cursor: 'pointer' }}>Unschedule</button>
                  <button type="button" onClick={() => {
                    if (detailEvent.type === 'task') {
                      const task = tasks?.find(t => t.id === detailEvent.id);
                      if (task && onUpdateTask) onUpdateTask({ ...task, name: detailEvent.title, time: detailEvent.time, endTime: detailEvent.endTime, isAllDay: detailEvent.isAllDay, category: detailEvent.category, completed: detailEvent.completed });
                    } else if (detailEvent.type === 'event') {
                      // Persist ALL edited fields (title/category/completed too — not just
                      // schedule) and preserve the event's own date via the `...e` spread.
                      const u = customEvents.map(e => e.id === detailEvent.id
                        ? { ...e, title: detailEvent.title, time: detailEvent.time, endTime: detailEvent.endTime, isAllDay: detailEvent.isAllDay, category: detailEvent.category, completed: detailEvent.completed }
                        : e);
                      setCustomEvents(u); localStorage.setItem('nook-calendar-events', JSON.stringify(u));
                      logActivity({ module: 'calendar', entity_type: 'calendar_event', entity_id: detailEvent.id, action: 'updated', title: detailEvent.title });
                    }
                    // (gcal events are read-only in Nook — no local persistence path)
                    setDetailEvent(null);
                  }} style={{ flex: 2, padding: 12, background: 'var(--accent)', border: 'none', borderRadius: 13, color: '#fff', fontWeight: 700, cursor: 'pointer', boxShadow: '0 4px 14px rgba(120,105,252,.35)' }}>Save Changes</button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
});
