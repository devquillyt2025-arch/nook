import { memo, useState } from 'react';
import AnalyticsDashboard from './AnalyticsDashboard';
import DetailedAnalysis from './DetailedAnalysis';

// ─── Reports view ──────────────────────────────────────────────────
// Reports is a read-only, cross-tab analytics screen. It no longer surfaces
// or manages the nook-trackers system — everything here is synthesised from the
// real tabs: Habits (nook_habits), Tasks, Focus (pomodoro log) and Journal.
// (nook-trackers data is left untouched in localStorage; it simply has no UI
// on this screen anymore.)
//
// Two views over the same data: the at-a-glance Overview and a Detailed Analysis
// that goes through every tab. They share one time range so switching keeps the
// period you picked.
const VIEWS = [['overview', 'Overview'], ['analysis', 'Detailed Analysis']];

export default memo(function ReportsView({ habits = [], tasks = [], pomodoroLog = [] }) {
  const [view, setView] = useState('overview');
  const [range, setRange] = useState({ mode: 'week', customStart: '', customEnd: '' });   // mode: 'week' | 'month' | 'custom'
  return (
    <div className="reports-view">
      <div className="ra-view-switch no-print">
        <div className="ra-seg" role="group" aria-label="Report view">
          {VIEWS.map(([id, label]) => (
            <button key={id} className={view === id ? 'ra-seg-on' : ''} onClick={() => setView(id)} aria-pressed={view === id}>{label}</button>
          ))}
        </div>
      </div>
      {view === 'overview'
        ? <AnalyticsDashboard habits={habits} tasks={tasks} pomodoroLog={pomodoroLog} range={range} onRangeChange={setRange} />
        : <DetailedAnalysis habits={habits} tasks={tasks} pomodoroLog={pomodoroLog} range={range} onRangeChange={setRange} />}
    </div>
  );
});
