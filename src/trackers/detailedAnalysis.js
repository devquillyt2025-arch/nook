// ─── Detailed analysis ─────────────────────────────────────────────
// Read-only maths behind Reports → Detailed Analysis. Pulls from every tab —
// Tasks, Habits, Focus, Journal, Notes, Links, Countdowns, Calendar, Activity and
// Weekly Reviews — over the selected range, with the same-length previous period
// for comparison, plus a handful of all-time totals.
//
// Pure: `buildAnalysis` takes everything through `src`, so it runs under test.
// `loadAnalysisSources` is the only function here that touches localStorage.
//
// It reuses reportsAnalytics.js for every number the Overview also shows (habit
// rate, daily score, …) so the two views can never disagree. Task / focus ISO
// timestamps are bucketed by their date prefix, exactly as the Overview does.

import { localDateStr, isScheduledOn, isCompletedOn, calcStreak, calcBestStreak, fmtFrequency, HABIT_CATS } from '../habitsStore';
import { CAT_META } from '../utils/categoryMeta';
import { loadActivityLog } from '../utils/activityLog';
import { shift, daysBetween, eachDay, habitRangeStats, habitTrends, dailyScoreH, POMODORO_MIN } from './reportsAnalytics';

export const MAX_DAYS = 731;   // the analysis never looks at more than two years at once
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── Small helpers ─────────────────────────────────────────────────
// A strict YYYY-MM-DD, or ''. Anything else (a hand-edited or imported value like
// '2026-1-5' or 'soon') would compare as text and then turn into NaN the moment it
// reaches date maths, so it is treated as "no date" instead. For every valid value this
// agrees with the Overview, which slices the same ISO prefix.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ymd    = v => (typeof v === 'string' && DATE_RE.test(v) ? v : '');
const isoDay = ts => ymd(typeof ts === 'string' ? ts.slice(0, 10) : '');
const inR    = (ds, s, e) => typeof ds === 'string' && ds !== '' && ds >= s && ds <= e;
const dowOf  = ds => new Date(ds + 'T12:00:00').getDay();
const sum    = xs => xs.reduce((a, b) => a + b, 0);
const pct    = (a, b) => (b > 0 ? Math.round((a / b) * 100) : null);
const round1 = n => Math.round(n * 10) / 10;
const arr    = v => (Array.isArray(v) ? v : []);
const objs   = v => arr(v).filter(x => x && typeof x === 'object');
const cap    = s => String(s ?? '').replace(/[_-]+/g, ' ').replace(/^./, c => c.toUpperCase());

export const fmtHour = h => `${h % 12 === 0 ? 12 : h % 12} ${h < 12 ? 'AM' : 'PM'}`;
export const fmtMinutes = m => {
  const n = Math.max(0, Math.round(m || 0));
  return n < 60 ? `${n}m` : `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}`;
};

// [{ key, count }] sorted most-common first.
function tally(items, keyFn) {
  const m = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (k == null || k === '') continue;
    m.set(k, (m.get(k) || 0) + 1);
  }
  return [...m].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || String(a.key).localeCompare(String(b.key)));
}
// Busiest key of a { key: count } map. Ties go to the latest date so the answer
// never depends on storage / enumeration order (which differs between devices).
const busiest = map => Object.keys(map).sort((a, b) => map[b] - map[a] || b.localeCompare(a))[0];
// Counts per weekday (Sun..Sat) for a list of YYYY-MM-DD strings.
function byWeekday(dates) {
  const out = Array(7).fill(0);
  for (const ds of dates) if (ds) out[dowOf(ds)]++;
  return out;
}
const countBy = (items, keyFn) => {
  const o = {};
  for (const it of items) { const k = keyFn(it); if (k) o[k] = (o[k] || 0) + 1; }
  return o;
};

// Daily points for ranges up to 45 days, 7-day blocks beyond, so a long custom
// range stays readable instead of drawing hundreds of bars.
function makeBuckets(days) {
  if (days.length <= 45) return days.map(d => ({ date: d, days: [d] }));
  const out = [];
  for (let i = 0; i < days.length; i += 7) out.push({ date: days[i], days: days.slice(i, i + 7) });
  return out;
}
const bucketSum = (buckets, perDay) => buckets.map(b => ({ date: b.date, value: sum(b.days.map(d => perDay[d] || 0)) }));

