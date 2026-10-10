import { describe, it, expect, afterAll, vi } from 'vitest';
import { buildAnalysis, loadAnalysisSources, fmtHour, fmtMinutes, MAX_DAYS } from './detailedAnalysis';
import { rangeBounds, tasksDoneInRange, focusInRange, habitRangeStats, journalCountInRange, dailyScoreH } from './reportsAnalytics';

// "Today" is Saturday 2026-10-10, so "this week" is Sun 10-04 … Sat 10-10 and the
// previous week is 09-27 … 10-03.
const TODAY = '2026-10-10';
const at = ds => `${ds}T12:00:00.000Z`;   // UTC noon: the date prefix is `ds` in every timezone
const week = () => rangeBounds('week');

// Pin the clock at import time, NOT in a beforeAll: several describe blocks below build their
// analysis in the describe body, which runs while vitest is still collecting — before any
// beforeAll. With the clock pinned there they used the real date, so they passed only on the one
// day the real date happened to be 2026-10-10.
vi.useFakeTimers();
vi.setSystemTime(new Date(2026, 9, 10, 12, 0, 0));
afterAll(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const habit = (id, completions, extra = {}) => ({ id, name: id, category: 'health', frequency: 'daily', completions, createdAt: at('2026-01-01'), ...extra });

describe('tasks', () => {
  const tasks = [
    { id: 'a', name: 'A', category: 'work', priority: 'high', completed: true, createdAt: at('2026-10-01'), completedAt: at('2026-10-05'), dueDate: '2026-10-06', timeEstimate: 30, timeLogged: 40, pomodorosCompleted: 2 },
    { id: 'b', name: 'B', category: 'work', priority: 'low', completed: true, createdAt: at('2026-10-04'), completedAt: at('2026-10-09'), dueDate: '2026-10-07', timeEstimate: 20, timeLogged: 0 },
    { id: 'c', name: 'C', category: 'errands', completed: true, createdAt: at('2026-09-20'), completedAt: at('2026-09-30') },   // previous week
    { id: 'd', name: 'D', category: 'work', priority: 'medium', completed: false, createdAt: at('2026-10-02'), dueDate: '2026-10-08' },   // overdue
    { id: 'e', name: 'E', category: 'errands', completed: false, createdAt: at('2026-10-09'), dueDate: '2026-10-12' },   // due soon
    { id: 'f', name: 'F', completed: false, createdAt: at('2026-10-10'), dueDate: TODAY, recurrence: 'daily' },
  ];
  const a = buildAnalysis({ tasks, customCategories: { errands: { label: 'Errands', color: '#123456' } } }, week()).tasks;

  it('counts created / completed in the range and the previous one', () => {
    expect(a.completed).toBe(2);
    expect(a.completedPrev).toBe(1);
    expect(a.created).toBe(3);   // b, e, f — d was created 10-02, in the previous week
    expect(a.createdPrev).toBe(2);   // a, d
    expect(a.openNow).toBe(3);
    expect(a.total).toBe(6);
  });
  it('flags overdue, due today and due soon from today, not from the range', () => {
    expect(a.overdue).toBe(1);
    expect(a.overdueList[0]).toMatchObject({ name: 'D', daysLate: 2 });
    expect(a.dueToday).toBe(1);
    expect(a.dueSoon).toBe(1);
    expect(a.noDueDate).toBe(0);
    expect(a.recurring).toBe(1);
  });
  it('measures on-time rate and cycle time on tasks finished in the range', () => {
    expect(a.onTime).toEqual({ n: 1, of: 2, rate: 50 });   // a on time, b two days late
    expect(a.avgDaysToComplete).toBe(4.5);                 // a took 4 days, b took 5
  });
  it('splits by category (custom labels) and priority', () => {
    const work = a.byCategory.find(x => x.key === 'work');
    expect(work).toMatchObject({ done: 2, open: 1, label: 'Work' });
    expect(a.byCategory.find(x => x.key === 'errands')).toMatchObject({ label: 'Errands', color: '#123456', open: 1 });
    expect(a.byPriority.find(x => x.key === 'high').done).toBe(1);
    expect(a.byPriority.find(x => x.key === 'none').open).toBe(2);   // e and f have no priority
  });
  it('sums effort and builds one series point per day', () => {
    expect(a.effort).toEqual({ estMin: 50, loggedMin: 40, pomodoros: 2 });
    expect(a.series).toHaveLength(7);
    expect(a.series.find(p => p.date === '2026-10-05')).toMatchObject({ completed: 1 });
  });
  it('agrees with the Overview', () => {
    const r = week();
    expect(a.completed).toBe(tasksDoneInRange(tasks, r.start, r.end));
  });
});

describe('habits', () => {
  // Daily habit "run": done every day this week except Tue 10-06 and Wed 10-07.
  const run  = habit('run',  ['2026-10-04', '2026-10-05', '2026-10-08', '2026-10-09', '2026-10-10']);
  const read = habit('read', ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'], { category: 'learning' });
  const a = buildAnalysis({ habits: [run, read] }, week()).habits;

  it('matches the Overview headline numbers', () => {
    const r = week();
    expect(a.cur).toEqual(habitRangeStats([run, read], r.start, r.end));
    expect(a.cur).toMatchObject({ due: 14, done: 12, rate: 86 });
  });
  it('ranks habits and reports misses, streaks and category', () => {
    expect(a.rows.map(r => r.id)).toEqual(['read', 'run']);
    expect(a.rows[1]).toMatchObject({ missed: 2, done: 5, due: 7, streak: 3, catLabel: 'Health' });
    expect(a.rows[0]).toMatchObject({ rate: 100, catLabel: 'Learning', streak: 7 });
  });
  it('finds perfect days, the longest run, and the weak weekdays', () => {
    expect(a.perfectDays).toBe(5);        // everything but Tue and Wed
    expect(a.longestPerfect).toBe(3);     // Thu-Fri-Sat
    expect(a.weekday[2]).toMatchObject({ label: 'Tue', due: 2, done: 1, rate: 50 });
    expect(a.worstDay.rate).toBe(50);
    expect(a.bestDay.rate).toBe(100);
  });
  it('groups by category', () => {
    expect(a.byCategory.map(g => [g.key, g.rate])).toEqual([['learning', 100], ['health', 71]]);
  });
  it('lists habits needing attention only when there is enough data', () => {
    const weak = buildAnalysis({ habits: [habit('weak', ['2026-10-04'])] }, week()).habits;
    expect(weak.attention.map(h => h.id)).toEqual(['weak']);
    expect(a.attention).toEqual([]);
  });
  it('skips future days and respects non-daily schedules', () => {
    const weekdays = habit('wd', [], { frequency: 'weekdays' });
    const h = buildAnalysis({ habits: [weekdays] }, week()).habits;
    expect(h.cur.due).toBe(5);   // Mon–Fri of this week; the weekend is unscheduled
  });
});

describe('focus', () => {
  const sess = (y, m, d, h) => new Date(y, m, d, h, 0, 0).toISOString();
  const log = [
    new Date(2026, 9, 8, 12).toISOString(), new Date(2026, 9, 8, 12, 30).toISOString(), new Date(2026, 9, 9, 12).toISOString(),
    new Date(2026, 9, 10, 12).toISOString(), at('2026-09-30'),
  ];
  const a = buildAnalysis({ pomodoroLog: log }, week()).focus;

  it('matches the Overview and converts sessions to minutes', () => {
    const r = week();
    expect(a.sessions).toBe(focusInRange(log, r.start, r.end).sessions);
    expect(a.sessions).toBe(4);
    expect(a.sessionsPrev).toBe(1);
    expect(a.minutes).toBe(100);
  });
  it('finds the busiest day, active days and streaks', () => {
    expect(a.activeDays).toBe(3);
    expect(a.bestDay).toMatchObject({ date: '2026-10-08', sessions: 2 });
    expect(a.avgPerActiveDay).toBe(1.3);
    expect(a.longestStreak).toBe(3);
    expect(a.currentStreak).toBe(3);
  });
  it('buckets by local hour and part of day', () => {
    expect(a.byHour[12]).toBe(4);
    expect(a.peakHour).toBe(12);
    expect(a.dayParts.find(p => p.key === 'afternoon').count).toBe(4);
    const night = buildAnalysis({ pomodoroLog: [sess(2026, 9, 9, 23), sess(2026, 9, 9, 2)] }, week()).focus;
    expect(night.dayParts.find(p => p.key === 'night').count).toBe(2);
  });
  it('is empty-safe', () => {
    const none = buildAnalysis({}, week()).focus;
    expect(none).toMatchObject({ sessions: 0, peakHour: null, bestDay: null, avgPerActiveDay: null });
  });
});

describe('journal', () => {
  const journal = [
    { date: '2026-10-10', content: '<p>one two three</p>' },
    { date: '2026-10-09', content: '<div>four&nbsp;five</div><br>six' },
    { date: '2026-10-08', content: '<p>seven</p>' },
    { date: '2026-10-05', content: '<p>&nbsp;</p>' },      // counts as an entry (same rule as the Overview) but has no words
    { date: '2026-10-04', content: '<p><br></p>' },        // no text → not an entry
    { date: '2026-09-29', content: '<p>old entry here</p>' },
  ];
  const a = buildAnalysis({ journal, journalIcons: { '2026-10-10': '😀', '2026-10-09': '😀', '2026-10-08': '😐', '2026-09-01': '😡' } }, week()).journal;

  it('counts entries by the same rule as the Overview', () => {
    expect(a.entries).toBe(4);
    expect(a.entriesPrev).toBe(1);
  });
  it('counts words, coverage and the longest entry', () => {
    expect(a.words).toBe(7);
    expect(a.avgWords).toBe(2);
    expect(a.coverage).toBe(57);
    expect(a.longest).toEqual({ date: '2026-10-10', words: 3 });   // 10-09 ties; the later day wins, whatever the storage order
  });
  it('tracks the writing streak and mood counts inside the range only', () => {
    expect(a.currentStreak).toBe(3);
    expect(a.bestStreak).toBe(3);
    expect(a.moods).toEqual([{ emoji: '😀', count: 2 }, { emoji: '😐', count: 1 }]);
  });
  it('matches the Overview count when read from storage', () => {
    const store = new Map(journal.map(e => [`nook_journal_${e.date}`, JSON.stringify(e)]));
    store.set('nook_journal_icons', '{}'); store.set('nook_journal_calview', 'month');
    vi.stubGlobal('localStorage', { get length() { return store.size; }, key: i => [...store.keys()][i], getItem: k => store.get(k) ?? null });
    const r = week();
    expect(journalCountInRange(r.start, r.end)).toBe(a.entries);
    expect(loadAnalysisSources().journal).toHaveLength(journal.length);   // icons / calview aren't entries
  });
});

describe('notes, links, countdowns, calendar, goals', () => {
  const src = {
    notes: [
      { id: '1', title: 'x', content: '<p>a b c</p>', pinned: true, color: 'blue', tags: ['ideas', 'work'], createdAt: at('2026-10-05'), updatedAt: at('2026-10-05') },
      { id: '2', title: 'y', content: '<p>d e</p>', color: 'blue', tags: ['ideas'], createdAt: at('2026-09-01'), updatedAt: at('2026-10-07') },
      { id: '3', title: 'z', content: '', createdAt: at('2026-09-29'), updatedAt: at('2026-09-29') },
    ],
    links: [{ id: 'l1', category: 'Dev', starred: true, createdAt: at('2026-10-06') }, { id: 'l2', category: 'Dev', createdAt: at('2026-09-01') }, { id: 'l3', createdAt: at('2026-09-28') }],
    countdowns: [
      { id: 'c1', name: 'Trip', category: 'Travel', startDate: '2026-09-10', endDate: '2026-10-20' },
      { id: 'c2', name: 'Done', startDate: '2026-08-01', endDate: '2026-09-01', completed: true },
      { id: 'c3', name: 'Late', startDate: '2026-08-01', endDate: '2026-09-15' },
      { id: 'c4', name: 'Later', startDate: '2026-11-01', endDate: '2026-12-01' },
    ],
    events: [
      { id: 'e1', title: 'Standup', date: '2026-10-06', time: '09:00', endTime: '09:30', category: 'work' },
      { id: 'e2', title: 'Holiday', date: '2026-10-09', isAllDay: true, category: 'growth' },
      { id: 'e3', title: 'Dentist', date: '2026-10-14', time: '10:00', endTime: '11:00', category: 'mental' },
    ],
    goals: [{ id: 'g1', milestones: [{ done: true }, { done: false }] }, { id: 'g2', manualProgress: 100, completed: true }],
  };
  const a = buildAnalysis(src, week());

  it('summarises notes', () => {
    expect(a.notes).toMatchObject({ total: 3, pinned: 1, created: 1, createdPrev: 1, edited: 1, totalWords: 5 });
    expect(a.notes.topTags[0]).toEqual({ key: 'ideas', count: 2 });
    expect(a.notes.byColor[0]).toEqual({ key: 'blue', count: 2 });
  });
  it('summarises links', () => {
    expect(a.links).toMatchObject({ total: 3, starred: 1, added: 1, addedPrev: 1 });
    expect(a.links.byCategory[0]).toEqual({ key: 'Dev', count: 2 });
  });
  it('classifies countdowns the way the Countdowns tab does', () => {
    expect(a.countdowns).toMatchObject({ total: 4, active: 1, upcoming: 1, overdue: 1, completed: 1 });
    expect(a.countdowns.nextUp.map(c => c.name)).toEqual(['Trip', 'Later']);
    expect(a.countdowns.nextUp[0]).toMatchObject({ daysLeft: 10, pct: 75 });   // 30 of its 40 days have elapsed
  });
  it('summarises the calendar', () => {
    expect(a.events).toMatchObject({ total: 3, inRange: 2, allDay: 1, scheduledMin: 30, upcoming7: 1 });
    expect(a.events.next).toEqual({ title: 'Dentist', date: '2026-10-14', time: '10:00' });
  });
  it('summarises goals', () => {
    expect(a.goals).toEqual({ total: 2, completed: 1, avgProgress: 75 });
  });
});

describe('activity and reviews', () => {
  const act = (module, action, ds, h = 12, status = 'success') => ({ id: `${module}${ds}${action}${h}`, module, action, status, created_at: new Date(`${ds}T${String(h).padStart(2, '0')}:00:00`).toISOString() });
  const src = {
    activity: [act('tasks', 'completed', '2026-10-09'), act('tasks', 'created', '2026-10-09'), act('habits', 'updated', '2026-10-08'), act('vault', 'deleted', '2026-10-07', 12, 'error'), act('tasks', 'created', '2026-09-30')],
    reviews: [
      { date: at('2026-10-05'), rating: 4, nextFocus: 'ship it' }, { date: at('2026-10-09'), rating: 2 }, { date: at('2026-09-28'), rating: 5 },
    ],
  };
  const a = buildAnalysis(src, week());

  it('breaks activity down by module, action and busiest day', () => {
    expect(a.activity).toMatchObject({ actions: 4, actionsPrev: 1, failed: 1, activeDays: 3 });
    expect(a.activity.byModule[0]).toMatchObject({ key: 'tasks', count: 2, label: 'Tasks' });
    expect(a.activity.byModule.find(m => m.key === 'vault').label).toBe('Saved Logins');
    expect(a.activity.busiestDay).toEqual({ date: '2026-10-09', count: 2 });
    expect(a.activity.truncated).toBe(false);
  });
  it('averages review ratings against the previous period', () => {
    expect(a.reviews).toMatchObject({ count: 2, avg: 3, avgPrev: 5, total: 3, latestNext: '' });
    expect(a.reviews.recent.map(r => r.rating)).toEqual([5, 4, 2]);
  });
});

describe('score', () => {
  it('matches dailyScoreH for each day', () => {
    const habits = [habit('h', ['2026-10-09', '2026-10-10'])];
    const tasks = [{ id: 't', completed: true, completedAt: at('2026-10-10') }];
    const log = [at('2026-10-10')];
    const s = buildAnalysis({ habits, tasks, pomodoroLog: log }, week()).score;
    expect(s.days).toBe(7);
    expect(s.best).toEqual({ date: TODAY, score: dailyScoreH(habits, tasks, log, TODAY) });
    expect(s.series).toHaveLength(7);
    expect(s.byWeekday).toHaveLength(7);
    expect(s.hasData).toBe(true);
  });
  it('says "no data" instead of a flat 50 when there is nothing to score', () => {
    // dailyScoreH gives 50 free habit points on a day with no habits scheduled.
    const s = buildAnalysis({ tasks: [{ id: 'open', completed: false }] }, week()).score;
    expect(s).toMatchObject({ hasData: false, avg: null, avgPrev: null, best: null, worst: null });
    expect(s.series).toEqual([]);
  });
});

describe('range handling', () => {
  it('clamps a huge custom range and says so', () => {
    const a = buildAnalysis({}, rangeBounds('custom', '2015-01-01', TODAY));
    expect(a.clamped).toBe(true);
    expect(a.days).toBe(MAX_DAYS);
    expect(a.weekly).toBe(true);
    expect(a.tasks.series.length).toBeLessThan(120);   // weekly blocks, not 731 bars
  });
  it('does not count future days in a custom range that ends after today', () => {
    const a = buildAnalysis({ habits: [habit('h', [])] }, rangeBounds('custom', '2026-10-08', '2026-10-20'));
    expect(a.habits.cur.due).toBe(3);   // 8th, 9th and 10th only
    expect(a.score.days).toBe(3);
  });
  it('survives completely empty and malformed sources', () => {
    const a = buildAnalysis({ habits: [null, 'x'], tasks: [undefined, { id: 1 }], pomodoroLog: [1, null, 'bad'], notes: 'nope', activity: [{}], journal: [{}] }, week());
    expect(a.tasks.total).toBe(1);
    expect(a.insights.length).toBeGreaterThanOrEqual(0);
    expect(a.allTime.since).toBeNull();
  });
});

describe('bad data and edge ranges', () => {
  const finite = v => typeof v === 'number' && Number.isFinite(v);

  it('keeps a countdown with an unusable end date out of the timeline rather than printing NaN', () => {
    const a = buildAnalysis({ countdowns: [
      { id: 'bad', name: 'Bad', endDate: 'soon', startDate: '2026-09-01' },
      { id: 'ok', name: 'Fine', endDate: '2026-10-20', startDate: '2026-10-01' },
    ] }, week()).countdowns;
    expect(a.total).toBe(2);                       // still counted…
    expect(a.nextUp.map(c => c.name)).toEqual(['Fine']);   // …but never placed in time
    expect(a.nextUp.every(c => finite(c.daysLeft) && finite(c.pct))).toBe(true);
  });
  it('treats a countdown with a bad start date as already started', () => {
    const c = buildAnalysis({ countdowns: [{ id: 'x', name: 'X', endDate: '2026-10-20', startDate: 'garbage' }] }, week()).countdowns;
    expect(c.nextUp[0]).toMatchObject({ status: 'active', daysLeft: 10, pct: 0 });
  });
  it('treats a malformed due date as no due date — not overdue, never "NaN days late"', () => {
    const a = buildAnalysis({ tasks: [{ id: 't', name: 'T', completed: false, dueDate: '2026-1-5', createdAt: at('2026-10-01') }] }, week());
    expect(a.tasks.overdue).toBe(0);
    expect(a.tasks.noDueDate).toBe(1);
    expect(a.insights.some(i => /NaN/.test(i.text))).toBe(false);
  });
  it('skips unreadable created / completed stamps in cycle time', () => {
    const t = { id: 't', name: 'T', completed: true, completedAt: at('2026-10-08'), createdAt: 'yesterday' };
    expect(buildAnalysis({ tasks: [t] }, week()).tasks.avgDaysToComplete).toBeNull();
  });
  it('anchors a clamped window on today when the custom end date is still in the future', () => {
    const tasks = [{ id: 't', name: 'T', completed: true, completedAt: at('2026-10-09'), createdAt: at('2026-10-01') }];
    const a = buildAnalysis({ tasks }, rangeBounds('custom', '2015-01-01', '2100-01-01'));
    expect(a.end).toBe(TODAY);
    expect(a.days).toBe(MAX_DAYS);
    expect(a.clamped).toBe(true);
    expect(a.tasks.completed).toBe(1);   // used to be 0: the window sat in 2098–2100
  });
  it('never reaches back before the start that was picked, even if the end is far away', () => {
    const a = buildAnalysis({}, rangeBounds('custom', '2026-07-01', '2100-01-01'));
    expect(a.start).toBe('2026-07-01');
    expect(a.end).toBe(TODAY);
    expect(a.clamped).toBe(false);
    expect(a.days).toBe(102);
  });
  it('labels activity areas without inventing aliases', () => {
    const mk = (module, i) => ({ id: `${module}${i}`, module, action: 'created', status: 'success', created_at: new Date(2026, 9, 9, 12).toISOString() });
    const a = buildAnalysis({ activity: [mk('focus', 1), mk('vault', 2), mk('tasks', 3)] }, week()).activity;
    expect(a.byModule.map(m => m.label).sort()).toEqual(['Focus', 'Saved Logins', 'Tasks']);
  });
});

describe('highlights', () => {
  it('reports a habit improvement and an overdue task in plain words', () => {
    const habits = [habit('h', ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'])];
    const tasks = [{ id: 'o', name: 'Pay rent', completed: false, createdAt: at('2026-09-01'), dueDate: '2026-10-07' }];
    const text = buildAnalysis({ habits, tasks }, week()).insights;
    expect(text.some(i => i.tone === 'good' && /up 100 points to 100%/.test(i.text))).toBe(true);
    expect(text.some(i => i.tone === 'warn' && /Pay rent/.test(i.text) && /3 days late/.test(i.text))).toBe(true);
    expect(text.length).toBeLessThanOrEqual(8);
  });
  it('names weekdays in full', () => {
    const days = n => Array.from({ length: n }, (_, i) => `2026-10-${String(4 + i).padStart(2, '0')}`);
    const miss = d => days(7).filter(x => !d.includes(x));
    const habits = [habit('run', miss(['2026-10-06', '2026-10-07'])), habit('read', days(7))];   // run skips Tue + Wed
    const text = buildAnalysis({ habits }, week()).insights.map(i => i.text).join('\n');
    expect(text).toMatch(/most consistent on Sundays \(100%\) and least on Tuesdays \(50%\)/);
  });
});

describe('formatting', () => {
  it('formats hours and minutes', () => {
    expect(fmtHour(0)).toBe('12 AM');
    expect(fmtHour(12)).toBe('12 PM');
    expect(fmtHour(15)).toBe('3 PM');
    expect(fmtMinutes(0)).toBe('0m');
    expect(fmtMinutes(45)).toBe('45m');
    expect(fmtMinutes(125)).toBe('2h 5m');
    expect(fmtMinutes(120)).toBe('2h');
  });
});
