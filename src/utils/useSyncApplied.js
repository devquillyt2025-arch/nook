import { useEffect, useRef } from 'react';
import { onSyncApplied, ackSync } from './sync';

// The handler behind useSyncApplied, separated so it can be tested without React.
// Runs `cb(hitNames)` for the names this view cares about and acknowledges the
// engine ONLY if the view really refreshed — a callback that deliberately skipped
// (returns `false`: a reply is in flight, the editor has unsaved keystrokes) has not
// seen the merged data, so the engine must keep guarding it.
export function makeAppliedHandler(names, getCb, ack) {
  const mine = new Set(names);
  return (applied) => {
    const hit = applied.filter(n => mine.has(n));
    if (!hit.length) return;
    const refreshed = getCb()(hit);
    if (refreshed !== false) ack(hit);
  };
}

// Re-read a synced slice from localStorage when another device's change lands.
//
//   useSyncApplied(['notes'], () => setNotes(loadNotes()));
//
// `names` are sync def names (see syncDefs.js). The callback runs after the
// engine has already written the merged data to localStorage, so it only has to
// reload state from there — exactly what the view did on mount. Return `false`
// to say "I did not refresh" (see makeAppliedHandler).
//
// This is part of the sync contract, not a nicety: until a view acknowledges a
// refresh the engine treats items it merged in as "not yet seen by the app" and
// puts them back if a stale save drops them. We ack on mount (state was just
// read fresh) and again after every refresh.
export function useSyncApplied(names, onApplied) {
  const cb = useRef(onApplied);
  cb.current = onApplied;
  const key = names.join(',');

  useEffect(() => {
    const list = key.split(',');
    ackSync(list);
    return onSyncApplied(makeAppliedHandler(list, () => cb.current, ackSync));
  }, [key]);
}
