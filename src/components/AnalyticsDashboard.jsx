import { useState, useMemo } from 'react';
import DateInput from './DateInput';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  Tooltip,
  Legend,
  Filler,
  ArcElement
} from 'chart.js';
import { Doughnut, Line, Bar } from 'react-chartjs-2';
import { HABIT_CATS } from '../habitsStore';
import {
  rangeBounds, habitRangeStats, perHabitConsistency, habitTrends, streakSeries,
  tasksDoneInRange, focusInRange, journalCountInRange, delta, POMODORO_MIN,
  dailyScoreH, scoreHistoryH, categoryCompletions, globalHabitHeatmap,
} from '../trackers/reportsAnalytics';
import { todayStr as getTodayStr } from '../utils/date';

// Self-contained chart.js registration (register() is idempotent). ArcElement →
// Doughnuts; scales/Point/Line/Filler → the score Line; BarElement → the
// consistency / focus Bars.
ChartJS.register(
  CategoryScale, LinearScale, PointElement, LineElement, BarElement,
  ArcElement, Tooltip, Legend, Filler,
);

// Reports = read-only cross-tab analytics over the real tabs: Habits, Tasks,
// Focus and Journal. No trackers.
export default function AnalyticsDashboard({ habits = [], tasks = [], pomodoroLog = [] }) {
  const todayStr = getTodayStr();

  // ── Time range + same-length previous-period comparison ──
  const [rangeMode, setRangeMode] = useState('week'); // 'week' | 'month' | 'custom'
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const { start, end, prevStart, prevEnd, label } = rangeBounds(rangeMode, customStart, customEnd);

  const R = useMemo(() => {
    const habitCur  = habitRangeStats(habits, start, end);
    const habitPrev = habitRangeStats(habits, prevStart, prevEnd);
    const tasksCur  = tasksDoneInRange(tasks, start, end);
    const tasksPrev = tasksDoneInRange(tasks, prevStart, prevEnd);
    const focusCur  = focusInRange(pomodoroLog, start, end);
    const focusPrev = focusInRange(pomodoroLog, prevStart, prevEnd);
    const journalCur  = journalCountInRange(start, end);
    const journalPrev = journalCountInRange(prevStart, prevEnd);
    const consistency = perHabitConsistency(habits, start, end);
    const trends = habitTrends(habits, start, end, prevStart, prevEnd);
    const topHabit = consistency[0] ? habits.find(h => h.id === consistency[0].id) : null;
    const streaks = topHabit ? streakSeries(topHabit, start, end) : [];
    return { habitCur, habitPrev, tasksCur, tasksPrev, focusCur, focusPrev, journalCur, journalPrev, consistency, trends, topHabit, streaks };
  }, [habits, tasks, pomodoroLog, start, end, prevStart, prevEnd]);

  // ── Productivity score (habits + tasks + focus) ──
  const currentScore  = dailyScoreH(habits, tasks, pomodoroLog, todayStr);
  const scoreHistory  = useMemo(() => scoreHistoryH(habits, tasks, pomodoroLog, 30), [habits, tasks, pomodoroLog]);
  const yesterdayScore = scoreHistory.length > 1 ? scoreHistory[scoreHistory.length - 2].score : 0;
  const weekAvg = Math.round(scoreHistory.slice(-7).reduce((s, h) => s + h.score, 0) / Math.max(1, Math.min(scoreHistory.length, 7)));
  const bestScore = scoreHistory.length ? Math.max(...scoreHistory.map(h => h.score)) : 0;

  const scoreDoughnutData = {
    datasets: [{ data: [currentScore, 100 - currentScore], backgroundColor: ['var(--accent)', 'var(--ring-track)'], borderWidth: 0, cutout: '75%', circumference: 270, rotation: 225 }],
  };
  const scores = scoreHistory.map(h => h.score);
  const dataMin = scores.length ? Math.min(...scores) : 0;
  const dataMax = scores.length ? Math.max(...scores) : 100;
  const yMin = Math.max(0, Math.floor(dataMin - 10));
  const yMax = Math.ceil(dataMax + 10);
  const yStep = (yMax - yMin) <= 20 ? 5 : (yMax - yMin) <= 50 ? 10 : 25;
  const scoreLabels = scoreHistory.map(h => new Date(h.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
  const scoreLineData = {
    labels: scoreLabels,
    datasets: [{ label: 'Productivity Score', data: scores, borderColor: 'var(--color-green)', backgroundColor: 'var(--color-green-bg)', fill: true, tension: 0.3, pointRadius: 3, pointHoverRadius: 5 }],
  };
  const scoreLineOpts = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'var(--bg-elevated)' } },
    scales: {
      x: { ticks: { color: 'var(--text-muted)', maxTicksLimit: 7, font: { size: 11 } }, grid: { color: 'var(--border)' }, border: { color: 'var(--border)' } },
      y: { min: yMin, max: yMax, ticks: { color: 'var(--text-muted)', stepSize: yStep, font: { size: 11 } }, grid: { color: 'var(--border)' }, border: { color: 'var(--border)' } },
    },
  };

  // ── Category doughnut (habit completions this range) ──
  const catBreakdown = categoryCompletions(habits, start, end);
  const catLabels = Object.keys(catBreakdown).filter(k => catBreakdown[k] > 0);
  const catData = {
    labels: catLabels.map(k => HABIT_CATS[k]?.label || k),
    datasets: [{ data: catLabels.map(k => catBreakdown[k]), backgroundColor: catLabels.map(k => HABIT_CATS[k]?.color || '#888'), borderWidth: 0 }],
  };

  // ── Consistency heatmap (12 weeks, all habits) ──
  const heatCells = useMemo(() => globalHabitHeatmap(habits, 12), [habits]);

  // ── Chart configs (period) ──
  const fmtShort = (ds) => new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const axisColor = 'var(--text-muted)';
  const gridColor = 'var(--border)';
  const barBase = { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { backgroundColor: 'var(--bg-elevated)' } } };
  const focusHoursCur = Math.round((R.focusCur.minutes / 60) * 10) / 10;

  const dHabit   = delta(R.habitCur.rate, R.habitPrev.rate);
  const dTasks   = delta(R.tasksCur, R.tasksPrev);
  const dFocus   = delta(R.focusCur.sessions, R.focusPrev.sessions);
  const dJournal = delta(R.journalCur, R.journalPrev);

  const consistencyData = {
    labels: R.consistency.map(h => h.name),
    datasets: [{ data: R.consistency.map(h => h.rate), backgroundColor: R.consistency.map(h => h.color), borderRadius: 4, barThickness: 15 }],
  };
  const consistencyOpts = {
    ...barBase, indexAxis: 'y',
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'var(--bg-elevated)', callbacks: { label: c => `${c.raw}% consistent` } } },
    scales: {
      x: { min: 0, max: 100, ticks: { color: axisColor, callback: v => v + '%', font: { size: 10 } }, grid: { color: gridColor } },
      y: { ticks: { color: 'var(--text-secondary)', font: { size: 11 } }, grid: { display: false } },
    },
  };

  const focusData = {
    labels: R.focusCur.perDay.map(d => fmtShort(d.date)),
    datasets: [{ data: R.focusCur.perDay.map(d => d.count), backgroundColor: 'var(--accent)', borderRadius: 3 }],
  };
  const focusOpts = {
    ...barBase,
    plugins: { legend: { display: false }, tooltip: { backgroundColor: 'var(--bg-elevated)', callbacks: { label: c => `${c.raw} session${c.raw === 1 ? '' : 's'} · ${c.raw * POMODORO_MIN}m` } } },
    scales: {
      x: { ticks: { color: axisColor, maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { color: axisColor, precision: 0, font: { size: 10 } }, grid: { color: gridColor } },
    },
  };

  const streakColor = R.topHabit?.color || 'var(--accent)';
  const streakData = {
    labels: R.streaks.map(s => fmtShort(s.date)),
    datasets: [{ data: R.streaks.map(s => s.streak), borderColor: streakColor, backgroundColor: (R.topHabit?.color || '#7869fc') + '22', fill: true, tension: 0.3, pointRadius: 0 }],
  };
  const streakOpts = {
    ...barBase,
    scales: {
      x: { ticks: { color: axisColor, maxTicksLimit: 6, font: { size: 10 } }, grid: { display: false } },
      y: { beginAtZero: true, ticks: { color: axisColor, precision: 0, font: { size: 10 } }, grid: { color: gridColor } },
    },
  };

  // ── Weekly reviews (Journal → Weekly Review modal) ──
  const getWeeklyReviews = () => { try { return JSON.parse(localStorage.getItem('nook-weekly-reviews') || '[]'); } catch { return []; } };
  const reviews = getWeeklyReviews().slice(0, 8);

  const printDashboard = () => window.print();
  const exportJSON = () => {
    const data = { habits, tasks, pomodoroLog, reviews: getWeeklyReviews(), exportDate: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `nook-analytics-${todayStr}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const sectionTitle = { fontSize: '14px', textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-secondary)', margin: 0 };

  return (
    <div className="analytics-dashboard" id="export-dashboard-area" style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 24 }}>

      {/* ══ Period overview + same-length comparison ══ */}
      <div className="analytics-section">
        <div className="ra-period-head">
          <h2 className="analytics-section-title" style={sectionTitle}>Period Overview</h2>
          <div className="ra-range-ctl no-print">
            <div className="ra-seg" role="group" aria-label="Time range">
              {[['week', 'This Week'], ['month', 'This Month'], ['custom', 'Custom']].map(([m, l]) => (
                <button key={m} className={rangeMode === m ? 'ra-seg-on' : ''} onClick={() => setRangeMode(m)} aria-pressed={rangeMode === m}>{l}</button>
              ))}
            </div>
            {rangeMode === 'custom' && (
              <div className="ra-custom">
                <DateInput value={customStart} max={customEnd || undefined} onChange={e => setCustomStart(e.target.value)} aria-label="Start date" />
                <span>→</span>
                <DateInput value={customEnd} min={customStart || undefined} onChange={e => setCustomEnd(e.target.value)} aria-label="End date" />
              </div>
            )}
            <div className="header-actions no-print" style={{ display: 'flex', gap: 8 }}>
              <button className="ra-icon-btn" onClick={printDashboard} title="Export PDF" aria-label="Export PDF">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/></svg>
              </button>
              <button className="ra-icon-btn" onClick={exportJSON} title="Export JSON" aria-label="Export JSON">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><polyline points="7 11 12 16 17 11"/><line x1="12" y1="4" x2="12" y2="16"/></svg>
              </button>
            </div>
          </div>
        </div>
        <div className="ra-range-caption">{fmtShort(start)} – {fmtShort(end)} vs previous {label}</div>
        <div className="ra-kpis">
          <KpiTile label="Habit completion" value={`${R.habitCur.rate}%`} sub={`${R.habitCur.done}/${R.habitCur.due} scheduled`} d={dHabit} unit="pt" periodLabel={label} />
          <KpiTile label="Tasks completed"  value={R.tasksCur} d={dTasks} periodLabel={label} />
          <KpiTile label="Focus time"       value={`${focusHoursCur}h`} sub={`${R.focusCur.sessions} session${R.focusCur.sessions === 1 ? '' : 's'}`} d={dFocus} unit="" periodLabel={label} />
          <KpiTile label="Journal entries"  value={R.journalCur} d={dJournal} periodLabel={label} />
        </div>
      </div>

      {/* ══ Habit performance ══ */}
      {habits.length > 0 ? (
        <>
          <div className="ra-divider" />
          <div className="analytics-section">
            <h2 className="analytics-section-title" style={{ ...sectionTitle, marginBottom: 16 }}>Habit Performance</h2>
            <div className="ra-grid2">
              <div className="ra-card">
                <h3 className="ra-card-title">Consistency — last {label}</h3>
                {R.consistency.length ? (
                  <div style={{ height: Math.max(120, R.consistency.length * 28) }}><Bar data={consistencyData} options={consistencyOpts} /></div>
                ) : <p className="ra-empty">No scheduled habits in this range.</p>}
              </div>
              <div className="ra-card">
                <h3 className="ra-card-title">Trending vs last {label}</h3>
                <TrendList trends={R.trends} label={label} />
              </div>
            </div>
            {R.streaks.length > 1 && R.topHabit && (
              <div className="ra-card" style={{ marginTop: 16 }}>
                <h3 className="ra-card-title">Streak history — {R.topHabit.name}</h3>
                <div style={{ height: 170 }}><Line data={streakData} options={streakOpts} /></div>
              </div>
            )}
          </div>
        </>
      ) : (
        <div className="ra-card"><p className="ra-empty">No habits yet — add some in the Habits tab to see performance analytics here.</p></div>
      )}

      {/* ══ Focus & time ══ */}
      <div className="ra-divider" />
      <div className="analytics-section">
        <h2 className="analytics-section-title" style={{ ...sectionTitle, marginBottom: 16 }}>Focus &amp; Time</h2>
        <div className="ra-card">
          <div className="ra-focus-head">
            <div>
              <span className="ra-focus-big">{focusHoursCur}h</span>
              <span className="ra-focus-sub">{R.focusCur.sessions} session{R.focusCur.sessions === 1 ? '' : 's'} · last {label}</span>
            </div>
            <DeltaBadge d={dFocus} unit="" periodLabel={label} />
          </div>
          <div style={{ height: 150 }}><Bar data={focusData} options={focusOpts} /></div>
        </div>
      </div>

      {/* ══ Daily productivity score ══ */}
      <div className="ra-divider" />
      <div className="analytics-section">
        <h2 className="analytics-section-title" style={{ ...sectionTitle, marginBottom: 24 }}>Daily Productivity Score</h2>
        <div className="dashboard-row" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          <div className="ra-card" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            <div style={{ position: 'relative', height: 200, width: '100%', display: 'flex', justifyContent: 'center' }}>
              <Doughnut data={scoreDoughnutData} options={{ maintainAspectRatio: false, plugins: { tooltip: { enabled: false } } }} />
              <div style={{ position: 'absolute', top: '55%', left: '50%', transform: 'translate(-50%, -50%)', textAlign: 'center' }}>
                <span style={{ fontSize: '3rem', fontWeight: 700, color: 'var(--text-primary)' }}>{currentScore}</span>
                <span style={{ display: 'block', fontSize: '0.9rem', color: 'var(--text-secondary)' }}>Today's Score</span>
              </div>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-around', width: '100%', marginTop: 24, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>{yesterdayScore}</div><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Yesterday</div></div>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>{weekAvg}</div><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>7d Avg</div></div>
              <div style={{ textAlign: 'center' }}><div style={{ fontSize: '1.2rem', fontWeight: 600, color: 'var(--text-primary)' }}>{bestScore}</div><div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Best</div></div>
            </div>
          </div>
          <div className="ra-card">
            <h3 className="ra-card-title">Completions by category — last {label}</h3>
            {catLabels.length ? (
              <div style={{ height: 240, position: 'relative' }}>
                <Doughnut data={catData} options={{ maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: 'var(--text-secondary)', font: { size: 13 } } } } }} />
              </div>
            ) : <p className="ra-empty">No habit completions in this range yet.</p>}
          </div>
        </div>
        <div className="ra-card" style={{ height: 220, marginTop: 24, padding: '16px 16px 8px 8px' }}>
          <Line data={scoreLineData} options={scoreLineOpts} />
        </div>
      </div>

      {/* ══ Consistency heatmap (12 weeks) ══ */}
      <div className="ra-divider" />
      <div className="analytics-section">
        <h2 className="analytics-section-title" style={{ ...sectionTitle, marginBottom: 16 }}>Consistency Heatmap (Last 12 Weeks)</h2>
        <div className="ra-card">
          <ConsistencyHeatmap cells={heatCells} />
        </div>
      </div>

      {/* ══ Weekly review journal ══ */}
      <div className="ra-divider" />
      <div className="analytics-section">
        <h2 className="analytics-section-title" style={{ ...sectionTitle, marginBottom: 16 }}>Weekly Review Journal</h2>
        {reviews.length ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {reviews.map(r => (
              <div key={r.date} className="ra-card">
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
                  <strong style={{ color: 'var(--text-primary)', fontSize: '1rem' }}>{new Date(r.date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</strong>
                  <span style={{ color: 'var(--color-amber)', fontSize: '1.1rem', letterSpacing: '0.1em' }}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
                </div>
                <div style={{ fontSize: '0.9rem', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  <p style={{ marginBottom: 8 }}><strong>Went well:</strong> {r.wentWell}</p>
                  <p style={{ marginBottom: 8 }}><strong>Hard:</strong> {r.wasHard}</p>
                  <p><strong>Next Focus:</strong> {r.nextFocus}</p>
                </div>
              </div>
            ))}
          </div>
        ) : <p className="ra-empty">No weekly reviews completed yet.</p>}
      </div>

    </div>
  );
}

// ─── Consistency heatmap (flat 84-cell grid, Sunday-aligned) ───────
function ConsistencyHeatmap({ cells }) {
  if (!cells.length) return <p className="ra-empty">No data to display.</p>;
  const WEEKS = 12, DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], CELL_H = 16, GAP = 3;
  // Theme-aware: empty/unscheduled cells use the surface token so they don't
  // render as dark squares on a light card; completions are graduated-opacity
  // purple, which reads on both light and dark backgrounds.
  const color = (c) => {
    if (!c || c.isFuture || !c.scheduled) return 'var(--bg-elevated)';
    const r = c.rate ?? 0;
    if (r <= 0)    return 'var(--bg-elevated)';
    if (r <= 0.25) return 'rgba(168, 85, 247, 0.32)';
    if (r <= 0.50) return 'rgba(168, 85, 247, 0.55)';
    if (r <= 0.75) return 'rgba(168, 85, 247, 0.78)';
    return 'var(--color-purple)';
  };
  const fmtWk = (ds) => ds ? new Date(ds + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
  const gridCols = `repeat(${WEEKS}, 1fr)`;
  return (
    <div style={{ width: '100%' }}>
      <div style={{ display: 'flex' }}>
        <div style={{ width: 32, flexShrink: 0, paddingTop: 22, marginRight: 8 }}>
          {DAY_LABELS.map(dl => <div key={dl} style={{ height: CELL_H, marginBottom: GAP, fontSize: 10, color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>{dl}</div>)}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: gridCols, gap: GAP, marginBottom: 4, height: 18 }}>
            {Array.from({ length: WEEKS }, (_, w) => (
              <div key={w} style={{ fontSize: 10, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>{w % 2 === 0 ? fmtWk(cells[w * 7]?.date) : ''}</div>
            ))}
          </div>
          {Array.from({ length: 7 }, (_, day) => (
            <div key={day} style={{ display: 'grid', gridTemplateColumns: gridCols, gap: GAP, marginBottom: GAP }}>
              {Array.from({ length: WEEKS }, (_, week) => {
                const c = cells[week * 7 + day];
                const pct = c?.scheduled > 0 ? Math.round((c.rate ?? 0) * 100) : null;
                return <div key={week} title={c ? `${c.date}${pct !== null ? ` — ${pct}%` : ''}` : ''} style={{ height: CELL_H, borderRadius: 3, backgroundColor: color(c) }} />;
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Comparison helper components ──────────────────────────────────
function DeltaBadge({ d, unit = '', periodLabel }) {
  const cls   = d.dir === 'up' ? 'ra-up' : d.dir === 'down' ? 'ra-down' : 'ra-flat';
  const arrow = d.dir === 'up' ? '↑' : d.dir === 'down' ? '↓' : '→';
  const body  = d.dir === 'flat' ? 'no change' : `${arrow} ${Math.abs(d.diff)}${unit}`;
  return <span className={`ra-delta ${cls}`}>{body} <span className="ra-delta-vs">vs last {periodLabel}</span></span>;
}

function KpiTile({ label, value, sub, d, unit = '', periodLabel }) {
  return (
    <div className="ra-kpi">
      <div className="ra-kpi-val">{value}</div>
      <div className="ra-kpi-lbl">{label}</div>
      {sub && <div className="ra-kpi-sub">{sub}</div>}
      <DeltaBadge d={d} unit={unit} periodLabel={periodLabel} />
    </div>
  );
}

function TrendList({ trends, label }) {
  const up   = trends.filter(t => t.delta > 0).slice(0, 4);
  const down = trends.filter(t => t.delta < 0).slice(-4).reverse();
  if (!up.length && !down.length) return <p className="ra-empty">No change vs last {label} yet.</p>;
  const Row = (t, dir) => (
    <div key={t.id} className="ra-trend-row">
      <span className="ra-dot" style={{ background: t.color }} />
      <span className="ra-trend-name">{t.name}</span>
      <span className={`ra-trend-delta ${dir === 'up' ? 'ra-up' : 'ra-down'}`}>{dir === 'up' ? '↑' : '↓'} {Math.abs(t.delta)}pt</span>
    </div>
  );
  return <div className="ra-trend-list">{up.map(t => Row(t, 'up'))}{down.map(t => Row(t, 'down'))}</div>;
}
