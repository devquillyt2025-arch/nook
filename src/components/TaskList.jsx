import { useState, useMemo, useRef, useEffect, useLayoutEffect, useCallback, memo } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { CAT_META } from '../utils/categoryMeta';
import { PRI_META } from '../utils/priorityMeta';
import ErrorBoundary from './ErrorBoundary';
import Select from './Select';
import ReminderField from './ReminderField';
import CalendarDatePicker from './CalendarDatePicker';
import { syncTaskField } from '../utils/googleTasksSync';


const PRI_ORDER = { high: 0, medium: 1, low: 2, none: 3 };

const SORT_OPTIONS = [
  { value: 'due',      label: 'Due Date'  },
  { value: 'priority', label: 'Priority'  },
  { value: 'created',  label: 'Created'   },
  { value: 'az',       label: 'A → Z'     },
];
const LS_SORT_KEY = 'nook_task_sort';

function fmtTime(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function fmtDue(dateStr) {
  if (!dateStr) return null;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const due   = new Date(dateStr + 'T00:00:00');
  const diff  = Math.round((due - today) / 86400000);
  if (diff < 0) {
    const label = due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    return { text: label, overdue: true, color: 'var(--color-red)', fontWeight: 600 };
  }
  if (diff === 0) return { text: 'Today',    overdue: false, color: 'var(--color-amber)', fontWeight: 600 };
  if (diff === 1) return { text: 'Tomorrow', overdue: false, color: 'var(--color-amber)', fontWeight: 600 };
  if (diff <= 7)  return { text: `In ${diff} days`, overdue: false, color: 'var(--text-secondary)', fontWeight: 500 };
  return {
    text: due.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    overdue: false, color: 'var(--text-secondary)', fontWeight: 500,
  };
}

// Returns local-date today as YYYY-MM-DD — kept consistent with fmtDue's local-time logic
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Deadline-urgency bar value — DERIVED at render time from the due date's full
// calendar day. Never stored on the task or synced. The range is FIXED to the
// due day itself (local midnight → local end-of-day), independent of createdAt
// or when the page loaded, so the bar means the same thing on every render.
// Returns null when there's nothing to show (task done or no dueDate).
function computeUrgency(task, nowMs, isDone) {
  if (isDone || !task.dueDate) return null;
  const dayStart = new Date(task.dueDate + 'T00:00:00').getTime(); // 12:00:00 AM local, due date
  const dayEnd   = new Date(task.dueDate + 'T23:59:59').getTime(); // 11:59:59 PM local, due date
  if (!Number.isFinite(dayStart) || !Number.isFinite(dayEnd)) return null;
  // Past the end of the due day → expired: full red bar (also covers Overdue tasks
  // sharing this component). Before the due day → clamps to 0% (empty bar).
  if (nowMs > dayEnd) return { pct: 100, color: 'var(--color-red)' };
  const pct = Math.min(100, Math.max(0, ((nowMs - dayStart) / (dayEnd - dayStart)) * 100));
  const color = pct < 60 ? 'var(--accent)'
              : pct <= 90 ? 'var(--color-amber)'
              : 'var(--color-orange)';
  return { pct, color };
}

// normalise display name
function displayName(name) {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\b(\w+)\b/g, (w, match, offset) => {
    if (w.length > 1 && w === w.toUpperCase()) return w; // keep all-caps acronyms intact
    if (offset === 0) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    if (w.length > 1 && w.slice(1) !== w.slice(1).toLowerCase()) {
      return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }
    return w;
  });
}

