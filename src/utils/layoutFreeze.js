import { useSyncExternalStore } from 'react';

// Pauses framer-motion `layout` animations for a moment.
//
// Toggling the sidebar resizes the whole page ONCE. framer-motion sees the task rows / link rows move and
// animates them from the old box to the new one (a translate + scale), so they visibly shrink and grow even
// though the page itself has already settled — framer only suppresses that when the *window* width changes.
// App calls freezeLayoutAnimations() just before it flips the sidebar; rows read useLayoutAnimations() and
// pass it as `layout`, so they reflow instantly then and keep their glide for adds / removes / reorders.
let frozen = false;
let timer = null;
const subs = new Set();

const notify = () => subs.forEach(fn => fn());
const subscribe = (fn) => { subs.add(fn); return () => subs.delete(fn); };
const getFrozen = () => frozen;

export function freezeLayoutAnimations(ms = 500) {
  frozen = true;
  notify();
  clearTimeout(timer);
  timer = setTimeout(() => { frozen = false; notify(); }, ms);
}

export const useLayoutAnimations = () => !useSyncExternalStore(subscribe, getFrozen, getFrozen);
