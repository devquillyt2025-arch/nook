import { useRef, useState } from 'react';
import { AnimatePresence } from 'framer-motion';
import TimePicker from './TimePicker';
import FloatingPopover from './FloatingPopover';

// Drop-in replacement for <input type="time"> that uses the app's own scroll-wheel time
// popup (TimePicker) instead of the browser's native one, which ignores the theme.
//   value     'HH:MM' (24h) or ''
//   onChange  called with { target: { value } }, '' when cleared
//   required  an empty required field blocks form submission, as the native input did
// `className` / `style` go on the trigger button, so existing field styling carries over.

const ClockIco = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="nk-pick-ico">
    <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
  </svg>
);

// '14:05' → '2:05 PM'
export function formatPickedTime(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h)) return hhmm;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m || 0).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

export default function TimeInput({
  value = '', onChange,
  required = false, disabled = false,
  className = '', style, wrapStyle,
  placeholder = 'Set time', icon = true,
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
        <span className={`nk-pick-text${value ? '' : ' nk-pick-ph'}`}>{value ? formatPickedTime(value) : placeholder}</span>
        {icon && <ClockIco />}
      </button>

      {required && (
        <input
          tabIndex={-1} aria-hidden="true" required value={value} onChange={() => {}}
          style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }}
        />
      )}

      <AnimatePresence>
        {open && (
          <FloatingPopover key="time-popover" anchorRef={btnRef} align="right" onClose={() => setOpen(false)}>
            <TimePicker
              value={value}
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
