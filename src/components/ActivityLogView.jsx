import { memo,  useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { loadActivityLog, clearActivityLog } from '../utils/activityLog';

// ── Verb/dot colors per action ────────────────────────────────────
function dotColor(action, status) {
  if (status === 'failed') return 'var(--color-red)';
  if (action === 'deleted')   return 'var(--color-red)';
  if (action === 'completed') return 'var(--color-green)';
  if (action === 'created')   return 'var(--color-blue)';
  if (action === 'updated')   return 'var(--color-amber)';
  return 'var(--text-secondary)';
}
function verbColor(action, status) {
  if (status === 'failed') return 'var(--color-red)';
  if (action === 'deleted')   return 'var(--color-red)';
  if (action === 'completed') return 'var(--color-green)';
  if (action === 'created')   return 'var(--color-blue)';
  if (action === 'updated')   return 'var(--color-amber)';
  return 'var(--text-secondary)';
}

// ── Module metadata ───────────────────────────────────────────────
const MODULE_META = {
  tasks:    { label: 'Tasks',    tab: 'tasks'    },
  habits:   { label: 'Habits',  tab: 'habits'   },
  notes:    { label: 'Notes',   tab: 'notes'    },
  countdowns: { label: 'Countdowns', tab: 'countdowns' },
  journal:  { label: 'Journal', tab: 'journal'  },
  calendar: { label: 'Calendar',tab: 'calendar' },
  vault:    { label: 'Saved Logins', tab: 'vault' },
  links:    { label: 'Links',       tab: 'links'  },
  trackers: { label: 'Trackers',    tab: 'reports' },
  intentions: { label: 'Intentions', tab: 'daily'  },
  focus:    { label: 'Focus',       tab: 'timer'  },
};
const MODULE_OPTIONS = [
  { value: 'all', label: 'All' },
  ...Object.entries(MODULE_META).map(([k, v]) => ({ value: k, label: v.label })),
];
const STATUS_OPTIONS = [
  { value: 'all',     label: 'All'     },
  { value: 'success', label: 'Success' },
  { value: 'failed',  label: 'Failed'  },
];

// ── Date helpers ──────────────────────────────────────────────────
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function startOfDay(d) { const r = new Date(d); r.setHours(0, 0, 0, 0); return r; }
function endOfDay(d)   { const r = new Date(d); r.setHours(23, 59, 59, 999); return r; }

function thisWeekRange() {
  const end   = new Date();
  const start = startOfDay(new Date()); start.setDate(start.getDate() - 6);
  return { start, end };
}

function fmtRangeLabel({ start, end }) {
  if (!start && !end) return 'All Time';
  const o = { month: 'short', day: 'numeric' };
  const s = start ? start.toLocaleDateString('en-US', o) : '…';
  const e = end   ? end.toLocaleDateString('en-US', o)   : '…';
  if (start && end && sameDay(start, end)) return s;
  return `${s} – ${e}`;
}

// ── Timeline grouping ─────────────────────────────────────────────
function getGroup(iso) {
  const d = new Date(iso); const now = new Date();
  const yest    = new Date(now); yest.setDate(now.getDate() - 1);
  const weekAgo = new Date(now); weekAgo.setDate(now.getDate() - 7);
  if (sameDay(d, now))  return 'Today';
  if (sameDay(d, yest)) return 'Yesterday';
  if (d > weekAgo)      return 'This Week';
  return 'Older';
}
const GROUP_ORDER = ['Today', 'Yesterday', 'This Week', 'Older'];
function groupEntries(entries) {
  const map = {};
  for (const e of entries) { const g = getGroup(e.created_at); (map[g] = map[g] || []).push(e); }
  return GROUP_ORDER.filter(g => map[g]).map(g => ({ label: g, entries: map[g] }));
}

// ── Formatters ────────────────────────────────────────────────────
function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
}
function fmtFull(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).toLowerCase();
}

const VERBS = { created: 'Created', updated: 'Updated', deleted: 'Deleted',
                completed: 'Completed', archived: 'Archived', restored: 'Restored' };
function buildLabel(entity_type, action) {
  if (entity_type === 'habit' && action === 'completed') return 'Logged Habit';
  const verb = VERBS[action] || action;
  const type = entity_type
    ? entity_type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : '';
  return `${verb} ${type}`.trim();
}

const PAGE_SIZE = 150;

