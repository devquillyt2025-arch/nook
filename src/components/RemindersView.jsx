import { memo,  useState, useEffect, useCallback, useMemo } from 'react';
import { listReminders, groupReminders, clearReminder, saveReminder } from '../utils/reminders';
import { isAuthConfigured } from '../utils/authClient';
import { localDateStr } from '../utils/date';
import { genId } from '../utils/id';
import { askConfirm } from '../utils/confirmDialog';
import DateInput from './DateInput';
import TimeInput from './TimeInput';

// Aggregated view over the `reminders` companion table. Task and calendar
// reminders are set on their owner (a task's Scheduling tab, an event's detail
// modal) and only surface here — click one to jump to it. Manual reminders
// (source_type 'custom', migration 0013) have no owner: they're created, edited
// and deleted right here, and the row's `title` is the reminder itself.
export default memo(function RemindersView({ onNavigateToSource, tasks }) {
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  // null = closed, {} = new manual reminder, a row = editing that manual reminder.
  const [editing, setEditing]     = useState(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    listReminders()
      .then(setReminders)
      .catch(err => setError(err.message || 'Could not load reminders.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  // Refresh (without the loading spinner) when the tab regains focus, so reminders
  // added/cleared from a task's Scheduling tab show up without a manual reload.
  useEffect(() => {
    const onFocus = () => load(true);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // A reminder's `title` is a snapshot taken when the reminder was set, but the
  // task stays the source of truth for its own content (03-tabs-and-features).
  // Resolve through the live task so a rename — a fixed typo, say — shows here
  // straight away, without waiting on a refetch or a network round-trip, and so
  // rows written before renameReminder existed correct themselves on read with
  // no backfill migration. Falls back to the stored title when the task is gone
  // or the source isn't a task. Calendar reminders resolve the same way through
  // the Nook events in `nook-calendar-events` (read here, not held in state —
  // CalendarView owns that slice).
  const resolved = useMemo(() => {
    const names = new Map((tasks || []).map(t => [t.id, t.name]));
    let events = [];
    try { events = JSON.parse(localStorage.getItem('nook-calendar-events') || '[]'); } catch {}
    const eventNames = new Map((Array.isArray(events) ? events : []).map(e => [e.id, e.title]));
    return reminders.map(r => {
      const live = r.source_type === 'task' ? names.get(r.source_id)
                 : r.source_type === 'calendar' ? eventNames.get(r.source_id)
                 : null;
      return live && live !== r.title ? { ...r, title: live } : r;
    });
  }, [reminders, tasks]);

  const { overdue, today, upcoming } = groupReminders(resolved);
  const total = resolved.length;

  const openNew = useCallback(() => setEditing({}), []);
  const closeModal = useCallback(() => setEditing(null), []);
  const onRowClick = useCallback((r) => {
    if (r.source_type === 'custom') setEditing(r);
    else onNavigateToSource?.(r.source_type, r.source_id);
  }, [onNavigateToSource]);

  return (
    <div className="cdp-page">
      {/* Pinned header, same pattern as Countdowns: the stats + the add action */}
      <div className="cdp-head">
      <div className="cdp-stats">
        <StatCard icon={<IcoBell />} label="Total" value={total} sub="All reminders" />
        <StatCard icon={<IcoAlert />} label="Overdue" value={overdue.length} sub={overdue.length > 0 ? 'Need attention' : 'All caught up'} warn={overdue.length > 0} />
        <StatCard icon={<IcoSun />} label="Today" value={today.length} sub="Firing today" />
        <StatCard icon={<IcoClock />} label="Upcoming" value={upcoming.length} sub="Later" />
      </div>
      {isAuthConfigured && !loading && total > 0 && (
        <div className="cdp-filterbar">
          <div className="cdp-filter-group">
            {/* cdp-filter-label: secondary, so the phone layout hides it like the other labels */}
            <span className="cdp-filter-label">Tasks and calendar events set their own reminders. Add anything else here.</span>
          </div>
          <div className="cdp-filter-group">
            <button className="add-task-btn" onClick={openNew}>＋ New Reminder</button>
          </div>
        </div>
      )}
      </div>

      {error && (
        <div style={{ padding: 12, background: 'var(--color-red-bg)', border: '1px solid var(--color-red)', borderRadius: 'var(--radius-sm)', color: 'var(--color-red)', fontSize: '0.85rem' }}>
          {error}
        </div>
      )}

      {loading ? (
        <div className="cdp-empty">
          <span className="tab-fallback-spinner" aria-label="Loading" />
        </div>
      ) : !isAuthConfigured ? (
        <div className="cdp-empty">
          <IcoBell size={30} />
          <p className="cdp-empty-title">Reminders aren't set up</p>
          <p className="cdp-empty-sub">This Nook instance doesn't have Supabase configured, so reminders — which need a server to fire while the tab is closed — aren't available here.</p>
        </div>
      ) : total === 0 ? (
        <div className="cdp-empty">
          <IcoBell size={30} />
          <p className="cdp-empty-title">No reminders set</p>
          <p className="cdp-empty-sub">Add a reminder for anything you need to remember, or set one on a task or a calendar event.</p>
          <button className="hv-new-btn cdp-empty-btn" onClick={openNew}>＋ New Reminder</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
          <ReminderGroup label="Overdue" items={overdue} tone="red" onRowClick={onRowClick} onDismiss={() => load(true)} />
          <ReminderGroup label="Today" items={today} tone="accent" onRowClick={onRowClick} onDismiss={() => load(true)} />
          <ReminderGroup label="Upcoming" items={upcoming} tone="muted" onRowClick={onRowClick} onDismiss={() => load(true)} />
        </div>
      )}

      {editing && (
        <ReminderModal
          reminder={editing.id ? editing : null}
          onClose={closeModal}
          onSaved={() => { setEditing(null); load(true); }}
        />
      )}
    </div>
  );
});

function ReminderGroup({ label, items, tone, onRowClick, onDismiss }) {
  if (items.length === 0) return null;
  const toneColor = tone === 'red' ? 'var(--color-red)' : tone === 'accent' ? 'var(--accent)' : 'var(--text-muted)';
  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span style={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: toneColor }}>{label}</span>
        <span style={{ background: 'var(--bg-input)', color: 'var(--text-muted)', padding: '1px 8px', borderRadius: 10, fontSize: '0.7rem', fontWeight: 700 }}>{items.length}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map(r => <ReminderRow key={r.id} reminder={r} onRowClick={onRowClick} onDismiss={onDismiss} />)}
      </div>
    </section>
  );
}

function ReminderRow({ reminder, onRowClick, onDismiss }) {
  const [dismissing, setDismissing] = useState(false);
  const isCustom = reminder.source_type === 'custom';
  const reminderTime = new Date(reminder.reminder_at);
  // A manual reminder's target_at is just its own fire time — no "due" to show.
  const targetTime = reminder.target_at && !isCustom ? new Date(reminder.target_at) : null;

  // Task/calendar: drops only the reminder, the task/event stays — no confirm.
  // Manual: the row IS the reminder, so removing it deletes content — confirm.
  const handleDismiss = async (e) => {
    e.stopPropagation();
    if (dismissing) return;
    if (isCustom && !(await askConfirm({ title: 'Delete this reminder?', message: `"${reminder.title || 'This reminder'}" will be deleted. This can't be undone.` }))) return;
    setDismissing(true);
    try {
      await clearReminder(reminder.source_type, reminder.source_id);
      onDismiss?.();
    } catch {
      setDismissing(false);
    }
  };

  return (
    <div
      onClick={() => onRowClick?.(reminder)}
      style={{
        display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
        background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)',
        cursor: 'pointer', transition: 'border-color 0.13s ease',
      }}
      onMouseEnter={e => e.currentTarget.style.borderColor = 'var(--border-accent)'}
      onMouseLeave={e => e.currentTarget.style.borderColor = 'var(--border)'}
    >
      <span style={{ width: 34, height: 34, borderRadius: 9, background: 'var(--accent-glow)', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <SourceIcon type={reminder.source_type} />
      </span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: '0.88rem', fontWeight: 600, color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{reminder.title}</span>
        <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)' }}>
          {reminder.reminder_sent ? 'Reminded' : 'Reminds'} {reminderTime.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
          {targetTime && ` · due ${targetTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
        </span>
      </div>
      <button
        onClick={handleDismiss}
        disabled={dismissing}
        aria-label={isCustom ? 'Delete reminder' : 'Dismiss reminder'}
        title={isCustom ? 'Delete reminder' : 'Dismiss reminder'}
        style={{
          background: 'none', border: '1px solid var(--border)', borderRadius: 6,
          cursor: dismissing ? 'default' : 'pointer', color: 'var(--text-muted)',
          padding: '4px 8px', fontSize: '0.72rem', fontWeight: 600, flexShrink: 0,
          opacity: dismissing ? 0.5 : 1, transition: 'opacity 0.13s',
        }}
      >
        {dismissing ? '…' : isCustom ? 'Delete' : 'Dismiss'}
      </button>
    </div>
  );
}

function SourceIcon({ type }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: '2', strokeLinecap: 'round', strokeLinejoin: 'round' };
  if (type === 'custom') return <IcoBell size={16} />;
  if (type === 'calendar') {
    return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
  }
  return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
}

// ─── Manual reminder create / edit ─────────────────────────────────
const pad = n => String(n).padStart(2, '0');
// Same cap send-task-reminders clips notification titles to.
const MAX_TITLE = 200;

// New reminders default to the next whole hour (which may be tomorrow).
function defaultWhen() {
  const d = new Date();
  d.setHours(d.getHours() + 1, 0, 0, 0);
  return { date: localDateStr(d), time: `${pad(d.getHours())}:00` };
}

function ReminderModal({ reminder, onClose, onSaved }) {
  const isEdit = !!reminder;
  const [title, setTitle] = useState(() => reminder?.title || '');
  const [date, setDate]   = useState(() => reminder ? localDateStr(new Date(reminder.reminder_at)) : defaultWhen().date);
  const [time, setTime]   = useState(() => {
    if (!reminder) return defaultWhen().time;
    const d = new Date(reminder.reminder_at);
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [saving, setSaving] = useState(false);
  const [error, setError]   = useState('');

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const save = async () => {
    if (saving) return;
    const text = title.trim();
    if (!text) { setError('Write what you want to be reminded about.'); return; }
    if (!date || !time) { setError('Pick a date and a time.'); return; }
    // Local wall-clock time, parsed as local (no Z), same as ReminderField.
    const at = new Date(`${date}T${time}`);
    // Saving re-arms the row (reminder_sent = false), so a past time would fire
    // on the next cron tick. Always ask for a future one.
    if (!(at > new Date())) { setError('Pick a time in the future.'); return; }
    setSaving(true); setError('');
    try {
      await saveReminder({
        sourceType: 'custom',
        sourceId: reminder?.source_id || genId(),
        title: text,
        targetAt: null,
        mode: 'absolute',
        absoluteAt: `${date}T${time}`,
        offsetMinutes: null,
      });
      onSaved();
    } catch (err) {
      // 23514 = check_violation: the database predates migration 0013.
      setError(err?.code === '23514' || /source_type_check/.test(err?.message || '')
        ? "Manual reminders aren't enabled on the server yet (database migration 0013 hasn't been applied)."
        : (err?.message || 'Could not save the reminder.'));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!(await askConfirm({ title: 'Delete this reminder?', message: `"${reminder.title || 'This reminder'}" will be deleted. This can't be undone.` }))) return;
    setSaving(true);
    try { await clearReminder('custom', reminder.source_id); onSaved(); }
    catch (err) { setError(err?.message || 'Could not delete the reminder.'); setSaving(false); }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box cdp-modal" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="rm-modal-title">
        <div className="cdp-modal-hdr">
          <div className="cdp-modal-hdr-left">
            <span className="cdp-modal-hdr-icon"><IcoBell size={16} /></span>
            <div>
              <span className="cdp-modal-eyebrow">Reminders</span>
              <h3 className="cdp-modal-title" id="rm-modal-title">{isEdit ? 'Edit Reminder' : 'New Reminder'}</h3>
            </div>
          </div>
          <button className="cdp-modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <form className="cdp-modal-body" onSubmit={e => { e.preventDefault(); save(); }}>
          <div className="cdp-field">
            <label className="cdp-field-label" htmlFor="rm-title">Remind me to <span className="req">*</span></label>
            <input
              id="rm-title"
              autoFocus
              className={`cdp-input${error && !title.trim() ? ' cdp-input-error' : ''}`}
              value={title}
              maxLength={MAX_TITLE}
              onChange={e => { setTitle(e.target.value); if (error) setError(''); }}
              placeholder="e.g. Call the bank"
            />
          </div>
          <div className="cdp-field-row">
            <div className="cdp-field">
              <label className="cdp-field-label">Date</label>
              <DateInput className="cdp-date-display" iconStart value={date} min={localDateStr(new Date())}
                onChange={e => { setDate(e.target.value); if (error) setError(''); }} aria-label="Reminder date" />
            </div>
            <div className="cdp-field">
              <label className="cdp-field-label">Time</label>
              <TimeInput className="cdp-date-display" value={time}
                onChange={e => { setTime(e.target.value); if (error) setError(''); }} aria-label="Reminder time" />
            </div>
          </div>
          <span style={{ fontSize: '0.76rem', color: 'var(--text-muted)' }}>
            Arrives as a push notification and/or email (whichever is on in Settings), even when Nook is closed.
          </span>
          {error && <span className="cdp-form-error">{error}</span>}
        </form>

        <div className="cdp-modal-footer">
          {isEdit && (
            <button type="button" className="cdp-delete-btn" onClick={remove} disabled={saving}>Delete</button>
          )}
          <div className="cdp-modal-footer-right">
            <button type="button" className="cdp-btn-cancel" onClick={onClose}>Cancel</button>
            <button type="button" className="cdp-btn-save" disabled={!title.trim() || saving} onClick={save}>
              {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Reminder'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

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

function IcoBell({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>; }
function IcoAlert({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>; }
function IcoSun({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>; }
function IcoClock({ size = 18 }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>; }
