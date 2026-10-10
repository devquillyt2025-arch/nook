import { useState, useMemo, useSyncExternalStore } from 'react';
import Select from './Select';
import { TodayDonut, WeekBars, CategoryPie } from './TodayCharts';
import { getTickSeconds, subscribeTick } from '../utils/timerTickStore';
import { useSyncApplied } from '../utils/useSyncApplied';
import { calcStreak as habitStreak } from '../habitsStore';
import { CAT_META } from '../utils/categoryMeta';
import { localDateStr } from '../utils/date';
import { buildToday, countEventsOn } from '../trackers/todayStats';
import { daysBetween } from '../trackers/reportsAnalytics';

// ─── Today ─────────────────────────────────────────────────────────
// The landing dashboard: three small charts (today's progress, the last 7 days, this week
// by category) over the things you act on today — tasks due, habits, the timer, the journal.
// All the numbers come from buildToday() (trackers/todayStats.js). Anything deeper lives in
// Reports. (The old Goals / Recent Activity / Time Breakdown cards are gone: they showed
// made-up or all-time numbers under "today" labels, or data nothing can create any more.)

const ROWS = 4;   // rows shown per list card — "View all" opens the full tab

function readJSON(key, fallback) {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function loadRecentJournalEntries() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('nook_journal_')) continue;
    try {
      const e = JSON.parse(localStorage.getItem(key));
      if (e?.date) out.push(e);
    } catch {}
  }
  return out.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 3);
}

function getJournalPreview(content) {
  if (!content) return 'No entry yet';
  const text = content.replace(/<\/?[^>]+(>|$)/g, '').trim();
  if (!text) return 'No entry yet';
  return text.length > 50 ? text.slice(0, 50) + '...' : text;
}

function formatTimerDisplay(secs) {
  if (secs == null || isNaN(secs)) return '25:00';
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const fmtMinutes = m => `${Math.floor(m / 60)}h ${m % 60}m`;
const shortDate  = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });

