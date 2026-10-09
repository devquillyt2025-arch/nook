import { useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import CalendarDatePicker from './CalendarDatePicker';
import FloatingPopover from './FloatingPopover';

// Drop-in replacement for <input type="date"> that uses the app's own calendar popup
// (CalendarDatePicker) instead of the browser's native one, which ignores the theme.
//
// Same data contract as the native input so call sites barely change:
//   value     'YYYY-MM-DD' or ''
//   onChange  called with { target: { value } } (like utils Select does), '' when cleared
//   min / max 'YYYY-MM-DD' — days outside are disabled in the calendar
//   required  an empty required field blocks form submission, as the native input did
// `className` / `style` go on the trigger button, so existing field styling carries over.

const CalIco = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="nk-pick-ico">
    <rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>
  </svg>
);

// 'YYYY-MM-DD' → 'Oct 9, 2026'. Anchored at local noon so a DST shift can't change the day.
export function formatPickedDate(iso) {
  if (!iso) return '';
  const d = new Date(iso + 'T12:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export default function DateInput({
  value = '', onChange, min, max,
  required = false, disabled = false,
  className = '', style, wrapStyle,
  placeholder = 'Select date', icon = true, iconStart = false, format = formatPickedDate,
  id, 'aria-label': ariaLabel,
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef(null);
  const emit = (v) => onChange?.({ target: { value: v } });

  return (
    <div style={{ position: 'relative', minWidth: 0, ...wrapStyle }}>
      <button
        ref={btnRef}
        id={id}
        type="button"
        disabled={disabled}
        className={`nk-pick ${className}`.trim()}
        style={style}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => { if (!disabled) setOpen(o => !o); }}
      >
        {icon && iconStart && <CalIco />}
        <span className={`nk-pick-text${value ? '' : ' nk-pick-ph'}`}>{value ? format(value) : placeholder}</span>
        {icon && !iconStart && <CalIco />}
      </button>

      {/* A button can't be `required`. This invisible input carries the value so the
          browser still refuses to submit an empty required date, as the native input did. */}
      {required && (
        <input
          tabIndex={-1} aria-hidden="true" required value={value} onChange={() => {}}
          style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }}
        />
      )}

      <AnimatePresence>
        {open && (
          <FloatingPopover key="date-popover" anchorRef={btnRef} align="left" onClose={() => setOpen(false)}>
            <CalendarDatePicker
              value={value}
              min={min}
              max={max}
              allowClear={!required}
              onChange={emit}
              onClose={() => setOpen(false)}
            />
          </FloatingPopover>
        )}
      </AnimatePresence>
    </div>
  );
}
