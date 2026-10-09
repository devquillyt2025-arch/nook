import { memo,  useState, useEffect, useRef, useMemo } from 'react';
import Select from './Select';
import { genId } from '../trackers/trackerUtils';
import { logActivity, diffObjects } from '../utils/activityLog';
import { localDateStr } from '../utils/date';

// ─── Storage ───────────────────────────────────────────────────────
const CD_KEY = 'nook_countdowns';
const PINNED_KEY = 'nook_countdown_pinned';

function loadCountdowns() {
  try { return JSON.parse(localStorage.getItem(CD_KEY) || '[]'); }
  catch { return []; }
}
function saveCountdowns(list) {
  try { localStorage.setItem(CD_KEY, JSON.stringify(list)); } catch {}
}
function loadPinned() {
  try { return localStorage.getItem(PINNED_KEY) || null; } catch { return null; }
}
function savePinned(id) {
  try { id ? localStorage.setItem(PINNED_KEY, id) : localStorage.removeItem(PINNED_KEY); } catch {}
}

// ─── Category / Priority meta ───────────────────────────────────────
const PRESET_CATEGORIES = ['Personal', 'Work', 'Health', 'Learning', 'Travel'];
const CATEGORY_COLORS = {
  Personal: '#a855f7', Work: 'var(--color-blue)', Health: 'var(--color-green)',
  Learning: 'var(--accent)', Travel: 'var(--color-amber)', Other: 'var(--text-secondary)',
};
function categoryColor(cat) { return CATEGORY_COLORS[cat] || '#8b5cf6'; }

const PRIORITY_META = {
  low:    { label: 'Low',    color: 'var(--color-green)' },
  medium: { label: 'Medium', color: '#eab308' },
  high:   { label: 'High',   color: 'var(--color-red)' },
};
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };

const SELECT_PILL_STYLE = {
  width: 160, padding: '8px 14px', background: 'var(--bg-hover)', border: 'none',
  borderRadius: 999, color: 'var(--text-primary)', fontSize: '0.8rem', fontWeight: 600,
};

// ─── Date helpers ──────────────────────────────────────────────────
// Shared local-date helper (was a byte-identical reimplementation of localDateStr).
const todayLocal = () => localDateStr();
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00') - new Date(a + 'T00:00:00')) / 86400000);
}
function fmtCdDate(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}
function openPicker(ref) {
  const el = ref.current;
  if (!el) return;
  try { el.showPicker(); }
  catch { el.focus(); }
}

// ─── Derived countdown state ────────────────────────────────────────
function sortedMilestones(list) {
  return [...(list || [])].sort((a, b) => a.targetDate.localeCompare(b.targetDate));
}

function computeCd(cd) {
  const today = todayLocal();
  const total = Math.max(1, daysBetween(cd.startDate, cd.endDate));

  if (isNaN(total)) {
    console.warn(`[Countdowns] "${cd.title || cd.id}" has an invalid startDate/endDate — showing a neutral state.`);
    const milestones = sortedMilestones(cd.milestones);
    const nextMs = milestones.find(m => m.targetDate >= today) || null;
    return { total: 1, daysCompleted: 0, daysRemaining: 1, pct: 0, status: 'active', overdueDays: 0, milestones, nextMs };
  }

  const elapsed = daysBetween(cd.startDate, today);
  const daysCompleted = Math.min(total, Math.max(0, elapsed));
  const pct = Math.min(100, Math.max(0, Math.round((daysCompleted / total) * 100)));
  const daysRemaining = Math.max(0, total - daysCompleted);
  const overdue = !cd.completed && today > cd.endDate;
  const upcoming = today < cd.startDate;
  let status = 'active';
  if (cd.completed) status = 'completed';
  else if (overdue) status = 'overdue';
  else if (upcoming) status = 'upcoming';
  const overdueDays = overdue ? daysBetween(cd.endDate, today) : 0;

  const milestones = sortedMilestones(cd.milestones);
  const nextMs = milestones.find(m => m.targetDate >= today) || null;

  return { total, daysCompleted, daysRemaining, pct, status, overdueDays, milestones, nextMs };
}

