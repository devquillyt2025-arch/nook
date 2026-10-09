// ─── Cross-device sync engine ────────────────────────────────────────
// Syncs every non-task/habit tab (notes, links, journal, settings…)
// through the generic `synced_items` Supabase table (migration 0012).
//
// THE CONTRACT, same as tasksService/habitsService:
//   • localStorage stays the synchronous source of truth the UI reads. Nothing
//     here changes what a view reads or how it writes; views keep calling
//     localStorage exactly as before.
//   • The engine OBSERVES writes to the keys it was told about, diffs each
//     collection against what it last synced, and pushes only the items that
//     changed. A remote change is merged INTO localStorage and views are told
//     via an event.
//   • Reconciliation is per ITEM, last-write-wins on the edit time, with
//     soft-delete tombstones — so two devices editing different notes never
//     overwrite each other, and a deletion propagates instead of resurrecting.
//   • EVERY entry point is a clean no-op when auth isn't configured or nobody
//     is signed in. Never assume a session exists.
//
// ⚠️ WIRING RULE FOR VIEWS: a view that keeps a synced list in React state must
// refresh from storage on the 'applied' event (useSyncApplied does this AND
// acknowledges). Until a refresh is acknowledged, the engine treats items it
// merged in as "not yet seen by the app" and will put them back if a stale save
// drops them — it never reads such a drop as the user deleting them.
//
// This file is the pure core: it takes its environment (storage, supabase,
// clock, lock, emitter) as arguments so the whole thing runs under test against
// a real Postgres. The browser wiring lives in sync.js.

// Bookkeeping keys use a `nook:` prefix ON PURPOSE. Every sweep of Nook's
// storage — backup export, import's ALLOWED_PREFIX, the cross-tab banner —
// matches /^nook[-_]/, so these stay out of backup files (a restored copy would
// carry another device's stale sync state), can't be re-imported, and never
// raise the "data changed in another tab" banner. "Clear all data" removes them
// explicitly (clearLocalSyncState in sync.js).
const META_PREFIX     = 'nook:sync:meta:';
export const CURSOR_KEY = 'nook:sync:cursor';
export const UID_KEY    = 'nook:sync:uid';
// Written just before the engine merges remote data into storage. Other tabs of
// the same browser see it via the `storage` event and know that the data-key
// writes which follow are a SYNC, not a competing edit (see sync.js / App.jsx).
export const APPLIED_KEY = 'nook:sync:applied-at';

const PUSH_CHUNK       = 100;
const PUSH_CHUNK_BYTES = 900_000;   // stay well under typical request limits
const PULL_PAGE        = 1000;      // PostgREST's default max-rows
const CURSOR_OVERLAP   = 15_000;    // re-read a little behind the cursor: server
                                    // commit order ≠ updated_at order for slow txns
const TOMB_TTL         = 7 * 24 * 3600 * 1000;

// ─── Small pure helpers (exported for tests) ──────────────────────────

// Key-order-independent JSON. A value that round-trips through Postgres jsonb
// comes back with its keys re-ordered, so plain JSON.stringify would call an
// unchanged item "changed" and bounce it between devices forever.
export function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(x => stableStringify(x === undefined ? null : x)).join(',') + ']';
  const keys = Object.keys(v).filter(k => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';
}

