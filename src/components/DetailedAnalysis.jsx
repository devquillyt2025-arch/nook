import { useEffect, useMemo, useState } from 'react';
import {
  Chart as ChartJS, CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler,
} from 'chart.js';
import { Bar, Line } from 'react-chartjs-2';
import ReportRangeControl from './ReportRangeControl';
import { KpiTile } from './AnalyticsDashboard';
import { rangeBounds, delta } from '../trackers/reportsAnalytics';
import { buildAnalysis, loadAnalysisSources, fmtHour, fmtMinutes, WEEKDAYS } from '../trackers/detailedAnalysis';
import { useSyncApplied } from '../utils/useSyncApplied';
import { todayStr } from '../utils/date';

// Self-contained chart.js registration (register() is idempotent) — see AnalyticsDashboard.
ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, BarElement, Tooltip, Legend, Filler);

// Reports → Detailed Analysis: a read-only, section-by-section breakdown of every
// tab over the selected range (maths in trackers/detailedAnalysis.js). Everything
// is derived; nothing here writes to storage.

// Canvas can't resolve `var(--x)`, so chart colours are read from the live theme.
function themeColors() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
  return {
    accent: v('--accent', '#7869fc'), green: v('--color-green', '#34d399'), blue: v('--color-blue', '#60a5fa'),
    amber: v('--color-amber', '#fbbf24'), purple: v('--color-purple', '#c084fc'),
    text: v('--text-primary', '#f5f5f5'), text2: v('--text-secondary', '#a1a1aa'), muted: v('--text-muted', '#71717a'),
    grid: v('--border', '#27272a'), tip: v('--bg-elevated', '#1f1f23'),
  };
}

