// ─── Storage ──────────────────────────────────────────────────────
const SK = 'nook-trackers';

export function loadTrackers() {
  try {
    const list = JSON.parse(localStorage.getItem(SK) || '[]');
    const seenId = new Set();
    const seenName = new Set();
    return list.filter(t => {
      if (seenId.has(t.id)) return false;
      seenId.add(t.id);
      const nameKey = (t.name || '').trim().toLowerCase();
      if (seenName.has(nameKey)) return false;
      seenName.add(nameKey);
      return true;
    });
  } catch { return []; }
}
// Same retention pattern as utils/activityLog.js's MAX_ENTRIES: a tracker
// logged daily for MAX_LOGS_PER_TRACKER days (~5.5 years) is a real amount of
// history, but `logs` otherwise grows forever with no cap, and it's the
// largest unbounded store in the app across long-term daily use. Capped per
// tracker (not globally) since each tracker's logs are independent history.
const MAX_LOGS_PER_TRACKER = 2000;

export function saveTrackers(list) {
  try {
    const capped = list.map(t => {
      if (!Array.isArray(t.logs) || t.logs.length <= MAX_LOGS_PER_TRACKER) return t;
      // logs are date-sorted ascending (see upsertLog) — drop the oldest, keep the newest.
      return { ...t, logs: t.logs.slice(-MAX_LOGS_PER_TRACKER) };
    });
    localStorage.setItem(SK, JSON.stringify(capped));
  } catch {}
}

// ─── Meta ──────────────────────────────────────────────────────────
export const TRACKER_CATS = {
  health:   { label: 'Health',   color: '#10b981' },
  work:     { label: 'Work',     color: '#3b82f6' },
  finance:  { label: 'Finance',  color: '#f59e0b' },
  personal: { label: 'Personal', color: '#ec4899' },
};

export const TRACKER_TYPES = {
  habit:   { label: 'Habit',   icon: '🔄', desc: 'Track yes/no on a schedule' },
  target:  { label: 'Target',  icon: '🎯', desc: 'Hit a numeric goal by a date' },
  average: { label: 'Average', icon: '📊', desc: 'Maintain a rolling average' },
  project: { label: 'Project', icon: '📋', desc: 'Complete milestone-based goal' },
};

// ─── Helpers ──────────────────────────────────────────────────────
// genId is single-sourced in utils/id.js; re-exported here so existing
// importers (CountdownsView) keep working unchanged.
export { genId } from '../utils/id';

// NOTE: this todayStr is UTC-based (toISOString) and intentionally distinct
// from the local-date todayStr in utils/date.js — do not merge them.
export function todayStr() {
  return new Date().toISOString().split('T')[0];
}

export function dateStrOf(d) {
  const dt = d instanceof Date ? d : new Date(d);
  return dt.toISOString().split('T')[0];
}

export function defaultConfig(type) {
  switch (type) {
    case 'habit':   return { schedule: 'daily', timeTag: null };
    case 'target':  return { targetValue: 100, unit: '', startValue: 0, targetDate: '' };
    case 'average': return { unit: '', targetAverage: 0, schedule: 'daily', timeTag: null };
    case 'project': return { milestones: [], targetDate: '' };
    default: return {};
  }
}

// Config-less trackers can reach here from corrupted/legacy/imported data.
// Falling back to the same defaultConfig() used for brand-new trackers means
// every reader sees one consistent, already-trusted shape instead of each
// call site inventing its own fallback.
export function getConfig(tracker) {
  return tracker.config || defaultConfig(tracker.type);
}

// ─── Schedule ─────────────────────────────────────────────────────
export function isScheduledOn(tracker, date = new Date()) {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date;
  const dow = d.getDay(); // 0 = Sun

  if (tracker.type === 'target' || tracker.type === 'project') return true;

  const { schedule = 'daily' } = tracker.config || {};
  if (schedule === 'daily') return true;
  if (schedule === 'weekdays') return dow >= 1 && dow <= 5;
  if (schedule === 'weekends') return dow === 0 || dow === 6;
  if (Array.isArray(schedule)) return schedule.includes(dow);
  return true;
}

