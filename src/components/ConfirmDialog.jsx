import { useEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getConfirm, settleConfirm, subscribeConfirm } from '../utils/confirmDialog';

// Draws the popup behind `askConfirm()` (utils/confirmDialog.js). Mount it ONCE, in App.jsx.
//
// Rendered into <body> at a z-index above every modal and FloatingPopover (10050), so a delete
// asked from inside a note editor or the task side panel still shows on top of it. Escape
// cancels THIS popup only: the listener is on the capture phase and stops propagation, so the
// modal / panel underneath doesn't also close (same trick as FloatingPopover). Focus starts on
// Cancel — Enter on an accidental double-press can't delete — and returns to where it was.
export default function ConfirmHost() {
  const pending = useSyncExternalStore(subscribeConfirm, getConfirm, getConfirm);
  return pending ? createPortal(<Dialog key={pending.id} pending={pending} />, document.body) : null;
}

const TrashIcon = () => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
  </svg>
);

function Dialog({ pending }) {
  const { id, opts } = pending;
  const { title = 'Delete this?', message, confirmLabel = 'Delete', cancelLabel = 'Cancel' } = opts;
  const cancelRef = useRef(null);
  const confirmRef = useRef(null);
  const openedAt = useRef(Date.now());

  useEffect(() => {
    const before = document.activeElement;
    cancelRef.current?.focus();
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); settleConfirm(id, false); }
      else if (e.key === 'Tab') {                       // keep Tab inside the two buttons
        e.preventDefault();
        (document.activeElement === cancelRef.current ? confirmRef : cancelRef).current?.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      try { before?.isConnected && before.focus?.(); } catch {}
    };
  }, [id]);

  // A double-click on a trash icon lands its second click on the backdrop; don't let that dismiss.
  const onBackdrop = () => { if (Date.now() - openedAt.current > 350) settleConfirm(id, false); };

  return (
    <div className="nk-confirm-overlay" data-nk-popover="" onMouseDown={e => e.stopPropagation()} onClick={onBackdrop}>
      <div className="nk-confirm" role="alertdialog" aria-modal="true" aria-labelledby="nk-confirm-title" aria-describedby={message ? 'nk-confirm-body' : undefined} onClick={e => e.stopPropagation()}>
        <div className="nk-confirm-icon"><TrashIcon /></div>
        <h3 className="nk-confirm-title" id="nk-confirm-title">{title}</h3>
        {message && <p className="nk-confirm-body" id="nk-confirm-body">{message}</p>}
        <div className="nk-confirm-actions">
          <button type="button" ref={cancelRef} className="nk-confirm-cancel" onClick={() => settleConfirm(id, false)}>{cancelLabel}</button>
          <button type="button" ref={confirmRef} className="nk-confirm-del" onClick={() => settleConfirm(id, true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}