// ReportsView is memoised and App only flips `data-theme` on the root, so nothing would re-render
// the charts when the theme changes (the sidebar toggle works from any tab, Reports included) and
// their axis / grid / tooltip colours would stay on the old theme. Re-render on that attribute.
function useThemeVersion() {
  const [v, setV] = useState(0);
  useEffect(() => {
    const mo = new MutationObserver(() => setV(n => n + 1));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  return v;
}

const fmtShort = ds => (ds ? new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const fmtDay   = ds => (ds ? new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) : '');
const pctText  = v => (v == null ? '—' : `${v}%`);
const plural   = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
const cmp      = (cur, prev) => (cur == null || prev == null ? null : delta(cur, prev));

const NAV = [['tasks', 'Tasks'], ['habits', 'Habits'], ['focus', 'Focus'], ['journal', 'Journal'], ['library', 'Notes & links'],
  ['calendar', 'Calendar'], ['activity', 'Activity'], ['score', 'Score'], ['reviews', 'Reviews'], ['alltime', 'All time']];

export default function DetailedAnalysis({ habits = [], tasks = [], pomodoroLog = [], range, onRangeChange }) {
  // Everything outside habits / tasks / focus is read straight from localStorage, so
  // re-read when another device's change lands (see useSyncApplied in utils/).
  const [tick, setTick] = useState(0);
  useSyncApplied(['notes', 'links', 'countdowns', 'goals', 'calendar_events', 'journal', 'journal_icons', 'activity_log', 'weekly_reviews', 'custom_categories'],
    () => setTick(t => t + 1));
  const sources = useMemo(() => loadAnalysisSources(), [tick]);

  const r = rangeBounds(range.mode, range.customStart, range.customEnd);
  const a = useMemo(
    () => buildAnalysis({ ...sources, habits, tasks, pomodoroLog }, r),
    [sources, habits, tasks, pomodoroLog, r.start, r.end, r.prevStart, r.prevEnd, r.label],   // eslint-disable-line react-hooks/exhaustive-deps
  );
  useThemeVersion();   // re-render (so themeColors() is re-read) when the theme flips
  const C = themeColors();
  const L = a.label;

  const printPage = () => window.print();
  const exportJSON = () => {
    const blob = new Blob([JSON.stringify({ generatedAt: new Date().toISOString(), analysis: a }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), el = document.createElement('a');
    el.href = url; el.download = `nook-analysis-${todayStr()}.json`;
    document.body.appendChild(el); el.click(); document.body.removeChild(el);
    URL.revokeObjectURL(url);
  };
  const jump = id => document.getElementById(`da-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

  // ── Chart plumbing ──
  const label = d => (a.weekly ? `Wk of ${fmtShort(d)}` : fmtShort(d));
  const scale = (extra = {}) => ({
    x: { ticks: { color: C.muted, maxTicksLimit: 8, font: { size: 10 } }, grid: { display: false }, border: { color: C.grid } },
    y: { beginAtZero: true, ticks: { color: C.muted, precision: 0, font: { size: 10 } }, grid: { color: C.grid }, border: { color: C.grid }, ...extra },
  });
  const chartOpts = (extra = {}, legend = false) => ({
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: legend, labels: { color: C.text2, boxWidth: 10, boxHeight: 10, font: { size: 11 } } }, tooltip: { backgroundColor: C.tip, titleColor: C.text, bodyColor: C.text2, ...extra.tooltip } },
    scales: extra.scales || scale(),
  });

  const t = a.tasks, h = a.habits, f = a.focus, j = a.journal, n = a.notes, k = a.links, cd = a.countdowns;
  const ev = a.events, ac = a.activity, rv = a.reviews, sc = a.score, at = a.allTime;
  const wk = (values, fmt = v => v) => WEEKDAYS.map((l, i) => ({ label: l, value: values[i] ?? 0, display: fmt(values[i] ?? 0) }));

  return (
    <div className="da" id="export-analysis-area">

      {/* ══ Header ══ */}
      <div className="da-head">
        <div>
          <h2 className="da-title">Detailed Analysis</h2>
          <div className="ra-range-caption" style={{ marginBottom: 0 }}>
            {fmtShort(a.start)} – {fmtShort(a.end)} vs previous {L} · {plural(a.days, 'day')}
          </div>
          {a.clamped && <div className="ra-range-caption" style={{ marginTop: 4 }}>Showing the most recent {a.days} days of the range you picked.</div>}
        </div>
        <div className="ra-range-ctl no-print">
          <ReportRangeControl range={range} onChange={onRangeChange} />
          <div className="header-actions no-print" style={{ display: 'flex', gap: 8 }}>
            <button className="ra-icon-btn" onClick={printPage} title="Export PDF" aria-label="Export PDF">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/></svg>
            </button>
            <button className="ra-icon-btn" onClick={exportJSON} title="Export JSON" aria-label="Export JSON">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><polyline points="7 11 12 16 17 11"/><line x1="12" y1="4" x2="12" y2="16"/></svg>
            </button>
          </div>
        </div>
      </div>

      <nav className="da-nav no-print" aria-label="Jump to section">
        {NAV.map(([id, text]) => <button key={id} className="da-chip" onClick={() => jump(id)}>{text}</button>)}
      </nav>

      {/* ══ Highlights ══ */}
      <Section id="highlights" title="Highlights" sub={`What stands out in this ${L}.`}>
        {a.insights.length ? (
          <div className="da-insights">
            {a.insights.map((i, x) => <div key={x} className={`da-insight da-insight-${i.tone}`}>{i.text}</div>)}
          </div>
        ) : <p className="ra-empty">Not enough activity in this range to say much yet — log some habits, tasks or focus sessions and check back.</p>}
      </Section>

      {/* ══ At a glance ══ */}
      <Section id="glance" title="At a glance" sub={`Across every tab, with the change from the previous ${L}.`}>
        <div className="ra-kpis">
          <KpiTile label="Avg daily score"   value={sc.avg ?? '—'} sub={sc.hasData && sc.days ? `best ${sc.best?.score ?? '—'}` : undefined} d={cmp(sc.avg, sc.avgPrev)} periodLabel={L} />
          <KpiTile label="Habit completion"  value={pctText(h.cur.due ? h.cur.rate : null)} sub={`${h.cur.done}/${h.cur.due} scheduled`} d={h.prev.due ? delta(h.cur.rate, h.prev.rate) : null} unit="pt" periodLabel={L} />
          <KpiTile label="Tasks completed"   value={t.completed} sub={`${t.created} created`} d={delta(t.completed, t.completedPrev)} periodLabel={L} />
          <KpiTile label="Focus time"        value={fmtMinutes(f.minutes)} sub={plural(f.sessions, 'session')} d={delta(f.sessions, f.sessionsPrev)} periodLabel={L} />
          <KpiTile label="Journal entries"   value={j.entries} sub={`${j.words.toLocaleString()} words`} d={delta(j.entries, j.entriesPrev)} periodLabel={L} />
          <KpiTile label="Notes created"     value={n.created} sub={`${n.edited} edited`} d={delta(n.created, n.createdPrev)} periodLabel={L} />
          <KpiTile label="Links added"       value={k.added} sub={`${k.total} saved`} d={delta(k.added, k.addedPrev)} periodLabel={L} />
          <KpiTile label="Actions recorded"  value={ac.actions} sub={`${plural(ac.activeDays, 'active day')}`} d={delta(ac.actions, ac.actionsPrev)} periodLabel={L} />
        </div>
      </Section>

      {/* ══ Tasks ══ */}
      <Section id="tasks" title="Tasks" sub="What you finished, what's still open, and how it's trending.">
        {t.total === 0 ? <Empty>No tasks yet — add some in the Tasks tab.</Empty> : <>
          <Stats items={[
            ['Completed', t.completed, { hint: `${t.completedPrev} previous ${L}` }],
            ['Created', t.created, { hint: `${t.createdPrev} previous ${L}` }],
            ['Open now', t.openNow],
            ['Overdue', t.overdue, { warn: t.overdue > 0 }],
            ['Due today', t.dueToday],
            ['Due in 7 days', t.dueSoon],
            ['Done on time', pctText(t.onTime.rate), { hint: t.onTime.of ? `${t.onTime.n} of ${t.onTime.of} with a due date` : 'no due dates' }],
            ['Avg days to finish', t.avgDaysToComplete ?? '—', { hint: 'from created to completed' }],
            ['Due-date follow-through', pctText(t.dueInRange.rate), { hint: t.dueInRange.total ? `${t.dueInRange.done} of ${t.dueInRange.total} due in range` : 'none due in range' }],
          ]} />
          <Card title={`Created vs completed — per ${a.weekly ? 'week' : 'day'}`}>
            <div style={{ height: 200 }}>
              <Bar options={chartOpts({}, true)} data={{
                labels: t.series.map(p => label(p.date)),
                datasets: [
                  { label: 'Created', data: t.series.map(p => p.created), backgroundColor: C.blue, borderRadius: 3 },
                  { label: 'Completed', data: t.series.map(p => p.completed), backgroundColor: C.green, borderRadius: 3 },
                ],
              }} />
            </div>
          </Card>
          <div className="da-grid">
            <Card title="By category" note="solid = completed this period · faded = still open">
              <HBars rows={t.byCategory.map(c => ({ label: c.label, color: c.color, parts: [{ value: c.done }, { value: c.open, faded: true }], display: `${c.done} · ${c.open}` }))} empty="No tasks to break down." />
            </Card>
            <Card title="By priority" note="solid = completed this period · faded = still open">
              <HBars rows={t.byPriority.map(p => ({ label: p.label, color: p.color, parts: [{ value: p.done }, { value: p.open, faded: true }], display: `${p.done} · ${p.open}` }))} />
            </Card>
          </div>
          <div className="da-grid">
            <Card title="Completed by weekday">
              <Columns items={wk(t.byWeekday)} color={C.green} />
            </Card>
            <Card title="Time & effort — tasks completed in range">
              <KV rows={[
                ['Estimated time', fmtMinutes(t.effort.estMin)], ['Logged with the timer', fmtMinutes(t.effort.loggedMin)],
                ['Pomodoros on these tasks', t.effort.pomodoros], ['Open recurring tasks', t.recurring], ['Open with no due date', t.noDueDate],
              ]} />
            </Card>
          </div>
          <Card title="Overdue">
            {t.overdueList.length ? (
              <div>
                {t.overdueList.map((o, idx) => (
                  <div key={`${idx}:${o.id ?? o.name}`} className="da-row">
                    <span className="da-row-name">{o.name}</span>
                    <span className="ra-down da-row-val">{plural(o.daysLate, 'day')} late</span>
                  </div>
                ))}
                {t.overdue > t.overdueList.length && <p className="da-note">…and {t.overdue - t.overdueList.length} more.</p>}
              </div>
            ) : <p className="ra-empty">Nothing overdue — nice.</p>}
          </Card>
        </>}
      </Section>

      {/* ══ Habits ══ */}
      <Section id="habits" title="Habits" sub="Consistency per habit, the days you slip, and how each is moving.">
        {h.count === 0 ? <Empty>No habits yet — add some in the Habits tab.</Empty> : <>
          <Stats items={[
            ['Completion rate', pctText(h.cur.due ? h.cur.rate : null), { hint: h.prev.due ? `${h.prev.rate}% previous ${L}` : undefined }],
            ['Check-ins', `${h.cur.done}/${h.cur.due}`, { hint: 'done / scheduled' }],
            ['Perfect days', h.perfectDays, { hint: 'every scheduled habit done' }],
            ['Best perfect run', h.longestPerfect ? plural(h.longestPerfect, 'day') : '—'],
            ['Habits tracked', h.count],
            ['Strongest day', h.bestDay ? `${h.bestDay.label} · ${h.bestDay.rate}%` : '—'],
            ['Weakest day', h.worstDay ? `${h.worstDay.label} · ${h.worstDay.rate}%` : '—'],
          ]} />
          <Card title="Every habit" note="ranked by consistency in this range">
            <div className="da-habits">
              {h.rows.map((x, idx) => (
                <div key={`${idx}:${x.id}`} className="da-habit">
                  <div className="da-habit-name"><span className="ra-dot" style={{ background: x.color }} /><span className="da-habit-title">{x.name}</span><span className="da-habit-freq">{x.frequency}</span></div>
                  <div className="da-hb-track"><div className="da-hb-fill" style={{ width: `${x.rate}%`, background: x.color }} /></div>
                  <div className="da-habit-meta">
                    <strong>{x.due ? `${x.rate}%` : '—'}</strong>
                    <span>{x.done}/{x.due}</span>
                    <span title="Current streak">streak {x.streak}d</span>
                    <span title="Best streak ever">best {x.best}d</span>
                    {x.due > 0 && h.rows.some(y => y.delta !== 0) && <span className={x.delta > 0 ? 'ra-up' : x.delta < 0 ? 'ra-down' : 'ra-flat'}>{x.delta > 0 ? '↑' : x.delta < 0 ? '↓' : '→'} {Math.abs(x.delta)}pt</span>}
                  </div>
                </div>
              ))}
            </div>
          </Card>
          <div className="da-grid">
            <Card title="Completion by weekday" note="share of scheduled habits you finished">
              <Columns items={h.weekday.map(w => ({ label: w.label, value: w.rate ?? 0, display: w.rate == null ? '' : `${w.rate}%`, title: w.due ? `${w.done}/${w.due}` : 'nothing scheduled' }))} color={C.accent} max={100} />
            </Card>
            <Card title={`Daily completion — per ${a.weekly ? 'week' : 'day'}`}>
              <div style={{ height: 150 }}>
                <Line options={chartOpts({ scales: scale({ max: 100, ticks: { color: C.muted, callback: v => v + '%', font: { size: 10 } } }) })} data={{
                  labels: h.daily.map(p => label(p.date)),
                  datasets: [{ data: h.daily.map(p => p.rate), borderColor: C.accent, backgroundColor: C.accent + '22', fill: true, tension: 0.3, pointRadius: h.daily.length > 20 ? 0 : 3, spanGaps: true }],
                }} />
              </div>
            </Card>
          </div>
          <div className="da-grid">
            <Card title="By category">
              <HBars rows={h.byCategory.map(g => ({ label: g.label, color: g.color, value: g.rate, display: `${g.rate}%`, title: `${g.done}/${g.due}` }))} max={100} empty="Nothing scheduled in this range." />
            </Card>
            <Card title="By time of day">
              {h.byTimeTag.length > 1
                ? <HBars rows={h.byTimeTag.map(g => ({ label: g.label, color: g.color, value: g.rate, display: `${g.rate}%`, title: `${g.done}/${g.due}` }))} max={100} />
                : <p className="ra-empty">Give your habits a time of day (morning, evening…) to compare them here.</p>}
            </Card>
          </div>
          <div className="da-grid3">
            <Card title="Needs attention">
              {h.attention.length ? h.attention.map(x => <div key={x.id} className="da-row"><span className="da-row-name">{x.name}</span><span className="ra-down da-row-val">{x.rate}% · {x.done}/{x.due}</span></div>) : <p className="ra-empty">No habit is below 50% with enough data.</p>}
            </Card>
            <Card title="Most improved">
              {h.improved ? <div className="da-row"><span className="da-row-name">{h.improved.name}</span><span className="ra-up da-row-val">↑ {h.improved.delta}pt</span></div> : <p className="ra-empty">No habit improved on the previous {L}.</p>}
            </Card>
            <Card title="Biggest drop">
              {h.declined ? <div className="da-row"><span className="da-row-name">{h.declined.name}</span><span className="ra-down da-row-val">↓ {Math.abs(h.declined.delta)}pt</span></div> : <p className="ra-empty">No habit dropped on the previous {L}.</p>}
            </Card>
          </div>
        </>}
      </Section>

      {/* ══ Focus ══ */}
      <Section id="focus" title="Focus" sub="When you focus, how often, and how consistently. One logged session counts as 25 minutes.">
        {at.focusSessions === 0 ? <Empty>No focus sessions yet — run a timer in the Focus tab.</Empty> : <>
          <Stats items={[
            ['Sessions', f.sessions, { hint: `${f.sessionsPrev} previous ${L}` }],
            ['Focus time', fmtMinutes(f.minutes)],
            ['Active days', `${f.activeDays}/${a.days}`],
            ['Avg per active day', f.avgPerActiveDay ?? '—', { hint: 'sessions' }],
            ['Busiest day', f.bestDay ? plural(f.bestDay.sessions, 'session') : '—', { hint: f.bestDay ? fmtDay(f.bestDay.date) : undefined }],
            ['Peak hour', f.peakHour == null ? '—' : fmtHour(f.peakHour)],
            ['Longest streak', f.longestStreak ? plural(f.longestStreak, 'day') : '—', { hint: 'in this range' }],
            ['Current streak', f.currentStreak ? plural(f.currentStreak, 'day') : '—'],
          ]} />
          <Card title={`Sessions — per ${a.weekly ? 'week' : 'day'}`}>
            <div style={{ height: 170 }}>
              <Bar options={chartOpts({ tooltip: { callbacks: { label: c => `${plural(c.raw, 'session')} · ${c.raw * 25}m` } } })} data={{
                labels: f.series.map(p => label(p.date)),
                datasets: [{ data: f.series.map(p => p.value), backgroundColor: C.accent, borderRadius: 3 }],
              }} />
            </div>
          </Card>
          <div className="da-grid">
            <Card title="Sessions by hour of day">
              <div style={{ height: 170 }}>
                <Bar options={chartOpts({ tooltip: { callbacks: { title: i => fmtHour(i[0].dataIndex), label: c => plural(c.raw, 'session') } }, scales: { ...scale(), x: { ...scale().x, ticks: { color: C.muted, maxTicksLimit: 8, font: { size: 10 }, callback: i => fmtHour(+i) } } } })} data={{
                  labels: f.byHour.map((_, i) => i),
                  datasets: [{ data: f.byHour, backgroundColor: C.purple, borderRadius: 2 }],
                }} />
              </div>
            </Card>
            <Card title="Time of day">
              <HBars rows={f.dayParts.map(p => ({ label: p.label, value: p.count, color: C.purple, display: p.count }))} />
              <div style={{ marginTop: 16 }}>
                <div className="ra-card-title">By weekday</div>
                <Columns items={wk(f.byWeekday)} color={C.accent} compact />
              </div>
            </Card>
          </div>
        </>}
      </Section>

      {/* ══ Journal ══ */}
      <Section id="journal" title="Journal" sub="How often you write, how much, and your mood.">
        {j.allTime.days === 0 ? <Empty>No journal entries yet — write one in the Journal tab.</Empty> : <>
          <Stats items={[
            ['Entries', j.entries, { hint: `${j.entriesPrev} previous ${L}` }],
            ['Days covered', pctText(j.coverage), { hint: `${j.entries} of ${j.daysInRange} days` }],
            ['Words written', j.words.toLocaleString()],
            ['Avg per entry', j.avgWords ?? '—', { hint: 'words' }],
            ['Longest entry', j.longest ? `${j.longest.words} words` : '—', { hint: j.longest ? fmtDay(j.longest.date) : undefined }],
            ['Current streak', j.currentStreak ? plural(j.currentStreak, 'day') : '—'],
            ['Best streak', j.bestStreak ? plural(j.bestStreak, 'day') : '—', { hint: 'all time' }],
          ]} />
          <Card title={`Words written — per ${a.weekly ? 'week' : 'day'}`}>
            <div style={{ height: 160 }}>
              <Bar options={chartOpts({ tooltip: { callbacks: { label: c => `${c.raw.toLocaleString()} words` } } })} data={{
                labels: j.series.map(p => label(p.date)),
                datasets: [{ data: j.series.map(p => p.value), backgroundColor: C.blue, borderRadius: 3 }],
              }} />
            </div>
          </Card>
          <div className="da-grid">
            <Card title="Entries by weekday"><Columns items={wk(j.byWeekday)} color={C.blue} /></Card>
            <Card title="Mood" note="from the mood you set on each day">
              <HBars rows={j.moods.map(m => ({ label: m.emoji, value: m.count, color: C.amber, display: m.count }))} empty="No moods set in this range." emoji />
            </Card>
          </div>
        </>}
      </Section>

      {/* ══ Notes, links, countdowns ══ */}
      <Section id="library" title="Notes, links & countdowns" sub="What you've captured and what you're counting down to.">
        <div className="da-grid3">
          <Card title="Notes">
            {n.total === 0 ? <p className="ra-empty">No notes yet.</p> : <>
              <KV rows={[['Total', n.total], ['Pinned', n.pinned], [`Created this ${L}`, n.created], [`Edited this ${L}`, n.edited], ['Words (all notes)', n.totalWords.toLocaleString()], ['Avg words per note', n.avgWords ?? '—']]} />
              {n.topTags.length > 0 && <div className="da-chips">{n.topTags.map(x => <span key={x.key} className="da-tag">#{x.key} <b>{x.count}</b></span>)}</div>}
            </>}
          </Card>
          <Card title="Links">
            {k.total === 0 ? <p className="ra-empty">No links yet.</p> : <>
              <KV rows={[['Total', k.total], ['Starred', k.starred], [`Added this ${L}`, k.added]]} />
              <div style={{ marginTop: 12 }}><HBars rows={k.byCategory.map(c => ({ label: c.key, value: c.count, color: C.blue, display: c.count }))} /></div>
            </>}
          </Card>
          <Card title="Countdowns">
            {cd.total === 0 ? <p className="ra-empty">No countdowns yet.</p> : <>
              <KV rows={[['Active', cd.active], ['Upcoming', cd.upcoming], ['Overdue', cd.overdue], ['Completed', cd.completed]]} />
              {cd.nextUp.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  {cd.nextUp.map((c, idx) => (
                    <div key={`${idx}:${c.id ?? c.name}`} className="da-cd">
                      <div className="da-row"><span className="da-row-name">{c.name}</span><span className="da-row-val">{c.status === 'upcoming' ? 'not started' : `${c.daysLeft}d left`}</span></div>
                      <div className="da-hb-track"><div className="da-hb-fill" style={{ width: `${c.pct}%`, background: 'var(--accent)' }} /></div>
                    </div>
                  ))}
                </div>
              )}
            </>}
          </Card>
        </div>
      </Section>

      {/* ══ Calendar (+ goals) ══ */}
      <Section id="calendar" title="Calendar" sub="Your custom calendar events (Google Calendar events are fetched live and aren't included).">
        {ev.total === 0 && a.goals.total === 0 ? <Empty>No calendar events yet.</Empty> : <>
          <Stats items={[
            ['Events in range', ev.inRange, { hint: `${ev.inRangePrev} previous ${L}` }],
            ['All-day', ev.allDay],
            ['Scheduled time', fmtMinutes(ev.scheduledMin)],
            ['Next 7 days', ev.upcoming7],
            ['Next event', ev.next ? ev.next.title : '—', { hint: ev.next ? `${fmtDay(ev.next.date)}${ev.next.time ? ` · ${ev.next.time}` : ''}` : undefined }],
            ...(a.goals.total ? [['Goals', `${a.goals.completed}/${a.goals.total}`, { hint: `${a.goals.avgProgress}% average progress` }]] : []),
          ]} />
          <div className="da-grid">
            <Card title="By category"><HBars rows={ev.byCategory.map(c => ({ label: c.key, value: c.count, color: C.accent, display: c.count }))} empty="No events in this range." /></Card>
            <Card title="By weekday"><Columns items={wk(ev.byWeekday)} color={C.accent} /></Card>
          </div>
        </>}
      </Section>

      {/* ══ Activity ══ */}
      <Section id="activity" title="Activity" sub="Everything you did across the app, from the Activity Log.">
        {at.activity === 0 ? <Empty>No activity recorded yet.</Empty> : <>
          <Stats items={[
            ['Actions', ac.actions, { hint: `${ac.actionsPrev} previous ${L}` }],
            ['Active days', `${ac.activeDays}/${a.days}`],
            ['Busiest day', ac.busiestDay ? plural(ac.busiestDay.count, 'action') : '—', { hint: ac.busiestDay ? fmtDay(ac.busiestDay.date) : undefined }],
            ['Failed', ac.failed, { warn: ac.failed > 0 }],
          ]} />
          {ac.truncated && <p className="da-note">The Activity Log keeps only the newest 2,000 entries, so the start of this range may be under-counted.</p>}
          <div className="da-grid">
            <Card title="By area"><HBars rows={ac.byModule.map(m => ({ label: m.label, value: m.count, color: C.accent, display: m.count }))} empty="No activity in this range." /></Card>
            <Card title="By action"><HBars rows={ac.byAction.map(m => ({ label: m.label, value: m.count, color: C.purple, display: m.count }))} empty="No activity in this range." /></Card>
          </div>
          <div className="da-grid">
            <Card title="By weekday"><Columns items={wk(ac.byWeekday)} color={C.accent} /></Card>
            <Card title="By hour of day">
              <div style={{ height: 130 }}>
                <Bar options={chartOpts({ tooltip: { callbacks: { title: i => fmtHour(i[0].dataIndex), label: c => plural(c.raw, 'action') } }, scales: { ...scale(), x: { ...scale().x, ticks: { color: C.muted, maxTicksLimit: 8, font: { size: 10 }, callback: i => fmtHour(+i) } } } })} data={{
                  labels: ac.byHour.map((_, i) => i),
                  datasets: [{ data: ac.byHour, backgroundColor: C.accent, borderRadius: 2 }],
                }} />
              </div>
            </Card>
          </div>
        </>}
      </Section>

      {/* ══ Productivity score ══ */}
      <Section id="score" title="Productivity score" sub="The same daily score as the Overview: 50 habits · 30 tasks · 20 focus.">
        {!sc.hasData ? <Empty>Nothing to score yet — complete a habit, a task or a focus session and it shows up here.</Empty> : <>
        <Stats items={[
          ['Average', sc.avg ?? '—', { hint: sc.avgPrev != null ? `${sc.avgPrev} previous ${L}` : undefined }],
          ['Best day', sc.best ? sc.best.score : '—', { hint: sc.best ? fmtDay(sc.best.date) : undefined }],
          ['Lowest day', sc.worst ? sc.worst.score : '—', { hint: sc.worst ? fmtDay(sc.worst.date) : undefined }],
          ['Great days', sc.greatDays, { hint: `score 80+ of ${sc.days}` }],
        ]} />
        <div className="da-grid">
          <Card title={`Score — per ${a.weekly ? 'week (average)' : 'day'}`}>
            <div style={{ height: 170 }}>
              <Line options={chartOpts({ scales: scale({ max: 100 }) })} data={{
                labels: sc.series.map(p => label(p.date)),
                datasets: [{ data: sc.series.map(p => p.avg), borderColor: C.green, backgroundColor: C.green + '22', fill: true, tension: 0.3, pointRadius: sc.series.length > 20 ? 0 : 3, spanGaps: true }],
              }} />
            </div>
          </Card>
          <Card title="Average by weekday">
            <Columns items={sc.byWeekday.map(w => ({ label: w.label, value: w.avg ?? 0, display: w.avg ?? '', title: w.n ? `${plural(w.n, 'day')}` : 'no data' }))} color={C.green} max={100} />
          </Card>
        </div>
        </>}
      </Section>

      {/* ══ Weekly reviews ══ */}
      <Section id="reviews" title="Weekly reviews" sub="How you rated your own weeks (Today → Weekly Review).">
        {rv.total === 0 ? <Empty>No weekly reviews yet — do one from the Today tab.</Empty> : <>
          <Stats items={[
            [`Reviews this ${L}`, rv.count],
            ['Avg rating', rv.avg == null ? '—' : `${rv.avg} / 5`, { hint: rv.avgPrev != null ? `${rv.avgPrev} previous ${L}` : undefined }],
            ['All-time reviews', rv.total],
          ]} />
          <div className="da-grid">
            <Card title="Recent ratings">
              <Columns items={rv.recent.map(x => ({ label: fmtShort(x.date), value: x.rating, display: '★'.repeat(x.rating) }))} color={C.amber} max={5} wide />
            </Card>
            <Card title="Your latest “next focus”">
              {rv.latestNext ? <p className="da-quote">{rv.latestNext}</p> : <p className="ra-empty">Your latest review didn't set one.</p>}
            </Card>
          </div>
        </>}
      </Section>

      {/* ══ All time ══ */}
      <Section id="alltime" title="All time" sub="Totals since you started — these ignore the date range.">
        <Stats items={[
          ['Using Nook for', at.daysUsing ? plural(at.daysUsing, 'day') : '—', { hint: at.since ? `since ${fmtDay(at.since)}` : undefined }],
          ['Tasks completed', at.tasksCompleted, { hint: `of ${at.tasksTotal}` }],
          ['Habit check-ins', at.habitCheckIns.toLocaleString()],
          ['Best habit streak', at.bestHabitStreak ? plural(at.bestHabitStreak, 'day') : '—'],
          ['Focus sessions', at.focusSessions.toLocaleString(), { hint: fmtMinutes(at.focusMinutes) }],
          ['Journal days', at.journalDays, { hint: `${at.journalWords.toLocaleString()} words` }],
          ['Notes', at.notes], ['Links', at.links], ['Countdowns', at.countdowns], ['Calendar events', at.events],
          ['Activity entries', at.activity.toLocaleString()],
        ]} />
      </Section>

    </div>
  );
}

// ─── Building blocks ───────────────────────────────────────────────
function Section({ id, title, sub, children }) {
  return (
    <section id={`da-${id}`} className="da-sec">
      <h2 className="da-sec-title">{title}</h2>
      {sub && <p className="da-sec-sub">{sub}</p>}
      <div className="da-sec-body">{children}</div>
    </section>
  );
}

const Empty = ({ children }) => <div className="ra-card"><p className="ra-empty">{children}</p></div>;

function Card({ title, note, children }) {
  return (
    <div className="ra-card">
      {title && <h3 className="ra-card-title" style={note ? { marginBottom: 4 } : undefined}>{title}</h3>}
      {note && <p className="da-note" style={{ marginTop: 0 }}>{note}</p>}
      {children}
    </div>
  );
}

// items: [label, value, { hint?, warn? }]
function Stats({ items }) {
  return (
    <div className="da-stats">
      {items.map(([label, value, o = {}]) => (
        <div key={label} className={`da-stat${o.warn ? ' da-stat-warn' : ''}`}>
          <div className="da-stat-val" title={typeof value === 'string' ? value : undefined}>{value ?? '—'}</div>
          <div className="da-stat-lbl">{label}</div>
          {o.hint && <div className="da-stat-hint">{o.hint}</div>}
        </div>
      ))}
    </div>
  );
}

function KV({ rows }) {
  return <div>{rows.map(([k, v]) => <div key={k} className="da-row"><span className="da-row-name">{k}</span><span className="da-row-val">{v}</span></div>)}</div>;
}

// Horizontal bars in plain CSS. A row is { label, color, value, display } or, for a
// done/open split, { parts: [{ value, faded? }] }.
function HBars({ rows, max, empty = 'Nothing to show yet.', emoji = false }) {
  if (!rows.length) return <p className="ra-empty">{empty}</p>;
  const total = r => (r.parts ? r.parts.reduce((s, p) => s + p.value, 0) : r.value);
  const top = max ?? Math.max(1, ...rows.map(total));
  return (
    <div className="da-hb">
      {rows.map((r, idx) => (
        <div key={`${idx}:${r.label}`} className="da-hb-row" title={r.title}>
          <span className="da-hb-name" style={emoji ? { fontSize: '1.15rem' } : undefined}>{r.label}</span>
          <div className="da-hb-track">
            {(r.parts || [{ value: r.value }]).map((p, i) => (
              <div key={i} className="da-hb-fill" style={{ width: `${Math.min(100, (p.value / top) * 100)}%`, background: r.color, opacity: p.faded ? 0.35 : 1 }} />
            ))}
          </div>
          <span className="da-hb-val">{r.display ?? total(r)}</span>
        </div>
      ))}
    </div>
  );
}

// Seven (or n) vertical bars with a label underneath; the tallest is drawn solid.
function Columns({ items, color, max, compact = false, wide = false }) {
  const top = max ?? Math.max(1, ...items.map(i => i.value));
  const best = Math.max(...items.map(i => i.value));
  return (
    <div className={`da-cols${compact ? ' da-cols-compact' : ''}`} style={wide ? { gridTemplateColumns: `repeat(${Math.max(1, items.length)}, minmax(0, 1fr))` } : undefined}>
      {items.map((i, idx) => (
        <div key={`${idx}:${i.label}`} className="da-col" title={i.title}>
          <span className="da-col-val">{i.display}</span>
          <div className="da-col-track"><div className="da-col-bar" style={{ height: `${Math.min(100, (i.value / top) * 100)}%`, background: color, opacity: i.value > 0 && i.value === best ? 1 : 0.45 }} /></div>
          <span className="da-col-lbl">{i.label}</span>
        </div>
      ))}
    </div>
  );
}
