// ─── What gets synced, and how each localStorage key maps to items ────
// One "def" per synced slice. A def teaches the engine (syncEngine.js) how to
// read a slice out of storage as [{ id, data }] items and how to write items
// back — nothing else. The storage KEYS and SHAPES here are exactly what the
// views already use; sync changes neither (see nook-overview/02-data-model.md).
//
// Not synced on purpose (device-specific or secret):
//   nook_google_tokens / nook_gcal_tokens / *_pkce_verifier / sync queues
//   nook_ai_api_key            — a credential
//   nook-notif-* toggles       — depend on THIS browser's notification permission
//   nook-sidebar-open, nook-active-tab, nook-visits, nook-install-dismissed
//   nook_journal_calview / _calcollapsed — per-device view preferences
//   nook_ai_chat_history       — the hidden assistant panel
//   tasks / habits / reminders — they have their own Supabase tables + services

// Parse helper that distinguishes "absent" (undefined) from "corrupt" (throws).
// The engine treats a throw as "skip this pass", never as "everything deleted".
function parseJson(raw, key) {
  try { return JSON.parse(raw); }
  catch { throw new Error(`${key} is not valid JSON`); }
}

const hasId = (x) => x && typeof x === 'object' && x.id != null && x.id !== '';

function tsFromData(d) {
  const n = Date.parse(d?.updatedAt || d?.createdAt || '');
  return Number.isNaN(n) ? null : n;
}

// ── Array of objects that each carry an `id` ──────────────────────────
function listDef({ name, collection = name, lsKey, tsOf = tsFromData, ...rest }) {
  return {
    name, collection, tsOf,
    matchKey: (k) => k === lsKey,
    isWholeKey: (k) => k === lsKey,
    read(storage) {
      const raw = storage.getItem(lsKey);
      if (raw == null) return [];
      const arr = parseJson(raw, lsKey);
      if (!Array.isArray(arr)) return [];
      return arr.filter(hasId).map(x => ({ id: String(x.id), data: x }));
    },
    write(storage, items) {
      // Entries with no id can't be keyed or synced — carry them through rather
      // than silently dropping user data the day sync first touches the list.
      let keep = [];
      try {
        const cur = JSON.parse(storage.getItem(lsKey) || '[]');
        if (Array.isArray(cur)) keep = cur.filter(x => !hasId(x));
      } catch {}
      const out = [...items.map(i => i.data), ...keep];
      if (!out.length) storage.setItem(lsKey, '[]'); else storage.setItem(lsKey, JSON.stringify(out));
    },
    ...rest,
  };
}

// ── One value in one key, synced as a single fixed-id item ────────────
//   codec 'json': the key holds JSON.   codec 'raw': the key holds a plain string.
function singleDef({ name, collection, fixedId, lsKey, codec = 'json', maxBytes, tsOf = () => null }) {
  return {
    name, collection, fixedId, maxBytes, tsOf,
    matchKey: (k) => k === lsKey,
    isWholeKey: (k) => k === lsKey,
    read(storage) {
      const raw = storage.getItem(lsKey);
      if (raw == null) return [];
      return [{ id: fixedId, data: codec === 'json' ? parseJson(raw, lsKey) : raw }];
    },
    write(storage, items) {
      if (!items.length) { storage.removeItem(lsKey); return; }
      const d = items[0].data;
      storage.setItem(lsKey, codec === 'json' ? JSON.stringify(d) : String(d));
    },
  };
}

// ── One storage key PER item (the journal: nook_journal_<YYYY-MM-DD>) ─
function keyedDef({ name, collection = name, prefix, idPattern }) {
  const keyOf = (id) => prefix + id;
  const readOne = (storage, id) => {
    const raw = storage.getItem(keyOf(id));
    if (raw == null) return null;
    const data = parseJson(raw, keyOf(id));
    return data && typeof data === 'object' ? { id, data } : null;
  };
  return {
    name, collection, readOne,
    tsOf: tsFromData,
    // Returns the item id (a string) so the engine can re-diff just that day.
    matchKey: (k) => { const m = idPattern.exec(k); return m ? m[1] : null; },
    isWholeKey: () => false,
    read(storage) {
      const out = [];
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        const m = k && idPattern.exec(k);
        if (!m) continue;
        const it = readOne(storage, m[1]);
        if (it) out.push(it);
      }
      return out;
    },
    write(storage, items, delta = {}) {
      const byId = new Map(items.map(i => [i.id, i]));
      for (const id of delta.upserts || []) {
        const it = byId.get(id);
        if (it) storage.setItem(keyOf(id), JSON.stringify(it.data));
      }
      for (const id of delta.removes || []) storage.removeItem(keyOf(id));
    },
  };
}

// ── One object used as a map { key: value } (journal icons, categories) ─
function mapDef({ name, collection = name, lsKey }) {
  return {
    name, collection,
    tsOf: () => null,
    matchKey: (k) => k === lsKey,
    isWholeKey: (k) => k === lsKey,
    read(storage) {
      const raw = storage.getItem(lsKey);
      if (raw == null) return [];
      const obj = parseJson(raw, lsKey);
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return [];
      return Object.entries(obj).map(([id, data]) => ({ id, data }));
    },
    write(storage, items) {
      if (!items.length) { storage.removeItem(lsKey); return; }
      storage.setItem(lsKey, JSON.stringify(Object.fromEntries(items.map(i => [i.id, i.data]))));
    },
  };
}

