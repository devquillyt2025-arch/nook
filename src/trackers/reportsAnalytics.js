// ─── Reports analytics (R2) ────────────────────────────────────────
// Read-only cross-tab synthesis for the Reports → Analytics view. Pulls from
// Habits (nook_habits), Tasks, Focus (pomodoro log) and Journal, all over a
// selectable time range with same-length previous-period comparison.
//
// Everything here is derived + read-only. Habit math uses the habitsStore
// (local-date based); tasks/focus ISO timestamps are compared by their date
// prefix, which is close enough for day-bucketed analytics.

import { localDateStr, isScheduledOn as habitScheduledOn, isCompletedOn as habitCompletedOn, HABIT_CATS } from '../habitsStore';

export const POMODORO_MIN = 25; // one logged focus session ≈ 25 min (timerUtils default)

// ─── Date helpers ──────────────────────────────────────────────────
export function shift(ds, deltaDays) {
  const d = new Date(ds + 'T12:00:00');
  d.setDate(d.getDate() + deltaDays);
  return localDateStr(d);
}
export function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
}
export function eachDay(start, end) {
  const out = [];
  let d = start;
  // guard against an inverted range
  if (daysBetween(start, end) < 0) return [start];
  while (d <= end) { out.push(d); d = shift(d, 1); }
  return out;
}

// mode: 'week' (last 7d) | 'month' (last 30d) | 'custom' (customStart..customEnd).
// Returns current window + an equal-length window immediately before it.
export function rangeBounds(mode, customStart, customEnd) {
  const today = localDateStr();
  let start, end;
  if (mode === 'custom' && customStart && customEnd) {
    start = customStart <= customEnd ? customStart : customEnd;
    end   = customStart <= customEnd ? customEnd : customStart;
  } else {
    const len = mode === 'month' ? 30 : 7;
    end   = today;
    start = shift(today, -(len - 1));
  }
  const len = daysBetween(start, end) + 1;
  const prevEnd   = shift(start, -1);
  const prevStart = shift(prevEnd, -(len - 1));
  const label = mode === 'month' ? 'month' : mode === 'custom' ? 'period' : 'week';
  return { start, end, prevStart, prevEnd, len, label };
}

// ─── Habits ────────────────────────────────────────────────────────
// Completion rate = completed scheduled days / scheduled days in the window.
export function habitRangeStats(habits, start, end) {
  let due = 0, done = 0;
  const days = eachDay(start, end);
  const today = localDateStr();
  for (const h of habits) {
    for (const ds of days) {
      if (ds > today) continue;
      if (!habitScheduledOn(h, ds)) continue;
      due++;
      if (habitCompletedOn(h, ds)) done++;
    }
  }
  return { due, done, rate: due > 0 ? Math.round((done / due) * 100) : 0 };
}

// Per-habit consistency over the window, sorted best-first.
export function perHabitConsistency(habits, start, end) {
  const days = eachDay(start, end);
  const today = localDateStr();
  return habits.map(h => {
    let due = 0, done = 0;
    for (const ds of days) {
      if (ds > today) continue;
      if (!habitScheduledOn(h, ds)) continue;
      due++;
      if (habitCompletedOn(h, ds)) done++;
    }
    return {
      id: h.id, name: h.name,
      color: h.color || HABIT_CATS[h.category]?.color || '#818cf8',
      rate: due > 0 ? Math.round((done / due) * 100) : 0,
      done, due,
    };
  }).sort((a, b) => b.rate - a.rate);
}

// Trend = current-window rate minus previous-window rate, per habit.
export function habitTrends(habits, start, end, prevStart, prevEnd) {
  const cur  = perHabitConsistency(habits, start, end);
  const prev = perHabitConsistency(habits, prevStart, prevEnd);
  const prevMap = Object.fromEntries(prev.map(h => [h.id, h.rate]));
  return cur
    .map(h => ({ ...h, delta: h.rate - (prevMap[h.id] ?? 0) }))
    .sort((a, b) => b.delta - a.delta);
}

// Streak length as of each day in the window, for one habit. Walks forward from
// creation so the streak value at `start` is already correct.
export function streakSeries(habit, start, end) {
  if (!habit) return [];
  const done = new Set(habit.completions || []);
  const created = habit.createdAt ? localDateStr(new Date(habit.createdAt)) : start;
  const from = created < start ? created : start;
  const today = localDateStr();
  let run = 0;
  const out = [];
  for (const ds of eachDay(from, end)) {
    if (ds > today) break;
    if (habitScheduledOn(habit, ds)) {
      if (done.has(ds)) run++;
      else run = 0;
    }
    if (ds >= start) out.push({ date: ds, streak: run });
  }
  return out;
}

