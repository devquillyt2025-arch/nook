// ─── Habits data layer ────────────────────────────────────────────
// Separate from the trackers system; stores per-habit completion dates.

const HABITS_KEY    = 'nook_habits';
const MIGRATED_FLAG = 'nook_habits_migrated';

// ─── Category / color meta ─────────────────────────────────────────
export const HABIT_CATS = {
  health:   { label: 'Health',   color: '#10b981' },
  work:     { label: 'Work',     color: '#3b82f6' },
  finance:  { label: 'Finance',  color: '#f59e0b' },
  personal: { label: 'Personal', color: '#ec4899' },
  learning: { label: 'Learning', color: '#6366f1' },
  fitness:  { label: 'Fitness',  color: '#f97316' },
};

export const ACCENT_COLORS = ['#818cf8','#22c55e','#f59e0b','#ef4444','#06b6d4','#ec4899'];

// ─── Local-date helpers (NOT UTC) ──────────────────────────────────
export function localDateStr(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── Storage ───────────────────────────────────────────────────────
export function loadHabits() {
  try {
    const raw = localStorage.getItem(HABITS_KEY);
    return raw ? JSON.parse(raw) : null;          // null = not yet initialised
  } catch { return []; }
}

export function saveHabits(list) {
  try { localStorage.setItem(HABITS_KEY, JSON.stringify(list)); } catch {}
}

// ─── One-time migration from trackers store ────────────────────────
// Returns the new habits array, or null if migration already ran.
export function migrateFromTrackers(trackers) {
  if (localStorage.getItem(MIGRATED_FLAG)) return null;
  localStorage.setItem(MIGRATED_FLAG, '1');

  const habitTrackers = trackers.filter(t => t.type === 'habit');
  return habitTrackers.map(t => ({
    id:              t.id,
    name:            t.name,
    category:        t.category ?? 'health',
    frequency:       t.config?.schedule ?? 'daily',
    timeTag:         t.config?.timeTag ?? null,
    color:           HABIT_CATS[t.category]?.color ?? '#818cf8',
    reminderEnabled: !!t.config?.reminderTime,
    reminderTime:    t.config?.reminderTime ?? null,
    // Convert value=true log entries into plain date strings
    completions: (t.logs || [])
      .filter(l => l.value === true)
      .map(l => l.date),
    createdAt: t.createdAt ?? new Date().toISOString(),
  }));
}

// ─── Schedule helpers ──────────────────────────────────────────────
export function isScheduledOn(habit, date = new Date()) {
  const d   = typeof date === 'string' ? new Date(date + 'T12:00:00') : date;
  const dow = d.getDay(); // 0 = Sun
  const f   = habit.frequency;
  if (f === 'daily')    return true;
  if (f === 'weekdays') return dow >= 1 && dow <= 5;
  if (f === 'weekends') return dow === 0 || dow === 6;
  if (Array.isArray(f)) return f.includes(dow);
  return true;
}

export function isScheduledToday(habit) {
  return isScheduledOn(habit, new Date());
}

// ─── Completion helpers ────────────────────────────────────────────
export function isCompletedOn(habit, ds) {
  return (habit.completions || []).includes(ds);
}

export function isCompletedToday(habit) {
  return isCompletedOn(habit, localDateStr());
}

export function toggleCompletion(habit, ds = localDateStr()) {
  const c = habit.completions || [];
  return {
    ...habit,
    completions: c.includes(ds) ? c.filter(d => d !== ds) : [...c, ds],
  };
}

// ─── Streak calculation ────────────────────────────────────────────
// Skips non-scheduled days; breaks at first scheduled day with no completion.
// Today is not a break if not yet done.
export function calcStreak(habit) {
  const done  = new Set(habit.completions || []);
  const today = localDateStr();
  let streak  = 0;
  const base  = new Date();

  for (let i = 0; i < 365; i++) {
    const d  = new Date(base);
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    if (ds > today) continue;
    if (!isScheduledOn(habit, d)) continue;        // skip non-scheduled days
    if (done.has(ds))        { streak++; }
    else if (i === 0)        { /* today not done yet – don't break */ }
    else                     { break; }
  }
  return streak;
}

export function calcBestStreak(habit) {
  if (!habit.completions?.length) return 0;
  const sorted = [...habit.completions].sort();
  let best = 1, run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i-1] + 'T12:00:00');
    const curr = new Date(sorted[i]   + 'T12:00:00');
    // Check every day between prev+1 and curr – if any scheduled day is missing, reset
    let gap = Math.round((curr - prev) / 86400000);
    if (gap === 1) { run++; if (run > best) best = run; }
    else           { run = 1; }
  }
  return best;
}

