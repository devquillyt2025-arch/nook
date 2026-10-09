import { useState, useMemo } from 'react';
import { motion } from 'framer-motion';
import { localDateStr as toISO, todayStr as isoToday } from '../utils/date';

const MONTHS_FULL = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const WEEK_DAYS   = ['Su','Mo','Tu','We','Th','Fr','Sa'];

// Shared date-picker popup — used by the task due-date field, the reminder
// "at a specific time" date trigger, and (via DateInput) every date field in the app.
// `min` / `max` ('YYYY-MM-DD', optional): days outside the range can't be picked.
export default function CalendarDatePicker({ value, onChange, onClose, allowClear = true, min, max }) {
  const parsed = value ? new Date(value + 'T00:00:00') : new Date();
  const [nav, setNav] = useState({ year: parsed.getFullYear(), month: parsed.getMonth() });
  const today = isoToday();

  const grid = useMemo(() => {
    const { year, month } = nav;
    const first = new Date(year, month, 1);
    const last  = new Date(year, month + 1, 0);
    const cells = [];
    const offset = first.getDay();
    const prevLast = new Date(year, month, 0).getDate();
    for (let i = offset - 1; i >= 0; i--) {
      const d = new Date(year, month - 1, prevLast - i);
      cells.push({ date: d, cur: false, iso: toISO(d) });
    }
    for (let i = 1; i <= last.getDate(); i++) {
      const d = new Date(year, month, i);
      cells.push({ date: d, cur: true, iso: toISO(d) });
    }
    while (cells.length % 7 !== 0) {
      const n = cells.length - last.getDate() - offset + 1;
      const d = new Date(year, month + 1, n);
      cells.push({ date: d, cur: false, iso: toISO(d) });
    }
    return cells;
  }, [nav]);

  const prevMonth = () => setNav(n => {
    const d = new Date(n.year, n.month - 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const nextMonth = () => setNav(n => {
    const d = new Date(n.year, n.month + 1, 1);
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const blocked = (iso) => (!!min && iso < min) || (!!max && iso > max);

  const quickIso = (label) => {
    const d = new Date();
    if (label === 'Tomorrow')   d.setDate(d.getDate() + 1);
    if (label === 'Next week')  d.setDate(d.getDate() + (7 - d.getDay() + 1));
    if (label === 'In 2 weeks') d.setDate(d.getDate() + 14);
    if (label === 'Next month') d.setMonth(d.getMonth() + 1);
    return toISO(d);
  };
  const quickPick = (label) => {
    const iso = quickIso(label);
    if (blocked(iso)) return;
    onChange(iso); onClose();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{
        position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 100,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 16, boxShadow: '0 16px 40px rgba(0,0,0,0.4)',
        width: 292, overflow: 'hidden',
      }}
      onClick={e => e.stopPropagation()}
    >
      {/* Quick picks */}
      <div style={{ padding: '12px 12px 8px', display: 'flex', flexWrap: 'wrap', gap: 6, borderBottom: '1px solid var(--border)' }}>
        {['Today','Tomorrow','Next week','In 2 weeks','Next month'].map(lbl => {
          const off = blocked(quickIso(lbl));
          return (
            <button key={lbl} type="button" onClick={() => quickPick(lbl)} disabled={off}
              style={{ padding: '4px 10px', borderRadius: 20, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-secondary)', fontSize: '0.75rem', fontWeight: 600, cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.4 : 1, transition: 'all 0.12s' }}
              onMouseEnter={e => { if (off) return; e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-secondary)'; }}>
              {lbl}
            </button>
          );
        })}
      </div>

      {/* Month nav */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 8px' }}>
        <button onClick={prevMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px 8px', borderRadius: 8, fontSize: '1rem', lineHeight: 1 }}>‹</button>
        <span style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>
          {MONTHS_FULL[nav.month]} {nav.year}
        </span>
        <button onClick={nextMonth} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '4px 8px', borderRadius: 8, fontSize: '1rem', lineHeight: 1 }}>›</button>
      </div>

      {/* Day headers */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', padding: '0 10px' }}>
        {WEEK_DAYS.map(d => (
          <div key={d} style={{ textAlign: 'center', fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', padding: '4px 0', textTransform: 'uppercase' }}>{d}</div>
        ))}
      </div>

      {/* Day grid */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', padding: '0 10px 14px', gap: '2px 0' }}>
        {grid.map((cell) => {
          const isSelected = cell.iso === value;
          const isToday    = cell.iso === today;
          const isPast     = cell.iso < today;
          const off        = blocked(cell.iso);
          return (
            <button key={cell.iso} type="button" disabled={off} aria-label={cell.iso} onClick={() => { onChange(cell.iso); onClose(); }}
              style={{
                width: 36, height: 36, margin: '0 auto', borderRadius: '50%', border: 'none',
                background: isSelected ? 'var(--accent)' : isToday ? 'var(--accent-glow)' : 'transparent',
                color: isSelected ? '#fff' : isToday ? 'var(--accent)' : !cell.cur ? 'var(--text-muted)' : isPast ? 'var(--text-secondary)' : 'var(--text-primary)',
                fontSize: '0.82rem', fontWeight: isSelected || isToday ? 700 : 400,
                cursor: off ? 'not-allowed' : 'pointer', opacity: off ? 0.28 : 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
                outline: isToday && !isSelected ? '1px solid var(--accent)' : 'none',
                transition: 'all 0.1s ease',
              }}
              onMouseEnter={e => { if (!isSelected && !off) e.currentTarget.style.background = 'var(--bg-hover)'; }}
              onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = isToday ? 'var(--accent-glow)' : 'transparent'; }}
            >
              {cell.date.getDate()}
            </button>
          );
        })}
      </div>

      {/* Footer */}
      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', justifyContent: allowClear ? 'space-between' : 'flex-end', alignItems: 'center' }}>
        {allowClear && (
          <button onClick={() => { onChange(''); onClose(); }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-red)', fontSize: '0.78rem', fontWeight: 600, padding: '4px 0' }}>
            Clear date
          </button>
        )}
        <button onClick={onClose}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.78rem', fontWeight: 600, padding: '4px 0' }}>
          Cancel
        </button>
      </div>
    </motion.div>
  );
}
