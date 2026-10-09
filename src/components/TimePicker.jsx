import { useState, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';

const ITEM_H = 40;
const VISIBLE = 4; // odd count of fully-visible rows around center works best visually with padding below
const COL_H = ITEM_H * VISIBLE;
const PAD = (COL_H - ITEM_H) / 2;

const HOURS   = Array.from({ length: 12 }, (_, i) => i + 1); // 1..12
const MINUTES = Array.from({ length: 60 }, (_, i) => i);      // 0..59
const MERIDIEMS = ['AM', 'PM'];

function parse24(hhmm) {
  const [h, m] = (hhmm || '09:00').split(':').map(Number);
  const meridiem = h >= 12 ? 'PM' : 'AM';
  let hour12 = h % 12; if (hour12 === 0) hour12 = 12;
  const minute = (m ?? 0) % 60;
  return { hour12, minute, meridiem };
}

function to24(hour12, minute, meridiem) {
  let h = hour12 % 12;
  if (meridiem === 'PM') h += 12;
  return `${String(h).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

// Odd number of repeated blocks used to fake an infinite wheel. The current
// value sits in the middle block; after every scroll settles we jump back to
// the middle block's equivalent item (an identical-looking row), so there are
// always ~4 blocks of runway in either direction and the loop never "ends".
const LOOP_REPEAT = 9;

// Scrollable "wheel" column — click an item, or scroll and it snaps to
// whichever item lands in the center band. When `loop` is set (hours/minutes),
// the list wraps around continuously in both directions.
function WheelColumn({ items, value, onChange, format = v => v, loop = false }) {
  const ref = useRef(null);
  const scrollTimer = useRef(null);
  const didInit = useRef(false);

  const len = items.length;
  const middleStart = loop ? Math.floor(LOOP_REPEAT / 2) * len : 0;
  const rendered = loop
    ? Array.from({ length: LOOP_REPEAT * len }, (_, i) => items[i % len])
    : items;

  // Position to the selected value on first open, or when it changes externally
  // (e.g. the "Now" button). Skips repositioning when our own scroll already
  // centered the right item, so it never fights the user mid-scroll.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const centeredIdx = Math.round(el.scrollTop / ITEM_H);
    const centeredVal = loop
      ? items[((centeredIdx % len) + len) % len]
      : items[Math.max(0, Math.min(len - 1, centeredIdx))];
    if (didInit.current && centeredVal === value) return;
    const vIdx = items.indexOf(value);
    if (vIdx < 0) return;
    el.scrollTop = (middleStart + vIdx) * ITEM_H;
    didInit.current = true;
  }, [items, value, loop, len, middleStart]);

  const settle = () => {
    const el = ref.current;
    if (!el) return;
    const idx = Math.round(el.scrollTop / ITEM_H);
    if (loop) {
      const mod = ((idx % len) + len) % len;
      // Snap to the nearest item AND recenter into the middle block in one
      // instant move — lands on an identical row, so the jump is invisible and
      // the wheel can keep scrolling forever in both directions.
      el.scrollTop = (middleStart + mod) * ITEM_H;
      if (items[mod] !== value) onChange(items[mod]);
    } else {
      const clamped = Math.max(0, Math.min(len - 1, idx));
      el.scrollTo({ top: clamped * ITEM_H, behavior: 'smooth' });
      if (items[clamped] !== value) onChange(items[clamped]);
    }
  };

  const handleScroll = () => {
    if (scrollTimer.current) clearTimeout(scrollTimer.current);
    scrollTimer.current = setTimeout(settle, 100);
  };

  const selectItem = (renderedIdx, item) => {
    onChange(item);
    ref.current?.scrollTo({ top: renderedIdx * ITEM_H, behavior: 'smooth' });
  };

  return (
    <div style={{ position: 'relative', width: 64, height: COL_H }}>
      {/* Center selection band */}
      <div style={{
        position: 'absolute', left: 0, right: 0, top: PAD, height: ITEM_H,
        borderTop: '1px solid var(--border-accent)', borderBottom: '1px solid var(--border-accent)',
        background: 'var(--accent-glow)', pointerEvents: 'none', borderRadius: 6,
      }} />
      <div
        ref={ref}
        onScroll={handleScroll}
        style={{
          height: COL_H, overflowY: 'auto', scrollSnapType: 'y mandatory',
          padding: `${PAD}px 0`, scrollbarWidth: 'none',
        }}
      >
        {rendered.map((item, idx) => {
          const isSelected = item === value;
          return (
            <div
              key={idx}
              onClick={() => selectItem(idx, item)}
              style={{
                height: ITEM_H, scrollSnapAlign: 'center',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: isSelected ? '1.05rem' : '0.92rem',
                fontWeight: isSelected ? 700 : 500,
                color: isSelected ? 'var(--accent)' : 'var(--text-secondary)',
                cursor: 'pointer', transition: 'color 0.1s ease, font-size 0.1s ease',
              }}
            >
              {format(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Scroll-wheel time picker popup — companion to CalendarDatePicker for the
// reminder "at a specific time" field.
export default function TimePicker({ value, onChange, onClose, allowClear = false }) {
  const initial = parse24(value);
  const [hour12, setHour12]   = useState(initial.hour12);
  const [minute, setMinute]   = useState(initial.minute);
  const [meridiem, setMeridiem] = useState(initial.meridiem);

  const setNow = () => {
    const n = parse24(`${new Date().getHours()}:${new Date().getMinutes()}`);
    setHour12(n.hour12); setMinute(n.minute); setMeridiem(n.meridiem);
  };

  const confirm = () => {
    onChange(to24(hour12, minute, meridiem));
    onClose();
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: -6, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -6, scale: 0.97 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      style={{
        // Anchored to the right edge, not the left: this popup is wider than
        // its trigger button, and the trigger sits near the panel's right
        // edge (it's the second of two side-by-side buttons), so growing
        // rightward (left: 0) pushes it past the viewport.
        position: 'absolute', top: 'calc(100% + 6px)', right: 0, zIndex: 100,
        background: 'var(--bg-elevated)', border: '1px solid var(--border)',
        borderRadius: 16, boxShadow: '0 16px 40px rgba(0,0,0,0.4)',
        width: 260, overflow: 'hidden',
      }}
      onClick={e => e.stopPropagation()}
    >
      <div style={{ padding: '14px 12px 4px', display: 'flex', justifyContent: 'center', gap: 4 }}>
        <WheelColumn items={HOURS} value={hour12} onChange={setHour12} format={h => String(h).padStart(2, '0')} loop />
        <div style={{ display: 'flex', alignItems: 'center', fontSize: '1.1rem', fontWeight: 700, color: 'var(--text-muted)' }}>:</div>
        <WheelColumn items={MINUTES} value={minute} onChange={setMinute} format={m => String(m).padStart(2, '0')} loop />
        <WheelColumn items={MERIDIEMS} value={meridiem} onChange={setMeridiem} />
      </div>

      <div style={{ borderTop: '1px solid var(--border)', padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', gap: 14 }}>
          <button type="button" onClick={setNow}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.78rem', fontWeight: 600, padding: '4px 0' }}>
            Now
          </button>
          {allowClear && (
            <button type="button" onClick={() => { onChange(''); onClose(); }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-red)', fontSize: '0.78rem', fontWeight: 600, padding: '4px 0' }}>
              Clear
            </button>
          )}
        </div>
        <div style={{ display: 'flex', gap: 14 }}>
          <button type="button" onClick={onClose}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.78rem', fontWeight: 600, padding: '4px 0' }}>
            Cancel
          </button>
          <button type="button" onClick={confirm}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '0.78rem', fontWeight: 700, padding: '4px 0' }}>
            Set
          </button>
        </div>
      </div>
    </motion.div>
  );
}