function TaskRow({
  task,
  isDone,
  now,
  activeTaskId,
  timerRunning,
  confirmDeleteId,
  setConfirmDeleteId,
  kebabOpenId,
  setKebabOpenId,
  openDetail,
  onToggle,
  onDelete,
  onQuickUpdate,
  onUpdate,
  setShowDatePicker,
  ALL_CATS,
  handleNewList,
}) {
  const meta = CAT_META[task.category] ?? CAT_META.work;
  const isActive = task.id === activeTaskId;
  const isConfirming = confirmDeleteId === task.id;
  const due = fmtDue(task.dueDate);
  const isOverdue = !isDone && due?.overdue;
  const priColor = !isDone && task.priority !== 'none' ? (PRI_META[task.priority]?.color ?? null) : null;
  const cardBorderLeft = priColor ? `4px solid ${priColor}` : '4px solid transparent';
  const urgency = computeUrgency(task, now, isDone);

  // ── Kebab menu positioning ──
  // The menu is portalled to <body> so the pending-list scroll container can't
  // clip it. Position is derived from the button's viewport rect, flipping above
  // the button when there isn't room below.
  const kebabBtnRef = useRef(null);
  const menuOpen = kebabOpenId === task.id;
  const [menuPos, setMenuPos] = useState(null);
  useLayoutEffect(() => {
    if (!menuOpen || !kebabBtnRef.current) return;
    const rect = kebabBtnRef.current.getBoundingClientRect();
    const MENU_W = 224;
    const spaceBelow = window.innerHeight - rect.bottom;
    const openUp = spaceBelow < 360 && rect.top > spaceBelow;
    setMenuPos({
      left: Math.max(8, Math.min(rect.right - MENU_W, window.innerWidth - MENU_W - 8)),
      top:    openUp ? null : Math.round(rect.bottom + 6),
      bottom: openUp ? Math.round(window.innerHeight - rect.top + 6) : null,
    });
  }, [menuOpen]);
  // Close on scroll/resize so the fixed dropdown can't drift from its button.
  useEffect(() => {
    if (!menuOpen) return;
    const close = () => setKebabOpenId(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [menuOpen, setKebabOpenId]);

  const menuItemStyle = { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', borderRadius: 8, background: 'transparent', border: 'none', color: 'var(--text-primary)', cursor: 'pointer', width: '100%', textAlign: 'left', fontSize: '0.875rem', fontWeight: 500, fontFamily: 'inherit' };

  return (
    <motion.div
      key={task.id}
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, x: -16 }}
      transition={{ duration: 0.18, ease: 'easeOut' }}
      className={`linear-task-row${isActive ? ' task-active' : ''}${isDone ? ' item-completed' : ''}`}
      onClick={() => { if (!isConfirming) openDetail(task); }}
      title={timerRunning && !isActive && !isConfirming ? 'Pause timer to switch tasks' : undefined}
      style={{ borderLeft: cardBorderLeft }}
    >
      {isConfirming ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', padding: '0 8px' }}>
          <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>Delete this task?</span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            <button type="button" style={{ background: 'transparent', border: 'none', color: 'var(--color-red)', fontSize: '13px', fontWeight: 'bold', cursor: 'pointer', padding: 0 }}
              onClick={e => { e.stopPropagation(); onDelete(task.id); setConfirmDeleteId(null); }}>Yes</button>
            <button type="button" style={{ background: 'transparent', border: 'none', color: 'var(--text-secondary)', fontSize: '13px', cursor: 'pointer', padding: 0 }}
              onClick={e => { e.stopPropagation(); setConfirmDeleteId(null); }}>Cancel</button>
          </div>
        </div>
      ) : (
        <>
          {/* Checkbox — circular, fills with category color when checked */}
          <div
            className={`linear-checkbox${isDone ? ' checked' : ''}`}
            role="checkbox"
            aria-checked={isDone}
            tabIndex={0}
            style={{ '--cat': meta.color }}
            onClick={e => { e.stopPropagation(); onToggle(task.id); }}
            onKeyDown={e => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); onToggle(task.id); } }}
            aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
          >
            {isDone && (
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
            )}
          </div>

          {/* Task Title (Flexible width, wins layout fight) */}
          <div className="linear-task-title-container">
            <span className="linear-task-title" title={task.name}>{displayName(task.name)}</span>
          </div>

          {/* Inline Icons (recurrence, subtasks, attachments, notes, time logged, pomodoros, conflict) */}
          <div className="linear-task-icons">
            {task.recurrence && (
              <span className="linear-inline-meta" title={`Repeats ${task.recurrence}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="17 1 21 5 17 9"/>
                  <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
                  <polyline points="7 23 3 19 7 15"/>
                  <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
                </svg>
              </span>
            )}
            {task.subtasks?.length > 0 && (
              <span className="linear-inline-meta" title={`Subtasks: ${task.subtasks.filter(s => s.completed).length}/${task.subtasks.length}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>
                </svg>
                <span>{task.subtasks.filter(s => s.completed).length}/{task.subtasks.length}</span>
              </span>
            )}
            {task.attachments?.length > 0 && (
              <span className="linear-inline-meta" title={`${task.attachments.length} attachment${task.attachments.length > 1 ? 's' : ''}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                </svg>
                <span>{task.attachments.length}</span>
              </span>
            )}
            {task.timeLogged > 0 && (
              <span className="linear-inline-meta" title={`Time logged: ${fmtTime(task.timeLogged)}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                </svg>
                <span>{fmtTime(task.timeLogged)}</span>
              </span>
            )}
            {task.pomodorosCompleted > 0 && (
              <span className="linear-inline-meta" title={`Pomodoros completed: ${task.pomodorosCompleted}`}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/>
                </svg>
                <span>{task.pomodorosCompleted}</span>
              </span>
            )}
            {task.notes && (
              <span className="linear-inline-meta tc-notes-icon" title={task.notes.length > 120 ? task.notes.slice(0, 120) + '…' : task.notes} aria-label="Has notes">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="16" y1="13" x2="8" y2="13"/>
                  <line x1="16" y1="17" x2="8" y2="17"/>
                  <polyline points="10 9 9 9 8 9"/>
                </svg>
              </span>
            )}
            {task.syncConflict && (
              <span className="linear-inline-meta" style={{ color: 'var(--color-amber, #f59e0b)' }} title={task.syncConflict}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                <span>Conflict</span>
              </span>
            )}
          </div>

          {/* Category — color-coded pill */}
          <div className="linear-task-cat">
            <span className="linear-cat-badge" style={{ background: meta.color + '16', color: meta.color }}>
              <span className="linear-cat-badge-dot" style={{ background: meta.color }} />
              {meta.label}
            </span>
          </div>

          {/* Date — consistent column: date (urgency-colored) + Overdue tag, or "No due date" placeholder */}
          <div className="linear-task-due">
            {due ? (
              <span className="ltd-date" style={{ color: !isDone ? due.color : undefined, fontWeight: !isDone ? due.fontWeight : undefined }}>{due.text}</span>
            ) : (
              <span className="ltd-empty">No due date</span>
            )}
            {isOverdue && <span className="ltd-overdue-tag">Overdue</span>}
          </div>

          {/* Actions (Star & Kebab menu, shrunk to fit row height) */}
          <div className="linear-task-actions">
            {/* Star Button */}
            <button
              type="button"
              className="linear-action-btn star-btn"
              style={{ color: task.starred ? 'var(--color-amber, #f59e0b)' : 'var(--text-secondary)' }}
              onClick={e => { e.stopPropagation(); (onQuickUpdate || onUpdate)({ ...task, starred: !task.starred }); }}
              aria-label={task.starred ? 'Unstar task' : 'Star task'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill={task.starred ? 'var(--color-amber, #f59e0b)' : 'none'} stroke={task.starred ? 'var(--color-amber, #f59e0b)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
              </svg>
            </button>

            {/* Kebab Menu Button */}
            <button
              ref={kebabBtnRef}
              type="button"
              className="linear-action-btn kebab-btn"
              style={{ background: menuOpen ? 'var(--bg-hover)' : 'transparent', color: 'var(--text-secondary)' }}
              onClick={e => { e.stopPropagation(); setKebabOpenId(menuOpen ? null : task.id); }}
              aria-label="More actions"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="1"/><circle cx="12" cy="5" r="1"/><circle cx="12" cy="19" r="1"/>
              </svg>
            </button>

            {/* Dropdown Menu — portalled to <body> so the pending-list scroll
                container can't clip it. Positioned from the button rect (menuPos).
                onMouseDown stopPropagation keeps the outside-click handler from
                closing it before an item's onClick fires. */}
            {menuOpen && menuPos && createPortal(
              <div
                className="kebab-dropdown-menu"
                onMouseDown={e => e.stopPropagation()}
                style={{
                  position: 'fixed', left: menuPos.left,
                  ...(menuPos.top != null ? { top: menuPos.top } : { bottom: menuPos.bottom }),
                  zIndex: 1000, width: 224, maxHeight: '72vh', overflowY: 'auto',
                  background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)',
                  borderRadius: 14, boxShadow: '0 16px 40px rgba(0,0,0,0.4)', padding: 6,
                  display: 'flex', flexDirection: 'column', gap: 1, textAlign: 'left',
                  color: 'var(--text-primary)', fontSize: '0.875rem', fontWeight: 500,
                }}
              >
                <button
                  type="button" className="kebab-menu-item" style={menuItemStyle}
                  onClick={e => { e.stopPropagation(); setKebabOpenId(null); openDetail(task, 'scheduling'); setTimeout(() => setShowDatePicker(true), 120); }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                  Add deadline
                </button>
                <button
                  type="button" className="kebab-menu-item" style={menuItemStyle}
                  onClick={e => { e.stopPropagation(); setKebabOpenId(null); openDetail(task, 'subtasks'); setTimeout(() => { const el = document.getElementById('subtask-input'); el?.focus(); }, 120); }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>
                  Add a subtask
                </button>
                <button
                  type="button" className="kebab-menu-item" style={menuItemStyle}
                  onClick={e => { e.stopPropagation(); setKebabOpenId(null); openDetail(task, 'details'); setTimeout(() => { const el = document.getElementById('attachment-input'); el?.click(); }, 120); }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  Add attachment
                </button>
                <button
                  type="button" className="kebab-menu-item" style={{ ...menuItemStyle, color: 'var(--color-red)' }}
                  onClick={e => { e.stopPropagation(); setKebabOpenId(null); setConfirmDeleteId(task.id); }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--color-red-bg, rgba(239,68,68,0.12))'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>
                  Delete
                </button>

                <div style={{ height: 1, background: 'var(--border)', margin: '5px 4px' }} />
                <div style={{ padding: '4px 10px 4px', fontSize: '0.68rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)' }}>Move to list</div>

                {/* List selection */}
                {ALL_CATS.map(catKey => {
                  const isCur = task.category === catKey;
                  const cMeta = CAT_META[catKey];
                  return (
                    <button
                      key={catKey}
                      type="button"
                      className="kebab-menu-item"
                      style={menuItemStyle}
                      onClick={e => { e.stopPropagation(); setKebabOpenId(null); (onQuickUpdate || onUpdate)({ ...task, category: catKey }); }}
                      onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                    >
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: cMeta?.color, flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{cMeta?.label}</span>
                      {isCur && <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                    </button>
                  );
                })}

                <button
                  type="button"
                  className="kebab-menu-item"
                  style={{ ...menuItemStyle, color: 'var(--text-secondary)' }}
                  onClick={e => { e.stopPropagation(); handleNewList(task); }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                  New list
                </button>
              </div>,
              document.body
            )}
          </div>

          {/* Deadline-urgency bar — derived, absolutely positioned, does not affect
              layout/height. Clip layer (not overflow on the row) keeps the kebab
              dropdown from being clipped. */}
          {urgency && (
            <div aria-hidden="true" style={{ position: 'absolute', inset: 0, borderRadius: 10, overflow: 'hidden', pointerEvents: 'none' }}>
              <div style={{ position: 'absolute', bottom: 0, left: 0, height: 2, width: `${urgency.pct}%`, background: urgency.color, transition: 'width 500ms ease-out, background-color 500ms ease-out' }} />
            </div>
          )}
        </>
      )}
    </motion.div>
  );
}

function DonutChart({ pendingCount, completedCount }) {
  const R = 50, SW = 9;
  const C = 2 * Math.PI * R;
  const size = (R + SW) * 2 + 2;
  const cx = size / 2, cy = size / 2;

  const total = pendingCount + completedCount;
  const pendingArc   = total > 0 ? (pendingCount   / total) * C : C;
  const completedArc = total > 0 ? (completedCount / total) * C : 0;
  const pct = total > 0 ? Math.round((completedCount / total) * 100) : 0;

  return (
    <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
      <svg width={size} height={size} style={{ transform: 'rotate(-90deg)', display: 'block' }}>
        <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--ring-track)" strokeWidth={SW} />
        {total > 0 && pendingCount > 0 && (
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--accent)" strokeWidth={SW}
            strokeDasharray={`${pendingArc} ${C - pendingArc}`} strokeDashoffset={0} strokeLinecap="butt" />
        )}
        {completedCount > 0 && (
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="#10b981" strokeWidth={SW}
            strokeDasharray={`${completedArc} ${C - completedArc}`} strokeDashoffset={-pendingArc} strokeLinecap="butt" />
        )}
        {total === 0 && (
          <circle cx={cx} cy={cy} r={R} fill="none" stroke="var(--border-accent)" strokeWidth={SW} />
        )}
      </svg>
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 1 }}>
        <span style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--text-primary)', lineHeight: 1 }}>{pct}%</span>
        <span style={{ fontSize: '0.6rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Done</span>
      </div>
    </div>
  );
}

// Subsection header inside the pending list (Overdue / Today / Upcoming)
function SectionLabel({ title, count, color }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 4px 6px' }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
      <span style={{ fontSize: '0.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{title}</span>
      <span style={{ fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg-base)', borderRadius: 20, padding: '1px 8px' }}>{count}</span>
      <span style={{ flex: 1, height: 1, background: 'var(--border)' }} />
    </div>
  );
}

// One bordered card per pending group (Overdue / Today / Upcoming). Rendered
// only when it has tasks — empty groups are skipped by the caller.
function TaskGroupCard({ title, count, color, tasks, renderTask }) {
  return (
    <div style={{ background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: 12, padding: '2px 14px 10px', marginBottom: 12 }}>
      <SectionLabel title={title} count={count} color={color} />
      <AnimatePresence initial={false}>
        {tasks.map(task => renderTask(task, false))}
      </AnimatePresence>
    </div>
  );
}

const BASE_CATS = ['work', 'learning', 'fitness', 'mental', 'growth'];

function CompletionAnalytics({ pending, completed, onAdd, renderTask, onClearCompleted, catCounts }) {
  const [activeTab, setActiveTab] = useState('overview');
  const totalTasks = pending.length + completed.length;
  const completedPct = totalTasks > 0 ? Math.round((completed.length / totalTasks) * 100) : 0;
  // Show the base categories always (grayed out at 0) plus any custom list that has tasks —
  // sorted by count desc so active categories lead.
  const catKeys = Array.from(new Set([...BASE_CATS, ...Object.keys(catCounts)]));
  const catBreakdown = catKeys
    .map(k => [k, catCounts[k] || 0])
    .sort(([, a], [, b]) => b - a);
  const maxCatCount = Math.max(1, ...catBreakdown.map(([, c]) => c));

  return (
    <div className="yartu-card" style={{ display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '16px 20px', gap: 14, overflowY: 'auto' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
        <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 700, color: 'var(--text-primary)' }}>Completion Analytics</h3>
        <span style={{ fontSize: '0.65rem', fontWeight: 700, color: 'var(--color-green)', background: 'rgba(16,185,129,0.12)', padding: '2px 8px', borderRadius: 20, border: '1px solid rgba(16,185,129,0.25)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Live</span>
      </div>

      <div style={{ display: 'flex', gap: 3, background: 'var(--bg-base)', borderRadius: 10, padding: 3, flexShrink: 0 }}>
        {[{ id: 'overview', label: 'Overview' }, { id: 'completed', label: `Completed (${completed.length})` }].map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)} style={{
            flex: 1, padding: '6px 8px', borderRadius: 7, border: 'none', cursor: 'pointer',
            fontSize: '0.78rem', fontWeight: 600, transition: 'all 0.15s ease',
            background: activeTab === tab.id ? 'var(--bg-elevated)' : 'transparent',
            color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
            boxShadow: activeTab === tab.id ? '0 1px 4px rgba(0,0,0,0.25)' : 'none',
          }}>{tab.label}</button>
        ))}
      </div>

      {activeTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, justifyContent: 'center' }}>
            <DonutChart pendingCount={pending.length} completedCount={completed.length} />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
              <div style={{ background: 'var(--accent-glow)', borderRadius: 10, padding: '10px 14px', border: '1px solid var(--border-accent)' }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--accent-light)', lineHeight: 1 }}>{pending.length}</div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Pending</div>
              </div>
              <div style={{ background: 'var(--color-green-bg)', borderRadius: 10, padding: '10px 14px', border: '1px solid rgba(16,185,129,0.2)' }}>
                <div style={{ fontSize: '1.4rem', fontWeight: 800, color: 'var(--color-green)', lineHeight: 1 }}>{completed.length}</div>
                <div style={{ fontSize: '0.68rem', color: 'var(--text-secondary)', marginTop: 3, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Completed</div>
              </div>
            </div>
          </div>

          {totalTasks > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>Overall Progress</span>
                <span style={{ fontSize: '0.78rem', fontWeight: 700, color: completedPct === 100 ? 'var(--color-green)' : 'var(--text-secondary)' }}>{completedPct}%</span>
              </div>
              <div style={{ height: 7, background: 'var(--ring-track)', borderRadius: 99, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${completedPct}%`, background: completedPct === 100 ? 'var(--color-green)' : 'var(--accent-gradient)', borderRadius: 99, transition: 'width 0.5s ease', minWidth: completedPct > 0 ? 6 : 0 }} />
              </div>
            </div>
          )}

          {catBreakdown.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>By Category</span>
              {catBreakdown.map(([cat, count]) => {
                const meta = CAT_META[cat] ?? CAT_META.work;
                const empty = count === 0;
                const barPct = empty ? 0 : Math.max(8, (count / maxCatCount) * 100);
                return (
                  <div key={cat} className="ca-cat-row" style={{ opacity: empty ? 0.4 : 1 }}>
                    <span className="ca-cat-dot" style={{ background: empty ? 'var(--text-muted)' : meta.color }} />
                    <span className="ca-cat-label">{meta.label}</span>
                    <div className="ca-cat-track">
                      <div className="ca-cat-fill" style={{ width: `${barPct}%`, background: empty ? 'transparent' : `linear-gradient(90deg, ${meta.color}cc, ${meta.color})` }} />
                    </div>
                    <span className="ca-cat-count" style={{ color: empty ? 'var(--text-muted)' : 'var(--text-primary)', background: empty ? 'transparent' : meta.color + '16' }}>{count}</span>
                  </div>
                );
              })}
            </div>
          )}

          {totalTasks === 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '16px', textAlign: 'center', background: 'var(--bg-base)', borderRadius: 12, border: '1px solid var(--border)' }}>
              <span style={{ fontSize: '1.8rem' }}>🎯</span>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', lineHeight: 1.4 }}>Start your journey by adding your first task!</div>
              <button onClick={onAdd} style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '7px 18px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer' }}>＋ Add First Task</button>
            </div>
          )}
        </div>
      )}

      {activeTab === 'completed' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1, minHeight: 0 }}>
          {completed.length > 0 && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', flexShrink: 0 }}>
              <button onClick={() => { if (confirm(`Delete all ${completed.length} completed task${completed.length > 1 ? 's' : ''}?`)) onClearCompleted(); }} style={{ background: 'transparent', border: '1px solid rgba(239,68,68,0.3)', color: 'var(--color-red)', padding: '4px 12px', borderRadius: 7, fontSize: '0.73rem', fontWeight: 600, cursor: 'pointer' }}>Clear all</button>
            </div>
          )}
          <div style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
            {completed.length === 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10, padding: '28px 16px', textAlign: 'center' }}>
                <div style={{ width: 44, height: 44, borderRadius: '50%', background: 'var(--color-green-bg)', border: '1px solid rgba(16,185,129,0.2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                </div>
                <div>
                  <div style={{ fontSize: '0.875rem', fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>No completed tasks yet</div>
                  <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', lineHeight: 1.5 }}>Start checking off tasks to see them here!</div>
                </div>
              </div>
            ) : (
              <AnimatePresence initial={false}>
                {completed.map(task => renderTask(task, true))}
              </AnimatePresence>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function TaskList({ tasks, activeTaskId, timerRunning, onSelect, onToggle, onDelete, onClearCompleted, onAdd, onAddTask, onEdit, onUpdate, onQuickUpdate, syncStatus, onSyncNow, openTaskId, onOpenTaskIdHandled }) {
  const [customCats, setCustomCats] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('nook_custom_categories') || '{}');
      Object.assign(CAT_META, saved);
      return saved;
    } catch (e) { return {}; }
  });
  const ALL_CATS = useMemo(() => Object.keys(CAT_META), [customCats]);
  const [kebabOpenId,     setKebabOpenId]     = useState(null);
  const [catFilter,       setCatFilter]       = useState('all');
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [showCompleted,   setShowCompleted]   = useState(false);
  const [sortBy,          setSortBy]          = useState(() => localStorage.getItem(LS_SORT_KEY) || 'created');
  const [sortOpen,        setSortOpen]        = useState(false);
  const [query,           setQuery]           = useState('');
  const [detailTask,      setDetailTask]      = useState(null); // original snapshot
  const [local,           setLocal]           = useState(null); // editable copy
  const [savedFeedback,   setSavedFeedback]   = useState(false);
  const [catOpen,         setCatOpen]         = useState(false);
  const [inlineAddCat,    setInlineAddCat]    = useState(null);
  const [inlineAddText,   setInlineAddText]   = useState('');
  const [detailTab,       setDetailTab]       = useState('details'); // 'details' | 'scheduling' | 'subtasks'
  // Single tab-scoped clock that drives the deadline-urgency bar on every card
  // (one interval for the whole list, not one per row). 30s granularity is more
  // than enough for date-scale deadlines and avoids per-second re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, []);
  const sortRef      = useRef(null);
  const searchRef    = useRef(null);
  const savedTimerRef = useRef(null);
  const titleRef     = useRef(null);
  const notesRef     = useRef(null);
  const catMenuRef       = useRef(null);
  const datePickerRef    = useRef(null);
  const timePickerRef    = useRef(null);
  const skipBlurRef      = useRef(false); // prevents onBlur from firing after Escape in inline-add
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);
  // 'idle' | 'saving' | 'saved' | 'error' | 'offline'
  const [dueSyncStatus, setDueSyncStatus] = useState('idle');
  const dueSyncTimerRef = useRef(null);
  const saveDueTimeDebounceRef = useRef(null);

  // Close calendar picker on outside click
  useEffect(() => {
    if (!showDatePicker && !showTimePicker) return;
    const handler = (e) => {
      if (showDatePicker && datePickerRef.current && !datePickerRef.current.contains(e.target)) {
        setShowDatePicker(false);
      }
      if (showTimePicker && timePickerRef.current && !timePickerRef.current.contains(e.target)) {
        setShowTimePicker(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showDatePicker, showTimePicker]);

  const handleNewList = (taskToMove) => {
    const name = prompt('Enter new list name:');
    if (!name || !name.trim()) return;
    const label = name.trim();
    const key = label.toLowerCase().replace(/\s+/g, '_');
    if (!CAT_META[key]) {
      const colors = ['#8b5cf6', '#06b6d4', '#f97316', '#14b8a6', 'var(--accent)', '#ec4899'];
      const color = colors[Object.keys(CAT_META).length % colors.length];
      CAT_META[key] = { label, color };
      const updatedCustom = { ...customCats, [key]: { label, color } };
      localStorage.setItem('nook_custom_categories', JSON.stringify(updatedCustom));
      setCustomCats(updatedCustom);
    }
    if (taskToMove) {
      (onQuickUpdate || onUpdate)({ ...taskToMove, category: key });
    }
    setKebabOpenId(null);
  };

  // Close kebab dropdown on outside click
  useEffect(() => {
    if (!kebabOpenId) return;
    const h = () => setKebabOpenId(null);
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [kebabOpenId]);

  // Close sort dropdown on outside click
  useEffect(() => {
    if (!sortOpen) return;
    const handler = e => { if (!sortRef.current?.contains(e.target)) setSortOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [sortOpen]);

  // Close detail panel if the task is deleted externally
  useEffect(() => {
    if (detailTask && !tasks.find(t => t.id === detailTask.id)) {
      setDetailTask(null); setLocal(null);
    }
  }, [tasks, detailTask]);

  // Sync fields the panel doesn't own (status, timeLogged, etc.) when tasks prop updates while panel is open.
  // This prevents stale status showing after the timer or a toggle fires from outside the panel.
  useEffect(() => {
    if (!detailTask) return;
    const fresh = tasks.find(t => t.id === detailTask.id);
    if (!fresh) return;
    setLocal(prev => prev ? {
      ...prev,
      status: fresh.status,
      completed: fresh.completed,
      timeLogged: fresh.timeLogged,
      pomodorosCompleted: fresh.pomodorosCompleted,
      starred: fresh.starred,
    } : prev);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks]);

  // Escape key closes panel
  useEffect(() => {
    if (!detailTask) return;
    const handler = e => { if (e.key === 'Escape') closePanel(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTask, local]);

  // Close category dropdown on outside click
  useEffect(() => {
    if (!catOpen) return;
    const h = e => { if (!catMenuRef.current?.contains(e.target)) setCatOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [catOpen]);

  // Auto-focus title + sync notes height whenever a task opens in the panel
  useEffect(() => {
    if (!detailTask?.id) return;
    const t = setTimeout(() => titleRef.current?.focus(), 30);
    if (notesRef.current) {
      notesRef.current.style.height = 'auto';
      notesRef.current.style.height = notesRef.current.scrollHeight + 'px';
    }
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailTask?.id]);

  const showSaved = () => {
    setSavedFeedback(true);
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSavedFeedback(false), 1500);
  };

  // Immediately persist a field change and show inline feedback
  const saveField = (key, value) => {
    const updated = { ...local, [key]: value };
    setLocal(updated);
    (onQuickUpdate || onUpdate)(updated);
    showSaved();
  };

  // ── Due-date save with Google Tasks sync feedback ──────────────────
  // Saves locally first (optimistic), then fires a direct PATCH to Google Tasks.
  // On failure: shows an error badge + rolls back the local change.
  const saveDueDate = useCallback(async (newDate) => {
    const syncEnabled = localStorage.getItem('nook_sync_enabled') === 'true';
    const prevDate = local?.dueDate ?? '';
    const updated = { ...local, dueDate: newDate };

    // 1. Optimistic local save.
    setLocal(updated);
    (onQuickUpdate || onUpdate)(updated);
    showSaved();
    setShowDatePicker(false);

    // 2. If Google Tasks is not connected, show a subtle offline badge and bail.
    if (!syncEnabled) {
      setDueSyncStatus('offline');
      clearTimeout(dueSyncTimerRef.current);
      dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 2500);
      return;
    }

    // 3. Push to Google Tasks.
    setDueSyncStatus('saving');
    try {
      const result = await syncTaskField(updated);

      if (result.ok) {
        setDueSyncStatus('saved');
        clearTimeout(dueSyncTimerRef.current);
        dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 2000);
      } else if (result.reason === 'unauthenticated') {
        // Token expired and could not be refreshed — roll back.
        const rolledBack = { ...local, dueDate: prevDate };
        setLocal(rolledBack);
        (onQuickUpdate || onUpdate)(rolledBack);
        setDueSyncStatus('error');
        clearTimeout(dueSyncTimerRef.current);
        dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 3500);
      } else if (result.reason === 'no_google_id') {
        // Task not yet created in Google — the regular sync queue will handle it.
        setDueSyncStatus('saved');
        clearTimeout(dueSyncTimerRef.current);
        dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 1500);
      } else {
        // API error — roll back.
        const rolledBack = { ...local, dueDate: prevDate };
        setLocal(rolledBack);
        (onQuickUpdate || onUpdate)(rolledBack);
        setDueSyncStatus('error');
        clearTimeout(dueSyncTimerRef.current);
        dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 3500);
      }
    } catch {
      setDueSyncStatus('error');
      clearTimeout(dueSyncTimerRef.current);
      dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 3500);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, onQuickUpdate, onUpdate, showSaved]);

  const saveDueTime = useCallback((newTime) => {
    const syncEnabled = localStorage.getItem('nook_sync_enabled') === 'true';
    const prevTime = local?.time ?? '';
    const updated = { ...local, time: newTime };

    // 1. Optimistic local save.
    setLocal(updated);
    (onQuickUpdate || onUpdate)(updated);
    showSaved();
    setShowTimePicker(false);

    // 2. If Google Tasks is not connected, show a subtle offline badge and bail.
    if (!syncEnabled) {
      setDueSyncStatus('offline');
      clearTimeout(dueSyncTimerRef.current);
      dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 2500);
      return;
    }

    if (saveDueTimeDebounceRef.current) clearTimeout(saveDueTimeDebounceRef.current);

    // 3. Push to Google Tasks (debounced)
    setDueSyncStatus('saving');
    saveDueTimeDebounceRef.current = setTimeout(async () => {
      try {
        const result = await syncTaskField(updated);

        if (result.ok) {
          setDueSyncStatus('saved');
          clearTimeout(dueSyncTimerRef.current);
          dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 2000);
        } else if (result.reason === 'unauthenticated' || result.reason === 'api_error') {
          const rolledBack = { ...local, time: prevTime };
          setLocal(rolledBack);
          (onQuickUpdate || onUpdate)(rolledBack);
          setDueSyncStatus('error');
          clearTimeout(dueSyncTimerRef.current);
          dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 3500);
        } else {
          setDueSyncStatus('saved');
          clearTimeout(dueSyncTimerRef.current);
          dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 1500);
        }
      } catch {
        setDueSyncStatus('error');
        clearTimeout(dueSyncTimerRef.current);
        dueSyncTimerRef.current = setTimeout(() => setDueSyncStatus('idle'), 3500);
      }
    }, 500);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local, onQuickUpdate, onUpdate, showSaved]);

  // Cleanup sync timer on unmount. saveDueTimeDebounceRef needs the same
  // treatment as dueSyncTimerRef — without it, a due-time edit made just
  // before navigating away can still fire post-unmount and silently revert
  // to whatever the debounced closure captured.
  useEffect(() => () => {
    clearTimeout(dueSyncTimerRef.current);
    clearTimeout(saveDueTimeDebounceRef.current);
  }, []);

  const openDetail = (task, initialTab = 'details') => {
    setDetailTask(task);
    setLocal({ ...task });
    setCatOpen(false);
    setDetailTab(initialTab);
  };

  // Deep link from the Reminders tab: open a specific task straight to
  // its Scheduling tab (where the reminder field lives).
  useEffect(() => {
    if (!openTaskId) return;
    const task = tasks.find(t => t.id === openTaskId);
    if (task) openDetail(task, 'scheduling');
    onOpenTaskIdHandled?.();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTaskId]);

  const closePanel = () => {
    if (local && detailTask && local.name.trim()) {
      const changed = local.name !== detailTask.name
        || local.priority !== detailTask.priority
        || local.category !== detailTask.category
        || local.dueDate  !== detailTask.dueDate
        || (local.notes  || '') !== (detailTask.notes  || '');
      if (changed) (onQuickUpdate || onUpdate)(local);
    }
    setDetailTask(null);
    setLocal(null);
    setCatOpen(false);
  };

  const handleInlineAdd = (cat) => {
    if (inlineAddText.trim()) {
      if (onAddTask) {
        onAddTask({
          name: inlineAddText.trim(),
          category: cat,
          priority: 'none',
          timeEstimate: 25,
          notes: '',
          dueDate: '',
          recurrence: null,
          recurrenceDays: []
        });
      } else {
        onAdd();
      }
    }
    setInlineAddCat(null);
    setInlineAddText('');
  };

  const _today = todayISO();
  const overdueFront = t => (t.dueDate && t.dueDate < _today) ? -1 : PRI_ORDER[t.priority] ?? 3;

  const sortFns = {
    due:      (a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    },
    priority: (a, b) => overdueFront(a) - overdueFront(b)
                      || new Date(b.createdAt) - new Date(a.createdAt),
    created:  (a, b) => overdueFront(a) - overdueFront(b)
                      || new Date(b.createdAt) - new Date(a.createdAt),
    az:       (a, b) => a.name.localeCompare(b.name),
  };

  const { pending, completed } = useMemo(() => {
    let base = catFilter === 'all' ? tasks : tasks.filter(t => t.category === catFilter);
    if (query.trim()) {
      const q = query.trim().toLowerCase();
      base = base.filter(t => t.name.toLowerCase().includes(q));
    }
    // Sort applies to pending only; completed stays newest-completedAt-first
    const pendingSorted   = base.filter(t => t.status === 'needsAction' || (!t.status && !t.completed)).sort(sortFns[sortBy]);
    const completedSorted = base.filter(t => t.status === 'completed' || (!t.status && t.completed))
                                .sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt));
    return { pending: pendingSorted, completed: completedSorted };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, catFilter, sortBy, query]);

  // Split the (already sorted + filtered) pending list into three groups.
  // Overdue = due before today; Today = due exactly today; Upcoming = due after
  // today OR undated. `_today` is a LOCAL-date YYYY-MM-DD (see todayISO), and
  // dueDate is date-only, so plain string comparison is chronological here.
  // Sort order within each group is preserved.
  const { overdueTasks, todayTasks, upcomingTasks } = useMemo(() => {
    const overdue = [], today = [], upcoming = [];
    for (const t of pending) {
      if (t.dueDate && t.dueDate < _today) overdue.push(t);
      else if (t.dueDate && t.dueDate === _today) today.push(t);
      else upcoming.push(t); // future-dated or no due date
    }
    return { overdueTasks: overdue, todayTasks: today, upcomingTasks: upcoming };
  }, [pending, _today]);

  // ── Single source of truth for the analytics panel ──
  // The left list is filtered by catFilter/query; the analytics dashboard
  // (ring, completed count, category bars) always reflects the FULL task set
  // so the three visuals never disagree.
  const isPendingTask = t => t.status === 'needsAction' || (!t.status && !t.completed);
  const isCompletedTask = t => t.status === 'completed' || (!t.status && t.completed);
  const allPending = useMemo(() => tasks.filter(isPendingTask), [tasks]);
  const allCompleted = useMemo(
    () => tasks.filter(isCompletedTask).sort((a, b) => new Date(b.completedAt || b.createdAt) - new Date(a.completedAt || a.createdAt)),
    [tasks]
  );
  const pendingCount = allPending.length;

  // Count pending tasks per category (always from full task list, ignoring current filter)
  const catCounts = useMemo(() => {
    const c = {};
    tasks.forEach(t => {
      if (t.status === 'needsAction' || (!t.status && !t.completed)) c[t.category] = (c[t.category] || 0) + 1;
    });
    return c;
  }, [tasks]);

  const renderTask = (task, isDone) => (
    <TaskRow
      key={task.id}
      task={task}
      isDone={isDone}
      now={now}
      activeTaskId={activeTaskId}
      timerRunning={timerRunning}
      confirmDeleteId={confirmDeleteId}
      setConfirmDeleteId={setConfirmDeleteId}
      kebabOpenId={kebabOpenId}
      setKebabOpenId={setKebabOpenId}
      openDetail={openDetail}
      onToggle={onToggle}
      onDelete={onDelete}
      onQuickUpdate={onQuickUpdate}
      onUpdate={onUpdate}
      setShowDatePicker={setShowDatePicker}
      ALL_CATS={ALL_CATS}
      handleNewList={handleNewList}
    />
  );

  return (
    <div className="task-list-panel today-3col-container" style={{ background: 'transparent', border: 'none', gap: 10 }}>
      
      <style>{`
        @keyframes customSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .tasks-dashboard-grid {
          display: grid;
          grid-template-columns: 60% 1fr;
          /* Bound the single row to the grid's own (viewport-filling) height so the
             cards can't grow past it — minmax(0, 1fr) lets each card shrink below
             its content and hand the overflow to its own inner scroll. */
          grid-template-rows: minmax(0, 1fr);
          gap: 24px;
          width: 100%;
          flex: 1;
          min-height: 0;
          /* Clamp to the bounded parent so the grid can't grow to its content
             height — otherwise the cards' inner scroll never engages. */
          overflow: hidden;
          /* The single grid row fills the full available height (viewport minus the
             top toolbar) and align-items:stretch makes BOTH cards fill it — so the
             Pending and Completion Analytics cards are as tall as the space allows
             and their bottom edges align. The Pending list (flex:1 inside its card)
             fills the taller card and scrolls; Analytics content sits at the top
             with any extra space falling to the bottom. */
          align-items: stretch;
        }
        @media (max-width: 992px) {
          .tasks-dashboard-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      {/* ── UNIFIED COMPACT TOOLBAR: Search → Sort → Filter → Overview → Sync ── */}
      <div className="yartu-card" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 16px', width: '100%', boxSizing: 'border-box', flexShrink: 0, overflow: 'visible', position: 'relative', zIndex: 20 }}>

        {/* 1. Search — grows to fill */}
        <div className="task-search-wrap" style={{ position: 'relative', flex: 1, minWidth: 150, maxWidth: 280 }}>
          <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-secondary)', pointerEvents: 'none' }} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            ref={searchRef}
            className="task-search-input"
            style={{ width: '100%', height: 34, padding: '0 10px 0 28px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.82rem', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }}
            type="text"
            placeholder="Search tasks..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            aria-label="Search tasks"
          />
          {query && (
            <button style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'transparent', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', padding: 0, display: 'flex' }} onClick={() => { setQuery(''); searchRef.current?.focus(); }} aria-label="Clear search">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
          )}
        </div>

        {/* 2. Sort button */}
        <div className="sort-dropdown" ref={sortRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            aria-label={`Sort tasks by ${SORT_OPTIONS.find(o => o.value === sortBy)?.label ?? 'Created'}`}
            aria-expanded={sortOpen}
            aria-haspopup="listbox"
            style={{ display: 'flex', alignItems: 'center', gap: 5, height: 34, padding: '0 12px', background: 'var(--bg-base)', border: '1px solid var(--border)', borderRadius: '8px', fontSize: '0.82rem', fontWeight: 600, color: 'var(--text-primary)', cursor: 'pointer', boxSizing: 'border-box', whiteSpace: 'nowrap' }}
            onClick={() => setSortOpen(o => !o)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 8h10M3 12h7M3 16h4M17 8v8M14 5l3-3 3 3M14 19l3 3 3-3"/>
            </svg>
            {SORT_OPTIONS.find(o => o.value === sortBy)?.label ?? 'Sort'}
          </button>
          {sortOpen && (
            <div className="sort-menu" style={{ position: 'absolute', top: 40, left: 0, zIndex: 200, background: 'var(--bg-elevated)', border: '1px solid var(--border-strong)', borderRadius: '10px', padding: '6px 0', width: '160px', boxShadow: '0 10px 25px rgba(0,0,0,0.2)' }}>
              {SORT_OPTIONS.map(opt => {
                const isActive = sortBy === opt.value;
                return (
                  <button
                    key={opt.value}
                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 14px', width: '100%', background: isActive ? 'var(--accent-glow)' : 'transparent', border: 'none', color: 'var(--text-primary)', fontSize: '0.82rem', cursor: 'pointer', textAlign: 'left' }}
                    onClick={() => { setSortBy(opt.value); localStorage.setItem(LS_SORT_KEY, opt.value); setSortOpen(false); }}
                    onMouseEnter={e => !isActive && (e.currentTarget.style.background = 'var(--bg-hover)')}
                    onMouseLeave={e => !isActive && (e.currentTarget.style.background = 'transparent')}
                  >
                    <span>{opt.label}</span>
                    {isActive && <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-light)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 3. Category filter dropdown — themed Select (native <select> popup rendered
              unreadable on Windows) */}
        <div style={{ flexShrink: 0 }}>
          <Select
            value={catFilter}
            onChange={e => setCatFilter(e.target.value)}
            options={[
              { value: 'all', label: `All Tasks (${tasks.filter(t => t.status === 'needsAction' || (!t.status && !t.completed)).length})` },
              ...ALL_CATS
                .filter(cat => (catCounts[cat] || 0) > 0 || catFilter === cat)
                .map(cat => ({ value: cat, label: `${CAT_META[cat].label} (${catCounts[cat] || 0})`, color: CAT_META[cat].color })),
            ]}
            style={{ height: 34, minWidth: 152, padding: '0 12px', fontSize: '0.82rem', fontWeight: 600, borderRadius: 8, background: 'var(--bg-base)', border: '1px solid var(--border)', boxSizing: 'border-box' }}
          />
        </div>

        {/* 4. Overview stats — right side */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 'auto', flexShrink: 0, fontSize: '0.78rem', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontWeight: 700, color: 'var(--accent)' }}>{pendingCount}</span>
            <span>pending</span>
          </span>
          <span style={{ color: 'var(--border)' }}>·</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span style={{ fontWeight: 700, color: 'var(--color-green)' }}>{allCompleted.length}</span>
            <span>done</span>
          </span>
        </div>

        {/* 5. Sync button — far right */}
        <div style={{ flexShrink: 0 }}>
          {syncStatus === 'Syncing...' ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: 'var(--accent)' }}>
              <svg style={{ animation: 'customSpin 1s linear infinite', width: 13, height: 13 }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.25"></circle>
                <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
              </svg>
              Syncing
            </span>
          ) : syncStatus === 'Not connected' ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: 'var(--text-muted)' }}>
              <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block' }} />
              Offline
            </span>
          ) : (
            <button
              type="button"
              onClick={onSyncNow}
              title="Sync Now"
              style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'transparent', border: '1px solid var(--border)', borderRadius: '7px', color: 'var(--accent)', cursor: 'pointer', padding: '4px 10px', fontSize: '0.75rem', fontWeight: 600 }}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M23 4v6h-6"/><path d="M1 20v-6h6"/>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
              </svg>
              {syncStatus.startsWith('Sync failed') ? 'Retry' : 'Sync'}
            </button>
          )}
        </div>

      </div>

      {/* ── TASKS DASHBOARD: 60/40 GRID ── */}
      <div className="tasks-dashboard-grid">

        {/* LEFT (60%): PENDING TASKS */}
        <div className="yartu-card" style={{ display: 'flex', flexDirection: 'column', boxSizing: 'border-box', padding: '16px 20px', gap: 8, minHeight: 0 }}>
          <div className="yartu-card-hdr">
            <span className="yartu-card-title">Pending Tasks ({pending.length})</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <button className="yartu-card-action" onClick={() => { setInlineAddCat('top'); setInlineAddText(''); }}>＋ Quick Add</button>
              <button style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '0 14px', height: 30, borderRadius: '8px', fontSize: '0.8rem', fontWeight: 600, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5, boxShadow: '0 2px 8px var(--accent-glow)' }} onClick={onAdd}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Task
              </button>
            </div>
          </div>
          <div className="yartu-list tasks-scroll-list" style={{ padding: '4px 0 0 0', gap: 0, overflowY: 'auto', flex: 1, minHeight: 0 }}>

            {inlineAddCat === 'top' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-base)', padding: '12px 18px', borderRadius: '12px', border: '1px solid var(--accent)', boxShadow: '0 4px 12px var(--accent-glow)', marginBottom: 8 }}>
                <input
                  autoFocus
                  type="text"
                  value={inlineAddText}
                  onChange={e => setInlineAddText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter') {
                      handleInlineAdd(catFilter === 'all' ? 'work' : catFilter);
                    } else if (e.key === 'Escape') {
                      skipBlurRef.current = true;
                      setInlineAddCat(null);
                      setInlineAddText('');
                    }
                  }}
                  onBlur={() => {
                    if (skipBlurRef.current) { skipBlurRef.current = false; return; }
                    handleInlineAdd(catFilter === 'all' ? 'work' : catFilter);
                  }}
                  placeholder={`Add a task to ${catFilter === 'all' ? 'Work' : CAT_META[catFilter]?.label}...`}
                  style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', width: '100%', outline: 'none', fontSize: '0.95rem' }}
                />
              </div>
            )}

            <div className="linear-task-list-container">
              {pending.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '48px 20px', color: 'var(--text-faint)', background: 'var(--bg-base)', borderRadius: '12px', border: '1px solid var(--border)', fontSize: '0.95rem' }}>
                  No pending tasks in this view. Click "＋ Quick Add" above to create one!
                </div>
              ) : (
                <>
                  {overdueTasks.length > 0 && (
                    <TaskGroupCard key="overdue" title="Overdue" count={overdueTasks.length} color="var(--color-red)" tasks={overdueTasks} renderTask={renderTask} />
                  )}
                  {todayTasks.length > 0 && (
                    <TaskGroupCard key="today" title="Today" count={todayTasks.length} color="var(--color-amber)" tasks={todayTasks} renderTask={renderTask} />
                  )}
                  {upcomingTasks.length > 0 && (
                    <TaskGroupCard key="upcoming" title="Upcoming" count={upcomingTasks.length} color="var(--accent)" tasks={upcomingTasks} renderTask={renderTask} />
                  )}
                </>
              )}
            </div>

          </div>
        </div>

        {/* RIGHT (40%): COMPLETION ANALYTICS */}
        <ErrorBoundary message="Analytics panel failed to render.">
          <CompletionAnalytics
            pending={allPending}
            completed={allCompleted}
            onAdd={onAdd}
            renderTask={renderTask}
            onClearCompleted={onClearCompleted}
            catCounts={catCounts}
          />
        </ErrorBoundary>

      </div>

      {/* ── Task detail panel (portalled to body to escape framer-motion transform ancestor) ── */}
      {createPortal(
        <>
          {detailTask && <div className="task-detail-backdrop" onClick={closePanel} />}
          <div className={`task-detail-panel${detailTask ? ' tdp-open' : ''}`} aria-hidden={!detailTask}>
        {local && (
          <>
            {/* ── Header ── */}
            <div className="tdp-header">
              <span className="tdp-heading">Task Details</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                {savedFeedback && (
                  <span className="tdp-saved-badge">
                    <TdpIconCheck />
                    Saved
                  </span>
                )}
                <button className="tdp-close-btn" onClick={closePanel} aria-label="Close">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
                  </svg>
                </button>
              </div>
            </div>

            {/* ── Tab Bar ── */}
            <div className="tdp-tab-bar">
              {[
                { id: 'details',    label: 'Details',     icon: '📋' },
                { id: 'scheduling', label: 'Scheduling',  icon: '🗓️' },
                { id: 'subtasks',   label: 'Subtasks',    icon: `✅${(local.subtasks?.length ?? 0) > 0 ? ` (${local.subtasks.filter(s=>s.completed).length}/${local.subtasks.length})` : ''}` },
              ].map(tab => (
                <button
                  key={tab.id}
                  className={`tdp-tab-btn${detailTab === tab.id ? ' tdp-tab-active' : ''}`}
                  onClick={() => setDetailTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            {/* ── Body (scrollable) ── */}
            <div className="tdp-body">

              {/* ══ TAB: DETAILS ══ */}
              {detailTab === 'details' && (
                <>
                  {/* Sync Conflict */}
                  {local.syncConflict && (
                    <div style={{ background: 'var(--color-amber-bg)', border: '1px solid #f59e0b', padding: 12, borderRadius: 8 }}>
                      <div style={{ color: 'var(--color-amber)', fontWeight: 'bold', fontSize: '0.9rem', marginBottom: 4 }}>⚠️ Sync Conflict</div>
                      <div style={{ color: 'var(--text-secondary)', fontSize: '0.85rem', marginBottom: 8 }}>{local.syncConflict}</div>
                      <button
                        type="button"
                        style={{ background: 'var(--color-amber)', color: '#000', border: 'none', padding: '4px 12px', borderRadius: 6, fontWeight: 'bold', fontSize: '0.8rem', cursor: 'pointer' }}
                        onClick={() => {
                          const updated = { ...local, syncConflict: null, updatedAt: new Date().toISOString() };
                          setLocal(updated);
                          (onQuickUpdate || onUpdate)(updated);
                        }}
                      >
                        Dismiss & Keep Local
                      </button>
                    </div>
                  )}

                  {/* Title */}
                  <div className="tdp-field">
                    <label className="tdp-label">Title</label>
                    <input
                      ref={titleRef}
                      className="tdp-title-input"
                      value={local.name || ''}
                      onChange={e => setLocal({ ...local, name: e.target.value })}
                      onBlur={() => {
                        if ((local.name || '').trim() && local.name !== detailTask.name) {
                          (onQuickUpdate || onUpdate)(local);
                          showSaved();
                        }
                      }}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }}
                      placeholder="Task title"
                    />
                  </div>

                  {/* Priority — compact select */}
                  <div className="tdp-field">
                    <label className="tdp-label">Priority</label>
                    <div className="tdp-compact-row">
                      {['none', 'high', 'medium', 'low'].map(p => {
                        const isActive = local.priority === p;
                        const pc = PRI_META[p]?.color;
                        const dotColor = p === 'none' ? 'var(--text-muted)' : pc;
                        return (
                          <button
                            key={p}
                            className={`tdp-seg-btn${isActive ? ' tdp-seg-active' : ''}`}
                            style={isActive ? { background: pc + '22', borderColor: pc, color: pc } : {}}
                            onClick={() => saveField('priority', p)}
                          >
                            <span className="tdp-seg-dot" style={{ background: dotColor }} />
                            {PRI_META[p].label}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Category */}
                  <div className="tdp-field">
                    <label className="tdp-label">Category</label>
                    <div className="tdp-cat-select" ref={catMenuRef}>
                      <button
                        type="button"
                        className={`tdp-cat-trigger${catOpen ? ' tdp-cat-open' : ''}`}
                        onClick={() => setCatOpen(o => !o)}
                      >
                        <span style={{ color: CAT_META[local.category]?.color }}>
                          {CAT_META[local.category]?.label}
                        </span>
                        <TdpIconChevron />
                      </button>
                      {catOpen && (
                        <div className="tdp-cat-menu">
                          {Object.entries(CAT_META).map(([key, meta]) => (
                            <button
                              key={key}
                              type="button"
                              className={`tdp-cat-option${local.category === key ? ' tdp-cat-active' : ''}`}
                              onClick={() => { saveField('category', key); setCatOpen(false); }}
                            >
                              <span className="tdp-cat-dot" style={{ background: meta.color }} />
                              {meta.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Notes */}
                  <div className="tdp-field">
                    <label className="tdp-label">Notes</label>
                    <textarea
                      ref={notesRef}
                      className="tdp-notes"
                      value={local.notes || ''}
                      onChange={e => {
                        setLocal({ ...local, notes: e.target.value });
                        e.target.style.height = 'auto';
                        e.target.style.height = e.target.scrollHeight + 'px';
                      }}
                      onBlur={() => {
                        const cur = local.notes || '', orig = detailTask.notes || '';
                        if (cur !== orig) { (onQuickUpdate || onUpdate)(local); showSaved(); }
                      }}
                      placeholder="Add notes..."
                      spellCheck="true"
                      autoCorrect="on"
                    />
                  </div>

                  {/* Attachments */}
                  <div className="tdp-field">
                    <label className="tdp-label">Attachments</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                      {(local.attachments || []).map(att => (
                        <div key={att.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-card)', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', fontSize: '0.85rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10, overflow: 'hidden' }}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                            <span style={{ color: 'var(--text-primary)', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>{att.name}</span>
                          </div>
                          <button type="button" style={{ background: 'transparent', border: 'none', color: 'var(--color-red)', cursor: 'pointer', padding: 4 }}
                            onClick={() => saveField('attachments', (local.attachments || []).filter(a => a.id !== att.id))}>
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 8, background: 'var(--bg-hover)', padding: '8px 12px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer', fontSize: '0.85rem', color: 'var(--text-secondary)', transition: 'all 0.15s ease' }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--color-blue)'}
                      onMouseLeave={e => e.currentTarget.style.borderColor = 'rgba(255,255,255,0.08)'}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      <span>Add attachment file...</span>
                      <input id="attachment-input" type="file" style={{ display: 'none' }}
                        onChange={e => {
                          const file = e.target.files?.[0];
                          if (file) {
                            saveField('attachments', [...(local.attachments || []), { id: Date.now().toString(), name: file.name, size: file.size }]);
                            e.target.value = '';
                          }
                        }}
                      />
                    </label>
                  </div>

                  {/* Created */}
                  <div className="tdp-created">
                    Created {new Date(detailTask.createdAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                  </div>
                </>
              )}

              {/* ══ TAB: SCHEDULING ══ */}
              {detailTab === 'scheduling' && (
                <>
                  {/* Due Date */}
                  <div className="tdp-field">
                    <label className="tdp-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      Due Date
                      {/* Google Tasks sync status badge */}
                      {dueSyncStatus === 'saving' && (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.7rem', color: 'var(--text-muted)' }}>
                          <span style={{ width: 10, height: 10, border: '1.5px solid var(--accent)', borderTopColor: 'transparent', borderRadius: '50%', animation: 'spin 0.6s linear infinite', display: 'inline-block', flexShrink: 0 }} />
                          Syncing…
                        </span>
                      )}
                      {dueSyncStatus === 'saved' && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--color-green)', display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                          Synced
                        </span>
                      )}
                      {dueSyncStatus === 'error' && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--color-red)', display: 'inline-flex', alignItems: 'center', gap: 3 }} title="Google Tasks sync failed — change rolled back">
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          Sync failed
                        </span>
                      )}
                      {dueSyncStatus === 'offline' && (
                        <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }} title="Connect Google Tasks in Settings to sync">
                          Local only
                        </span>
                      )}
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <div ref={datePickerRef} style={{ position: 'relative', flex: 3 }}>
                        <button
                          type="button"
                          disabled={dueSyncStatus === 'saving'}
                          onClick={() => { setShowDatePicker(p => !p); setShowTimePicker(false); }}
                          style={{
                            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                            background: 'var(--bg-input)', border: `1px solid ${showDatePicker ? 'var(--accent)' : 'var(--border)'}`,
                            borderRadius: 'var(--radius-sm)', padding: '9px 12px', cursor: dueSyncStatus === 'saving' ? 'not-allowed' : 'pointer',
                            color: local.dueDate ? 'var(--text-primary)' : 'var(--text-muted)',
                            fontSize: '0.875rem', fontWeight: local.dueDate ? 600 : 400,
                            transition: 'border-color 0.13s ease', gap: 8,
                            opacity: dueSyncStatus === 'saving' ? 0.65 : 1,
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: local.dueDate ? 'var(--accent)' : 'var(--text-muted)', flexShrink: 0 }}>
                              <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
                            </svg>
                            {local.dueDate
                              ? new Date(local.dueDate + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                              : 'Pick a date'}
                            {local.dueDate && local.time && (
                              <span style={{ color: 'var(--text-muted)', marginLeft: 4, fontWeight: 500 }}>
                                @ {(() => {
                                  const [h, m] = local.time.split(':').map(Number);
                                  const meridiem = h >= 12 ? 'PM' : 'AM';
                                  const h12 = h % 12 === 0 ? 12 : h % 12;
                                  return `${h12}:${String(m).padStart(2, '0')} ${meridiem}`;
                                })()}
                              </span>
                            )}
                          </span>
                          {local.dueDate && dueSyncStatus !== 'saving' && (
                            <span role="button"
                              onClick={e => { e.stopPropagation(); saveDueDate(''); saveDueTime(''); }}
                              title="Clear"
                              style={{ color: 'var(--color-red)', fontSize: '1rem', lineHeight: 1, padding: '0 2px', cursor: 'pointer' }}
                            >×</span>
                          )}
                        </button>
                        <AnimatePresence>
                          {showDatePicker && (
                            <CalendarDatePicker
                              value={local.dueDate || ''}
                              onChange={v => { saveDueDate(v); }}
                              onClose={() => setShowDatePicker(false)}
                            />
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                  {/* Keyframe for saving spinner — only injected once */}
                  <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>

                  {/* Reminder */}
                  <ReminderField
                    sourceType="task"
                    sourceId={local.id}
                    title={local.name}
                    targetAt={local.dueDate ? new Date(local.dueDate + 'T23:59:59') : null}
                    targetLabel="due date"
                    onTimeSelect={saveDueTime}
                  />

                  {/* Repeat — compact select */}
                  {/* NOTE: Recurrence is local-only. The Google Tasks REST API does not
                      support a recurrence/RRULE field for classic tasks. Nook handles
                      this locally by auto-creating the next occurrence on completion. */}
                  <div className="tdp-field">
                    <label className="tdp-label">Repeat</label>
                    <div className="tdp-select-wrap">
                      <select
                        className="tdp-native-select"
                        value={local.recurrence ?? 'none'}
                        onChange={e => saveField('recurrence', e.target.value === 'none' ? null : e.target.value)}
                      >
                        <option value="none">None</option>
                        <option value="daily">Daily</option>
                        <option value="weekdays">Weekdays</option>
                        <option value="weekly">Weekly</option>
                        <option value="monthly">Monthly</option>
                        <option value="custom">Custom</option>
                      </select>
                      <svg className="tdp-select-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="6 9 12 15 18 9"/></svg>
                    </div>
                    {local.recurrence === 'custom' && (
                      <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                        {['S','M','T','W','T','F','S'].map((lbl, i) => (
                          <button key={i} type="button"
                            onClick={() => {
                              const days = (local.recurrenceDays || []).includes(i)
                                ? (local.recurrenceDays || []).filter(d => d !== i)
                                : [...(local.recurrenceDays || []), i].sort((a,b) => a-b);
                              saveField('recurrenceDays', days);
                            }}
                            style={{
                              width: 32, height: 32, borderRadius: '50%', border: '1px solid',
                              borderColor: (local.recurrenceDays||[]).includes(i) ? 'var(--accent)' : 'var(--border)',
                              background:  (local.recurrenceDays||[]).includes(i) ? 'var(--accent)'  : 'transparent',
                              color:       (local.recurrenceDays||[]).includes(i) ? '#fff' : 'var(--text-muted)',
                              fontSize: '0.72rem', fontWeight: 700, cursor: 'pointer',
                              display: 'flex', alignItems: 'center', justifyContent: 'center',
                              transition: 'all 0.13s ease',
                            }}
                          >{lbl}</button>
                        ))}
                      </div>
                    )}
                    {local.recurrence && (
                      <div style={{ marginTop: 8, fontSize: '0.75rem', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
                        <span>🔁</span>
                        <span>Repeats {local.recurrence}{local.dueDate ? ` · next: ${new Date(local.dueDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}</span>
                      </div>
                    )}
                  </div>

                </>
              )}

              {/* ══ TAB: SUBTASKS ══ */}
              {detailTab === 'subtasks' && (
                <>
                  <div className="tdp-field">
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                      <label className="tdp-label">Subtasks</label>
                      {(local.subtasks?.length ?? 0) > 0 && (
                        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)', fontWeight: 600 }}>
                          {local.subtasks.filter(s => s.completed).length}/{local.subtasks.length} done
                        </span>
                      )}
                    </div>

                    {/* Progress bar */}
                    {(local.subtasks?.length ?? 0) > 0 && (
                      <div style={{ height: 4, background: 'var(--ring-track)', borderRadius: 99, overflow: 'hidden', marginBottom: 12 }}>
                        <div style={{
                          height: '100%',
                          width: `${(local.subtasks.filter(s=>s.completed).length / local.subtasks.length) * 100}%`,
                          background: 'linear-gradient(90deg, var(--accent), var(--color-green))',
                          borderRadius: 99, transition: 'width 0.35s ease',
                        }} />
                      </div>
                    )}

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 8 }}>
                      {(local.subtasks || []).map(sub => (
                        <div key={sub.id} className="tdp-subtask-row">
                          <button
                            type="button"
                            className={`tdp-subtask-check${sub.completed ? ' checked' : ''}`}
                            onClick={() => {
                              const nextSubs = (local.subtasks || []).map(s => s.id === sub.id ? { ...s, completed: !s.completed, updatedAt: new Date().toISOString() } : s);
                              saveField('subtasks', nextSubs);
                            }}
                          >
                            {sub.completed && <TdpIconCheck />}
                          </button>
                          <input
                            type="text"
                            value={sub.text}
                            onChange={e => {
                              const nextSubs = (local.subtasks || []).map(s => s.id === sub.id ? { ...s, text: e.target.value, updatedAt: new Date().toISOString() } : s);
                              setLocal({ ...local, subtasks: nextSubs });
                            }}
                            onBlur={() => { (onQuickUpdate || onUpdate)(local); showSaved(); }}
                            style={{ background: 'transparent', border: 'none', color: sub.completed ? 'var(--text-secondary)' : 'var(--text-primary)', textDecoration: sub.completed ? 'line-through' : 'none', width: '100%', outline: 'none', fontSize: '0.875rem' }}
                          />
                          <button type="button"
                            style={{ background: 'transparent', border: 'none', color: 'var(--color-red)', cursor: 'pointer', padding: '0 4px', fontSize: '1rem', lineHeight: 1, flexShrink: 0 }}
                            onClick={() => {
                              if (sub.googleTaskId) {
                                const delStr = localStorage.getItem('nook_deleted_tasks');
                                let deletedIds = [];
                                if (delStr) {
                                  try { deletedIds = JSON.parse(delStr); }
                                  catch { console.warn('[TaskList] nook_deleted_tasks was corrupted, resetting.'); }
                                }
                                if (!deletedIds.includes(sub.googleTaskId)) { deletedIds.push(sub.googleTaskId); localStorage.setItem('nook_deleted_tasks', JSON.stringify(deletedIds)); }
                              }
                              saveField('subtasks', (local.subtasks || []).filter(s => s.id !== sub.id));
                            }}
                          >×</button>
                        </div>
                      ))}
                    </div>

                    <div className="tdp-subtask-add-row">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      <input
                        id="subtask-input"
                        type="text"
                        placeholder="Add a subtask and press Enter..."
                        onKeyDown={e => {
                          if (e.key === 'Enter' && e.target.value.trim()) {
                            const newSub = { id: Date.now().toString(), text: e.target.value.trim(), completed: false, updatedAt: new Date().toISOString() };
                            saveField('subtasks', [...(local.subtasks || []), newSub]);
                            e.target.value = '';
                          }
                        }}
                        style={{ background: 'transparent', border: 'none', color: 'var(--text-primary)', width: '100%', outline: 'none', fontSize: '0.875rem' }}
                      />
                    </div>
                  </div>
                </>
              )}

            </div>{/* end tdp-body */}

            {/* ── Footer ── */}
            <div className="tdp-footer">
              <button
                type="button"
                className="tdp-delete-btn"
                onClick={() => { if (confirm(`Delete "${local.name}"?`)) { onDelete(local.id); setDetailTask(null); setLocal(null); } }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/>
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  <path d="M10 11v6"/><path d="M14 11v6"/>
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
                </svg>
                Delete
              </button>
              <button
                type="button"
                className="tdp-save-btn"
                onClick={() => {
                  (onQuickUpdate || onUpdate)(local);
                  closePanel();
                }}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
                Save / Done
              </button>
            </div>
          </>
        )}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

// ─── Panel-local icons (prefixed to avoid collisions) ────────────────
function TdpIconCheck() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12"/>
    </svg>
  );
}
function TdpIconChevron() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

export default memo(TaskList);
