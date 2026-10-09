// ─── Cross-device sync: browser wiring ───────────────────────────────
// Connects the pure engine (syncEngine.js) to the real world: the live
// localStorage, the Supabase session + Realtime socket, and window events.
//
// EVERYTHING here is a clean no-op when auth isn't configured or nobody is
// signed in (VITE_SUPABASE_* unset ⇒ startSync() returns immediately and no
// global is touched). Never assume a session exists.
//
// How a write becomes a sync:
//   view writes localStorage ─► observer (below) ─► engine diffs that slice
//   ─► dirty items pushed (debounced) ─► Supabase ─► Realtime ─► other devices
//   ─► engine merges into THEIR localStorage ─► 'nook-sync-applied' event
//   ─► views refresh via useSyncApplied().

import { supabase, isAuthConfigured } from './authClient';
import { createSyncEngine, APPLIED_KEY } from './syncEngine';
import { buildDefs } from './syncDefs';

const APPLIED_EVENT = 'nook-sync-applied';

let engine = null;
let started = false;
let beganFor = null;
let observerInstalled = false;

// One writer per slice across ALL open tabs of this browser (same reason the
// Google sync queues use navigator.locks: unlocked read-modify-writes on shared
// keys race across tabs). Falls back to an in-tab queue where unsupported.
const fallbackQueues = new Map();
function browserLock(name, fn) {
  if (typeof navigator !== 'undefined' && navigator.locks?.request) {
    return navigator.locks.request(`nook-sync-${name}`, fn);
  }
  const prev = fallbackQueues.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  fallbackQueues.set(name, next.catch(() => {}));
  return next;
}

