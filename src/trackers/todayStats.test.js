import { describe, it, expect } from 'vitest';
import { buildToday, localDayOf, addDays, lastDays, countEventsOn } from './todayStats';

// Today is Sunday 2026-10-11 — passed in, so no clock is involved. Timestamps are built from
// LOCAL components, so their local day is the same wherever the tests run.
const TODAY = '2026-10-11';
const at = (ds, h = 12) => { const [y, m, d] = ds.split('-').map(Number); return new Date(y, m - 1, d, h, 0, 0).toISOString(); };
const task = (id, o = {}) => ({ id, name: id, completed: false, category: 'work', ...o });
const habit = (id, completions = [], o = {}) => ({ id, name: id, frequency: 'daily', category: 'health', completions, ...o });

describe('date helpers', () => {
  it('localDayOf reads ISO strings in the local day, and tolerates a legacy {timestamp}', () => {
    expect(localDayOf(at('2026-10-11', 1))).toBe('2026-10-11');
    expect(localDayOf(at('2026-10-11', 23))).toBe('2026-10-11');
    expect(localDayOf({ timestamp: at('2026-10-09') })).toBe('2026-10-09');
    for (const bad of [undefined, null, '', 'nope', 7, {}]) expect(localDayOf(bad)).toBe('');
  });
  it('addDays and lastDays cross month and year boundaries', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(lastDays(7, TODAY)).toEqual(['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11']);
    expect(lastDays(3, '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01']);
  });
});

describe('focus (the log is plain ISO strings)', () => {
  const log = [at('2026-10-11', 8), at('2026-10-11', 9), at('2026-10-11', 22), at('2026-10-10', 10), at('2026-10-10', 11), at('2026-09-01'), 'junk', null, 5];
  const f = buildToday({ pomodoroLog: log }, TODAY).focus;

  it('counts today\'s sessions and turns them into minutes (25 each)', () => {
    expect(f.sessionsToday).toBe(3);
    expect(f.minutesToday).toBe(75);     // used to read "3h 45m" — the sum of every task's estimate
  });
  it('counts yesterday separately and ignores junk and older days', () => {
    expect(f.sessionsYesterday).toBe(2);
    expect(f.minutesYesterday).toBe(50);
  });
  it('is zero — not a made-up fallback — when nothing was logged', () => {
    const none = buildToday({ tasks: [task('a', { timeEstimate: 100 })], pomodoroLog: [] }, TODAY).focus;
    expect(none).toEqual({ sessionsToday: 0, minutesToday: 0, sessionsYesterday: 0, minutesYesterday: 0 });
  });
});

describe('tasks due', () => {
  const tasks = [
    task('overdue-old', { dueDate: '2026-10-05' }),
    task('overdue-new', { dueDate: '2026-10-09', priority: 'low' }),
    task('today-high', { dueDate: TODAY, priority: 'high' }),
    task('today-none', { dueDate: TODAY }),
    task('tomorrow', { dueDate: '2026-10-12' }),
    task('day6', { dueDate: '2026-10-17' }),
    task('day7', { dueDate: '2026-10-18' }),
    task('done-today', { dueDate: TODAY, completed: true, completedAt: at(TODAY) }),
    task('no-date'),
    task('bad-date', { dueDate: '2026-1-5' }),
  ];
  const t = buildToday({ tasks }, TODAY).tasks;

  it('lists overdue then due-today, oldest first, then by priority', () => {
    expect(t.due.map(x => x.id)).toEqual(['overdue-old', 'overdue-new', 'today-high', 'today-none']);
    expect(t.overdue).toBe(2);
  });
  it('the next-7-days list adds the following six days, not the seventh', () => {
    expect(t.dueWeek.map(x => x.id)).toEqual(['overdue-old', 'overdue-new', 'today-high', 'today-none', 'tomorrow', 'day6']);
  });
  it('leaves finished tasks out and counts undated ones separately — a malformed date is "no date"', () => {
    expect(t.due.some(x => x.id === 'done-today')).toBe(false);
    expect(t.undated).toBe(2);   // no-date, bad-date
    expect(t.pending).toBe(9);
  });
  it('counts only tasks completed TODAY as done today — one finished 40 days ago does not count', () => {
    const r = buildToday({ tasks: [task('old', { completed: true, completedAt: at('2026-09-01') }), task('now', { completed: true, completedAt: at(TODAY, 7) })] }, TODAY);
    expect(r.tasks.doneToday).toBe(1);
  });
});

