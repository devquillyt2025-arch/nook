import { useState, useCallback, useMemo, memo, useRef } from 'react';
import TimeInput from './TimeInput';
import {
  HABIT_CATS, ACCENT_COLORS, localDateStr,
  isScheduledToday, isScheduledOn, isCompletedToday, isCompletedOn,
  toggleCompletion, calcStreak, calcBestStreak, successRate,
  get7DayStrip, get12WeekGrid, fmtFrequency, makeHabit,
} from '../habitsStore';

const DOW_LABELS = ['S','M','T','W','T','F','S'];

// ─── Main view ─────────────────────────────────────────────────────
function HabitsView({ habits, onAddHabit, onUpdateHabit, onDeleteHabit }) {
  const [filterFreq,   setFilterFreq]   = useState('all');
  const [filterCat,    setFilterCat]    = useState('all');
  const [showModal,    setShowModal]    = useState(false);
  const [editingHabit, setEditingHabit] = useState(null);
  const [detailHabit,  setDetailHabit]  = useState(null);

  const today     = localDateStr();
  const dateLabel = new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });

  // ── Derived lists ──
  const filtered = habits.filter(h => {
    if (filterFreq !== 'all' && h.frequency !== filterFreq) return false;
    if (filterCat  !== 'all' && h.category  !== filterCat)  return false;
    return true;
  });

  const todayHabits = filtered.filter(h => isScheduledToday(h));
  const allHabits   = filtered;

  // Sort today: incomplete first, completed last
  const todaySorted = [
    ...todayHabits.filter(h => !isCompletedToday(h)),
    ...todayHabits.filter(h =>  isCompletedToday(h)),
  ];

  // ── Stats ──
  const totalDue    = habits.filter(isScheduledToday).length;
  const doneToday   = habits.filter(h => isScheduledToday(h) && isCompletedToday(h)).length;
  const todayRate   = totalDue > 0 ? Math.round((doneToday / totalDue) * 100) : 0;
  const longestStreak = habits.reduce((max, h) => Math.max(max, calcBestStreak(h)), 0);

  // ── Real 14-day activity (completion rate per day) ──
  const activity14 = useMemo(() => {
    const out = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - i);
      const ds   = localDateStr(d);
      const due  = habits.filter(h => isScheduledOn(h, ds));
      const done = due.filter(h => isCompletedOn(h, ds));
      out.push({ ds, offset: i, due: due.length, done: done.length,
        rate: due.length ? done.length / due.length : 0 });
    }
    return out;
  }, [habits]);

  const RING_R = 20;
  const RING_C = 2 * Math.PI * RING_R;

  // ── Callbacks ──
  const handleToggle = useCallback((habit) => {
    onUpdateHabit(toggleCompletion(habit));
  }, [onUpdateHabit]);

  const openEdit = (habit) => { setEditingHabit(habit); setShowModal(true); };
  const closeModal = () => { setShowModal(false); setEditingHabit(null); };

  const handleModalSave = (data) => {
    if (editingHabit) {
      onUpdateHabit({ ...editingHabit, ...data });
    } else {
      onAddHabit(makeHabit(data));
    }
    closeModal();
  };

  // When a detail panel habit is updated externally, keep it live
  const liveDetail = detailHabit ? habits.find(h => h.id === detailHabit.id) ?? null : null;

  // Unique frequencies and categories for filter pills
  const uniqueFreqs = [...new Set(habits.map(h =>
    h.frequency === 'daily' ? 'daily' :
    h.frequency === 'weekdays' ? 'weekdays' :
    Array.isArray(h.frequency) ? 'custom' : h.frequency
  ))];

  return (
    <div className="hv">

      {/* ── Sticky header: stats + filters stay pinned; only the list below scrolls ── */}
      <div className="hv-header">

      {/* ── Command bar ── */}
      <div className="hv-stat-bar">
        {/* Today progress ring */}
        <div className="hv-ring-wrap">
          <div className="hv-ring">
            <svg viewBox="0 0 44 44">
              <defs>
                <linearGradient id="hvRingGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" />
                  <stop offset="100%" stopColor="var(--accent-light)" />
                </linearGradient>
              </defs>
              <circle className="hv-ring-track" cx="22" cy="22" r={RING_R} />
              <circle className="hv-ring-fill" cx="22" cy="22" r={RING_R}
                strokeDasharray={RING_C}
                strokeDashoffset={RING_C * (1 - todayRate / 100)} />
            </svg>
            <div className="hv-ring-center">
              <span className="hv-ring-pct">{todayRate}<i>%</i></span>
            </div>
          </div>
          <div className="hv-ring-meta">
            <span className="hv-ring-title">Today</span>
            <span className="hv-ring-sub">{doneToday} of {totalDue} done</span>
          </div>
        </div>

        <div className="hv-stat-divider" />

        {/* Stat tiles */}
        <div className="hv-stat-group">
          <div className="hv-stat-item">
            <span className="hv-stat-value">{habits.length}</span>
            <span className="hv-stat-label">Habits</span>
          </div>
          <div className="hv-stat-item">
            <span className="hv-stat-value streak-color">{longestStreak}<i>d</i></span>
            <span className="hv-stat-label">Best streak</span>
          </div>
          <div className="hv-stat-item">
            <span className="hv-stat-value">{doneToday}<i>/{totalDue}</i></span>
            <span className="hv-stat-label">Completed</span>
          </div>
        </div>

        <div className="hv-stat-divider" />

        {/* Real 14-day activity heat-strip */}
        <div className="hv-sparkline">
          <span className="hv-spark-label">14-day activity</span>
          <div className="hv-spark-dots">
            {activity14.map((day) => {
              const isToday = day.offset === 0;
              const lvl = day.due === 0 ? 0
                : day.rate >= 1    ? 4
                : day.rate >= 0.66 ? 3
                : day.rate >= 0.33 ? 2
                : day.rate > 0     ? 1 : 0;
              return (
                <div key={day.ds}
                  className={`hv-spark-dot hv-spark-l${lvl}${isToday ? ' hv-spark-dot-today' : ''}`}
                  title={`${day.ds} · ${day.done}/${day.due} done`} />
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Filter pills ── */}
      <div className="hv-filters">
        {['all','daily','weekdays','weekends'].map(f => (
          <button key={f}
            className={`hv-pill${filterFreq === f ? ' hv-pill-active' : ''}`}
            onClick={() => setFilterFreq(f)}>
            {f === 'all' ? 'All' : f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
        <span className="hv-pill-sep" />
        {Object.entries(HABIT_CATS).map(([key, m]) => {
          const count = habits.filter(h => h.category === key).length;
          if (!count) return null;
          return (
            <button key={key}
              className={`hv-pill${filterCat === key ? ' hv-pill-active' : ''}`}
              style={filterCat === key ? { borderColor: m.color, color: m.color, background: m.color+'18' } : {}}
              onClick={() => setFilterCat(filterCat === key ? 'all' : key)}>
              {m.label}
            </button>
          );
        })}
        {/* New Habit — primary action, moved here from the removed page header */}
        <button className="hv-new-btn" style={{ marginLeft: 'auto' }} onClick={() => setShowModal(true)}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          New Habit
        </button>
      </div>
      </div>{/* end .hv-header */}

      {/* ── Content ── */}
      {habits.length === 0 ? (
        <HabitsEmptyState onAdd={() => setShowModal(true)} />
      ) : (
        <div className="hv-sections">

          {/* TODAY section */}
          {todaySorted.length > 0 && (
            <section className="hv-section">
              <div className="hv-section-label">
                Today
                <span className="hv-section-badge">{todaySorted.length}</span>
              </div>
              {todaySorted.map(h => (
                <HabitCard
                  key={h.id}
                  habit={h}
                  onToggle={handleToggle}
                  onOpenDetail={() => setDetailHabit(h)}
                  today={today}
                />
              ))}
            </section>
          )}

          {/* ALL HABITS section */}
          {allHabits.length > todaySorted.length && (
            <section className="hv-section">
              <div className="hv-section-label">All Habits</div>
              {allHabits.filter(h => !isScheduledToday(h)).map(h => (
                <HabitCard
                  key={h.id}
                  habit={h}
                  onToggle={handleToggle}
                  onOpenDetail={() => setDetailHabit(h)}
                  today={today}
                />
              ))}
            </section>
          )}

        </div>
      )}

      {/* ── Detail modal ── centered popup, same pattern as HabitModal (Edit) so
          the two share one modal system instead of a side-drawer + a modal. */}
      {liveDetail && (
        <div className="modal-overlay" onClick={() => setDetailHabit(null)}>
          <div className="modal-box hv-detail-box" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
            <HabitDetailPanel
              habit={liveDetail}
              onClose={() => setDetailHabit(null)}
              onEdit={() => { setDetailHabit(null); openEdit(liveDetail); }}
              onDelete={() => { onDeleteHabit(liveDetail.id); setDetailHabit(null); }}
              onToggle={handleToggle}
              today={today}
            />
          </div>
        </div>
      )}

      {/* ── Modal ── */}
      {showModal && (
        <HabitModal
          onSave={handleModalSave}
          onClose={closeModal}
          editHabit={editingHabit}
        />
      )}
    </div>
  );
}

// ─── Habit card ────────────────────────────────────────────────────
function HabitCard({ habit, onToggle, onOpenDetail, today }) {
  const [pressed, setPressed] = useState(false);
  const cat     = HABIT_CATS[habit.category] ?? HABIT_CATS.health;
  const done    = isCompletedToday(habit);
  const streak  = calcStreak(habit);
  const strip   = get7DayStrip(habit);
  const sched   = isScheduledToday(habit);

  const handleToggle = (e) => {
    e.stopPropagation();
    setPressed(true);
    setTimeout(() => setPressed(false), 150);
    onToggle(habit);
  };

  return (
    <div
      className={`hc${done ? ' hc-done' : ''}`}
      style={{ '--hc-color': habit.color }}
      onClick={onOpenDetail}
    >
      {/* Left: icon + info */}
      <div className="hc-left">
        <span className="hc-icon">
          <HCatIcon category={habit.category} />
        </span>
        <div className="hc-info">
          <span className="hc-name">{habit.name}</span>
          <div className="hc-badges">
            <span className="hc-freq-badge">{fmtFrequency(habit.frequency)}</span>
            <span className="cat-badge" style={{ background: cat.color+'22', color: cat.color, border: `1px solid ${cat.color}44` }}>
              {cat.label}
            </span>
            {habit.timeTag && <span className="hc-time-badge">{habit.timeTag.charAt(0).toUpperCase() + habit.timeTag.slice(1)}</span>}
          </div>
        </div>
      </div>

      {/* Middle: 7-day strip */}
      <div className="hc-strip" onClick={e => e.stopPropagation()}>
        <div className="hc-strip-dots">
          {strip.map((cell, i) => (
            <div
              key={i}
              className={`hc-dot${cell.done ? ' hc-dot-done' : ''}${cell.isToday ? ' hc-dot-today' : ''}${!cell.scheduled ? ' hc-dot-off' : ''}`}
              style={cell.done ? { background: habit.color } : cell.isToday ? { borderColor: habit.color } : {}}
            />
          ))}
        </div>
        <div className="hc-strip-labels">
          {strip.map((cell, i) => (
            <span key={i} className={`hc-dow${cell.isToday ? ' hc-dow-today' : ''}`}>{cell.label}</span>
          ))}
        </div>
      </div>

      {/* Right: streak + action */}
      <div className="hc-right" onClick={e => e.stopPropagation()}>
        {streak > 0 && (
          <div className="hc-streak">
            <HIcoFlame />
            <span>{streak}d</span>
          </div>
        )}
        {sched && (
          <button
            className={`hc-btn${done ? ' hc-btn-done' : ''}${pressed ? ' hc-btn-press' : ''}`}
            onClick={handleToggle}
          >
            {done ? '✓ Done' : 'Mark Done'}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Detail panel content ──────────────────────────────────────────
function HabitDetailPanel({ habit, onClose, onEdit, onDelete, onToggle, today }) {
  const cat    = HABIT_CATS[habit.category] ?? HABIT_CATS.health;
  const streak = calcStreak(habit);
  const best   = calcBestStreak(habit);
  const rate   = successRate(habit);
  const done   = isCompletedToday(habit);
  const grid   = get12WeekGrid(habit);
  const total  = (habit.completions || []).length;

  const recentDates = [...(habit.completions || [])]
    .sort((a, b) => b.localeCompare(a))
    .slice(0, 10);

  return (
    <>
      <div className="tdp-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: cat.color }}><HCatIcon category={habit.category} /></span>
          <span className="tdp-heading">{habit.name}</span>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <button className="tdp-close-btn" style={{ padding: '4px 8px', fontSize: '0.75rem', width: 'auto' }} onClick={onEdit}>Edit</button>
          <button className="tdp-close-btn" onClick={onClose} aria-label="Close">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          </button>
        </div>
      </div>

      <div className="tdp-body">
        {/* Quick action */}
        <button
          className={`hc-btn hv-panel-action${done ? ' hc-btn-done' : ''}`}
          onClick={() => onToggle(habit)}
        >
          {done ? '✓ Completed Today' : 'Mark Done Today'}
        </button>

        {/* Stats grid */}
        <div className="hv-panel-stats">
          <div className="hv-ps"><div className="hv-ps-val">{streak}d</div><div className="hv-ps-lbl">Current</div></div>
          <div className="hv-ps"><div className="hv-ps-val">{best}d</div><div className="hv-ps-lbl">Best</div></div>
          <div className="hv-ps"><div className="hv-ps-val">{total}</div><div className="hv-ps-lbl">Total</div></div>
          <div className="hv-ps"><div className="hv-ps-val">{rate}%</div><div className="hv-ps-lbl">Rate</div></div>
        </div>

        {/* 12-week heatmap */}
        <div className="tdp-label" style={{ marginBottom: 8 }}>Activity (12 weeks)</div>
        {total === 0 ? (
          <div className="hv-heatmap-empty" style={{ padding: '16px 12px', textAlign: 'center', background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', color: 'var(--text-muted)', fontSize: '0.8rem' }}>
            No activity yet. Complete this habit to start your heatmap!
          </div>
        ) : (
          <HabitHeatmap grid={grid} color={habit.color} />
        )}

        {/* Recent completions */}
        {recentDates.length > 0 && (
          <>
            <div className="tdp-label" style={{ marginTop: 16, marginBottom: 8 }}>Recent completions</div>
            <div className="hv-recent-list">
              {recentDates.map(d => (
                <div key={d} className="hv-recent-row">
                  <span className="hv-recent-dot" style={{ background: habit.color }} />
                  <span className="hv-recent-date">
                    {new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="tdp-footer">
        <button className="tdp-delete-btn" onClick={() => { if (confirm(`Delete "${habit.name}"?`)) onDelete(); }}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6"/><path d="M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
          Delete Habit
        </button>
      </div>
    </>
  );
}

// ─── 12-week heatmap ───────────────────────────────────────────────
function HabitHeatmap({ grid, color }) {
  return (
    <div className="hv-heatmap">
      {grid.map((week, wi) => (
        <div key={wi} className="hv-hm-week">
          {week.map((cell, di) => (
            <div
              key={di}
              className={[
                'hv-hm-cell',
                cell.isFuture   ? 'hv-hm-future'  : '',
                !cell.isFuture && cell.done   ? 'hv-hm-done'   : '',
                !cell.isFuture && !cell.done  ? 'hv-hm-missed' : '',
              ].filter(Boolean).join(' ')}
              style={!cell.isFuture && cell.done ? { background: color, borderColor: color } : {}}
              title={cell.date}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

// ─── Empty state ───────────────────────────────────────────────────
function HabitsEmptyState() {
  return (
    <div className="hv-empty">
      <div className="hv-empty-orb" aria-hidden="true">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="17 1 21 5 17 9"/>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <polyline points="7 23 3 19 7 15"/>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
      </div>
      <p className="hv-empty-title">Build your first habit</p>
      <p className="hv-empty-sub">Small daily actions compound into big results</p>
    </div>
  );
}

// ─── New / Edit habit modal ────────────────────────────────────────
function HabitModal({ onSave, onClose, editHabit = null }) {
  const isEdit = !!editHabit;
  const [form, setForm] = useState(() => isEdit ? {
    name:           editHabit.name,
    category:       editHabit.category,
    frequency:      editHabit.frequency,
    timeTag:        editHabit.timeTag ?? null,
    color:          editHabit.color ?? '#818cf8',
    reminderEnabled: editHabit.reminderEnabled ?? false,
    reminderTime:   editHabit.reminderTime ?? '',
  } : {
    name: '', category: 'health', frequency: 'daily',
    timeTag: null, color: '#818cf8',
    reminderEnabled: false, reminderTime: '',
  });
  const [nameError, setNameError] = useState('');
  const submittingRef = useRef(false); // guards a same-frame double-submit (double-Enter/double-click)

  const setF = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const isCustom = Array.isArray(form.frequency);

  const save = () => {
    if (submittingRef.current) return;
    if (!form.name.trim()) { setNameError('Name is required'); return; }
    submittingRef.current = true;
    onSave({ ...form, name: form.name.trim() });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-hdr">
          <h3>{isEdit ? 'Edit Habit' : 'New Habit'}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="modal-form">

          {/* Name */}
          <div className="form-grp">
            <label>Name <span className="req">*</span></label>
            <input
              autoFocus
              className={`form-inp${nameError ? ' form-inp-error' : ''}`}
              value={form.name}
              onChange={e => { setF('name', e.target.value); if (nameError) setNameError(''); }}
              placeholder="e.g. Meditate, Read 20 pages"
            />
            {nameError && <span className="form-error">{nameError}</span>}
          </div>

          {/* Category */}
          <div className="form-grp">
            <label>Category</label>
            <div className="cat-picker">
              {Object.entries(HABIT_CATS).map(([key, m]) => (
                <button key={key} type="button"
                  className={`cat-pick-btn${form.category === key ? ' cat-pick-active' : ''}`}
                  style={form.category === key ? { background: m.color+'22', borderColor: m.color, color: m.color } : {}}
                  onClick={() => setF('category', key)}>
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* Frequency */}
          <div className="form-grp">
            <label>Frequency</label>
            <div className="cat-picker">
              {[
                { val: 'daily',    lbl: 'Daily' },
                { val: 'weekdays', lbl: 'Weekdays' },
                { val: 'weekends', lbl: 'Weekends' },
                { val: 'custom',   lbl: 'Custom' },
              ].map(({ val, lbl }) => {
                const active = val === 'custom' ? isCustom : form.frequency === val;
                return (
                  <button key={val} type="button"
                    className={`cat-pick-btn${active ? ' cat-pick-active' : ''}`}
                    style={active ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                    onClick={() => setF('frequency', val === 'custom'
                      ? (isCustom ? 'daily' : [1,2,3,4,5])
                      : val
                    )}>
                    {lbl}
                  </button>
                );
              })}
            </div>
            {isCustom && (
              <div className="recur-days" style={{ marginTop: 8 }}>
                {DOW_LABELS.map((lbl, i) => (
                  <button key={i} type="button"
                    className={`recur-day${form.frequency.includes(i) ? ' recur-day-active' : ''}`}
                    onClick={() => {
                      const next = form.frequency.includes(i)
                        ? form.frequency.filter(d => d !== i)
                        : [...form.frequency, i].sort((a,b)=>a-b);
                      setF('frequency', next.length ? next : [i]);
                    }}>
                    {lbl}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Target time */}
          <div className="form-grp">
            <label>Target Time <span style={{ color: 'var(--text-muted)', fontWeight: 400, fontSize: '0.7rem', textTransform: 'none' }}>(optional)</span></label>
            <div className="cat-picker">
              {[null, 'morning', 'afternoon', 'evening'].map(t => (
                <button key={t ?? 'any'} type="button"
                  className={`cat-pick-btn${form.timeTag === t ? ' cat-pick-active' : ''}`}
                  style={form.timeTag === t ? { background: 'var(--accent-glow)', borderColor: 'var(--accent)', color: 'var(--accent)' } : {}}
                  onClick={() => setF('timeTag', t)}>
                  {t ? t.charAt(0).toUpperCase() + t.slice(1) : 'Anytime'}
                </button>
              ))}
            </div>
          </div>

          {/* Color accent */}
          <div className="form-grp">
            <label>Color Accent</label>
            <div className="hv-color-swatches">
              {ACCENT_COLORS.map(c => (
                <button key={c} type="button"
                  className={`hv-swatch${form.color === c ? ' hv-swatch-active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setF('color', c)}
                  title={c}
                />
              ))}
            </div>
          </div>

          {/* Reminder toggle */}
          <div className="form-grp">
            <label>Reminder</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                className="toggle-track"
                data-on={String(form.reminderEnabled)}
                onClick={() => setF('reminderEnabled', !form.reminderEnabled)}
              >
                <div className="toggle-thumb" />
              </div>
              {form.reminderEnabled && (
                <TimeInput
                  className="form-inp"
                  style={{ maxWidth: 130 }}
                  value={form.reminderTime}
                  onChange={e => setF('reminderTime', e.target.value)}
                />
              )}
            </div>
          </div>

          <div className="modal-footer">
            <button className="btn-cancel" onClick={onClose}>Cancel</button>
            <button
              className="btn-submit"
              style={{ '--submit-c': form.color }}
              disabled={!form.name.trim()}
              onClick={save}>
              {isEdit ? 'Save Changes' : 'Create Habit'}
            </button>
          </div>

        </div>
      </div>
    </div>
  );
}

// ─── Category icon ─────────────────────────────────────────────────
function HCatIcon({ category }) {
  const p = { fill:'none', stroke:'currentColor', strokeWidth:'2', strokeLinecap:'round', strokeLinejoin:'round' };
  switch (category) {
    case 'health':
      return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>;
    case 'fitness':
      return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><path d="M6.5 6.5h1M16.5 6.5h1M6.5 17.5h1M16.5 17.5h1"/><rect x="2" y="10" width="5" height="4" rx="1"/><rect x="17" y="10" width="5" height="4" rx="1"/><line x1="7" y1="12" x2="17" y2="12"/></svg>;
    case 'work':
      return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>;
    case 'learning':
      return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>;
    case 'finance':
      return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>;
    case 'personal':
    default:
      return <svg width="16" height="16" viewBox="0 0 24 24" {...p}><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>;
  }
}

function HIcoFlame() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/>
    </svg>
  );
}

export default memo(HabitsView);
