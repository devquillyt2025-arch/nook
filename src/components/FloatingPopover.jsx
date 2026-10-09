import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const MARGIN = 8;   // keep this far from the window edge
const GAP = 6;      // the pickers sit 6px below their anchor (their own `top: calc(100% + 6px)`)

// Renders a picker popup (CalendarDatePicker / TimePicker) into <body>, placed under
// `anchorRef`, so it can never be clipped by — or hidden behind — the panel, modal or
// scrolling area the trigger lives in. (Those pickers position themselves
// `absolute` relative to whatever contains them; inside a modal body or a scrolling
// side panel that clips them, which is exactly the bug this exists to prevent.)
//
// The popup's own CSS is unchanged: this wraps it in a zero-size `fixed` anchor point.
// `align` must match the popup's own anchoring: 'left' (CalendarDatePicker, `left: 0`)
// or 'right' (TimePicker, `right: 0`). The popup is kept inside the window, flips above
// the anchor when there is no room below, and follows the anchor on scroll/resize.
//
// Closes on an outside mousedown or Escape. Clicks on the anchor are ignored here so the
// trigger's own click can toggle it.
export default function FloatingPopover({ anchorRef, onClose, align = 'left', children }) {
  const wrapRef = useRef(null);
  const [pos, setPos] = useState(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const place = useCallback(() => {
    const anchor = anchorRef.current, wrap = wrapRef.current;
    if (!anchor || !wrap) return;
    const r = anchor.getBoundingClientRect();
    const pop = wrap.firstElementChild;
    // offsetWidth/Height ignore the entry animation's scale transform.
    const W = pop ? pop.offsetWidth : 0, H = pop ? pop.offsetHeight : 0;

    const wantLeft = align === 'right' ? r.right - W : r.left;
    const left = Math.min(Math.max(MARGIN, wantLeft), Math.max(MARGIN, window.innerWidth - W - MARGIN));
    const x = align === 'right' ? left + W : left;            // where the popup's anchored edge ends up

    let top = r.bottom;                                       // popup top = top + GAP
    if (H && top + GAP + H > window.innerHeight - MARGIN) {   // no room below → open above the anchor
      top = Math.max(MARGIN - GAP, r.top - GAP - H - GAP);
    }
    setPos(p => (p && p.top === top && p.left === x ? p : { top, left: x }));
  }, [anchorRef, align]);

  useLayoutEffect(() => {
    place();                                                  // before paint: no flash at 0,0
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);           // scrolling containers don't bubble
    const pop = wrapRef.current?.firstElementChild;
    const ro = pop && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(place) : null;
    if (ro) ro.observe(pop);                                  // e.g. a 6-week month is taller than a 5-week one
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      if (ro) ro.disconnect();
    };
  }, [place]);

  useEffect(() => {
    const onDown = (e) => {
      const inPopup = wrapRef.current && wrapRef.current.contains(e.target);
      const inAnchor = anchorRef.current && anchorRef.current.contains(e.target);
      if (!inPopup && !inAnchor) closeRef.current?.();
    };
    // Capture phase + stopPropagation: Escape closes THIS popup only, not also the
    // modal / menu it was opened from.
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeRef.current?.(); } };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={wrapRef}
      data-nk-popover=""
      style={{
        position: 'fixed', top: pos ? pos.top : 0, left: pos ? pos.left : 0,
        width: 0, height: 0, zIndex: 10050,
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