describe('the Today donut', () => {
  it('is done-today over what was planned today (tasks done + still due + habits scheduled)', () => {
    const r = buildToday({
      tasks: [task('a', { dueDate: TODAY, completed: true, completedAt: at(TODAY) }), task('b', { dueDate: TODAY }), task('c', { dueDate: '2026-10-01' })],
      habits: [habit('h1', [TODAY]), habit('h2', [])],
    }, TODAY).donut;
    expect(r).toMatchObject({ tasksDone: 1, tasksPlanned: 3, habitsDone: 1, habitsPlanned: 2, planned: 5, done: 2, pct: 40 });
  });
  it('counts a task finished today even if it was never given a due date', () => {
    const r = buildToday({ tasks: [task('a', { completed: true, completedAt: at(TODAY) })] }, TODAY).donut;
    expect(r).toMatchObject({ planned: 1, done: 1, pct: 100 });
  });
  it('is 0% (not NaN) when nothing is planned', () => {
    expect(buildToday({}, TODAY).donut).toMatchObject({ planned: 0, done: 0, pct: 0 });
  });
  it('does not count tasks completed on earlier days (the old "This Week" was all-time)', () => {
    const r = buildToday({ tasks: [task('x', { completed: true, completedAt: at('2026-09-01') }), task('y')] }, TODAY).donut;
    expect(r.done).toBe(0);
    expect(r.pct).toBe(0);
  });
});

describe('habits today', () => {
  it('lists only habits scheduled today, not-yet-done first', () => {
    const habits = [habit('done', [TODAY]), habit('todo'), habit('weekday', [], { frequency: 'weekdays' }), habit('weekend', [], { frequency: 'weekends' })];
    const h = buildToday({ habits }, TODAY).habits;   // 2026-10-11 is a Sunday: weekdays-only is off
    expect(h.rows.map(r => [r.habit.id, r.done])).toEqual([['todo', false], ['weekend', false], ['done', true]]);
    expect(h).toMatchObject({ scheduled: 3, done: 1 });
  });
});

describe('the last 7 days', () => {
  const tasks = [
    task('a', { completed: true, completedAt: at('2026-10-11', 9) }), task('b', { completed: true, completedAt: at('2026-10-11', 15) }),
    task('c', { completed: true, completedAt: at('2026-10-08') }), task('old', { completed: true, completedAt: at('2026-10-04') }),
  ];
  const habits = [habit('h1', ['2026-10-11', '2026-10-08', '2026-10-05']), habit('h2', ['2026-10-08'])];
  const w = buildToday({ tasks, habits }, TODAY).week;

  it('has seven days ending today, with today marked', () => {
    expect(w.map(d => d.date)[0]).toBe('2026-10-05');
    expect(w.at(-1)).toMatchObject({ date: TODAY, isToday: true });
    expect(w.filter(d => d.isToday)).toHaveLength(1);
  });
  it('counts tasks and habits completed on each day, and nothing from before the window', () => {
    expect(w.find(d => d.date === TODAY)).toMatchObject({ tasks: 2, habits: 1 });
    expect(w.find(d => d.date === '2026-10-08')).toMatchObject({ tasks: 1, habits: 2 });
    expect(w.find(d => d.date === '2026-10-05')).toMatchObject({ tasks: 0, habits: 1 });
    expect(w.reduce((n, d) => n + d.tasks, 0)).toBe(3);   // 'old' (10-04) is outside the window
  });
});

describe('tasks completed this week, by category', () => {
  const tasks = [
    task('a', { category: 'work', completed: true, completedAt: at(TODAY) }), task('b', { category: 'work', completed: true, completedAt: at('2026-10-08') }),
    task('c', { category: 'fitness', completed: true, completedAt: at('2026-10-09') }), task('d', { category: 'errands', completed: true, completedAt: at(TODAY) }),
    task('e', { completed: true, completedAt: at(TODAY), category: undefined }), task('old', { category: 'work', completed: true, completedAt: at('2026-10-01') }),
    task('open', { category: 'work' }),
  ];
  const c = buildToday({ tasks, customCategories: { errands: { label: 'Errands', color: '#123456' } } }, TODAY).byCategory;

  it('counts only tasks completed in the window, most first', () => {
    expect(c.map(x => [x.key, x.count])).toEqual([['work', 2], ['errands', 1], ['fitness', 1], ['other', 1]]);
  });
  it('uses the Tasks tab\'s labels and colours, including custom lists', () => {
    expect(c.find(x => x.key === 'work')).toMatchObject({ label: 'Work', color: '#3b82f6' });
    expect(c.find(x => x.key === 'errands')).toMatchObject({ label: 'Errands', color: '#123456' });
    expect(c.find(x => x.key === 'other').label).toBe('Other');
  });
});

describe('robustness', () => {
  it('copes with empty and malformed input', () => {
    const r = buildToday({ tasks: [null, 'x', { id: 1 }], habits: [undefined, 7], pomodoroLog: 'nope', customCategories: 'bad' }, TODAY);
    expect(r.week).toHaveLength(7);
    expect(r.donut.pct).toBe(0);
    expect(buildToday({}, TODAY).byCategory).toEqual([]);
    expect(buildToday(undefined, TODAY).week).toHaveLength(7);   // no argument at all
  });
  it('counts a day\'s custom calendar events', () => {
    expect(countEventsOn([{ date: TODAY }, { date: TODAY }, { date: '2026-10-12' }, null, 'x'], TODAY)).toBe(2);
    expect(countEventsOn(undefined, TODAY)).toBe(0);
  });
});