// ── Main component ────────────────────────────────────────────────
export default memo(function ActivityLogView({ setActiveTab }) {
  const [log,          setLog]          = useState([]);
  const [search,       setSearch]       = useState('');
  const [moduleFilter, setModuleFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [dateRange,    setDateRange]    = useState(thisWeekRange);
  const [page,         setPage]         = useState(1);

  const [gearOpen, setGearOpen] = useState(false);
  const gearRef = useRef(null);

  const [dateOpen, setDateOpen] = useState(false);
  const dateBtnRef = useRef(null);

  const [clearModal,  setClearModal]  = useState(false);
  const [deleteInput, setDeleteInput] = useState('');
  const undoBackupRef = useRef(null);

  const [undoVisible, setUndoVisible] = useState(false);
  const [undoSecs,    setUndoSecs]    = useState(10);
  const undoIntervalRef = useRef(null);

  const reload = useCallback(() => { setLog(loadActivityLog()); setPage(1); }, []);
  useEffect(() => { reload(); }, [reload]);

  // Keep the view live: reload whenever the log is written to.
  // - Same tab: App.jsx fires 'nook-activity-updated' after each logActivity call.
  //   (Throttled to avoid cascade on rapid bursts.)
  // - Cross tab: storage event fires when another tab writes to the key.
  useEffect(() => {
    let lastReload = 0;
    const throttledReload = () => {
      const now = Date.now();
      if (now - lastReload > 1500) { lastReload = now; setLog(loadActivityLog()); }
    };
    const onStorage = (e) => { if (e.key === 'nook-activity-log') throttledReload(); };
    const onCustom   = () => throttledReload();
    window.addEventListener('storage', onStorage);
    window.addEventListener('nook-activity-updated', onCustom);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('nook-activity-updated', onCustom);
    };
  }, []);


  useEffect(() => {
    const h = (e) => {
      if (gearRef.current && !gearRef.current.contains(e.target)) setGearOpen(false);
    };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const startUndo = useCallback(() => {
    setUndoVisible(true); setUndoSecs(10);
    if (undoIntervalRef.current) clearInterval(undoIntervalRef.current);
    undoIntervalRef.current = setInterval(() => {
      setUndoSecs(s => {
        if (s <= 1) { clearInterval(undoIntervalRef.current); setUndoVisible(false); undoBackupRef.current = null; return 10; }
        return s - 1;
      });
    }, 1000);
  }, []);
  useEffect(() => () => clearInterval(undoIntervalRef.current), []);

  // ── Filtering ─────────────────────────────────────────────────
  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    const { start, end } = dateRange;
    const endMs = end ? endOfDay(end).getTime() : null;
    return log.filter(e => {
      const t = new Date(e.created_at).getTime();
      if (start && t < start.getTime()) return false;
      if (endMs  && t > endMs)          return false;
      if (statusFilter !== 'all' && e.status !== statusFilter) return false;
      if (moduleFilter !== 'all' && e.module !== moduleFilter) return false;
      if (q && ![e.title, e.module, e.action, e.entity_type].some(s => s?.toLowerCase().includes(q))) return false;
      return true;
    });
  }, [log, search, moduleFilter, statusFilter, dateRange]);

  const visible    = filtered.slice(0, page * PAGE_SIZE);
  const hasMore    = visible.length < filtered.length;
  const grouped    = useMemo(() => groupEntries(visible), [visible]);
  const hasFilters = !!(search || moduleFilter !== 'all' || statusFilter !== 'all' || dateRange.start !== null);

  const resetFilters = () => {
    setSearch(''); setModuleFilter('all'); setStatusFilter('all');
    setDateRange({ start: null, end: null }); setPage(1);
  };

  // ── Export ────────────────────────────────────────────────────
  const doExport = (fmt) => {
    let content, filename, mime;
    if (fmt === 'json') {
      content = JSON.stringify(filtered, null, 2);
      filename = `nook-activity-${new Date().toISOString().slice(0, 10)}.json`;
      mime = 'application/json';
    } else {
      const cols = ['id', 'module', 'entity_type', 'entity_id', 'action', 'title', 'status', 'created_at'];
      content = [cols.join(','), ...filtered.map(e => cols.map(c => JSON.stringify(e[c] ?? '')).join(','))].join('\n');
      filename = `nook-activity-${new Date().toISOString().slice(0, 10)}.csv`;
      mime = 'text/csv';
    }
    const url = URL.createObjectURL(new Blob([content], { type: mime }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setGearOpen(false);
  };

  const openClear = () => { setDeleteInput(''); setClearModal(true); setGearOpen(false); };
  const handleClear = () => {
    if (deleteInput !== 'DELETE') return;
    undoBackupRef.current = [...log];
    clearActivityLog(); setLog([]); setPage(1);
    setClearModal(false); setDeleteInput('');
    startUndo();
  };
  const handleUndo = () => {
    if (!undoBackupRef.current) return;
    localStorage.setItem('nook-activity-log', JSON.stringify(undoBackupRef.current));
    setLog(undoBackupRef.current); undoBackupRef.current = null;
    clearInterval(undoIntervalRef.current); setUndoVisible(false);
  };

  return (
    <div className="al-view">

      {/* ── Single-row compact toolbar ── */}
      <div className="al-toolbar">
        <div className="al-tb-search">
          <IcoSearch />
          <input className="al-tb-inp" placeholder="Search entries…" value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }} />
          {search && <button className="al-tb-clear" onClick={() => setSearch('')}>×</button>}
        </div>

        <DropSelect
          label="Module"
          value={moduleFilter}
          options={MODULE_OPTIONS}
          onChange={v => { setModuleFilter(v); setPage(1); }}
          width={148}
        />
        <DropSelect
          label="Status"
          value={statusFilter}
          options={STATUS_OPTIONS}
          onChange={v => { setStatusFilter(v); setPage(1); }}
          width={118}
        />

        <div className="al-date-wrap">
          <button
            ref={dateBtnRef}
            type="button"
            className={`al-date-btn${dateOpen ? ' open' : ''}`}
            onClick={() => setDateOpen(!dateOpen)}
          >
            <IcoCal />
            <span>{fmtRangeLabel(dateRange)}</span>
            <IcoChevronD />
          </button>
          
          {/* ── Calendar popover (absolute anchored to right) ── */}
          {dateOpen && (
            <DateRangePicker
              dateRange={dateRange}
              triggerRef={dateBtnRef}
              onChange={r => { setDateRange(r); setPage(1); setDateOpen(false); }}
              onClose={() => setDateOpen(false)}
            />
          )}
        </div>

        <span className="al-count-txt">{filtered.length} entries found</span>

        {/* Gear menu + Refresh — moved here from the removed page header */}
        <div className="al-header-right">
          <div className="al-gear-wrap" ref={gearRef}>
            <button className="al-icon-btn" onClick={() => setGearOpen(o => !o)} title="Options"><IcoGear /></button>
            {gearOpen && (
              <div className="al-drop al-gear-drop">
                <button className="al-drop-item" onClick={() => doExport('csv')}>Export CSV</button>
                <button className="al-drop-item" onClick={() => doExport('json')}>Export JSON</button>
                <div className="al-drop-divider" />
                <button className="al-drop-danger" onClick={openClear}><IcoTrash /> Clear Log…</button>
              </div>
            )}
          </div>
          <button className="al-icon-btn" onClick={reload} title="Refresh"><IcoRefresh /></button>
        </div>
      </div>

      {/* ── Dense timeline ── */}
      <div className="al-list">
        {visible.length === 0 ? (
          <EmptyState hasFilters={hasFilters} onReset={resetFilters} />
        ) : (
          <>
            {grouped.map(group => (
              <div key={group.label} className="al-group">
                <div className="al-group-hdr">{group.label}</div>
                <div className="al-group-body">
                  {group.entries.map(e => (
                    <DenseEntry key={e.id} entry={e} setActiveTab={setActiveTab} />
                  ))}
                </div>
              </div>
            ))}
            {hasMore && (
              <button className="al-load-more" onClick={() => setPage(p => p + 1)}>
                Load more · {filtered.length - visible.length} remaining
              </button>
            )}
          </>
        )}
      </div>

      {/* ── Clear modal ── */}
      {clearModal && (
        <div className="al-overlay" onClick={e => e.target === e.currentTarget && setClearModal(false)}>
          <div className="al-confirm">
            <div className="al-confirm-icon-wrap"><IcoTrash /></div>
            <h3 className="al-confirm-title">Clear Activity Log?</h3>
            <p className="al-confirm-body">Permanently delete <strong>{log.length} {log.length === 1 ? 'entry' : 'entries'}</strong>. You'll have 10 seconds to undo.</p>
            <p className="al-confirm-hint">Type <strong>DELETE</strong> to confirm:</p>
            <input className="al-confirm-inp" placeholder="Type DELETE" value={deleteInput}
              onChange={e => setDeleteInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && deleteInput === 'DELETE' && handleClear()}
              autoFocus />
            <div className="al-confirm-actions">
              <button className="al-confirm-cancel" onClick={() => setClearModal(false)}>Cancel</button>
              <button className={`al-confirm-del${deleteInput === 'DELETE' ? ' ready' : ''}`}
                disabled={deleteInput !== 'DELETE'} onClick={handleClear}>Delete All</button>
            </div>
          </div>
        </div>
      )}

      {/* ── Undo toast ── */}
      {undoVisible && (
        <div className="al-undo-toast">
          <span className="al-undo-msg">Activity log cleared</span>
          <button className="al-undo-btn" onClick={handleUndo}>Undo ({undoSecs}s)</button>
        </div>
      )}
    </div>
  );
});

