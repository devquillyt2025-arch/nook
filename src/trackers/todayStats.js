// ─── Today tab maths ───────────────────────────────────────────────
// Everything the Today dashboard shows, as one pure function so it can be tested.
//
// "Today" here is the viewer's LOCAL calendar day: timestamps (completedAt, focus
// sessions) are bucketed with localDayOf, and due dates / habit completions are already
// local YYYY-MM-DD strings. (Reports buckets timestamps by their UTC date prefix; for
// today's numbers near local midnight the local day is the right one.)
//
// The previous Today view got three things wrong that live here now:
//   · focus sessions are stored as plain ISO strings, but it read `.timestamp` off
//     them — always undefined — so "focus today" was always 0 and fell back to the sum
//     of every task's estimate;
//   · its "This Week" ring was all-time done / all tasks;
//   · its task list and recent-activity feed ignored dates altogether.

import { localDateStr } from '../utils/date';
import { isScheduledOn, isCompletedOn } from '../habitsStore';
import { CAT_META } from '../utils/categoryMeta';
import { POMODORO_MIN } from './reportsAnalytics';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd  = v => (typeof v === 'string' && DATE_RE.test(v) ? v : '');   // a malformed date is "no date", never NaN
const objs = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);
const cap  = s => String(s ?? '').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());
const RANK = { high: 0, medium: 1, low: 2 };

// A stored instant → the viewer's local calendar day ('' if unreadable). Focus sessions
// are ISO strings; a legacy { timestamp } object is tolerated.
export function localDayOf(stamp) {
  const s = typeof stamp === 'string' ? stamp : stamp?.timestamp;
  if (!s) return '';
  const d = new Date(s);
  return isNaN(d) ? '' : localDateStr(d);
}

export function addDays(ds, n) {
  const d = new Date(ds + 'T12:00:00');   // local noon: a DST shift can't change the day
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

// The last n local days, oldest first, ending on `today`.
export function lastDays(n, today = localDateStr()) {
  return Array.from({ length: n }, (_, i) => addDays(today, i - (n - 1)));
}

export function buildToday({ tasks, habits, pomodoroLog, customCategories } = {}, today = localDateStr()) {
  const T = objs(tasks), H = objs(habits);
  const log = Array.isArray(pomodoroLog) ? pomodoroLog : [];
  const days = lastDays(7, today);

  // ── Tasks ──
  const doneOn = ds => T.filter(t => t.completed && localDayOf(t.completedAt) === ds);
  const dueBy  = last => T.filter(t => !t.completed && ymd(t.dueDate) && t.dueDate <= last)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || (RANK[a.priority] ?? 3) - (RANK[b.priority] ?? 3) || String(a.name).localeCompare(String(b.name)));
  const due     = dueBy(today);               // overdue + due today, oldest first
  const dueWeek = dueBy(addDays(today, 6));   // …plus the next six days
  const doneToday = doneOn(today).length;

  // ── Habits ── (not-yet-done first)
  const rows = H.filter(h => isScheduledOn(h, today)).map(h => ({ habit: h, done: isCompletedOn(h, today) })).sort((a, b) => a.done - b.done);
  const habitsDone = rows.filter(r => r.done).length;

  // ── "Today" donut: what was planned today and how much of it is done ──
  const tasksPlanned = doneToday + due.length;     // finished today + still due/overdue
  const planned = tasksPlanned + rows.length;
  const done    = doneToday + habitsDone;

  // ── Last 7 days: tasks and habits completed per day ──
  const week = days.map(ds => ({ date: ds, isToday: ds === today, tasks: doneOn(ds).length, habits: H.filter(h => isCompletedOn(h, ds)).length }));

  // ── Tasks completed in those 7 days, by category ──
  const meta = { ...CAT_META, ...(customCategories && typeof customCategories === 'object' ? customCategories : {}) };
  const inWeek = new Set(days), counts = new Map();
  for (const t of T) {
    if (!t.completed || !inWeek.has(localDayOf(t.completedAt))) continue;
    const k = t.category || 'other';
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  const byCategory = [...counts].map(([key, count]) => ({ key, count, label: meta[key]?.label || cap(key), color: meta[key]?.color || '#8b5cf6' }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));

  // ── Focus ──
  const sessionsOn = ds => log.filter(s => localDayOf(s) === ds).length;
  const sToday = sessionsOn(today), sYesterday = sessionsOn(addDays(today, -1));

  return {
    today,
    tasks: { due, dueWeek, overdue: due.filter(t => t.dueDate < today).length, doneToday, undated: T.filter(t => !t.completed && !ymd(t.dueDate)).length, pending: T.filter(t => !t.completed).length },
    habits: { scheduled: rows.length, done: habitsDone, rows },
    donut: { planned, done, tasksDone: doneToday, tasksPlanned, habitsDone, habitsPlanned: rows.length, pct: planned ? Math.round((done / planned) * 100) : 0 },
    week, byCategory,
    focus: { sessionsToday: sToday, minutesToday: sToday * POMODORO_MIN, sessionsYesterday: sYesterday, minutesYesterday: sYesterday * POMODORO_MIN },
  };
}

// Custom calendar events on a given day (the Calendar tab's own events, not Google's).
export const countEventsOn = (events, ds) => objs(events).filter(e => e.date === ds).length;
