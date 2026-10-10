// Today dashboard charts — plain CSS / SVG, no Chart.js. DailyGoalsView is on the landing
// page's bundle, and CSS colours follow the theme with no re-render (a canvas can't read
// `var(--x)`). Each takes the matching slice of buildToday() (trackers/todayStats.js).

const Empty = ({ children }) => <p className="tc-empty">{children}</p>;

const dayLabel = ds => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

// A ring: tasks done (accent) + habits done (green) out of everything planned for today.
export function TodayDonut({ donut }) {
  const { planned, done, tasksDone, tasksPlanned, habitsDone, habitsPlanned, pct } = donut;
  if (!planned) return <Empty>Nothing planned for today yet — add a task or a habit.</Empty>;
  const a = (tasksDone / planned) * 100, b = a + (habitsDone / planned) * 100;
  return (
    <div className="tc-donut-wrap">
      <div className="tc-donut" role="img" aria-label={`${done} of ${planned} done today (${pct}%)`}
        style={{ background: `conic-gradient(var(--accent) 0 ${a}%, var(--color-green) ${a}% ${b}%, var(--ring-track) ${b}% 100%)` }}>
        <div className="tc-donut-hole">
          <span className="tc-donut-pct">{pct}%</span>
          <span className="tc-donut-sub">{done} of {planned} done</span>
        </div>
      </div>
      <ul className="tc-legend">
        <li><span className="tc-dot" style={{ background: 'var(--accent)' }} /><span className="tc-name">Tasks</span><b>{tasksDone}/{tasksPlanned}</b></li>
        <li><span className="tc-dot" style={{ background: 'var(--color-green)' }} /><span className="tc-name">Habits</span><b>{habitsDone}/{habitsPlanned}</b></li>
        {planned > done && <li><span className="tc-dot" style={{ background: 'var(--ring-track)', boxShadow: 'inset 0 0 0 1px var(--border)' }} /><span className="tc-name">Still to do</span><b>{planned - done}</b></li>}
      </ul>
    </div>
  );
}

// Seven stacked columns: habits (green) under tasks (accent) completed each day.
export function WeekBars({ week }) {
  const total = d => d.tasks + d.habits;
  const max = Math.max(...week.map(total));
  if (!max) return <Empty>No tasks or habits completed in the last 7 days yet.</Empty>;
  const summary = week.map(d => `${dayLabel(d.date)}: ${plural(d.tasks, 'task')}, ${plural(d.habits, 'habit')}`).join('; ');
  return (
    <div>
      <div className="tc-bars" role="img" aria-label={`Tasks and habits completed per day. ${summary}`}>
        {week.map(d => (
          <div key={d.date} className={`tc-bar-col${d.isToday ? ' is-today' : ''}`} title={`${dayLabel(d.date)} — ${plural(d.tasks, 'task')}, ${plural(d.habits, 'habit')}`}>
            <span className="tc-bar-total">{total(d) || ''}</span>
            <div className="tc-bar-track">
              <div className="tc-bar-stack" style={{ height: `${(total(d) / max) * 100}%`, minHeight: total(d) ? 6 : 0 }}>
                <div className="tc-seg" style={{ flex: d.tasks, background: 'var(--accent)' }} />
                <div className="tc-seg" style={{ flex: d.habits, background: 'var(--color-green)' }} />
              </div>
            </div>
            <span className="tc-bar-day">{new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1)}</span>
            <span className="tc-bar-num">{Number(d.date.slice(8))}</span>
          </div>
        ))}
      </div>
      <ul className="tc-legend tc-legend-row">
        <li><span className="tc-dot" style={{ background: 'var(--accent)' }} />Tasks</li>
        <li><span className="tc-dot" style={{ background: 'var(--color-green)' }} />Habits</li>
      </ul>
    </div>
  );
}

// A pie of the tasks completed this week, by category (top five, the rest rolled into "More").
export function CategoryPie({ items }) {
  if (!items.length) return <Empty>No tasks completed in the last 7 days yet.</Empty>;
  const shown = items.slice(0, 5), rest = items.slice(5);
  const slices = rest.length ? [...shown, { key: '__more', label: 'More', color: 'var(--text-muted)', count: rest.reduce((n, i) => n + i.count, 0) }] : shown;
  const total = slices.reduce((n, i) => n + i.count, 0);
  let acc = 0;
  const stops = slices.map(i => { const from = acc; acc += (i.count / total) * 100; return `${i.color} ${from}% ${acc}%`; }).join(', ');
  return (
    <div className="tc-donut-wrap">
      <div className="tc-pie" role="img" aria-label={`Tasks completed by category: ${slices.map(i => `${i.label} ${i.count}`).join(', ')}`} style={{ background: `conic-gradient(${stops})` }}>
        <div className="tc-pie-hole">
          <span className="tc-donut-pct" style={{ fontSize: '1.45rem' }}>{total}</span>
          <span className="tc-donut-sub">completed</span>
        </div>
      </div>
      <ul className="tc-legend">
        {slices.map(i => (
          <li key={i.key}><span className="tc-dot" style={{ background: i.color }} /><span className="tc-name">{i.label}</span><b>{i.count}</b></li>
        ))}
      </ul>
    </div>
  );
}