// Current run (counting back from today — today may still be pending) and best
// run ever, for a Set of YYYY-MM-DD strings.
function runs(set, today) {
  const sorted = [...set].sort();
  let best = 0, run = 0, prev = null;
  for (const ds of sorted) {
    run = prev && daysBetween(prev, ds) === 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = ds;
  }
  let current = 0, d = set.has(today) ? today : shift(today, -1);
  while (set.has(d)) { current++; d = shift(d, -1); }
  return { current, best };
}

// Rich-text HTML → plain words. "Has text" deliberately matches the Overview's
// journal-entry rule so the two views count the same entries.
const hasText   = html => String(html ?? '').replace(/<[^>]*>/g, '').trim().length > 0;
const wordCount = html => {
  const text = String(html ?? '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&');
  return (text.match(/\S+/g) || []).length;
};

// ─── Sources (the only localStorage access) ────────────────────────
const readJSON = (key, fallback) => { try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

export function loadAnalysisSources() {
  const journal = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^nook_journal_\d{4}-\d{2}-\d{2}$/.test(key)) continue;   // calview/icons share the prefix
      let e; try { e = JSON.parse(localStorage.getItem(key) || 'null'); } catch { continue; }
      if (e) journal.push({ date: key.slice('nook_journal_'.length), content: e.content ?? '' });
    }
  } catch {}
  return {
    notes: arr(readJSON('nook_notes', [])), links: arr(readJSON('nook_links', [])),
    countdowns: arr(readJSON('nook_countdowns', [])), events: arr(readJSON('nook-calendar-events', [])),
    goals: arr(readJSON('nook_goals', [])), activity: arr(loadActivityLog()),
    reviews: arr(readJSON('nook-weekly-reviews', [])), customCategories: readJSON('nook_custom_categories', {}) || {},
    journalIcons: readJSON('nook_journal_icons', {}) || {}, journal,
  };
}