// ── Append-only array of strings (the pomodoro log: ISO timestamps) ───
function stringSetDef({ name, collection = name, lsKey, cap }) {
  const tsOf = (s) => { const n = Date.parse(s); return Number.isNaN(n) ? null : n; };
  return {
    name, collection, tsOf, cap, capFrom: 'end',
    immutable: true,
    deleteOnRemoveOnly: true,
    sort: (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),   // chronological, oldest first
    matchKey: (k) => k === lsKey,
    isWholeKey: (k) => k === lsKey,
    read(storage) {
      const raw = storage.getItem(lsKey);
      if (raw == null) return [];
      const arr = parseJson(raw, lsKey);
      if (!Array.isArray(arr)) return [];
      return [...new Set(arr.filter(s => typeof s === 'string' && s))].map(s => ({ id: s, data: s }));
    },
    write(storage, items) {
      storage.setItem(lsKey, JSON.stringify(items.map(i => i.data)));
    },
  };
}

// ─────────────────────────────────────────────────────────────────────
export function buildDefs() {
  return [
    // ── Content tabs ──
    listDef({ name: 'notes',           lsKey: 'nook_notes' }),
    listDef({ name: 'links',           lsKey: 'nook_links' }),
    listDef({ name: 'countdowns',      lsKey: 'nook_countdowns' }),
    listDef({ name: 'goals',           lsKey: 'nook_goals' }),
    listDef({ name: 'calendar_events', lsKey: 'nook-calendar-events' }),
    listDef({ name: 'trackers',        lsKey: 'nook-trackers' }),

    // Journal: one item per day, and the per-day mood icons.
    keyedDef({ name: 'journal', prefix: 'nook_journal_', idPattern: /^nook_journal_(\d{4}-\d{2}-\d{2})$/ }),
    mapDef({ name: 'journal_icons', lsKey: 'nook_journal_icons' }),

    // ── Logs (immutable, capped identically on every device) ──
    listDef({
      name: 'activity_log', lsKey: 'nook-activity-log',
      tsOf: (d) => { const n = Date.parse(d?.created_at || ''); return Number.isNaN(n) ? null : n; },
      immutable: true, deleteOnRemoveOnly: true,
      sort: (a, b) => (a.data.created_at < b.data.created_at ? 1 : a.data.created_at > b.data.created_at ? -1 : 0), // newest first
      cap: 2000, capFrom: 'start',
    }),
    stringSetDef({ name: 'pomo_log', lsKey: 'nook-pomo-log', cap: 2000 }),
    listDef({
      name: 'chat_history', lsKey: 'nook_chat_history',
      immutable: true, deleteOnRemoveOnly: true,
      sort: (a, b) => (a.data.createdAt < b.data.createdAt ? -1 : a.data.createdAt > b.data.createdAt ? 1 : 0),     // oldest first
      cap: 200, capFrom: 'end',
    }),

    // ── Today / Focus Timer / Settings ──
    singleDef({ name: 'intentions',       collection: 'intentions', fixedId: 'current',         lsKey: 'nook-intentions' }),
    singleDef({ name: 'pomo_settings',    collection: 'settings',   fixedId: 'pomo_settings',    lsKey: 'nook-settings' }),
    singleDef({ name: 'theme',            collection: 'settings',   fixedId: 'theme',            lsKey: 'nook-theme' }),
    singleDef({ name: 'week_start',       collection: 'settings',   fixedId: 'week_start',       lsKey: 'nook-week-start',      codec: 'raw' }),
    singleDef({ name: 'profile_name',     collection: 'settings',   fixedId: 'profile_name',     lsKey: 'nook-profile-name',    codec: 'raw' }),
    singleDef({ name: 'profile_email',    collection: 'settings',   fixedId: 'profile_email',    lsKey: 'nook-profile-email',   codec: 'raw' }),
    // The avatar is an emoji or an uploaded data: URL; cap it so a big photo
    // can't make every other setting's push fail.
    singleDef({ name: 'profile_avatar',   collection: 'settings',   fixedId: 'profile_avatar',   lsKey: 'nook-profile-avatar',  codec: 'raw', maxBytes: 250_000 }),
    singleDef({ name: 'weekly_reviews',   collection: 'settings',   fixedId: 'weekly_reviews',   lsKey: 'nook-weekly-reviews' }),
    singleDef({ name: 'task_sort',        collection: 'settings',   fixedId: 'task_sort',        lsKey: 'nook_task_sort',       codec: 'raw' }),
    singleDef({ name: 'countdown_pinned', collection: 'settings',   fixedId: 'countdown_pinned', lsKey: 'nook_countdown_pinned', codec: 'raw' }),
    mapDef({ name: 'custom_categories', collection: 'custom_categories', lsKey: 'nook_custom_categories' }),
  ];
}