const STATUS_META = {
  active:    { label: 'On Track',  color: '#16a34a', bg: 'rgba(34,197,94,0.14)' },
  overdue:   { label: 'Overdue',   color: '#dc2626', bg: 'rgba(239,68,68,0.14)' },
  completed: { label: 'Completed', color: '#2563eb', bg: 'rgba(59,130,246,0.14)' },
  upcoming:  { label: 'Upcoming',  color: 'var(--text-muted)', bg: 'rgba(148,163,184,0.16)' },
};

function makeCountdown(data) {
  return {
    id: genId(),
    name: data.name,
    category: data.category,
    priority: data.priority,
    notes: data.notes,
    startDate: data.startDate,
    endDate: data.endDate,
    milestones: data.milestones,
    completed: false,
    createdAt: new Date().toISOString(),
  };
}

// ─── Main view ─────────────────────────────────────────────────────
export default memo(function CountdownsView() {
  const [countdowns, setCountdowns] = useState(loadCountdowns);
  const [pinnedId,   setPinnedId]   = useState(loadPinned);
  const [showModal,  setShowModal]  = useState(false);
  const [editingCd,  setEditingCd]  = useState(null);

  const [filterCategory,   setFilterCategory]   = useState('all');
  const [filterPriorities, setFilterPriorities] = useState(new Set());
  const [sortBy, setSortBy] = useState('endDate');

  useEffect(() => { saveCountdowns(countdowns); }, [countdowns]);
  useEffect(() => { savePinned(pinnedId); }, [pinnedId]);

  const today = todayLocal();
  const totalCount     = countdowns.length;
  const completedCount = countdowns.filter(c => c.completed).length;
  const overdueCount   = countdowns.filter(c => !c.completed && today > c.endDate).length;
  const activeCount    = totalCount - completedCount;
  const avgPct         = useMemo(() => countdowns.length
    ? Math.round(countdowns.reduce((s, c) => s + computeCd(c).pct, 0) / countdowns.length)
    : 0, [countdowns]);

  const categoryOptions = [
    { value: 'all', label: 'All Categories' },
    ...Array.from(new Set(countdowns.map(c => c.category).filter(Boolean))).sort().map(cat => ({ value: cat, label: cat })),
  ];
  const sortOptions = [
    { value: 'endDate', label: 'End Date' },
    { value: 'progress', label: 'Progress' },
    { value: 'name', label: 'Name' },
    { value: 'priority', label: 'Priority' },
  ];

  const togglePriorityFilter = (key) => {
    setFilterPriorities(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  // Filter → sort → float the pinned card to the top. The two sorts stay separate
  // (JS sort is stable, so the pin pass preserves the primary sort order).
  const finalList = useMemo(() => {
    const list = countdowns.filter(c => {
      if (filterCategory !== 'all' && c.category !== filterCategory) return false;
      if (filterPriorities.size > 0 && !filterPriorities.has(c.priority)) return false;
      return true;
    });
    list.sort((a, b) => {
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'priority') return (PRIORITY_ORDER[a.priority] ?? 3) - (PRIORITY_ORDER[b.priority] ?? 3);
      if (sortBy === 'progress') return computeCd(b).pct - computeCd(a).pct;
      return new Date(a.endDate) - new Date(b.endDate);
    });
    list.sort((a, b) => {
      if (a.id === pinnedId) return -1;
      if (b.id === pinnedId) return 1;
      return 0;
    });
    return list;
  }, [countdowns, filterCategory, filterPriorities, sortBy, pinnedId]);

  const handleSave = (data) => {
    const isEdit = !!editingCd;
    const changes = isEdit ? diffObjects(editingCd, data, ['name', 'category', 'priority', 'notes', 'startDate', 'endDate']) : null;
    logActivity({ module: 'countdowns', entity_type: 'countdown', entity_id: data.id, action: isEdit ? 'updated' : 'created', title: data.name, field_changes: changes });
    setCountdowns(prev => isEdit ? prev.map(c => c.id === data.id ? data : c) : [data, ...prev]);
    setShowModal(false);
    setEditingCd(null);
  };

  const openEdit  = (cd) => { setEditingCd(cd); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditingCd(null); };

  const deleteCountdown = (id) => {
    const cd = countdowns.find(c => c.id === id);
    if (cd) logActivity({ module: 'countdowns', entity_type: 'countdown', entity_id: id, action: 'deleted', title: cd.name });
    setCountdowns(prev => prev.filter(c => c.id !== id));
    if (pinnedId === id) setPinnedId(null);
  };

  const toggleComplete = (id) => {
    const cd = countdowns.find(c => c.id === id);
    if (cd) logActivity({
      module: 'countdowns', entity_type: 'countdown', entity_id: id,
      action: cd.completed ? 'updated' : 'completed', title: cd.name,
      field_changes: cd.completed ? [{ field: 'completed', from: 'true', to: 'false' }] : null,
    });
    setCountdowns(prev => prev.map(c => c.id === id ? { ...c, completed: !c.completed } : c));
  };

  const togglePin = (id) => {
    setPinnedId(prev => prev === id ? null : id);
  };

  return (
    <div className="cdp-page">
      <div className="cdp-stats">
        <StatCard icon={<CdIcoLayers />} label="Total" value={totalCount} sub="All time" />
        <StatCard icon={<CdIcoActivity />} label="Active" value={activeCount} sub="In progress" />
        <StatCard icon={<CdIcoAlertTriangle />} label="Overdue" value={overdueCount}
          sub={overdueCount > 0 ? 'Need attention' : 'All caught up'} warn={overdueCount > 0} />
        <StatCard icon={<CdIcoTrendingUp />} label="Avg Progress" value={`${avgPct}%`} sub="All countdowns" />
      </div>

      {countdowns.length > 0 && (
        <div className="cdp-filterbar">
          <div className="cdp-filter-group">
            <span className="cdp-filter-label">Category</span>
            <Select value={filterCategory} onChange={e => setFilterCategory(e.target.value)} options={categoryOptions} style={SELECT_PILL_STYLE} />
            <span className="cdp-filter-label">Priority</span>
            <div className="cdp-segment">
              {Object.entries(PRIORITY_META).map(([key, m]) => (
                <button
                  key={key}
                  type="button"
                  className={`cdp-segment-btn${filterPriorities.has(key) ? ' cdp-segment-btn-active' : ''}`}
                  style={filterPriorities.has(key) ? { background: m.color+'1a', color: m.color } : {}}
                  onClick={() => togglePriorityFilter(key)}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
          <div className="cdp-filter-group">
            <span className="cdp-filter-label">Sort</span>
            <Select value={sortBy} onChange={e => setSortBy(e.target.value)} options={sortOptions} style={{ ...SELECT_PILL_STYLE, width: 150 }} />
            <span className="cdp-count-label">{finalList.length} of {totalCount} shown</span>
            {/* Add Countdown — primary action, moved here from the removed page header */}
            <button className="add-task-btn" onClick={() => setShowModal(true)}>＋ Add Countdown</button>
          </div>
        </div>
      )}

      {countdowns.length === 0 ? (
        <div className="cdp-empty">
          <div className="cdp-empty-orb" aria-hidden="true"><CdIcoHourglass size={32} /></div>
          <p className="cdp-empty-title">Track your first countdown</p>
          <p className="cdp-empty-sub">Watch the time between a start and end date tick by</p>
          <button className="hv-new-btn cdp-empty-btn" onClick={() => setShowModal(true)}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Add Countdown
          </button>
        </div>
      ) : finalList.length === 0 ? (
        <div className="cdp-empty">
          <p className="cdp-empty-title">No countdowns match these filters</p>
          <p className="cdp-empty-sub">Try clearing the category or priority filters</p>
        </div>
      ) : (
        <div className="cdp-grid">
          {finalList.map(cd => (
            <CountdownRow
              key={cd.id}
              cd={cd}
              pinned={cd.id === pinnedId}
              onEdit={openEdit}
              onDelete={deleteCountdown}
              onToggleComplete={toggleComplete}
              onTogglePin={togglePin}
            />
          ))}
        </div>
      )}

      {showModal && (
        <CountdownModal
          onSave={handleSave}
          onClose={closeModal}
          editCd={editingCd}
          onDelete={editingCd ? () => { deleteCountdown(editingCd.id); closeModal(); } : null}
        />
      )}
    </div>
  );
});

// ─── SVG progress ring ────────────────────────────────────────────────
function Ring({ pct, size = 56, stroke = 5, color = 'var(--accent)', children }) {
  const clamped = Math.min(100, Math.max(0, pct || 0));
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const offset = c - (clamped / 100) * c;
  return (
    <div className="cdp-ring" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size/2} cy={size/2} r={r} fill="none" stroke="var(--ring-track)" strokeWidth={stroke} />
        <circle
          cx={size/2} cy={size/2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={offset} strokeLinecap="round"
          transform={`rotate(-90 ${size/2} ${size/2})`}
          className="cdp-ring-arc"
        />
      </svg>
      {children && <div className="cdp-ring-center">{children}</div>}
    </div>
  );
}

// ─── Summary stat card (compact, single dense row) ───────────────────
function StatCard({ icon, label, value, sub, warn }) {
  return (
    <div className="cdp-stat">
      <span className="cdp-stat-icon" style={{ background: warn ? 'rgba(239,68,68,0.12)' : 'var(--accent-glow)', color: warn ? 'var(--color-red)' : 'var(--accent)' }}>{icon}</span>
      <div className="cdp-stat-body">
        <span className="cdp-stat-label">{label}</span>
        <div className="cdp-stat-numrow">
          <span className="cdp-stat-value">{value}</span>
          {sub && <span className={`cdp-stat-sub${warn ? ' cdp-stat-sub-warn' : ''}`}>{sub}</span>}
        </div>
      </div>
    </div>
  );
}

// ─── Start → today → end timeline ─────────────────────────────────────
function TimelineBar({ startDate, endDate, pct, daysRemaining, overdueDays, status }) {
  const clamped = Math.min(100, Math.max(0, pct));
  const overdue = status === 'overdue';
  return (
    <div className="cdp-timeline">
      <div className="cdp-timeline-track">
        <div
          className="cdp-timeline-fill"
          style={{ width: `${clamped}%`, background: overdue ? 'linear-gradient(90deg,#f87171,#ef4444)' : 'linear-gradient(90deg, var(--accent-light), var(--accent))' }}
        />
        <span className="cdp-timeline-marker" style={{ left: `${clamped}%` }} title="Today" />
      </div>
      <div className="cdp-timeline-labels">
        <span>{fmtCdDate(startDate)}</span>
        <span className={`cdp-timeline-mid${overdue ? ' cdp-timeline-mid-overdue' : ''}`}>
          {overdue ? `${overdueDays}d overdue` : `${daysRemaining}d left`}
        </span>
        <span>{fmtCdDate(endDate)}</span>
      </div>
    </div>
  );
}

// ─── Countdown row card ──────────────────────────────────────────────
function CountdownRow({ cd, pinned, onEdit, onDelete, onToggleComplete, onTogglePin }) {
  const [notesOpen, setNotesOpen] = useState(false);
  const { daysRemaining, pct, status, overdueDays, nextMs } = computeCd(cd);
  const meta = STATUS_META[status];
  const priority = PRIORITY_META[cd.priority] || PRIORITY_META.medium;
  const catColor = categoryColor(cd.category);
  const ringColor = status === 'overdue' ? 'var(--color-red)' : status === 'completed' ? '#2563eb' : 'var(--accent)';

  const notes = cd.notes || '';
  const notesTruncated = notes.length > 60 ? notes.slice(0, 60) + '…' : notes;

  return (
    <div className={`cdp-row${pinned ? ' cdp-row-pinned' : ''}${status === 'overdue' ? ' cdp-row-overdue' : ''}`}>
      <div className="cdp-row-head">
        <Ring pct={pct} size={44} stroke={4} color={ringColor}>
          <span className="cdp-ring-pct">{pct}%</span>
        </Ring>
        <div className="cdp-row-titlecol">
          <h3 className="cdp-name">{pinned && <CdIcoStar />}{cd.name}</h3>
          <div className="cdp-row-badges">
            {cd.category && (
              <span className="cdp-pill" style={{ background: catColor+'16', color: catColor }}>{cd.category}</span>
            )}
            <span className="cdp-pill" style={{ background: priority.color+'16', color: priority.color }}>{priority.label}</span>
          </div>
        </div>
        <span className="cdp-status-badge" style={{ background: meta.bg, color: meta.color }}>
          <span className="cdp-status-dot" style={{ background: meta.color }} />
          {meta.label}
        </span>
      </div>

      {notes && (
        <p className="cdp-notes-line" title={notes} onClick={() => setNotesOpen(o => !o)}>
          {notesOpen ? notes : notesTruncated}
        </p>
      )}

      <TimelineBar
        startDate={cd.startDate} endDate={cd.endDate} pct={pct}
        daysRemaining={daysRemaining} overdueDays={overdueDays} status={status}
      />

      <div className="cdp-row-footer">
        <div className="cdp-ms-line">
          <CdIcoFlag />
          {nextMs
            ? <span><strong>{nextMs.name}</strong> · {fmtCdDate(nextMs.targetDate)}</span>
            : <span className="cdp-ms-line-muted">No milestones</span>}
        </div>
        <div className="cdp-row-actions">
          <button
            className={`cdp-cta${pinned ? ' cdp-cta-pinned' : ' cdp-cta-primary'}`}
            onClick={() => onTogglePin(cd.id)}
          >
            <CdIcoZap /> {pinned ? 'Pinned' : 'Active'}
          </button>
          <div className="cdp-icon-group">
            <button className="cdp-icon-btn" onClick={() => onEdit(cd)} title="Edit"><CdIcoPencil /></button>
            <button
              className={`cdp-icon-btn${cd.completed ? ' cdp-icon-btn-active' : ''}`}
              onClick={() => onToggleComplete(cd.id)}
              title={cd.completed ? 'Mark incomplete' : 'Mark complete'}
            >
              <CdIcoCheck />
            </button>
            <button className="cdp-icon-btn cdp-icon-btn-danger" onClick={() => { if (confirm('Delete this countdown?')) onDelete(cd.id); }} title="Delete"><CdIcoTrash /></button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Add / Edit modal ──────────────────────────────────────────────
function CountdownModal({ onSave, onClose, editCd = null, onDelete }) {
  const isEdit = !!editCd;
  const startRef = useRef(null);
  const endRef = useRef(null);
  const msDateRefs = useRef({});
  const submittingRef = useRef(false); // guards a same-frame double-submit (double-Enter/double-click)

  const [form, setForm] = useState(() => isEdit ? {
    name: editCd.name,
    category: editCd.category || 'Personal',
    priority: editCd.priority || 'medium',
    notes: editCd.notes || '',
    startDate: editCd.startDate,
    endDate: editCd.endDate,
    milestones: (editCd.milestones || []).map(m => ({ ...m })),
  } : {
    name: '', category: 'Personal', priority: 'medium', notes: '',
    startDate: todayLocal(), endDate: '', milestones: [],
  });
  const [customCat, setCustomCat] = useState(() => isEdit && !PRESET_CATEGORIES.includes(editCd.category) ? editCd.category : '');
  const [showCustomCat, setShowCustomCat] = useState(() => isEdit && !PRESET_CATEGORIES.includes(editCd.category || 'Personal'));
  const [error, setError] = useState('');

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const addMilestone = () => {
    setF('milestones', [...form.milestones, { id: genId(), name: '', targetDate: '' }]);
  };
  const updateMilestone = (id, field, val) => {
    setF('milestones', form.milestones.map(m => m.id === id ? { ...m, [field]: val } : m));
  };
  const removeMilestone = (id) => {
    setF('milestones', form.milestones.filter(m => m.id !== id));
  };

  const save = () => {
    if (submittingRef.current) return;
    if (!form.name.trim()) { setError('Name is required'); return; }
    if (!form.startDate || !form.endDate) { setError('Start and end dates are required'); return; }
    if (form.endDate < form.startDate) { setError('End date must be after start date'); return; }
    submittingRef.current = true;

    const milestones = form.milestones.filter(m => m.name.trim() && m.targetDate);

    const data = {
      name: form.name.trim(),
      category: (form.category === 'Other' ? customCat.trim() : form.category) || 'Other',
      priority: form.priority,
      notes: form.notes.trim().slice(0, 500),
      startDate: form.startDate,
      endDate: form.endDate,
      milestones,
    };
    onSave(isEdit ? { ...editCd, ...data } : makeCountdown(data));
  };

  const notesLen = form.notes.length;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box modal-box-wide cdp-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cdp-modal-hdr">
          <div className="cdp-modal-hdr-left">
            <span className="cdp-modal-hdr-icon"><CdIcoHourglassSm /></span>
            <div>
              <span className="cdp-modal-eyebrow">Time Tracking</span>
              <h3 className="cdp-modal-title">{isEdit ? 'Edit Countdown' : 'New Countdown'}</h3>
            </div>
          </div>
          <button className="cdp-modal-close" onClick={onClose} aria-label="Close"><CdIcoX /></button>
        </div>

        <div className="cdp-modal-body">
          <div className="cdp-field">
            <label className="cdp-field-label">Name <span className="req">*</span></label>
            <input
              autoFocus
              className={`cdp-input${error && !form.name.trim() ? ' cdp-input-error' : ''}`}
              value={form.name}
              onChange={e => { setF('name', e.target.value); if (error) setError(''); }}
              placeholder="e.g. Trip to Japan"
            />
          </div>

          <div className="cdp-field">
            <label className="cdp-field-label">Category</label>
            <div className="cdp-chip-wrap">
              {PRESET_CATEGORIES.map(cat => {
                const active = form.category === cat && !showCustomCat;
                return (
                  <button key={cat} type="button"
                    className={`cdp-chip${active ? ' cdp-chip-active' : ''}`}
                    style={active ? { background: categoryColor(cat)+'1f', borderColor: categoryColor(cat)+'66', color: categoryColor(cat) } : {}}
                    onClick={() => { setF('category', cat); setShowCustomCat(false); }}
                  >
                    <span className="cdp-chip-dot" style={{ background: categoryColor(cat) }} />
                    {cat}
                  </button>
                );
              })}
              <button type="button"
                className={`cdp-chip${showCustomCat ? ' cdp-chip-active' : ''}`}
                style={showCustomCat ? { background: categoryColor('Other')+'1f', borderColor: categoryColor('Other')+'66', color: categoryColor('Other') } : {}}
                onClick={() => { setShowCustomCat(true); setF('category', 'Other'); }}
              >
                <span className="cdp-chip-dot" style={{ background: categoryColor('Other') }} />
                Other
              </button>
            </div>
            {showCustomCat && (
              <input
                className="cdp-input"
                style={{ marginTop: 8 }}
                value={customCat}
                onChange={e => setCustomCat(e.target.value)}
                placeholder="Custom category name…"
              />
            )}
          </div>

          <div className="cdp-field">
            <label className="cdp-field-label">Priority</label>
            <div className="cdp-seg-bar">
              {Object.entries(PRIORITY_META).map(([key, m]) => (
                <button key={key} type="button"
                  className={`cdp-seg-bar-btn${form.priority === key ? ' cdp-seg-bar-btn-active' : ''}`}
                  style={form.priority === key ? { background: m.color+'1f', color: m.color } : {}}
                  onClick={() => setF('priority', key)}
                >
                  <span className="cdp-seg-dot" style={{ background: m.color }} />
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="cdp-field">
            <label className="cdp-field-label">Notes <span className="cdp-field-opt">optional</span></label>
            <textarea
              className="cdp-input cdp-textarea"
              rows={3}
              maxLength={500}
              value={form.notes}
              onChange={e => setF('notes', e.target.value.slice(0, 500))}
              placeholder="Trip itinerary, project description, anything worth remembering…"
              spellCheck="true"
              autoCorrect="on"
            />
            <span className="cdp-char-count">{notesLen}/500</span>
          </div>

          <div className="cdp-field-row">
            <div className="cdp-field">
              <label className="cdp-field-label">Start Date</label>
              <div className="tdp-date-wrap">
                <div className="cdp-date-display" onClick={() => openPicker(startRef)}>
                  <CdIcoCalendar />
                  <span>{form.startDate ? fmtCdDate(form.startDate) : 'Choose a date'}</span>
                </div>
                <input ref={startRef} type="date" className="tdp-date-hidden" value={form.startDate} onChange={e => setF('startDate', e.target.value)} />
              </div>
            </div>
            <div className="cdp-field">
              <label className="cdp-field-label">End Date</label>
              <div className="tdp-date-wrap">
                <div className="cdp-date-display" onClick={() => openPicker(endRef)}>
                  <CdIcoCalendar />
                  <span>{form.endDate ? fmtCdDate(form.endDate) : 'Choose a date'}</span>
                </div>
                <input ref={endRef} type="date" className="tdp-date-hidden" value={form.endDate} onChange={e => setF('endDate', e.target.value)} />
              </div>
            </div>
          </div>

          <div className="cdp-field">
            <label className="cdp-field-label">Milestones <span className="cdp-field-opt">optional</span></label>
            {form.milestones.length > 0 && (
              <div className="cdp-ms-edit-list">
                {form.milestones.map((m) => (
                  <div key={m.id} className="cdp-ms-edit-row">
                    <input
                      className="cdp-input"
                      value={m.name}
                      onChange={e => updateMilestone(m.id, 'name', e.target.value)}
                      placeholder="Milestone name…"
                    />
                    <div className="tdp-date-wrap cdp-ms-edit-date">
                      <div
                        className="cdp-date-display"
                        onClick={() => openPicker({ current: msDateRefs.current[m.id] })}
                      >
                        <span>{m.targetDate ? fmtCdDate(m.targetDate) : 'Date'}</span>
                      </div>
                      <input
                        ref={el => { msDateRefs.current[m.id] = el; }}
                        type="date"
                        className="tdp-date-hidden"
                        value={m.targetDate}
                        onChange={e => updateMilestone(m.id, 'targetDate', e.target.value)}
                      />
                    </div>
                    <button type="button" className="cdp-ms-del" onClick={() => removeMilestone(m.id)} aria-label="Remove milestone"><CdIcoX /></button>
                  </div>
                ))}
              </div>
            )}
            <button type="button" className="cdp-add-ms-btn" onClick={addMilestone}>
              <CdIcoPlus /> Add Milestone
            </button>
          </div>

          {error && <span className="cdp-form-error"><CdIcoAlertTriangle /> {error}</span>}
        </div>

        <div className="cdp-modal-footer">
          {onDelete && (
            <button type="button" className="cdp-delete-btn" onClick={() => { if (confirm('Delete this countdown?')) onDelete(); }}>
              <CdIcoTrash /> Delete
            </button>
          )}
          <div className="cdp-modal-footer-right">
            <button className="cdp-btn-cancel" onClick={onClose}>Cancel</button>
            <button className="cdp-btn-save" disabled={!form.name.trim()} onClick={save}>
              {isEdit ? 'Save Changes' : 'Create Countdown'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Inline icons ──────────────────────────────────────────────────
function CdIcoHourglass({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2h14"/><path d="M5 22h14"/>
      <path d="M5 2c0 6 6 6 6 10s-6 4-6 10"/><path d="M19 2c0 6-6 6-6 10s6 4 6 10"/>
    </svg>
  );
}
function CdIcoStar() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="#f59e0b" stroke="#f59e0b" strokeWidth="1" style={{ marginRight: 5, verticalAlign: -2 }}>
      <polygon points="12 2 15.09 8.63 22 9.24 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.24 8.91 8.63"/>
    </svg>
  );
}
function CdIcoPencil() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
    </svg>
  );
}
function CdIcoTrash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6"/>
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
    </svg>
  );
}
function CdIcoCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}
function CdIcoPlus() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"/>
      <line x1="5" y1="12" x2="19" y2="12"/>
    </svg>
  );
}
function CdIcoLayers() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 2 7 12 12 22 7 12 2"/>
      <polyline points="2 17 12 22 22 17"/>
      <polyline points="2 12 12 17 22 12"/>
    </svg>
  );
}
function CdIcoActivity() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>
    </svg>
  );
}
function CdIcoAlertTriangle() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
      <line x1="12" y1="9" x2="12" y2="13"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}
function CdIcoTrendingUp() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/>
      <polyline points="17 6 23 6 23 12"/>
    </svg>
  );
}
function CdIcoFlag() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/>
      <line x1="4" y1="22" x2="4" y2="15"/>
    </svg>
  );
}
function CdIcoZap() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" stroke="none">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
    </svg>
  );
}
function CdIcoHourglassSm() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 2h14"/><path d="M5 22h14"/>
      <path d="M5 2c0 6 6 6 6 10s-6 4-6 10"/><path d="M19 2c0 6-6 6-6 10s6 4 6 10"/>
    </svg>
  );
}
function CdIcoX() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  );
}
function CdIcoCalendar() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.7 }}>
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}