// ─── Tasks ─────────────────────────────────────────────────────────
function analyseTasks(src, c) {
  const { today, start, end, prevStart, prevEnd, buckets } = c;
  const all  = objs(src.tasks);
  const open = all.filter(t => !t.completed);
  const meta = { ...CAT_META, ...(src.customCategories || {}) };
  const due  = t => ymd(t.dueDate);
  const doneIn    = (s, e) => all.filter(t => t.completed && inR(isoDay(t.completedAt), s, e));
  const createdIn = (s, e) => all.filter(t => inR(isoDay(t.createdAt), s, e));
  const done = doneIn(start, end), created = createdIn(start, end);

  const overdue  = open.filter(t => due(t) && due(t) < today).sort((a, b) => due(a).localeCompare(due(b)) || String(a.name).localeCompare(String(b.name)));
  const dueScope = all.filter(t => inR(due(t), start, end < today ? end : today));   // future days aren't failures yet
  const withDue  = done.filter(t => due(t));
  const cycle    = done.filter(t => isoDay(t.createdAt)).map(t => Math.max(0, daysBetween(isoDay(t.createdAt), isoDay(t.completedAt))));

  const catOf = t => t.category || 'other';
  const byCategory = [...new Set([...done, ...open].map(catOf))].map(k => ({
    key: k, label: meta[k]?.label || cap(k), color: meta[k]?.color || '#8b5cf6',
    done: done.filter(t => catOf(t) === k).length, open: open.filter(t => catOf(t) === k).length,
  })).sort((a, b) => (b.done + b.open) - (a.done + a.open));

  const prOf = t => (['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'none');
  const byPriority = [['high', 'High', 'var(--color-red)'], ['medium', 'Medium', 'var(--color-amber)'], ['low', 'Low', 'var(--color-blue)'], ['none', 'No priority', 'var(--text-muted)']]
    .map(([key, label, color]) => ({ key, label, color, done: done.filter(t => prOf(t) === key).length, open: open.filter(t => prOf(t) === key).length }));

  const createdByDay = countBy(created, t => isoDay(t.createdAt));
  const doneByDay    = countBy(done, t => isoDay(t.completedAt));
  const cb = bucketSum(buckets, createdByDay), db = bucketSum(buckets, doneByDay);

  return {
    total: all.length, openNow: open.length,
    completed: done.length, completedPrev: doneIn(prevStart, prevEnd).length,
    created: created.length, createdPrev: createdIn(prevStart, prevEnd).length,
    overdue: overdue.length,
    overdueList: overdue.slice(0, 5).map(t => ({ id: t.id, name: t.name || '(untitled)', dueDate: due(t), daysLate: daysBetween(due(t), today), priority: prOf(t) })),
    dueToday: open.filter(t => due(t) === today).length,
    dueSoon:  open.filter(t => due(t) > today && due(t) <= shift(today, 7)).length,
    noDueDate: open.filter(t => !due(t)).length,
    dueInRange: { total: dueScope.length, done: dueScope.filter(t => t.completed).length, rate: pct(dueScope.filter(t => t.completed).length, dueScope.length) },
    onTime: { n: withDue.filter(t => isoDay(t.completedAt) <= due(t)).length, of: withDue.length, rate: pct(withDue.filter(t => isoDay(t.completedAt) <= due(t)).length, withDue.length) },
    avgDaysToComplete: cycle.length ? round1(sum(cycle) / cycle.length) : null,
    byCategory, byPriority,
    byWeekday: byWeekday(done.map(t => isoDay(t.completedAt))),
    effort: { estMin: sum(done.map(t => +t.timeEstimate || 0)), loggedMin: sum(done.map(t => +t.timeLogged || 0)), pomodoros: sum(done.map(t => +t.pomodorosCompleted || 0)) },
    recurring: open.filter(t => t.recurrence).length,
    series: cb.map((b, i) => ({ date: b.date, created: b.value, completed: db[i].value })),
  };
}

// ─── Habits ────────────────────────────────────────────────────────
function analyseHabits(src, c) {
  const { start, end, prevStart, prevEnd, elapsed, buckets } = c;
  const list = objs(src.habits);
  const cur = habitRangeStats(list, start, end), prev = habitRangeStats(list, prevStart, prevEnd);
  const byId = Object.fromEntries(list.map(h => [h.id, h]));

  const rows = habitTrends(list, start, end, prevStart, prevEnd).map(t => {
    const h = byId[t.id], cat = HABIT_CATS[h.category] ? h.category : 'health', all = arr(h.completions);
    return {
      ...t, category: cat, catLabel: HABIT_CATS[cat].label, frequency: fmtFrequency(h.frequency),
      timeTag: h.timeTag ? cap(h.timeTag) : 'Anytime', missed: t.due - t.done,
      streak: calcStreak(h), best: calcBestStreak(h), total: all.length, last: all.length ? [...all].sort().pop() : null,
    };
  }).sort((a, b) => b.rate - a.rate || b.done - a.done || String(a.name).localeCompare(String(b.name)));

  const perDay = elapsed.map(ds => {
    let due = 0, done = 0;
    for (const h of list) if (isScheduledOn(h, ds)) { due++; if (isCompletedOn(h, ds)) done++; }
    return { date: ds, due, done };
  });
  const wk = Array.from({ length: 7 }, () => ({ due: 0, done: 0 }));
  for (const d of perDay) { const w = wk[dowOf(d.date)]; w.due += d.due; w.done += d.done; }
  const weekday = wk.map((w, i) => ({ label: WEEKDAYS[i], name: WEEKDAY_NAMES[i], ...w, rate: pct(w.done, w.due) }));
  const ranked = weekday.filter(w => w.due >= 2 && w.rate !== null);

  let perfect = 0, run = 0, longestPerfect = 0;
  for (const d of perDay) {
    if (d.due === 0) continue;
    if (d.done === d.due) { perfect++; run++; if (run > longestPerfect) longestPerfect = run; } else run = 0;
  }

  const group = keyFn => {
    const m = new Map();
    for (const r of rows) { const k = keyFn(r); const g = m.get(k.key) || { ...k, due: 0, done: 0 }; g.due += r.due; g.done += r.done; m.set(k.key, g); }
    return [...m.values()].filter(g => g.due > 0).map(g => ({ ...g, rate: pct(g.done, g.due) })).sort((a, b) => b.rate - a.rate);
  };
  const dayMap = Object.fromEntries(perDay.map(d => [d.date, d]));
  const daily = buckets.map(b => {
    const ds = b.days.map(d => dayMap[d]).filter(Boolean);
    return { date: b.date, rate: pct(sum(ds.map(d => d.done)), sum(ds.map(d => d.due))) };
  });

  return {
    count: list.length, cur, prev, rows, weekday,
    bestDay: ranked.length ? [...ranked].sort((a, b) => b.rate - a.rate)[0] : null,
    worstDay: ranked.length > 1 ? [...ranked].sort((a, b) => a.rate - b.rate)[0] : null,
    perfectDays: perfect, longestPerfect,
    byCategory: group(r => ({ key: r.category, label: r.catLabel, color: HABIT_CATS[r.category].color })),
    byTimeTag:  group(r => ({ key: r.timeTag, label: r.timeTag, color: 'var(--accent)' })),
    attention: rows.filter(r => r.due >= 3 && r.rate < 50).sort((a, b) => a.rate - b.rate).slice(0, 3),
    improved: rows.filter(r => r.delta > 0).sort((a, b) => b.delta - a.delta)[0] || null,
    declined: rows.filter(r => r.delta < 0).sort((a, b) => a.delta - b.delta)[0] || null,
    daily,
  };
}

// ─── Focus ─────────────────────────────────────────────────────────
function analyseFocus(src, c) {
  const { today, start, end, prevStart, prevEnd, buckets } = c;
  const log   = arr(src.pomodoroLog).filter(ts => typeof ts === 'string');
  const mine  = log.filter(ts => inR(isoDay(ts), start, end));
  const prevN = log.filter(ts => inR(isoDay(ts), prevStart, prevEnd)).length;
  const perDay = countBy(mine, isoDay);
  const activeDays = Object.keys(perDay);
  const byHour = Array(24).fill(0);
  for (const ts of mine) { const d = new Date(ts); if (!isNaN(d)) byHour[d.getHours()]++; }
  const part = (from, to) => sum(byHour.slice(from, to));
  const best = busiest(perDay);
  const peak = mine.length ? byHour.indexOf(Math.max(...byHour)) : null;

  return {
    sessions: mine.length, sessionsPrev: prevN, minutes: mine.length * POMODORO_MIN,
    activeDays: activeDays.length, avgPerActiveDay: activeDays.length ? round1(mine.length / activeDays.length) : null,
    bestDay: best ? { date: best, sessions: perDay[best] } : null,
    longestStreak: runs(new Set(activeDays), today).best,
    currentStreak: runs(new Set(log.map(isoDay).filter(Boolean)), today).current,
    byHour, peakHour: peak, byWeekday: byWeekday(mine.map(isoDay)),
    dayParts: [
      { key: 'morning',   label: 'Morning (5–12)',   count: part(5, 12) },
      { key: 'afternoon', label: 'Afternoon (12–17)', count: part(12, 17) },
      { key: 'evening',   label: 'Evening (17–22)',   count: part(17, 22) },
      { key: 'night',     label: 'Night (22–5)',      count: part(22, 24) + part(0, 5) },
    ],
    series: bucketSum(buckets, perDay),
  };
}

// ─── Journal ───────────────────────────────────────────────────────
function analyseJournal(src, c) {
  const { today, start, end, prevStart, prevEnd, elapsed, buckets } = c;
  const entries = objs(src.journal).filter(e => hasText(e.content)).map(e => ({ date: e.date, words: wordCount(e.content) }));
  const mine = entries.filter(e => inR(e.date, start, end));
  const prevN = entries.filter(e => inR(e.date, prevStart, prevEnd)).length;
  const allRuns = runs(new Set(entries.map(e => e.date)), today);
  const icons = src.journalIcons && typeof src.journalIcons === 'object' ? src.journalIcons : {};
  const longest = [...mine].sort((a, b) => b.words - a.words || b.date.localeCompare(a.date))[0];

  return {
    entries: mine.length, entriesPrev: prevN, coverage: pct(mine.length, elapsed.length), daysInRange: elapsed.length,
    words: sum(mine.map(e => e.words)), avgWords: mine.length ? Math.round(sum(mine.map(e => e.words)) / mine.length) : null,
    longest: longest ? { date: longest.date, words: longest.words } : null,
    currentStreak: allRuns.current, bestStreak: allRuns.best,
    byWeekday: byWeekday(mine.map(e => e.date)),
    moods: tally(Object.keys(icons).filter(d => inR(d, start, end)), d => icons[d]).map(m => ({ emoji: m.key, count: m.count })),
    series: bucketSum(buckets, Object.fromEntries(mine.map(e => [e.date, e.words]))),
    allTime: { days: entries.length, words: sum(entries.map(e => e.words)) },
  };
}

// ─── Notes, links, countdowns, calendar, goals ─────────────────────
function analyseNotes(src, c) {
  const { start, end, prevStart, prevEnd } = c;
  const notes = objs(src.notes);
  const createdIn = (s, e) => notes.filter(n => inR(isoDay(n.createdAt), s, e));
  const created = createdIn(start, end);
  const createdSet = new Set(created);
  const edited = notes.filter(n => !createdSet.has(n) && inR(isoDay(n.updatedAt), start, end));
  const words = notes.map(n => wordCount(n.content));
  return {
    total: notes.length, pinned: notes.filter(n => n.pinned).length,
    created: created.length, createdPrev: createdIn(prevStart, prevEnd).length, edited: edited.length,
    totalWords: sum(words), avgWords: notes.length ? Math.round(sum(words) / notes.length) : null,
    byColor: tally(notes, n => n.color || 'default'),
    topTags: tally(notes.flatMap(n => arr(n.tags)), t => (typeof t === 'string' ? t : '')).slice(0, 8),
  };
}

function analyseLinks(src, c) {
  const { start, end, prevStart, prevEnd } = c;
  const links = objs(src.links);
  const addedIn = (s, e) => links.filter(l => inR(isoDay(l.createdAt), s, e)).length;
  return {
    total: links.length, starred: links.filter(l => l.starred).length,
    added: addedIn(start, end), addedPrev: addedIn(prevStart, prevEnd),
    byCategory: tally(links, l => l.category || 'Uncategorised').slice(0, 8),
  };
}

function analyseCountdowns(src, c) {
  const { today } = c;
  const all  = objs(src.countdowns);
  const list = all.filter(cd => ymd(cd.endDate));   // one with no usable end date can't be placed in time
  const statusOf = cd => (cd.completed ? 'completed' : today > cd.endDate ? 'overdue' : today < ymd(cd.startDate) ? 'upcoming' : 'active');
  const withStatus = list.map(cd => ({ cd, status: statusOf(cd) }));
  const n = s => withStatus.filter(x => x.status === s).length;
  const nextUp = withStatus.filter(x => x.status !== 'completed' && x.status !== 'overdue')
    .sort((a, b) => a.cd.endDate.localeCompare(b.cd.endDate) || String(a.cd.name).localeCompare(String(b.cd.name))).slice(0, 3).map(({ cd, status }) => {
      const from = ymd(cd.startDate) || cd.endDate;
      const total = Math.max(1, daysBetween(from, cd.endDate));
      const elapsed = Math.min(total, Math.max(0, daysBetween(from, today)));
      return { id: cd.id, name: cd.name || '(untitled)', endDate: cd.endDate, daysLeft: Math.max(0, daysBetween(today, cd.endDate)), pct: Math.round((elapsed / total) * 100), status };
    });
  return {
    total: all.length, active: n('active'), upcoming: n('upcoming'), overdue: n('overdue'), completed: n('completed'),
    nextUp, byCategory: tally(list, cd => cd.category || 'Other'),
  };
}

function analyseEvents(src, c) {
  const { today, start, end, prevStart, prevEnd } = c;
  const events = objs(src.events);
  const mine = events.filter(e => inR(e.date, start, end));
  const mins = e => {
    const [h1, m1] = String(e.time || '').split(':').map(Number), [h2, m2] = String(e.endTime || '').split(':').map(Number);
    const d = (h2 * 60 + m2) - (h1 * 60 + m1);
    return Number.isFinite(d) && d > 0 ? d : 0;
  };
  const next = events.filter(e => typeof e.date === 'string' && e.date >= today).sort((a, b) => a.date.localeCompare(b.date) || String(a.time || '').localeCompare(String(b.time || '')))[0];
  return {
    total: events.length, inRange: mine.length, inRangePrev: events.filter(e => inR(e.date, prevStart, prevEnd)).length,
    allDay: mine.filter(e => e.isAllDay).length, scheduledMin: sum(mine.filter(e => !e.isAllDay).map(mins)),
    upcoming7: events.filter(e => typeof e.date === 'string' && e.date >= today && e.date <= shift(today, 7)).length,
    next: next ? { title: next.title || '(untitled)', date: next.date, time: next.isAllDay ? '' : (next.time || '') } : null,
    byCategory: tally(mine, e => e.category || 'other'), byWeekday: byWeekday(mine.map(e => e.date)),
  };
}

function analyseGoals(src) {
  const goals = objs(src.goals);
  const progress = g => (arr(g.milestones).length ? Math.round(arr(g.milestones).filter(m => m.done).length / arr(g.milestones).length * 100) : +g.manualProgress || 0);
  return { total: goals.length, completed: goals.filter(g => g.completed).length, avgProgress: goals.length ? Math.round(sum(goals.map(progress)) / goals.length) : null };
}

// ─── Activity & reviews ────────────────────────────────────────────
const MODULE_LABELS = { vault: 'Saved Logins' };   // the removed tab; every other module reads fine capitalised

function analyseActivity(src, c) {
  const { start, end, prevStart, prevEnd, buckets } = c;
  const log = objs(src.activity);
  const day = e => isoDay(e.created_at);
  const mine = log.filter(e => inR(day(e), start, end));
  const perDay = countBy(mine, day);
  const best = busiest(perDay);
  const byHour = Array(24).fill(0);
  for (const e of mine) { const d = new Date(e.created_at); if (!isNaN(d)) byHour[d.getHours()]++; }
  const oldest = log.reduce((m, e) => (day(e) && (!m || day(e) < m) ? day(e) : m), '');
  return {
    actions: mine.length, actionsPrev: log.filter(e => inR(day(e), prevStart, prevEnd)).length,
    failed: mine.filter(e => e.status && e.status !== 'success').length,
    byModule: tally(mine, e => e.module).map(m => ({ ...m, label: MODULE_LABELS[m.key] || cap(m.key) })),
    byAction: tally(mine, e => e.action).map(m => ({ ...m, label: cap(m.key) })),
    byWeekday: byWeekday(mine.map(day)), byHour,
    busiestDay: best ? { date: best, count: perDay[best] } : null,
    activeDays: Object.keys(perDay).length,
    // The log keeps the newest 2000 entries, so a long range can reach past what's left.
    truncated: log.length >= 2000 && !!oldest && start < oldest,
    series: bucketSum(buckets, perDay),
  };
}

function analyseReviews(src, c) {
  const { start, end, prevStart, prevEnd } = c;
  const reviews = objs(src.reviews).filter(r => +r.rating > 0);
  const avg = list => (list.length ? round1(sum(list.map(r => +r.rating)) / list.length) : null);
  const mine = reviews.filter(r => inR(isoDay(r.date), start, end));
  const recent = [...reviews].sort((a, b) => String(a.date).localeCompare(String(b.date))).slice(-8);
  return {
    count: mine.length, avg: avg(mine), avgPrev: avg(reviews.filter(r => inR(isoDay(r.date), prevStart, prevEnd))),
    total: reviews.length, recent: recent.map(r => ({ date: isoDay(r.date), rating: +r.rating })),
    latestNext: [...reviews].sort((a, b) => String(b.date).localeCompare(String(a.date)))[0]?.nextFocus || '',
  };
}

// ─── Productivity score ────────────────────────────────────────────
function analyseScore(src, c) {
  const { start, end, prevStart, prevEnd, elapsed, buckets } = c;
  const habits = objs(src.habits), tasks = objs(src.tasks), log = arr(src.pomodoroLog);
  // With nothing to score, dailyScoreH still hands out its 50 free habit points
  // every day — a flat line at 50 says nothing, so report "no data" instead.
  if (!habits.length && !tasks.some(t => t.completed) && !log.length)
    return { hasData: false, avg: null, avgPrev: null, best: null, worst: null, greatDays: 0, days: elapsed.length, byWeekday: [], series: [] };
  const score = ds => dailyScoreH(habits, tasks, log, ds);
  const cur = elapsed.map(ds => ({ date: ds, score: score(ds) }));
  const prev = eachDay(prevStart, prevEnd).filter(ds => ds <= c.today).map(score);
  const avg = xs => (xs.length ? Math.round(sum(xs) / xs.length) : null);
  const wk = Array.from({ length: 7 }, () => []);
  for (const d of cur) wk[dowOf(d.date)].push(d.score);
  const scoreByDay = Object.fromEntries(cur.map(d => [d.date, d.score]));
  const ranked = [...cur].sort((a, b) => b.score - a.score);
  return {
    hasData: true, avg: avg(cur.map(d => d.score)), avgPrev: avg(prev),
    best: ranked[0] || null, worst: ranked.length > 1 ? ranked[ranked.length - 1] : null,
    greatDays: cur.filter(d => d.score >= 80).length, days: cur.length,
    byWeekday: wk.map((xs, i) => ({ label: WEEKDAYS[i], avg: avg(xs), n: xs.length })),
    series: buckets.map(b => { const xs = b.days.filter(d => d in scoreByDay).map(d => scoreByDay[d]); return { date: b.date, avg: avg(xs) }; }),
  };
}

// ─── All-time totals (ignore the range) ────────────────────────────
function analyseAllTime(src, c, parts) {
  const { today } = c;
  const habits = objs(src.habits), tasks = objs(src.tasks), log = arr(src.pomodoroLog);
  const stamps = [
    ...tasks.map(t => isoDay(t.createdAt)), ...habits.map(h => isoDay(h.createdAt)), ...objs(src.notes).map(n => isoDay(n.createdAt)),
    ...objs(src.links).map(l => isoDay(l.createdAt)), ...objs(src.journal).filter(e => hasText(e.content)).map(e => e.date),
  ].filter(Boolean).sort();
  const since = stamps[0] || null;
  return {
    since, daysUsing: since ? daysBetween(since, today) + 1 : 0,
    tasksCompleted: tasks.filter(t => t.completed).length, tasksTotal: tasks.length,
    habitCheckIns: sum(habits.map(h => arr(h.completions).length)),
    bestHabitStreak: habits.length ? Math.max(...habits.map(calcBestStreak)) : 0,
    focusSessions: log.length, focusMinutes: log.length * POMODORO_MIN,
    journalDays: parts.journal.allTime.days, journalWords: parts.journal.allTime.words,
    notes: parts.notes.total, links: parts.links.total, countdowns: parts.countdowns.total,
    events: parts.events.total, activity: objs(src.activity).length,
  };
}

// ─── Highlights ────────────────────────────────────────────────────
// Plain-language readouts, most useful first. Each is only emitted when the data
// behind it is thick enough to say something true.
function buildInsights(a) {
  const out = [], add = (tone, text) => out.push({ tone, text });
  const L = a.label, h = a.habits, t = a.tasks, f = a.focus, j = a.journal, s = a.score;

  if (h.cur.due > 0) {
    const d = h.prev.due > 0 ? h.cur.rate - h.prev.rate : null;
    if (d === null)      add('info', `Habit completion is ${h.cur.rate}% (${h.cur.done} of ${h.cur.due} scheduled check-ins).`);
    else if (d >= 5)     add('good', `Habit completion is up ${d} points to ${h.cur.rate}% compared with the previous ${L}.`);
    else if (d <= -5)    add('warn', `Habit completion fell ${-d} points to ${h.cur.rate}% compared with the previous ${L}.`);
    else                 add('info', `Habit completion held steady at ${h.cur.rate}%.`);
  }
  if (h.bestDay && h.worstDay && h.bestDay.rate - h.worstDay.rate >= 15)
    add('info', `You're most consistent on ${h.bestDay.name}s (${h.bestDay.rate}%) and least on ${h.worstDay.name}s (${h.worstDay.rate}%).`);
  if (h.attention[0]) add('warn', `${h.attention[0].name} is at ${h.attention[0].rate}% (${h.attention[0].done} of ${h.attention[0].due}) — the habit most in need of attention.`);
  if (h.perfectDays > 0) add('good', `${h.perfectDays} perfect habit day${h.perfectDays === 1 ? '' : 's'}${h.longestPerfect > 1 ? `, with a best run of ${h.longestPerfect} in a row` : ''}.`);

  if (t.overdue > 0) add('warn', `${t.overdue} task${t.overdue === 1 ? ' is' : 's are'} overdue — the oldest is “${t.overdueList[0].name}”, ${t.overdueList[0].daysLate} day${t.overdueList[0].daysLate === 1 ? '' : 's'} late.`);
  if (t.completed > 0 && t.completed > t.completedPrev) add('good', `You completed ${t.completed} task${t.completed === 1 ? '' : 's'}, ${t.completed - t.completedPrev} more than the previous ${L}.`);
  else if (t.completedPrev > 0 && t.completed < t.completedPrev) add('info', `You completed ${t.completed} task${t.completed === 1 ? '' : 's'}, ${t.completedPrev - t.completed} fewer than the previous ${L}.`);
  if (t.onTime.of >= 3 && t.onTime.rate !== null) add(t.onTime.rate >= 75 ? 'good' : 'info', `${t.onTime.rate}% of the tasks you finished with a due date were done on time.`);

  if (f.sessions > 0 && f.peakHour !== null) add('info', `Your focus peaks around ${fmtHour(f.peakHour)} — ${f.byHour[f.peakHour]} of ${f.sessions} sessions started in that hour.`);
  else if (f.sessions === 0) add('info', `No focus sessions were logged in this ${L}.`);

  if (j.currentStreak >= 2) add('good', `You're on a ${j.currentStreak}-day journaling streak.`);
  else if (j.coverage !== null && j.daysInRange >= 7 && j.coverage < 30) add('info', `You journaled on ${j.entries} of ${j.daysInRange} days this ${L}.`);

  if (s.hasData && s.avg !== null && s.avgPrev !== null && Math.abs(s.avg - s.avgPrev) >= 5)
    add(s.avg > s.avgPrev ? 'good' : 'warn', `Your average daily score is ${s.avg}, ${s.avg > s.avgPrev ? 'up' : 'down'} ${Math.abs(s.avg - s.avgPrev)} from ${s.avgPrev}.`);

  if (a.countdowns.overdue > 0) add('warn', `${a.countdowns.overdue} countdown${a.countdowns.overdue === 1 ? ' is' : 's are'} past ${a.countdowns.overdue === 1 ? 'its' : 'their'} end date and not marked complete.`);
  if (a.activity.byModule[0] && a.activity.actions >= 5) add('info', `${a.activity.byModule[0].label} was your busiest area: ${a.activity.byModule[0].count} of ${a.activity.actions} recorded actions.`);

  return out.slice(0, 8);
}

// ─── Entry point ───────────────────────────────────────────────────
// src:   { habits, tasks, pomodoroLog, notes, links, countdowns, events, goals,
//          activity, reviews, journal, journalIcons, customCategories }
// range: rangeBounds() output — { start, end, prevStart, prevEnd, label }
export function buildAnalysis(src, range) {
  const today = localDateStr();
  let { start, end, prevStart, prevEnd } = range;
  let clamped = false, len = daysBetween(start, end) + 1;
  if (len > MAX_DAYS) {
    // Keep the most recent two years — but anchor on today, not on a custom end date that's
    // still in the future (that would slide the window onto days that haven't happened) — and
    // never reach back before the start that was picked.
    const last  = end > today ? today : end;
    const first = shift(last, -(MAX_DAYS - 1));
    clamped = start < first;
    start = start > first ? start : first;
    end   = last < start ? start : last;
    len   = daysBetween(start, end) + 1;
    prevEnd = shift(start, -1); prevStart = shift(prevEnd, -(len - 1));
  }
  const days = eachDay(start, end);
  const c = { today, start, end, prevStart, prevEnd, days, elapsed: days.filter(d => d <= today), buckets: makeBuckets(days), label: range.label || 'period' };

  const a = {
    start, end, prevStart, prevEnd, label: c.label, clamped, days: days.length, weekly: days.length > 45,
    tasks: analyseTasks(src, c), habits: analyseHabits(src, c), focus: analyseFocus(src, c),
    journal: analyseJournal(src, c), notes: analyseNotes(src, c), links: analyseLinks(src, c),
    countdowns: analyseCountdowns(src, c), events: analyseEvents(src, c), goals: analyseGoals(src),
    activity: analyseActivity(src, c), reviews: analyseReviews(src, c), score: analyseScore(src, c),
  };
  a.allTime = analyseAllTime(src, c, a);
  a.insights = buildInsights(a);
  return a;
}