export function successRate(habit) {
  const today    = localDateStr();
  const created  = habit.createdAt
    ? localDateStr(new Date(habit.createdAt))
    : today;
  const done     = new Set(habit.completions || []);
  let sched = 0, comp = 0;
  const base = new Date(today + 'T12:00:00');
  for (let i = 0; i < 365; i++) {
    const d  = new Date(base);
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    if (ds < created) break;
    if (isScheduledOn(habit, d)) {
      sched++;
      if (done.has(ds)) comp++;
    }
  }
  return sched > 0 ? Math.round((comp / sched) * 100) : 0;
}

// ─── 7-day strip ───────────────────────────────────────────────────
const DOW_LABELS = ['S','M','T','W','T','F','S'];

export function get7DayStrip(habit) {
  const base  = new Date();
  const today = localDateStr();
  const done  = new Set(habit.completions || []);
  const strip = [];
  for (let i = 6; i >= 0; i--) {
    const d  = new Date(base);
    d.setDate(d.getDate() - i);
    const ds = localDateStr(d);
    strip.push({
      date:      ds,
      label:     DOW_LABELS[d.getDay()],
      scheduled: isScheduledOn(habit, d),
      done:      done.has(ds),
      isToday:   ds === today,
    });
  }
  return strip;
}

// ─── 12-week heatmap (84 cells) ───────────────────────────────────
export function get12WeekGrid(habit) {
  const base  = new Date();
  const today = localDateStr();
  const done  = new Set(habit.completions || []);
  // Align so the 12th week is the current week (ending this Saturday)
  const start = new Date(base);
  start.setDate(start.getDate() - start.getDay() - 77);

  const weeks = [];
  let d = new Date(start);
  for (let w = 0; w < 12; w++) {
    const week = [];
    for (let dow = 0; dow < 7; dow++) {
      const ds = localDateStr(d);
      week.push({
        date:      ds,
        scheduled: isScheduledOn(habit, d),
        done:      done.has(ds),
        isFuture:  ds > today,
      });
      d.setDate(d.getDate() + 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// ─── Frequency display label ───────────────────────────────────────
export function fmtFrequency(freq) {
  if (freq === 'daily')    return 'Daily';
  if (freq === 'weekdays') return 'Weekdays';
  if (freq === 'weekends') return 'Weekends';
  if (Array.isArray(freq)) {
    if (freq.length === 7) return 'Daily';
    if (freq.length === 5 && !freq.includes(0) && !freq.includes(6)) return 'Weekdays';
    return `${freq.length}x/week`;
  }
  return 'Daily';
}

// ─── New-habit scaffold ────────────────────────────────────────────
export function makeHabit({ name, category, frequency, timeTag, color, reminderEnabled, reminderTime }) {
  return {
    id:              Date.now().toString(36) + Math.random().toString(36).slice(2),
    name:            name.trim(),
    category:        category ?? 'health',
    frequency:       frequency ?? 'daily',
    timeTag:         timeTag ?? null,
    color:           color ?? '#818cf8',
    reminderEnabled: !!reminderEnabled,
    reminderTime:    reminderTime ?? null,
    completions:     [],
    createdAt:       new Date().toISOString(),
  };
}