function getEngine() {
  if (engine) return engine;
  engine = createSyncEngine({
    defs: buildDefs(),
    storage: window.localStorage,
    supabase,
    lock: browserLock,
    emit: (type, detail) => {
      try { window.dispatchEvent(new CustomEvent(`nook-sync-${type}`, { detail })); } catch {}
    },
    // A different account signing in on a browser that last synced as someone else.
    // Never upload the previous account's data without asking.
    onAccountSwitch: async () => (
      window.confirm(
        "You're signing in as a different account than the last one used on this browser.\n\n" +
        "OK — remove the previous account's notes, journal, links and other synced data from this browser (recommended; it stays safe in that account).\n" +
        "Cancel — keep it here and upload it into THIS account instead."
      ) ? 'discard' : 'keep'
    ),
    subscribeRealtime: (uid, onRow, onStatus) => {
      const channel = supabase
        .channel(`synced-items-${uid}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'synced_items', filter: `user_id=eq.${uid}` }, onRow)
        .subscribe(onStatus);
      return () => supabase.removeChannel(channel);
    },
  });
  return engine;
}

// Observe writes to localStorage. Wrapping Storage.prototype is deliberate: it
// means every existing writer (views, stores, voice commands, import) is synced
// without each call site having to remember to say so — and a future writer
// can't silently opt out. Only THIS window's localStorage is watched, and the
// original method always runs first, so behaviour (incl. quota errors) is
// unchanged.
function installObserver(eng) {
  if (observerInstalled || typeof Storage === 'undefined') return;
  observerInstalled = true;
  const proto = Storage.prototype;
  const origSet = proto.setItem;
  const origRemove = proto.removeItem;
  proto.setItem = function patchedSetItem(key, value) {
    const out = origSet.apply(this, arguments);
    if (this === window.localStorage) { try { eng.notifyWrite(String(key), false); } catch {} }
    return out;
  };
  proto.removeItem = function patchedRemoveItem(key) {
    const out = origRemove.apply(this, arguments);
    if (this === window.localStorage) { try { eng.notifyWrite(String(key), true); } catch {} }
    return out;
  };
}

// Another tab of this browser just merged a remote change into the shared
// localStorage. The `storage` events for the data keys that follow are a SYNC,
// not a competing edit — so this tab should refresh its views instead of
// raising the "data changed in another tab" banner.
let lastForeignApply = 0;
export function isForeignSyncApply() { return Date.now() - lastForeignApply < 2500; }

function forwardForeignApplies(eng) {
  window.addEventListener('storage', (e) => {
    if (e.storageArea !== window.localStorage || !e.key) return;
    if (e.key === APPLIED_KEY) { lastForeignApply = Date.now(); return; }
    if (!isForeignSyncApply()) return;
    const names = eng.namesForKey(e.key);
    if (names.length) {
      try { window.dispatchEvent(new CustomEvent(APPLIED_EVENT, { detail: { names } })); } catch {}
    }
  });
}

function beginOnce(eng, uid) {
  if (!uid || beganFor === uid) return;
  beganFor = uid;
  eng.begin(uid).catch(err => console.warn('[sync] begin failed:', err?.message || err));
}

export function startSync() {
  if (started || !isAuthConfigured || !supabase || typeof window === 'undefined') return;
  started = true;
  const eng = getEngine();
  installObserver(eng);
  forwardForeignApplies(eng);

  supabase.auth.onAuthStateChange((event, session) => {
    const id = session?.user?.id;
    if (id) beginOnce(eng, id);
    else if (event === 'SIGNED_OUT') { beganFor = null; eng.end(); }
  });
  supabase.auth.getSession().then(({ data }) => beginOnce(eng, data?.session?.user?.id)).catch(() => {});

  // Come back to the tab / regain network ⇒ catch up (Realtime may have slept).
  let lastFocus = 0;
  window.addEventListener('focus', () => {
    const t = Date.now();
    if (t - lastFocus < 5000) return;
    lastFocus = t;
    eng.syncNow();
  });
  window.addEventListener('online', () => eng.syncNow());
  // Leaving the tab: push what we have while we still can.
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') eng.flush(); });
  window.addEventListener('pagehide', () => { eng.flush(); });
}

// ── Public helpers ────────────────────────────────────────────────────

// Subscribe to "remote changes were merged into localStorage". handler(names[])
export function onSyncApplied(handler) {
  const fn = (e) => { try { handler(e.detail?.names || []); } catch (err) { console.warn('[sync] handler threw:', err); } };
  window.addEventListener(APPLIED_EVENT, fn);
  return () => window.removeEventListener(APPLIED_EVENT, fn);
}

// A view has refreshed from storage; the engine can stop guarding what it merged in.
export function ackSync(names) { if (engine) engine.ack(names); }

export function syncNow() { return engine ? engine.syncNow() : Promise.resolve(false); }
export function flushSync() { return engine ? engine.flush() : Promise.resolve(true); }
export function isSyncActive() { return !!engine && engine.isActive(); }
export function getSyncStatus() { return engine ? engine.getStatus() : { state: 'off', pending: 0, lastSyncAt: null, error: null }; }
export function onSyncStatus(fn) { return engine ? engine.onStatus(fn) : () => {}; }

// Run fn without the observer treating its storage writes as user edits. For
// "Clear all data": wiping this device must not delete the cloud copy.
export function runUntrackedSync(fn) { return engine ? engine.runUntracked(fn) : Promise.resolve(fn()); }

// Run fn (which writes storage — an import) so that items missing from what it
// wrote are NOT deleted from the account: the import is merged, like tasks and
// habits already are. Falls through to plain fn() when sync isn't running.
export function runAdditiveSync(fn) { return engine && engine.isActive() ? engine.runAdditive(fn) : Promise.resolve(fn()); }

// "Clear all data" wipes this device only; remove the sync bookkeeping with it
// (it uses a `nook:` prefix the nook-/nook_ sweep doesn't match). The cloud copy
// is untouched and syncs back down on next load.
export function clearLocalSyncState() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('nook:')) keys.push(k);
    }
    keys.forEach(k => localStorage.removeItem(k));
  } catch {}
}

// Make sure everything just written (e.g. by an import) is diffed and pushed
// BEFORE the caller reloads the page — a reload abandons in-flight requests.
export async function settleSync() {
  if (!engine || !engine.isActive()) return;
  await engine.processPendingNow();
  await engine.flush();
}