// cyrb53 — small, fast, 53 bits. A collision would mean an edit goes
// undetected; at 2^-53 per comparison that is not a real risk.
export function hashOf(v) {
  const s = stableStringify(v);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const toMs  = (iso) => { const n = iso ? Date.parse(iso) : NaN; return Number.isNaN(n) ? 0 : n; };
const toIso = (ms)  => new Date(ms).toISOString();

// Meta shape, per def — compact because the activity log alone is 2000 items:
//   i: { [itemId]: [editMs, contentHash, dirty(0|1)] }   live items
//   t: { [itemId]: [deletedMs, dirty(0|1)] }             tombstones
//   init: true once this device has processed the def at least once
function emptyMeta() { return { i: {}, t: {}, init: false }; }

// Stamp for an item the meta has never seen. On a device's FIRST pass an
// unknown item gets its own timestamp, or 0 = "never edited as far as I know".
// 0 is strictly OLDER than anything pushed (pushes are floored at 1ms), so a
// local default or stale copy can never beat — or tie with — a real remote
// value: on a first sync the cloud wins and the devices converge. A tie would
// leave both sides keeping their own value forever. Items created afterwards
// are stamped "now".
function newItemStamp(def, data, init, now) {
  const own = def.tsOf ? def.tsOf(data) : null;
  if (!init) return own ?? 0;
  return def.immutable ? (own ?? now) : now;
}

// ─── Engine ───────────────────────────────────────────────────────────
export function createSyncEngine({
  defs,
  storage,
  supabase,
  emit = () => {},
  lock = (_name, fn) => fn(),
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (h) => clearTimeout(h),
  subscribeRealtime = null,          // (uid, onRow, onStatus) => unsubscribe
  // Asked when a different account signs in on a browser that last synced as someone
  // else: 'discard' (default — never upload the previous account's data) or 'keep'.
  onAccountSwitch = async () => 'discard',
  debounceMs = 1500,
  touchDebounceMs = 250,
  log = (...a) => console.warn('[sync]', ...a),
}) {
  const byName = new Map(defs.map(d => [d.name, d]));
  const states = new Map();          // def.name -> { meta, unacked }
  let uid = null;                    // set by begin(); null = inactive
  let applying = 0;                  // >0 while WE are writing storage
  let suspended = 0;                 // >0 while the observer must stay quiet
  let unsubRealtime = null;
  let pushTimer = null, touchTimer = null, retryTimer = null;
  let retryDelay = 0;
  let again = false;                 // an edit landed while a flush was in flight
  let pullFailed = false;            // the last pull failed — status must not claim "up to date"
  const failCounts = new Map();      // "def/id" -> consecutive server rejections (memory only)
  let additive = 0;                  // >0 during an import: never turn absence into a delete
  const pendingTouch = new Map();    // def.name -> { removed, ids:Set|null }
  const statusListeners = new Set();
  const status = { state: 'idle', pending: 0, lastSyncAt: null, error: null };

  // ── status ──────────────────────────────────────────────────────────
  function setStatus(patch) {
    Object.assign(status, patch);
    for (const fn of statusListeners) { try { fn({ ...status }); } catch {} }
  }
  function countPending() {
    let n = 0;
    for (const def of defs) {
      const { meta } = getState(def);
      for (const k in meta.i) if (meta.i[k][2]) n++;
      for (const k in meta.t) if (meta.t[k][1]) n++;
    }
    return n;
  }

  // ── meta persistence ────────────────────────────────────────────────
  function readMeta(def) {
    try {
      const raw = storage.getItem(META_PREFIX + def.name);
      if (raw) { const p = JSON.parse(raw); if (p && p.i && p.t) return { i: p.i, t: p.t, init: !!p.init }; }
    } catch {}
    return emptyMeta();
  }
  // `fresh`: re-read the meta from storage. Every mutation happens inside
  // lock(def.name) — navigator.locks, so it spans all open tabs — and each
  // locked section starts with a fresh read. That is what keeps two tabs of the
  // same browser (one localStorage, two engines) from overwriting each other's
  // bookkeeping with a stale in-memory copy.
  function getState(def, fresh = false) {
    let st = states.get(def.name);
    if (!st) { st = { meta: readMeta(def), unacked: new Map() }; states.set(def.name, st); }
    else if (fresh) st.meta = readMeta(def);
    return st;
  }
  function saveMeta(def) {
    const { meta } = getState(def);
    const t = now();
    for (const id in meta.t) if (!meta.t[id][1] && t - meta.t[id][0] > TOMB_TTL) delete meta.t[id];
    try { storage.setItem(META_PREFIX + def.name, JSON.stringify(meta)); } catch {}
  }
  function resetMeta() {
    states.clear();
    for (const def of defs) { try { storage.removeItem(META_PREFIX + def.name); } catch {} }
    try { storage.removeItem(CURSOR_KEY); } catch {}
  }

  function withApplying(fn) { applying++; try { return fn(); } finally { applying--; } }

  // A corrupt / half-written key must make us SKIP this pass. Reading it as
  // "empty" would look like the user deleted every item and tombstone the cloud.
  function safeRead(def, fn) {
    try { return fn(); }
    catch (e) { log(`${def.name}: unreadable in storage, skipping this pass`, e?.message || e); return null; }
  }

  // ── routing: which def owns a (collection, id) row ──────────────────
  function routeRow(row) {
    let fallback = null;
    for (const def of defs) {
      if (def.collection !== row.collection) continue;
      if (def.fixedId) { if (def.fixedId === row.id) return def; }
      else fallback = def;
    }
    return fallback;
  }

  // ═════════════════════════════════════════════════════════════════════
  // LOCAL → META  (a view wrote storage; find what changed)
  // ═════════════════════════════════════════════════════════════════════
  // hint.ids (keyed defs only): the specific item ids whose storage keys were
  // written. Journal autosaves on every pause; rescanning every day's entry
  // each time would be wasted work.
  async function processDef(def, hint = {}) {
    return lock(def.name, async () => {
      const st = getState(def, true);
      const meta = st.meta;

      // Stamp an edit with when it was WRITTEN, not when this debounced pass runs:
      // a backgrounded tab throttles timers (sometimes to once a minute), and a
      // late stamp would let an older edit on another device win last-write-wins.
      const t = hint.t ?? now();
      const targeted = !!(def.readOne && hint.ids && hint.ids.size);
      const items = safeRead(def, () => targeted
        ? [...hint.ids].map(id => def.readOne(storage, id)).filter(Boolean)
        : def.read(storage));
      if (!items) return;
      const byId = new Map(items.map(i => [i.id, i]));
      const upsertedIds = new Set(), removedIds = new Set();

      // 1) STALE-VIEW PROTECTION (see the wiring rule in the file header).
      for (const [id, un] of [...st.unacked]) {
        if (targeted && !hint.ids.has(id)) continue;
        const cur = byId.get(id);
        if (un.kind === 'remove') {
          if (cur && hashOf(cur.data) === un.before) { byId.delete(id); removedIds.add(id); }  // stale view re-added a deleted item
          else st.unacked.delete(id);
          continue;
        }
        if (!cur) {
          // At its cap, a missing item was pushed out by a newer entry (that is how every
          // capped log works) — not dropped by a stale view. Restoring it would re-add and
          // re-trim on every single write.
          if (def.cap && items.length >= def.cap) { st.unacked.delete(id); continue; }
          byId.set(id, un.item); upsertedIds.add(id); continue;                        // dropped by a stale save → put back
        }
        const h = hashOf(cur.data);
        if (h === un.after) { st.unacked.delete(id); continue; }                     // app has caught up
        if (h === un.before) { byId.set(id, un.item); upsertedIds.add(id); continue; } // stale copy of the OLD version
        st.unacked.delete(id);                                                       // a real edit on top → normal diff
      }

      // 2) Diff storage against what we last synced.
      let dirty = false;
      for (const [id, it] of byId) {
        const h = hashOf(it.data);
        const m = meta.i[id];
        if (!m) {
          meta.i[id] = [newItemStamp(def, it.data, meta.init, t), h, 1];
          delete meta.t[id];                        // re-created after a delete
          dirty = true;
        } else if (m[1] !== h) {
          meta.i[id] = [t, h, 1];
          dirty = true;
        }
      }
      const candidates = targeted ? [...hint.ids] : Object.keys(meta.i);
      let dropped = 0;
      for (const id of candidates) {
        if (byId.has(id) || !meta.i[id]) continue;
        // Capped logs trim by DROPPING the oldest entries; that is not a delete
        // and must not mint a tombstone per write. Only wiping the whole key is.
        if (def.deleteOnRemoveOnly && !hint.removed) { delete meta.i[id]; continue; }
        // The first pass after sign-in, and an import, must NEVER read "it's not
        // in storage" as "the user deleted it": a wiped / half-cleared / freshly
        // restored localStorage would otherwise tombstone the whole cloud copy.
        // Forget the item locally instead; a full pull (below) brings it back.
        if (hint.initial || additive) { delete meta.i[id]; dropped++; continue; }
        meta.t[id] = [t, 1];
        delete meta.i[id];
        dirty = true;
      }
      if (dropped) { try { storage.removeItem(CURSOR_KEY); } catch {} }   // next pull re-fetches everything
      meta.init = true;

      if (upsertedIds.size || removedIds.size) {
        const list = targeted ? [...byId.values()] : orderItems(def, items, byId);
        withApplying(() => {
          try { storage.setItem(APPLIED_KEY, String(now())); } catch {}
          def.write(storage, list, { upserts: [...upsertedIds], removes: [...removedIds] });
        });
        emit('applied', { names: [def.name] });
      }
      saveMeta(def);
      if (dirty) schedulePush();
      setStatus({ pending: countPending() });
    });
  }

  // Keep the order the app wrote; items the engine re-adds go to the front.
  function orderItems(def, original, byId) {
    const seen = new Set();
    const out = [];
    for (const it of original) { const cur = byId.get(it.id); if (cur) { out.push(cur); seen.add(it.id); } }
    const extra = [];
    for (const [id, it] of byId) if (!seen.has(id)) extra.push(it);
    return finalize(def, [...extra, ...out]);
  }

  function finalize(def, list) {
    let out = list;
    if (def.sort) out = out.slice().sort(def.sort);
    if (def.cap && out.length > def.cap) out = def.capFrom === 'end' ? out.slice(out.length - def.cap) : out.slice(0, def.cap);
    return out;
  }

  // The observer calls this for every setItem/removeItem on localStorage.
  function notifyWrite(key, removed = false) {
    if (applying || suspended || !uid) return;
    let hit = false;
    for (const def of defs) {
      const match = def.matchKey(key);
      if (!match) continue;
      const prev = pendingTouch.get(def.name) || { removed: false, ids: new Set(), full: false, t: 0 };
      prev.t = now();
      if (removed && def.isWholeKey(key)) prev.removed = true;
      if (typeof match === 'string') prev.ids.add(match); else prev.full = true;
      pendingTouch.set(def.name, prev);
      hit = true;
    }
    if (hit && !touchTimer) touchTimer = setTimer(() => { touchTimer = null; runPendingTouches(); }, touchDebounceMs);
  }

  async function runPendingTouches() {
    if (touchTimer) { clearTimer(touchTimer); touchTimer = null; }
    const batch = [...pendingTouch.entries()];
    pendingTouch.clear();
    for (const [name, p] of batch) {
      await processDef(byName.get(name), { removed: p.removed, ids: p.full ? null : p.ids, t: p.t });
    }
  }

  // Run fn (which writes storage, e.g. an import) so that nothing it removes is
  // treated as a deletion — the import is MERGED into the account, like tasks and
  // habits already are, instead of silently deleting everything not in the file
  // from every device. Whatever the file replaced locally is re-fetched by the
  // full pull that follows (the cursor is reset).
  async function runAdditive(fn) {
    additive++;
    try { await fn(); await runPendingTouches(); } finally { additive--; }
  }

  // Run fn with the observer silenced — for "Clear all data", where wiping
  // localStorage must NOT be read as the user deleting everything in the cloud.
  async function runUntracked(fn) {
    // An edit still inside its debounce window would otherwise be diffed AFTER the
    // wipe, find every item gone, and tombstone the whole account. Diff it now, against
    // the storage as it is, and try to send it (bounded — we are about to wipe/reload).
    try {
      await runPendingTouches();
      await Promise.race([flush(), new Promise(r => setTimer(r, 4000))]);
    } catch {}
    suspended++;
    try { return await fn(); }
    finally {
      suspended--;
      pendingTouch.clear();
      if (touchTimer) { clearTimer(touchTimer); touchTimer = null; }
    }
  }

  // A view has refreshed from storage after an 'applied' event: it has now seen
  // everything the engine merged in, so stop guarding those items.
  function ack(names) {
    for (const n of names || []) { const d = byName.get(n); if (d) getState(d).unacked.clear(); }
  }

  // ═════════════════════════════════════════════════════════════════════
  // REMOTE → LOCAL  (merge rows from the server into storage)
  // ═════════════════════════════════════════════════════════════════════
  async function applyRows(rows) {
    const groups = new Map();
    for (const row of rows) {
      const def = routeRow(row);
      if (!def) continue;                         // a collection this build doesn't know yet
      if (!groups.has(def.name)) groups.set(def.name, []);
      groups.get(def.name).push(row);
    }
    const changedNames = [];
    for (const [name, list] of groups) {
      const def = byName.get(name);
      if (await applyToDef(def, list)) changedNames.push(name);
    }
    if (changedNames.length) emit('applied', { names: changedNames });
    return changedNames;
  }

  async function applyToDef(def, rows) {
    return lock(def.name, async () => {
      const st = getState(def, true);
      const meta = st.meta;
      const items = safeRead(def, () => def.read(storage));
      if (!items) return false;
      const byId = new Map(items.map(i => [i.id, i]));
      const added = [], upserts = new Set(), removes = new Set();
      let needsPush = false;

      const lastEdit = (id, local) => {
        const m = meta.i[id];
        if (m) return m[0];
        return (def.tsOf ? def.tsOf(local.data) : null) ?? 0;
      };

      // A local edit made inside the last debounce window has not been diffed yet:
      // meta still holds its PRE-edit hash and stamp. Recognise it as the edit it
      // is — stamped with when it was written — BEFORE comparing with the remote
      // row, or an older remote version would overwrite text the user just typed.
      // (Items awaiting a view refresh are the stale-view guard's job, not this.)
      const pendingAt = pendingTouch.get(def.name)?.t;
      for (const r of rows) {
        const l = byId.get(r.id), m0 = meta.i[r.id];
        if (!l || !m0 || st.unacked.has(r.id)) continue;
        const h = hashOf(l.data);
        if (m0[1] !== h) { meta.i[r.id] = [pendingAt ?? now(), h, 1]; needsPush = true; }
      }

      const sorted = rows.slice().sort((a, b) => toMs(a.updatedAt) - toMs(b.updatedAt));
      for (const r of sorted) {
        const id = r.id;
        const ru = toMs(r.updatedAt);
        const local = byId.get(id);
        const m = meta.i[id];
        const tm = meta.t[id];

        if (r.deleted_at) {
          if (!local) continue;
          if (ru >= lastEdit(id, local)) {
            st.unacked.set(id, { kind: 'remove', before: hashOf(local.data) });
            byId.delete(id);
            delete meta.i[id];
            upserts.delete(id); removes.add(id);
          } else if (m) { m[2] = 1; needsPush = true; }   // our copy is newer → it will resurrect the row
          continue;
        }

        if (tm) {
          if (tm[0] >= ru) { tm[1] = 1; needsPush = true; continue; } // our delete is newer → keep it, make sure it's pushed
          delete meta.t[id];                        // a newer remote edit beats our old delete
        }

        const data = r.data;
        if (local) {
          const lu = lastEdit(id, local);
          if (ru > lu) {
            const after = hashOf(data);
            if (m && m[1] === after) { meta.i[id] = [ru, after, 0]; continue; }   // same content, just newer stamp
            st.unacked.set(id, { kind: 'upsert', before: hashOf(local.data), after, item: { id, data } });
            byId.set(id, { id, data });
            meta.i[id] = [ru, after, 0];
            upserts.add(id); removes.delete(id);
          } else if (lu > ru && m) { m[2] = 1; needsPush = true; }   // local newer → push it
          // equal: converged (usually our own push echoing back through realtime)
        } else {
          const after = hashOf(data);
          st.unacked.set(id, { kind: 'upsert', before: null, after, item: { id, data } });
          byId.set(id, { id, data });
          meta.i[id] = [ru, after, 0];
          added.push(id); upserts.add(id); removes.delete(id);
        }
      }

      const changed = upserts.size > 0 || removes.size > 0;
      if (changed) {
        const original = items.filter(i => byId.has(i.id)).map(i => byId.get(i.id));
        // New remote items go to the FRONT, newest first (matches how the apps
        // prepend a fresh note); then the def's own sort/cap if it has one.
        const fresh = added.filter(id => byId.has(id)).map(id => byId.get(id)).reverse();
        const finalList = finalize(def, [...fresh, ...original]);
        // Items the def's cap just dropped are gone on purpose. Left in `unacked`, the
        // stale-view guard would "put them back" (and re-emit) on every later write.
        const kept = new Set(finalList.map(i => i.id));
        for (const [id, un] of [...st.unacked]) if (un.kind === 'upsert' && !kept.has(id)) st.unacked.delete(id);
        // Same for the bookkeeping: a never-uploaded entry the cap just pushed out is not
        // "waiting to upload" (there is nothing left to send), and it is not a delete either.
        // Without this a first merge of two big logs shows "N changes waiting" until the next
        // write to that log happens to clean it up (processDef does the same for capped logs).
        if (def.cap) for (const id of byId.keys()) if (!kept.has(id)) delete meta.i[id];
        withApplying(() => {
          try { storage.setItem(APPLIED_KEY, String(now())); } catch {}
          def.write(storage, finalList, { upserts: [...upserts], removes: [...removes] });
        });
      }
      saveMeta(def);
      if (needsPush) schedulePush();
      setStatus({ pending: countPending() });
      return changed;
    });
  }

  // ═════════════════════════════════════════════════════════════════════
  // PUSH
  // ═════════════════════════════════════════════════════════════════════
  function schedulePush(delay = debounceMs) {
    if (!uid) return;
    if (flushing) { again = true; return; }
    if (pushTimer) return;
    pushTimer = setTimer(() => { pushTimer = null; flush(); }, delay);
  }

  async function collectRows(def) {
    return lock(def.name, async () => {
      const { meta } = getState(def, true);
      const read = safeRead(def, () => def.read(storage));
      if (!read) return { rows: [], sent: [] };
      const items = new Map(read.map(i => [i.id, i]));
      const rows = [], sent = [];
      let skipped = false;
      for (const id in meta.i) {
        const m = meta.i[id];
        if (!m[2]) continue;
        const it = items.get(id);
        if (!it) continue;                          // vanished since; the next pass tombstones it
        const data = it.data;
        if (def.maxBytes && stableStringify(data).length > def.maxBytes) {
          log(`${def.name}/${id}: exceeds the sync size cap, kept on this device only`);
          m[2] = 0; skipped = true; continue;
        }
        rows.push({ collection: def.collection, id, data, updatedAt: toIso(Math.max(m[0], 1)), deleted_at: null });
        sent.push({ id, u: m[0], kind: 'i' });
      }
      for (const id in meta.t) {
        const tm = meta.t[id];
        if (!tm[1]) continue;
        rows.push({ collection: def.collection, id, data: {}, updatedAt: toIso(tm[0]), deleted_at: toIso(tm[0]) });
        sent.push({ id, u: tm[0], kind: 't' });
      }
      if (skipped) saveMeta(def);
      return { rows, sent };
    });
  }

  // Marks pushed items clean — but only if they weren't edited again while the
  // request was in flight (their stamp would differ). `poisoned`: rows the server
  // keeps rejecting; we stop retrying them (they stay on this device until edited).
  async function acknowledge(def, sent, resultById, poisoned = new Set()) {
    const serverWon = [];
    await lock(def.name, async () => {
      const { meta } = getState(def, true);
      for (const s of sent) {
        const live = s.kind === 'i';
        const entry = live ? meta.i[s.id] : meta.t[s.id];
        const untouched = !!entry && entry[0] === s.u;             // not edited again while in flight
        const dirtyAt = live ? 2 : 1;
        if (poisoned.has(s.id)) { if (untouched) entry[dirtyAt] = 0; continue; }
        const res = resultById.get(s.id);
        if (!res) continue;
        const sentStamp = live ? Math.max(s.u, 1) : s.u;
        const serverStamp = toMs(res.updatedAt);
        // `accepted:false` with OUR exact stamp means the server already holds this very
        // version — a previous attempt committed but its response was lost. That's done,
        // not a conflict; treating it as one would re-send it on every flush forever.
        if (res.accepted || serverStamp === sentStamp) {
          if (!untouched) continue;
          entry[dirtyAt] = 0;
          // The server clamps absurd future stamps (migration 0012); agree with what it stored.
          if (res.accepted && serverStamp && serverStamp !== sentStamp) entry[0] = serverStamp;
        } else {
          serverWon.push({ collection: def.collection, id: s.id, data: res.data, updatedAt: res.updatedAt, deleted_at: res.deleted_at });
        }
      }
      saveMeta(def);
    });
    // Another device edited later: adopt its version instead of retrying forever.
    if (serverWon.length) await applyRows(serverWon);
  }

  let flushing = null;
  async function flush() {
    if (!uid) return false;
    if (flushing) return flushing;                // coalesce concurrent callers
    flushing = (async () => {
      let failed = false;
      try {
        // Make sure any just-made edit has been diffed before we collect.
        await runPendingTouches();
        setStatus({ state: 'syncing' });
        for (const def of defs) {
          if (!hasDirty(def)) continue;                 // don't read/parse big slices that have nothing to send
          const { rows, sent } = await collectRows(def);
          if (!rows.length) continue;
          const resultById = new Map(), poisoned = new Set();
          let down = false;
          for (const chunk of chunked(rows)) {
            let r = await pushChunk(chunk, resultById);
            if (r === 'rejected') {
              // The server read the request and said no: one bad row may be sinking its
              // neighbours, so retry them singly. (Never do this when it is merely unreachable.)
              const each = chunk.length > 1 ? await pushEach(def, chunk, resultById) : rejectOne(def, chunk[0]);
              each.poisoned.forEach(id => poisoned.add(id));
              r = each.status;
            }
            if (r === 'network') { down = true; failed = true; break; }
            if (r === 'partial') failed = true;
          }
          await acknowledge(def, sent, resultById, poisoned);
          if (down) break;                              // offline: one failed request, not one per slice
        }
        setStatus(failed || pullFailed
          ? { state: 'error', pending: countPending() }
          : { state: 'idle', pending: countPending(), lastSyncAt: now(), error: null });
      } catch (e) {
        failed = true;
        log('flush threw', e?.message || e);
        setStatus({ state: 'error', error: String(e?.message || e), pending: countPending() });
      } finally {
        flushing = null;
      }
      if (failed) scheduleRetry();
      else { retryDelay = 0; if (again) { again = false; schedulePush(); } }
      return !failed;
    })();
    return flushing;
  }

  function* chunked(rows) {
    let cur = [], bytes = 0;
    for (const r of rows) {
      const sz = stableStringify(r.data).length + 120;
      if (cur.length && (cur.length >= PUSH_CHUNK || bytes + sz > PUSH_CHUNK_BYTES)) { yield cur; cur = []; bytes = 0; }
      cur.push(r); bytes += sz;
    }
    if (cur.length) yield cur;
  }

  // 'ok' | 'rejected' (the server looked at the request and refused it — a retry row by
  // row can help) | 'network' (unreachable, signed out, or the server is erroring — stop
  // and try again later; hammering it per row would just multiply the failures).
  async function pushChunk(chunk, resultById) {
    try {
      const res = await supabase.rpc('upsert_synced_items', { p_items: chunk });
      const { data, error } = res;
      if (error) {
        const status = res.status || 0;
        log('push failed:', error.message);
        setStatus({ error: error.message });
        const authProblem = status === 401 || status === 403 || /not authenticated|jwt/i.test(error.message || '');
        const refused = !authProblem && ((!!error.code && status < 500) || (status >= 400 && status < 500 && status !== 408 && status !== 429));
        return refused ? 'rejected' : 'network';
      }
      for (const r of data || []) resultById.set(r.id, r);
      return 'ok';
    } catch (e) {
      log('push threw:', e?.message || e);
      setStatus({ error: String(e?.message || e) });
      return 'network';
    }
  }

  // A row the server refused. After a few consecutive refusals stop retrying it
  // (it would keep the whole app "waiting to upload" forever); it stays on this
  // device and is tried again the next time it is edited.
  const GIVE_UP_AFTER = 3;
  function rejectOne(def, row) {
    const key = `${def.name}/${row.id}`;
    const n = (failCounts.get(key) || 0) + 1;
    if (n >= GIVE_UP_AFTER) {
      failCounts.delete(key);
      log(`${key}: refused by the server ${n} times, kept on this device only until it is edited`);
      return { status: 'ok', poisoned: new Set([row.id]) };
    }
    failCounts.set(key, n);
    return { status: 'partial', poisoned: new Set() };
  }
  async function pushEach(def, chunk, resultById) {
    const poisoned = new Set();
    let partial = false;
    for (const row of chunk) {
      const r = await pushChunk([row], resultById);
      if (r === 'network') return { status: 'network', poisoned };
      if (r === 'rejected') {
        const one = rejectOne(def, row);
        one.poisoned.forEach(id => poisoned.add(id));
        if (one.status === 'partial') partial = true;
      } else failCounts.delete(`${def.name}/${row.id}`);
    }
    return { status: partial ? 'partial' : 'ok', poisoned };
  }

  function hasDirty(def) {
    const { meta } = getState(def, true);               // re-read: another tab may have queued something
    for (const k in meta.i) if (meta.i[k][2]) return true;
    for (const k in meta.t) if (meta.t[k][1]) return true;
    return false;
  }

  function scheduleRetry() {
    if (retryTimer || !uid) return;
    retryDelay = Math.min(retryDelay ? retryDelay * 2 : 20_000, 5 * 60_000);
    retryTimer = setTimer(() => { retryTimer = null; syncNow(); }, retryDelay);
  }

  // ═════════════════════════════════════════════════════════════════════
  // PULL
  // ═════════════════════════════════════════════════════════════════════
  async function pull() {
    if (!uid) return false;
    let cursor = null;
    try { cursor = Number(storage.getItem(CURSOR_KEY)) || null; } catch {}

    const rows = [];
    let maxServer = cursor || 0;
    try {
      for (let from = 0; ; from += PULL_PAGE) {
        let q = supabase.from('synced_items').select('*');
        if (cursor) q = q.gt('updated_at', toIso(cursor - CURSOR_OVERLAP));
        q = q.order('updated_at', { ascending: true }).order('collection').order('id').range(from, from + PULL_PAGE - 1);
        const { data, error } = await q;
        if (error) { log('pull failed:', error.message); pullFailed = true; setStatus({ state: 'error', error: error.message }); return false; }
        const page = data || [];
        for (const r of page) {
          rows.push(r);
          maxServer = Math.max(maxServer, toMs(r.updated_at));
        }
        if (page.length < PULL_PAGE) break;
      }
    } catch (e) {
      log('pull threw:', e?.message || e);
      pullFailed = true;
      setStatus({ state: 'error', error: String(e?.message || e) });
      return false;
    }

    pullFailed = false;
    await applyRows(rows);
    if (maxServer) { try { storage.setItem(CURSOR_KEY, String(maxServer)); } catch {} }
    return true;
  }

  // Realtime delivers one row at a time. Large payloads can arrive without their
  // `data`; fetch the row when that happens rather than adopt an empty item.
  async function onRealtime(payload) {
    if (!uid) return;
    const row = payload?.new;
    if (!row || !row.collection) return;
    let r = row;
    if (!r.deleted_at && (r.data === undefined || r.data === null)) {
      try {
        const { data } = await supabase.from('synced_items').select('*')
          .eq('collection', r.collection).eq('id', r.id).maybeSingle();
        if (!data) return;
        r = data;
      } catch { return; }
    }
    await applyRows([r]);
  }

  // ═════════════════════════════════════════════════════════════════════
  // LIFECYCLE
  // ═════════════════════════════════════════════════════════════════════
  async function begin(userId) {
    if (!userId) return;
    let stored = null;
    try { stored = storage.getItem(UID_KEY); } catch {}
    if (stored && stored !== userId) {
      // A DIFFERENT account was last synced on this browser. Its notes/journal/links are
      // still in localStorage; uploading them would put one person's private data into
      // another person's account (and onto all of that account's devices).
      let choice = 'discard';
      try { choice = await onAccountSwitch(); } catch {}
      resetMeta();
      if (choice !== 'keep') wipeLocalSynced();
    }
    try { storage.setItem(UID_KEY, userId); } catch {}
    uid = userId;

    if (!unsubRealtime && subscribeRealtime) {
      unsubRealtime = subscribeRealtime(
        userId,
        (payload) => { onRealtime(payload); },
        (s) => { if (s === 'SUBSCRIBED') pull(); },   // catch up on anything missed while the socket was down
      );
    }
    // Diff everything once so edits made before sign-in (or while the engine
    // wasn't running) are picked up, then reconcile with the server.
    for (const def of defs) await processDef(def, { initial: true });
    await syncNow();
  }

  // Remove every synced slice's data from this browser (the previous account's copy
  // lives on in ITS cloud). Open views are told to refresh so a stale one can't re-save it.
  function wipeLocalSynced() {
    const names = [];
    withApplying(() => {
      try { storage.setItem(APPLIED_KEY, String(now())); } catch {}
      for (const def of defs) {
        let items = [];
        try { items = def.read(storage); } catch { continue; }       // unreadable → leave it alone
        if (!items.length) continue;
        def.write(storage, [], { upserts: [], removes: items.map(i => i.id) });
        names.push(def.name);
      }
    });
    if (names.length) emit('applied', { names });
  }

  function end() {
    uid = null;
    if (unsubRealtime) { try { unsubRealtime(); } catch {} unsubRealtime = null; }
    for (const h of [pushTimer, touchTimer, retryTimer]) if (h) clearTimer(h);
    pushTimer = touchTimer = retryTimer = null;
    setStatus({ state: 'idle' });
  }

  async function syncNow() {
    if (!uid) return false;
    setStatus({ state: 'syncing' });
    await runPendingTouches();
    const pulled = await pull();
    const pushed = await flush();
    if (!pulled) scheduleRetry();                       // reads failed: keep trying, and don't say "up to date"
    return pulled && pushed;
  }

  return {
    begin, end, syncNow, pull, flush, ack,
    notifyWrite, runUntracked, runAdditive, processPendingNow: runPendingTouches,
    applyRows, onRealtime,
    getStatus: () => ({ ...status }),
    onStatus: (fn) => { statusListeners.add(fn); return () => statusListeners.delete(fn); },
    isActive: () => !!uid,
    namesForKey: (key) => defs.filter(d => d.matchKey(key)).map(d => d.name),
    _state: getState,                           // tests only
  };
}