export default function DailyGoalsView({
  pomodoroLog = [], tasks = [], habits = [],
  onTriggerWeeklyReview, onMarkHabitDone,
  selectTask, toggleComplete, setOpenModal, setEditingTask,
  startTimer, pauseTimer, resetTimer, timerState, timerMode, totalSeconds: totalSessionSeconds = 1500, setActiveTab,
}) {
  // Sourced from an external store (not props) so this 1s tick only re-renders
  // DailyGoalsView itself, not the whole app tree — see utils/timerTickStore.js.
  const timerSeconds = useSyncExternalStore(subscribeTick, getTickSeconds);
  const [mode, setMode] = useState('viewing'); // 'viewing' or 'editing'
  const [taskRange, setTaskRange] = useState('today'); // 'today' or 'week'

  // The slices read straight from localStorage are re-read when another device's change lands.
  const [ver, setVer] = useState(0);
  useSyncApplied(['journal', 'calendar_events', 'custom_categories', 'weekly_reviews'], () => setVer(v => v + 1));

  // Single LOCAL "today" for every day-comparison here (see trackers/todayStats.js).
  const todayStr = localDateStr();

  // Loaded per sync-version, not per render: this component re-renders every second from the timer
  // tick, and these scan localStorage / parse JSON.
  const journalEntries = useMemo(() => loadRecentJournalEntries(), [ver]);   // eslint-disable-line react-hooks/exhaustive-deps
  const customCats     = useMemo(() => readJSON('nook_custom_categories', {}), [ver]);   // eslint-disable-line react-hooks/exhaustive-deps
  const eventsToday    = useMemo(() => countEventsOn(readJSON('nook-calendar-events', []), todayStr), [ver, todayStr]);   // eslint-disable-line react-hooks/exhaustive-deps
  // One tiny key, read every render (not memoised): a review saved from the modal doesn't touch `ver`,
  // and the modal closing re-renders this view, so "Last weekly review" is current straight away.
  const lastReview     = readJSON('nook-weekly-reviews', [])[0]?.date || null;

  const T = useMemo(
    () => buildToday({ tasks, habits, pomodoroLog, customCategories: customCats }, todayStr),
    [tasks, habits, pomodoroLog, customCats, todayStr],
  );
  const catMeta = { ...CAT_META, ...customCats };

  const journalDoneToday = journalEntries.some(e => e.date === todayStr && getJournalPreview(e.content) !== 'No entry yet');
  const habitsDue = T.habits.scheduled - T.habits.done;

  // Focus today: the logged sessions, plus the minutes elapsed in a focus session that's running now.
  const liveMin = timerState === 'running' && timerMode === 'focus' ? Math.max(0, Math.floor((totalSessionSeconds - timerSeconds) / 60)) : 0;
  const focusToday = T.focus.minutesToday + liveMin;

  const taskList = taskRange === 'today' ? T.tasks.due : T.tasks.dueWeek;
  const taskRows = taskList.slice(0, ROWS);
  const taskBarPct = T.donut.tasksPlanned ? Math.round((T.tasks.doneToday / T.donut.tasksPlanned) * 100) : 0;
  const habitPct = T.habits.scheduled ? Math.round((T.habits.done / T.habits.scheduled) * 100) : 0;
  const streaks = habits.map(h => ({ h, n: habitStreak(h) })).filter(x => x.n > 0);

  const dueTag = t => t.dueDate < todayStr ? { text: `${daysBetween(t.dueDate, todayStr)}d overdue`, color: 'var(--color-red)' }
    : t.dueDate > todayStr ? { text: shortDate(t.dueDate), color: 'var(--text-muted)' } : null;

  return (
    <div className="today-3col-container">

      {/* ── GREETING ROW — pinned (position:sticky, see .today-head) while everything below scrolls ── */}
      <div className="today-head">
      <div className="yartu-greeting-row">
        <div className="yartu-greeting-left">
          <h1 className="yartu-greeting-title">Welcome back, {localStorage.getItem('nook-profile-name') || 'Friend'} 👋</h1>
          <div className="yartu-summary-strip">
            <span className="yartu-summary-prefix">Today you have:</span>
            <div className="yartu-summary-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-blue)' }}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              <span className="yartu-summary-num">{eventsToday}</span>
              <span className="yartu-summary-label">{eventsToday === 1 ? 'calendar event' : 'calendar events'}</span>
            </div>
            <span className="yartu-summary-divider">·</span>
            <div className="yartu-summary-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--accent)' }}><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
              <span className="yartu-summary-num">{T.tasks.due.length}</span>
              <span className="yartu-summary-label">{T.tasks.due.length === 1 ? 'task due' : 'tasks due'}{T.tasks.overdue > 0 && <span style={{ color: 'var(--color-red)' }}> ({T.tasks.overdue} overdue)</span>}</span>
            </div>
            <span className="yartu-summary-divider">·</span>
            <div className="yartu-summary-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-amber)' }}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
              <span className="yartu-summary-num">{habitsDue}</span>
              <span className="yartu-summary-label">{habitsDue === 1 ? 'habit due' : 'habits due'}</span>
            </div>
            <span className="yartu-summary-divider">·</span>
            <div className="yartu-summary-item">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: 'var(--color-purple)' }}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
              <span className="yartu-summary-num">{journalDoneToday ? 0 : 1}</span>
              <span className="yartu-summary-label">{journalDoneToday ? 'journal entries pending' : 'journal entry pending'}</span>
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
          <div className="yartu-mode-toggle" title="Switch to Editing mode to manage tasks directly from the dashboard.">
            <button className={`yartu-mode-btn${mode === 'viewing' ? ' active' : ''}`} onClick={() => setMode('viewing')} title="View dashboard summary">Viewing</button>
            <button className={`yartu-mode-btn${mode === 'editing' ? ' active' : ''}`} onClick={() => setMode('editing')} title="Enable dashboard task management">Editing</button>
          </div>
          <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 500 }} title="In Editing mode, you can quickly edit tasks and add new tasks directly from here.">
            {mode === 'editing' ? 'Editing: task controls enabled' : 'Viewing: toggle editing to manage'}
          </span>
        </div>
      </div>
      </div>

      {/* ── CHARTS ── (on a phone: today's donut, then the action cards, then the other two) */}
      <div className="today-charts">
        <div className="yartu-card tc-donut-card">
          <div className="yartu-card-hdr stacked">
            <span className="yartu-card-title">Today</span>
            <span className="tc-card-sub">Done of what's planned</span>
          </div>
          <TodayDonut donut={T.donut} />
        </div>

        <div className="yartu-card tc-week-card">
          <div className="yartu-card-hdr">
            <span className="yartu-card-title">Last 7 days</span>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="yartu-card-action" onClick={() => onTriggerWeeklyReview?.()} title="Reflect on your last 7 days">Weekly review</button>
              <button className="yartu-card-action" onClick={() => setActiveTab?.('reports')} title="Full analysis in Reports">Reports →</button>
            </div>
          </div>
          <WeekBars week={T.week} />
          <span className="tc-foot">{lastReview ? `Last weekly review: ${new Date(lastReview).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : 'No weekly review yet — reflect on your week.'}</span>
        </div>

        <div className="yartu-card tc-pie-card">
          <div className="yartu-card-hdr stacked">
            <span className="yartu-card-title">This week by category</span>
            <span className="tc-card-sub">Tasks completed, last 7 days</span>
          </div>
          <CategoryPie items={T.byCategory} />
        </div>
      </div>

      {/* ── ACT ON TODAY ── */}
      <div className="today-actions">

        <div className="today-col">

          {/* TASKS DUE */}
          <div className="yartu-card">
            <div className="yartu-card-hdr">
              <span className="yartu-card-title">Tasks</span>
              <Select
                className="yartu-card-select"
                value={taskRange}
                onChange={e => setTaskRange(e.target.value)}
                options={[
                  { value: 'today', label: 'Due today' },
                  { value: 'week', label: 'Next 7 days' },
                ]}
                style={{ padding: '4px 8px', fontSize: '0.8rem', borderRadius: '6px', background: 'transparent', border: 'none', color: 'var(--text-secondary)', width: '120px' }}
              />
            </div>
            <div className="yartu-list">
              <div className="yartu-card-summary" style={{ padding: '0 4px 12px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 6 }}>
                  <span>{T.tasks.doneToday} done today · {T.tasks.due.length} still due</span>
                  <span>{taskBarPct}%</span>
                </div>
                <div className="yartu-mini-bar-track" style={{ height: 6 }}>
                  <div className="yartu-mini-bar-fill" style={{ width: `${taskBarPct}%` }} />
                </div>
              </div>
              {taskRows.length === 0 ? (
                <div style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>
                  Nothing due {taskRange === 'today' ? 'today' : 'in the next 7 days'} 🎉
                  {T.tasks.undated > 0 && <div style={{ marginTop: 4, fontSize: '0.78rem' }}>{T.tasks.undated} other task{T.tasks.undated === 1 ? ' has' : 's have'} no due date.</div>}
                </div>
              ) : (
                taskRows.map(task => {
                  const meta = catMeta[task.category] ?? catMeta.work ?? CAT_META.work;
                  const tag = dueTag(task);
                  return (
                    <div key={task.id} className="yartu-compact-row" onClick={() => { if (mode !== 'editing') selectTask?.(task.id); }} style={{ cursor: mode === 'editing' ? 'default' : 'pointer' }}>
                      <div className="yartu-row-left" style={{ flexWrap: 'wrap', gap: '8px 12px' }}>
                        <div className="sunsama-checkbox" onClick={e => { e.stopPropagation(); toggleComplete?.(task.id); }} />
                        <div className="yartu-row-title" style={{ color: 'var(--text-primary)' }}>{task.name}</div>
                        {tag && <span className="yartu-row-badge" style={{ color: tag.color, borderColor: 'transparent', background: 'transparent', fontWeight: 600 }}>{tag.text}</span>}
                        {task.timeEstimate > 0 && <span className="yartu-row-badge">{Math.round(task.timeEstimate / 25)} pomo</span>}
                        <span className="linear-cat-badge" style={{ background: meta.color + '16', color: meta.color, margin: 0 }}>
                          <span className="linear-cat-badge-dot" style={{ background: meta.color }} />
                          {meta.label}
                        </span>
                      </div>
                      <div className="yartu-row-right">
                        {mode === 'editing' ? (
                          <button onClick={e => { e.stopPropagation(); setEditingTask?.(task); }} style={{ background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', fontSize: '0.85rem', fontWeight: 600 }}>Edit</button>
                        ) : (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
              <button className="yartu-card-action" style={{ width: '100%', marginTop: 8, justifyContent: 'center' }} onClick={() => setActiveTab?.('tasks')}>
                {taskList.length > ROWS ? `View all tasks (${taskList.length - ROWS} more) →` : 'View All Tasks →'}
              </button>
              {mode === 'editing' && (
                <button className="yartu-card-action" style={{ width: '100%', marginTop: 8 }} onClick={() => setOpenModal?.('add')}>＋ Add New Task</button>
              )}
            </div>
          </div>

          {/* HABITS DUE */}
          <div className="yartu-card">
            <div className="yartu-card-hdr">
              <span className="yartu-card-title">Habits Due</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--text-secondary)' }}>Today</span>
            </div>
            <div className="yartu-list">
              <div className="yartu-card-summary" style={{ padding: '0 4px 12px', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', color: 'var(--text-secondary)', fontWeight: 600, marginBottom: 6 }}>
                  <span>{T.habits.done} / {T.habits.scheduled} habits completed</span>
                  <span>{habitPct}%</span>
                </div>
                <div className="yartu-mini-bar-track" style={{ height: 6 }}>
                  <div className="yartu-mini-bar-fill" style={{ width: `${habitPct}%` }} />
                </div>
              </div>
              {T.habits.rows.length === 0 ? (
                <div style={{ padding: '12px 16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.85rem' }}>No habits scheduled for today</div>
              ) : (
                T.habits.rows.slice(0, ROWS).map(({ habit: h, done }) => {
                  const streak = habitStreak(h);
                  return (
                    <div key={h.id} className={`yartu-compact-row${done ? ' item-completed' : ''}`}>
                      <div className="yartu-row-left">
                        <div className={`sunsama-checkbox${done ? ' checked' : ''}`} onClick={() => onMarkHabitDone?.(h.id)}>
                          {done ? '✓' : ''}
                        </div>
                        <div className="yartu-row-title" style={{ textDecoration: done ? 'line-through' : 'none', color: done ? 'var(--text-muted)' : 'var(--text-primary)' }}>
                          {h.name}
                        </div>
                        {streak > 0 && <span className="yartu-row-badge" style={{ background: '#f59e0b22', color: 'var(--color-amber)', borderColor: '#f59e0b44' }}>🔥 {streak}d streak</span>}
                      </div>
                    </div>
                  );
                })
              )}
              <button className="yartu-card-action" style={{ width: '100%', marginTop: 8, justifyContent: 'center' }} onClick={() => setActiveTab?.('habits')}>
                {T.habits.rows.length > ROWS ? `View all habits (${T.habits.rows.length - ROWS} more) →` : 'View All Habits →'}
              </button>
            </div>
          </div>

        </div>

        <div className="today-col">

          {/* POMODORO */}
          <div className="yartu-card">
            <div className="yartu-card-hdr">
              <span className="yartu-card-title">Pomodoro Timer</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--accent)', fontWeight: 600 }}>{timerState === 'running' ? 'Running' : 'Paused'}</span>
            </div>
            <div className="yartu-pomo-box">
              <div className="yartu-pomo-ring-wrap">
                <svg width="120" height="120" viewBox="0 0 120 120" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="60" cy="60" r="52" fill="none" stroke="var(--ring-track)" strokeWidth="5" />
                  <circle cx="60" cy="60" r="52" fill="none" stroke="var(--accent)" strokeWidth="5"
                    strokeDasharray={2 * Math.PI * 52}
                    strokeDashoffset={2 * Math.PI * 52 * (timerSeconds / totalSessionSeconds)}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dashoffset 0.3s linear' }}
                  />
                </svg>
                <div className="yartu-mini-timer">{formatTimerDisplay(timerSeconds)}</div>
              </div>
              <div className="yartu-timer-controls">
                <button className="yartu-timer-btn" onClick={startTimer} title="Start / Resume">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg>
                </button>
                <button className="yartu-timer-btn" onClick={pauseTimer} title="Pause">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                </button>
                <button className="yartu-timer-btn" onClick={resetTimer} title="Reset">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                </button>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginTop: 4, textAlign: 'center' }}>
                Focus today: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{fmtMinutes(focusToday)}</span>
                <span style={{ color: 'var(--text-muted)' }}> · {T.focus.sessionsToday} session{T.focus.sessionsToday === 1 ? '' : 's'}</span>
                <div style={{ fontSize: '0.74rem', color: 'var(--text-muted)', marginTop: 2 }}>Yesterday: {fmtMinutes(T.focus.minutesYesterday)}</div>
              </div>
            </div>
          </div>

          {/* JOURNAL */}
          <div className="yartu-card">
            <div className="yartu-card-hdr">
              <span className="yartu-card-title">Journal</span>
              <button className="yartu-card-action" onClick={() => setActiveTab?.('journal')}>＋ New Entry</button>
            </div>
            <div className="yartu-list">
              {journalEntries.length === 0 ? (
                <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.88rem' }}>No recent journal entries</div>
              ) : (
                journalEntries.slice(0, 1).map((e, idx) => (
                  <div key={idx} className="yartu-compact-row" onClick={() => setActiveTab?.('journal')} style={{ cursor: 'pointer' }}>
                    <div className="yartu-row-left" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                      <div className="yartu-row-title" style={{ fontSize: '0.8rem', color: 'var(--text-secondary)', fontWeight: 600 }}>{e.date === todayStr ? 'Today' : e.date}</div>
                      <div className="yartu-row-sub" style={{ color: 'var(--text-primary)', fontSize: '0.85rem', fontWeight: 500, lineHeight: 1.4 }}>{getJournalPreview(e.content)}</div>
                    </div>
                    <div className="yartu-row-right">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--text-secondary)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                    </div>
                  </div>
                ))
              )}
              <button className="yartu-card-action" style={{ width: '100%', marginTop: 8, justifyContent: 'center' }} onClick={() => setActiveTab?.('journal')}>
                Open Journal →
              </button>
            </div>
          </div>

          {/* STREAKS */}
          <div className="yartu-card">
            <div className="yartu-card-hdr stacked">
              <span className="yartu-card-title">Active Streaks</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--color-amber)', fontWeight: 600 }}>🔥 Keep going!</span>
            </div>
            <div className="yartu-streak-list">
              {streaks.length === 0 ? (
                <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem', textAlign: 'center', width: '100%', padding: '8px 0' }}>No active streaks yet. Complete a habit today!</div>
              ) : (
                streaks.map(({ h, n }) => (
                  <div key={h.id} className="yartu-streak-avatar">
                    <span className="yartu-flame-icon">🔥</span>
                    <div className="yartu-streak-text">
                      <span className="yartu-streak-name">{h.name}</span>
                      <span className="yartu-streak-num">{n} days</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