// ─── Tasks ─────────────────────────────────────────────────────────
export function tasksDoneInRange(tasks, start, end) {
  return (tasks || []).filter(t =>
    t.completed && typeof t.completedAt === 'string' &&
    t.completedAt.slice(0, 10) >= start && t.completedAt.slice(0, 10) <= end
  ).length;
}

// ─── Focus (pomodoro log) ──────────────────────────────────────────
export function focusInRange(pomodoroLog, start, end) {
  const perDayMap = {};
  let sessions = 0;
  for (const ts of pomodoroLog || []) {
    const ds = typeof ts === 'string' ? ts.slice(0, 10) : '';
    if (ds >= start && ds <= end) { sessions++; perDayMap[ds] = (perDayMap[ds] || 0) + 1; }
  }
  const perDay = eachDay(start, end).map(ds => ({ date: ds, count: perDayMap[ds] || 0 }));
  return { sessions, minutes: sessions * POMODORO_MIN, perDay };
}

// ─── Journal ───────────────────────────────────────────────────────
export function journalCountInRange(start, end) {
  let count = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^nook_journal_\d{4}-\d{2}-\d{2}$/.test(key)) continue;
      const ds = key.slice('nook_journal_'.length);
      if (ds < start || ds > end) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      let e; try { e = JSON.parse(raw); } catch { continue; }
      const content = (e?.content ?? '').toString().replace(/<[^>]*>/g, '').trim();
      if (content.length > 0) count++;
    }
  } catch {}
  return count;
}

// ─── Comparison helper ─────────────────────────────────────────────
// pct-style delta descriptor for a KPI vs its previous-period value.
export function delta(cur, prev) {
  const diff = cur - prev;
  return { diff, dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat', prev };
}

// ─── Cross-tab daily score (habits + tasks + focus) ────────────────
// Replaces the old tracker-based productivity score. 50 habits / 30 tasks /
// 20 focus, so a day with no habits scheduled still isn't unfairly penalised.
export function dailyScoreH(habits, tasks, pomodoroLog, ds) {
  let habitPts = 50;
  const sched = (habits || []).filter(h => habitScheduledOn(h, ds));
  if (sched.length) {
    const done = sched.filter(h => habitCompletedOn(h, ds)).length;
    habitPts = (done / sched.length) * 50;
  }
  const tasksDone = (tasks || []).filter(t =>
    t.completed && typeof t.completedAt === 'string' && t.completedAt.slice(0, 10) === ds).length;
  const taskPts = Math.min(30, tasksDone * 5);
  const focusCount = (pomodoroLog || []).filter(ts => typeof ts === 'string' && ts.slice(0, 10) === ds).length;
  const focusPts = Math.min(20, focusCount * 5);
  return Math.round(habitPts + taskPts + focusPts);
}

export function scoreHistoryH(habits, tasks, pomodoroLog, numDays = 30) {
  const out = [];
  const base = new Date();
  for (let i = numDays - 1; i >= 0; i--) {
    const d = new Date(base);
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    out.push({ date: ds, score: dailyScoreH(habits, tasks, pomodoroLog, ds) });
  }
  return out;
}

// Habit completions per category over the window (for the doughnut).
export function categoryCompletions(habits, start, end) {
  const out = {};
  Object.keys(HABIT_CATS).forEach(c => { out[c] = 0; });
  const days = eachDay(start, end);
  const today = localDateStr();
  for (const h of habits) {
    const cat = HABIT_CATS[h.category] ? h.category : 'health';
    for (const ds of days) {
      if (ds > today) continue;
      if (habitCompletedOn(h, ds)) out[cat] += 1;
    }
  }
  return out;
}

// Aggregate completion-rate heatmap across all habits, last `weeks` weeks,
// Sunday-aligned. Returns a flat array of weeks*7 cells.
export function globalHabitHeatmap(habits, weeks = 12) {
  const today = new Date();
  const todayS = localDateStr(today);
  const start = new Date(today);
  start.setDate(start.getDate() - (weeks * 7 - 1));
  start.setDate(start.getDate() - start.getDay());
  const cells = [];
  let d = new Date(start);
  for (let i = 0; i < weeks * 7; i++) {
    const ds = localDateStr(d);
    const isFuture = ds > todayS;
    let sched = 0, done = 0;
    if (!isFuture) {
      for (const h of habits) {
        if (habitScheduledOn(h, ds)) { sched++; if (habitCompletedOn(h, ds)) done++; }
      }
    }
    cells.push({ date: ds, isFuture, scheduled: sched, rate: sched > 0 ? done / sched : null });
    d.setDate(d.getDate() + 1);
  }
  return cells;
}