// ── Dense single-line entry ───────────────────────────────────────
function DenseEntry({ entry, setActiveTab }) {
  const tab       = MODULE_META[entry.module]?.tab;
  const clickable = !!(tab && setActiveTab);
  const dc        = dotColor(entry.action, entry.status);
  const vc        = verbColor(entry.action, entry.status);
  const label     = buildLabel(entry.entity_type, entry.action);

  return (
    <div
      className={`al-row${clickable ? ' al-row-link' : ''}${entry.status === 'failed' ? ' al-row-fail' : ''}`}
      onClick={clickable ? () => setActiveTab(tab) : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onKeyDown={clickable ? e => e.key === 'Enter' && setActiveTab(tab) : undefined}
      title={fmtFull(entry.created_at)}
    >
      <span className="al-dot" style={{ background: dc }} />
      <span className="al-row-time">{fmtTime(entry.created_at)}</span>
      <span className="al-row-sep" />
      <div className="al-row-desc">
        <span className="al-row-verb" style={{ color: vc }}>{label}</span>
        {entry.title && (
          <><span className="al-row-colon">: </span><span className="al-row-name">"{entry.title}"</span></>
        )}
      </div>
      <span className="al-row-mod">{MODULE_META[entry.module]?.label ?? entry.module}</span>
      {clickable && <span className="al-row-caret"><IcoChevronR /></span>}
    </div>
  );
}

// ── Date range picker popover ─────────────────────────────────────
function DateRangePicker({ dateRange, triggerRef, onChange, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose, triggerRef]);

  const [calMonth,  setCalMonth]  = useState(() => {
    const d = dateRange.start || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [tempRange, setTempRange] = useState({ start: dateRange.start, end: dateRange.end });
  const [picking,   setPicking]   = useState('start');
  const [hoverDay,  setHoverDay]  = useState(null);

  const yr  = calMonth.getFullYear();
  const mo  = calMonth.getMonth();
  const firstDow    = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const quick = (type) => {
    const now = new Date();
    if (type === 'all')   { onChange({ start: null, end: null }); return; }
    if (type === 'today') { onChange({ start: startOfDay(now), end: now }); return; }
    if (type === 'week')  { onChange(thisWeekRange()); return; }
    if (type === 'month') { onChange({ start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }); return; }
  };

  const handleDayClick = (day) => {
    const d = new Date(yr, mo, day);
    if (picking === 'start' || !tempRange.start) {
      setTempRange({ start: d, end: null });
      setPicking('end');
    } else {
      const s = tempRange.start;
      onChange({ start: d < s ? d : s, end: d < s ? s : d });
    }
  };

  const effectiveEnd = tempRange.end || hoverDay;

  const dayClass = (day) => {
    const d    = new Date(yr, mo, day);
    const isSel  = (tempRange.start && sameDay(d, tempRange.start)) || (tempRange.end && sameDay(d, tempRange.end));
    const isHov  = hoverDay && sameDay(d, hoverDay) && picking === 'end';
    const isBet  = tempRange.start && effectiveEnd && d > tempRange.start && d < effectiveEnd;
    const isTod  = sameDay(d, new Date());
    return ['al-cal-day', isSel ? 'sel' : isHov ? 'hov' : '', isBet ? 'bet' : '', isTod ? 'tod' : '']
      .filter(Boolean).join(' ');
  };

  return (
    <div ref={menuRef} className="al-cal-pop"
      style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50 }}>
      <div className="al-cal-qs">
        {[['today','Today'],['week','This Week'],['month','This Month'],['all','All Time']].map(([v, l]) => (
          <button key={v} className="al-cal-sc" onClick={() => quick(v)}>{l}</button>
        ))}
      </div>
      <div className="al-cal-hr" />

      <div className="al-cal-nav">
        <button className="al-cal-nb" onClick={() => setCalMonth(new Date(yr, mo - 1))}>‹</button>
        <span className="al-cal-ml">{calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <button className="al-cal-nb" onClick={() => setCalMonth(new Date(yr, mo + 1))}>›</button>
      </div>

      <div className="al-cal-grid">
        {DOW.map(d => <span key={d} className="al-cal-dow">{d}</span>)}
        {Array.from({ length: firstDow }).map((_, i) => <span key={`_${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          return (
            <button key={day} className={dayClass(day)}
              onMouseEnter={() => picking === 'end' && setHoverDay(new Date(yr, mo, day))}
              onMouseLeave={() => setHoverDay(null)}
              onClick={() => handleDayClick(day)}>
              {day}
            </button>
          );
        })}
      </div>

      <div className="al-cal-hint">
        <span>{picking === 'start' ? 'Select start date' : 'Select end date'}</span>
        {tempRange.start && picking === 'end' && (
          <button className="al-cal-rst"
            onClick={() => { setTempRange({ start: null, end: null }); setPicking('start'); }}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────
function EmptyState({ hasFilters, onReset }) {
  return (
    <div className="al-empty">
      <div className="al-empty-art">{hasFilters ? <IcoSearchLg /> : <IcoTimeline />}</div>
      <p className="al-empty-title">{hasFilters ? 'No entries match' : 'No activity yet'}</p>
      <p className="al-empty-sub">{hasFilters ? 'Clear filters to see more entries' : 'Actions across your modules will appear here'}</p>
      {hasFilters && <button className="al-empty-reset" onClick={onReset}>Clear filters</button>}
    </div>
  );
}

// ── Custom dropdown select ────────────────────────────────────────
function DropSelect({ label, value, options, onChange, width }) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef(null);
  const menuRef    = useRef(null);
  const chosen     = options.find(o => o.value === value);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen]);

  return (
    <div className="al-dsel" ref={triggerRef} style={{ width }}>
      <button type="button" className={`al-dsel-btn${isOpen ? ' open' : ''}`} onClick={() => setIsOpen(!isOpen)}>
        <span className="al-dsel-label">{label}:</span>
        <span className="al-dsel-value">{chosen?.label ?? 'All'}</span>
        <IcoChevronD />
      </button>
      {isOpen && (
        <div ref={menuRef} className="al-dsel-menu"
          style={{ position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 50 }}>
          {options.map(o => (
            <button key={o.value} type="button"
              className={`al-dsel-opt${value === o.value ? ' active' : ''}`}
              onClick={() => { onChange(o.value); setIsOpen(false); }}>
              {o.label}
              {value === o.value && <IcoCheck />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────
const SI = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' };
function IcoSearch()   { return <svg width="13" height="13" viewBox="0 0 24 24" {...SI}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function IcoRefresh()  { return <svg width="13" height="13" viewBox="0 0 24 24" {...SI}><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>; }
function IcoChevronD() { return <svg width="10" height="10" viewBox="0 0 24 24" {...SI} style={{ flexShrink: 0 }}><polyline points="6 9 12 15 18 9"/></svg>; }
function IcoChevronR() { return <svg width="11" height="11" viewBox="0 0 24 24" {...SI}><polyline points="9 18 15 12 9 6"/></svg>; }
function IcoGear()     { return <svg width="14" height="14" viewBox="0 0 24 24" {...SI}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>; }
function IcoTrash()    { return <svg width="13" height="13" viewBox="0 0 24 24" {...SI}><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>; }
function IcoCal()      { return <svg width="12" height="12" viewBox="0 0 24 24" {...SI}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>; }
function IcoCheck()    { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>; }
function IcoSearchLg() { return <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.2 }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>; }
function IcoTimeline() { return <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.2 }}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>; }