export function isScheduledToday(tracker) {
  return isScheduledOn(tracker, new Date());
}

// ─── Logs ─────────────────────────────────────────────────────────
export function getLogForDate(tracker, date = todayStr()) {
  return (tracker.logs || []).find(l => l.date === date) ?? null;
}

export function upsertLog(tracker, value, date = todayStr()) {
  const logs = (tracker.logs || []).filter(l => l.date !== date);
  return {
    ...tracker,
    logs: [...logs, { date, value }].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function toggleMilestone(tracker, milestoneId) {
  const config = getConfig(tracker);
  const milestones = (config.milestones || []).map(m =>
    m.id === milestoneId
      ? { ...m, done: !m.done, doneAt: !m.done ? new Date().toISOString() : null }
      : m
  );
  // Writing back through getConfig() heals a config-less tracker to a full
  // default shape (e.g. adds targetDate: '') the moment it's touched — a
  // strict superset of whatever was there before, never a data loss.
  return { ...tracker, config: { ...config, milestones } };
}

export function isLoggedToday(tracker) {
  const today = todayStr();
  if (tracker.type === 'project') {
    const { milestones = [] } = getConfig(tracker);
    return milestones.length > 0 && milestones.every(m => m.done);
  }
  if (tracker.type === 'habit') {
    // Only Done (true) counts for progress pill and perfect-day; Skip (false) is excluded
    return (tracker.logs || []).some(l => l.date === today && l.value === true);
  }
  return (tracker.logs || []).some(l => l.date === today);
}

// ─── Habit streaks ────────────────────────────────────────────────
export function computeHabitStreaks(tracker) {
  const logs = tracker.logs || [];
  const logMap = {};
  for (const l of logs) logMap[l.date] = l.value;

  const today = todayStr();
  const todayVal = logMap[today];

  // Current streak: walk backwards; skips are neutral, missed scheduled day = break
  let current = 0;
  const now = new Date();
  for (let i = 0; i < 365; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = dateStrOf(d);
    if (ds > today) continue;
    if (!isScheduledOn(tracker, d)) continue;

    const val = logMap[ds];
    if (val === true) {
      current++;
    } else if (val === false) {
      // skip: neutral
    } else {
      if (i === 0) { /* today not logged yet: don't break */ } else break;
    }
  }

  // Longest streak: scan all dates from creation
  let longest = 0;
  let run = 0;
  const createdDate = new Date(tracker.createdAt);
  if (isNaN(createdDate)) {
    console.warn(`[Trackers] "${tracker.name}" has an unparseable createdAt — longest streak may be understated.`);
  }
  for (let d = new Date(createdDate); d <= now; d.setDate(d.getDate() + 1)) {
    const ds = dateStrOf(d);
    if (!isScheduledOn(tracker, d)) continue;
    const val = logMap[ds];
    if (val === true) { run++; if (run > longest) longest = run; }
    else if (val !== false && ds < today) run = 0; // missed past day
  }
  longest = Math.max(longest, current);

  const doneCount = logs.filter(l => l.value === true).length;
  const logged = logs.filter(l => l.value === true || l.value === false).length;
  const successRate = logged > 0 ? Math.round((doneCount / logged) * 100) : 0;

  return { current, longest, successRate, doneCount, logged };
}

// ─── Target stats ─────────────────────────────────────────────────
export function computeTargetStats(tracker) {
  const { targetValue = 100, startValue = 0, unit = '', targetDate = '' } = getConfig(tracker);
  const logs = [...(tracker.logs || [])].sort((a, b) => a.date.localeCompare(b.date));
  const currentValue = logs.length > 0 ? logs[logs.length - 1].value : startValue;
  const range = targetValue - startValue;
  const progress = range > 0
    ? Math.min(100, Math.max(0, ((currentValue - startValue) / range) * 100))
    : currentValue >= targetValue ? 100 : 0;

  let pace = 'on-track';
  if (targetDate && range > 0) {
    const now = Date.now();
    const s = new Date(tracker.createdAt).getTime();
    const e = new Date(targetDate).getTime();
    const expectedPct = (e - s) > 0 ? Math.min(100, ((now - s) / (e - s)) * 100) : 0;
    if (progress < expectedPct - 10) pace = 'behind';
    else if (progress > expectedPct + 10) pace = 'ahead';
  }

  return { currentValue, targetValue, startValue, unit, progress: Math.round(progress), pace };
}

// ─── Average stats ────────────────────────────────────────────────
export function computeAverageStats(tracker) {
  const { targetAverage = 0, unit = '' } = getConfig(tracker);
  const today = todayStr();
  const logs = [...(tracker.logs || [])].sort((a, b) => a.date.localeCompare(b.date));
  const avg = list => list.length
    ? Math.round((list.reduce((s, l) => s + (l.value || 0), 0) / list.length) * 10) / 10
    : null;

  const cutoff = (days) => { const d = new Date(); d.setDate(d.getDate() - (days - 1)); return dateStrOf(d); };
  const last7  = logs.filter(l => l.date >= cutoff(7));
  const last30 = logs.filter(l => l.date >= cutoff(30));

  return {
    todayValue: logs.find(l => l.date === today)?.value ?? null,
    avg7:  avg(last7),
    avg30: avg(last30),
    targetAverage,
    unit,
  };
}

// ─── Project stats ────────────────────────────────────────────────
export function computeProjectStats(tracker) {
  const { milestones = [], targetDate = '' } = getConfig(tracker);
  const done = milestones.filter(m => m.done).length;
  const total = milestones.length;
  const progress = total > 0 ? Math.round((done / total) * 100) : 0;

  let pace = 'on-track';
  if (targetDate && total > 0) {
    const now = Date.now();
    const s = new Date(tracker.createdAt).getTime();
    const e = new Date(targetDate).getTime();
    const expectedPct = (e - s) > 0 ? Math.min(100, ((now - s) / (e - s)) * 100) : 0;
    if (progress >= 100) pace = 'complete';
    else if (progress < expectedPct - 10) pace = 'behind';
  }
  return { done, total, progress, pace };
}

// ─── Global stats ─────────────────────────────────────────────────
export function computeGlobalStats(trackers) {
  const today = todayStr();
  const now = new Date();

  // Projects can't be "logged" daily (they use milestones), so exclude them from
  // the daily progress pill and perfect-day calculation to avoid permanent inflation.
  const scheduled = trackers.filter(t => isScheduledToday(t) && t.type !== 'project');
  const logged    = scheduled.filter(t => isLoggedToday(t));
  const isPerfect = scheduled.length > 0 && logged.length === scheduled.length;

  // Perfect days this month
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  let perfectDaysMonth = 0;
  for (let d = new Date(monthStart); d <= now; d.setDate(d.getDate() + 1)) {
    const ds = dateStrOf(d);
    if (ds > today) break;
    const sched = trackers.filter(t => isScheduledOn(t, d) && t.type !== 'project');
    if (!sched.length) continue;
    if (sched.every(t => (t.logs || []).some(l => l.date === ds))) perfectDaysMonth++;
  }

  // Best habit streak (current) and longest historical streak
  let bestStreak = 0, longestStreak = 0;
  for (const t of trackers) {
    if (t.type === 'habit') {
      const { current, longest } = computeHabitStreaks(t);
      if (current > bestStreak) bestStreak = current;
      if (longest > longestStreak) longestStreak = longest;
    }
  }

  return {
    activeTrackers: trackers.length,
    scheduledCount: scheduled.length,
    loggedCount:    logged.length,
    isPerfect,
    perfectDaysMonth,
    bestStreak,
    longestStreak,
  };
}

// ─── Sparkline data ────────────────────────────────────────────────
export function getSparklineData(tracker) {
  const logs = [...(tracker.logs || [])].sort((a, b) => a.date.localeCompare(b.date)).slice(-14);
  if (tracker.type === 'habit') return logs.map(l => l.value === true ? 1 : 0);
  return logs.map(l => typeof l.value === 'number' ? l.value : 0);
}

// ─── Data export ──────────────────────────────────────────────────
export function exportTrackerData() {
  const trackers = loadTrackers();
  const json = JSON.stringify({ trackers, exportedAt: new Date().toISOString() }, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nook-trackers-${todayStr()}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
