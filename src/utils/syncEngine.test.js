// End-to-end tests for the cross-device sync engine.
//
// These do NOT mock the database: the real migration (0012_synced_items.sql) is
// applied to an in-process Postgres (PGlite) and every "device" is a separate
// engine instance with its own localStorage talking to it through a fake
// supabase-js client that translates calls to SQL. So last-write-wins, the
// tombstones and the upsert RPC are exercised for real — only the transport is
// simulated.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSyncEngine, hashOf, stableStringify, UID_KEY, APPLIED_KEY, CURSOR_KEY } from './syncEngine.js';
import { buildDefs } from './syncDefs.js';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const T0 = Date.parse('2026-03-01T10:00:00.000Z');

let db;
let dbLock = Promise.resolve();
const clock = { t: T0 };
const bus = { subs: new Set() };

// PGlite is a single connection: serialise (set_config + query) so two devices
// can't interleave and run each other's query under the wrong auth.uid().
function inDb(uid, fn) {
  const run = dbLock.then(async () => {
    await db.query(`select set_config('request.jwt.claim.sub', $1, false)`, [uid || '']);
    return fn();
  });
  dbLock = run.catch(() => {});
  return run;
}

const iso = (v) => (v instanceof Date ? v.toISOString() : v);
const normRow = (r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, iso(v)]));

// A just-enough supabase-js: .from().select().eq().gt().is().order().range(),
// .maybeSingle(), .rpc(), and a realtime channel fed by the fake's own writes.
function makeClient(uid) {
  class Q {
    constructor() { this.where = []; this.params = []; this.ord = []; this.rng = null; this.single = false; }
    select() { return this; }
    eq(c, v)  { this.params.push(v); this.where.push(`"${c}" = $${this.params.length}`); return this; }
    gt(c, v)  { this.params.push(v); this.where.push(`"${c}" > $${this.params.length}`); return this; }
    is(c, v)  { this.where.push(v === null ? `"${c}" is null` : `"${c}" is not null`); return this; }
    order(c, { ascending = true } = {}) { this.ord.push(`"${c}" ${ascending ? 'asc' : 'desc'}`); return this; }
    range(a, b) { this.rng = [a, b]; return this; }
    maybeSingle() { this.single = true; return this; }
    then(res, rej) {
      return inDb(uid, async () => {
        let sql = `select * from public.synced_items where user_id = auth.uid()`;   // stands in for RLS
        if (this.where.length) sql += ' and ' + this.where.join(' and ');
        if (this.ord.length) sql += ' order by ' + this.ord.join(', ');
        if (this.rng) sql += ` limit ${this.rng[1] - this.rng[0] + 1} offset ${this.rng[0]}`;
        const { rows } = await db.query(sql, this.params);
        const out = rows.map(normRow);
        return this.single ? { data: out[0] ?? null, error: null } : { data: out, error: null };
      }).then(res, rej);
    }
  }
  return {
    from: () => new Q(),
    async rpc(fn, args) {
      if (fn !== 'upsert_synced_items') throw new Error('unexpected rpc ' + fn);
      let rows;
      try {
        rows = await inDb(uid, async () => (await db.query(`select * from public.upsert_synced_items($1::jsonb)`, [JSON.stringify(args.p_items)])).rows.map(normRow));
      } catch (e) { return { data: null, error: { message: e.message } }; }
      // publish accepted rows to every subscribed device (like Realtime would)
      const accepted = rows.filter(r => r.accepted);
      if (accepted.length) {
        const full = await inDb(uid, async () => {
          const out = [];
          for (const r of accepted) {
            const { rows: x } = await db.query(`select * from public.synced_items where user_id = auth.uid() and collection = $1 and id = $2`, [r.collection, r.id]);
            out.push(normRow(x[0]));
          }
          return out;
        });
        for (const ch of bus.subs) if (ch._uid === uid) for (const row of full) queueMicrotask(() => ch._cb({ eventType: 'UPDATE', new: row }));
      }
      return { data: rows, error: null };
    },
    channel() {
      const ch = {
        on(_t, _f, cb) { ch._cb = cb; return ch; },
        subscribe(statusCb) { ch._uid = uid; bus.subs.add(ch); setTimeout(() => statusCb && statusCb('SUBSCRIBED'), 0); return ch; },
      };
      return ch;
    },
    removeChannel(ch) { bus.subs.delete(ch); },
  };
}

function memStorage() {
  const m = new Map();
  const s = {
    hook: null,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) { m.set(k, String(v)); s.hook && s.hook(k, false); },
    removeItem(k) { m.delete(k); s.hook && s.hook(k, true); },
  };
  return s;
}

const queue = new Map();
function lock(name, fn) {   // same contract as navigator.locks: one at a time per name
  const prev = queue.get(name) || Promise.resolve();
  const next = prev.then(fn, fn);
  queue.set(name, next.catch(() => {}));
  return next;
}

function device(label, { uid = U1, realtime = false, storage: shared = null, engineOptions = {} } = {}) {
  const storage = shared || memStorage();
  const client = makeClient(uid);
  const events = [];
  const timers = [];
  const defs = buildDefs();
  const engine = createSyncEngine({
    defs, storage, supabase: client, lock,
    emit: (type, detail) => events.push({ type, ...detail }),
    now: () => clock.t,
    setTimer: (fn) => { timers.push(fn); return timers.length; },
    clearTimer: () => {},
    log: () => {},
    ...engineOptions,
    subscribeRealtime: realtime
      ? (u, onRow, onStatus) => { const ch = client.channel().on('postgres_changes', {}, onRow).subscribe(onStatus); return () => client.removeChannel(ch); }
      : null,
  });
  if (!shared) storage.hook = (k, removed) => engine.notifyWrite(k, removed);
  const dev = {
    label, storage, engine, events, client,
    json: (k) => { const r = storage.getItem(k); return r == null ? null : JSON.parse(r); },
    set: (k, v) => storage.setItem(k, JSON.stringify(v)),      // like App.persist
    raw: (k, v) => storage.setItem(k, v),
    // Run the debounced work the way timers would, then push.
    async settle() { await engine.processPendingNow(); await engine.flush(); },
    async sync() { await dev.settle(); await engine.pull(); await engine.flush(); },
  };
  return dev;
}

const tick = (ms = 60_000) => { clock.t += ms; };
const serverRows = async (coll) => (await db.query(`select * from public.synced_items where collection = $1 order by id`, [coll])).rows.map(normRow);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create publication supabase_realtime;
    create or replace function public.set_updated_at() returns trigger language plpgsql as
      $$ begin new.updated_at = now(); return new; end; $$;
  `);
  await db.exec(fs.readFileSync(fileURLToPath(new URL('../../supabase/migrations/0012_synced_items.sql', import.meta.url)), 'utf8'));
  await db.exec(`insert into auth.users values ('${U1}'), ('${U2}')`);
}, 60_000);

beforeEach(async () => {
  await db.exec('delete from public.synced_items');
  clock.t = T0;
  bus.subs.clear();
});

// Fixed timestamps on purpose: an unchanged note must hash identically every time
// it is built, or the test would be "editing" every note on every call.
const note = (id, title, extra = {}) => ({ id, title, content: '', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', ...extra });

// ─────────────────────────────────────────────────────────────────────
describe('hashing', () => {
  it('is independent of key order (jsonb reorders keys)', () => {
    expect(hashOf({ a: 1, b: { c: 2, d: [1, { x: 1, y: 2 }] } })).toBe(hashOf({ b: { d: [1, { y: 2, x: 1 }], c: 2 }, a: 1 }));
    expect(stableStringify({ b: undefined, a: 1 })).toBe('{"a":1}');
  });
  it('changes when content changes', () => {
    expect(hashOf({ a: 1 })).not.toBe(hashOf({ a: 2 }));
    expect(hashOf('x')).not.toBe(hashOf('y'));
  });
});

describe('basic two-device sync', () => {
  it('pushes local data on first sign-in and a fresh device receives it', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'First'), note('n2', 'Second')]);
    await A.engine.begin(U1);
    expect((await serverRows('notes')).map(r => r.id)).toEqual(['n1', 'n2']);

    await B.engine.begin(U1);
    expect(B.json('nook_notes').map(n => n.title).sort()).toEqual(['First', 'Second']);
    expect(B.events.some(e => e.type === 'applied' && e.names.includes('notes'))).toBe(true);
  });

  it('only pushes the item that changed, not the whole list', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'two'), note('n3', 'three')]);
    await A.engine.begin(U1);
    const before = await serverRows('notes');

    tick();
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'two EDITED'), note('n3', 'three')]);
    await A.settle();
    const after = await serverRows('notes');
    const changed = after.filter((r, i) => r.updatedAt !== before[i].updatedAt).map(r => r.id);
    expect(changed).toEqual(['n2']);
  });

  it('a remote edit reaches another device and does not echo back', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'v1')]);
    await A.engine.begin(U1); await B.engine.begin(U1);

    tick();
    A.set('nook_notes', [note('n1', 'v2')]);
    await A.settle();
    await B.sync();
    expect(B.json('nook_notes')[0].title).toBe('v2');

    // B must not re-push what it just received
    const stamp = (await serverRows('notes'))[0].updatedAt;
    tick();
    await B.settle();
    expect((await serverRows('notes'))[0].updatedAt).toBe(stamp);
    expect(B.engine._state({ name: 'notes' }).meta.i.n1[2]).toBe(0);
  });
});

describe('the whole-blob failure mode this replaces', () => {
  it('two devices editing DIFFERENT notes while apart both keep their edits', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'two')]);
    await A.engine.begin(U1); await B.engine.begin(U1);

    tick();
    A.set('nook_notes', [note('n1', 'one — A edited'), note('n2', 'two')]);   // A offline edit
    tick(1000);
    B.set('nook_notes', [note('n1', 'one'), note('n2', 'two — B edited')]);   // B offline edit (stale n1)
    await A.settle(); await B.settle();
    await A.sync(); await B.sync(); await A.sync();

    for (const d of [A, B]) {
      const byId = Object.fromEntries(d.json('nook_notes').map(n => [n.id, n.title]));
      expect(byId).toEqual({ n1: 'one — A edited', n2: 'two — B edited' });
    }
  });

  it('a note created on each device while apart both survive', async () => {
    const A = device('A'), B = device('B');
    await A.engine.begin(U1); await B.engine.begin(U1);
    A.set('nook_notes', [note('a1', 'from A')]);
    B.set('nook_notes', [note('b1', 'from B')]);
    await A.settle(); await B.settle();
    await A.sync(); await B.sync();
    for (const d of [A, B]) expect(d.json('nook_notes').map(n => n.id).sort()).toEqual(['a1', 'b1']);
  });

  it('same-item conflict: the later edit wins everywhere', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'base')]);
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); A.set('nook_notes', [note('n1', 'A early')]);
    tick(5000); B.set('nook_notes', [note('n1', 'B later')]);
    await A.settle(); await B.settle();
    await A.sync(); await B.sync();
    expect(A.json('nook_notes')[0].title).toBe('B later');
    expect(B.json('nook_notes')[0].title).toBe('B later');
  });
});

describe('a local edit that has not been diffed yet', () => {
  it('beats an older remote version that lands inside the debounce window', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'base')]);
    await A.engine.begin(U1); await B.engine.begin(U1);

    tick(); B.set('nook_notes', [note('n1', 'B edit (older)')]); await B.settle();      // t+1m, on the server
    tick(30_000);
    A.set('nook_notes', [note('n1', 'A typed this just now')]);                          // t+1m30s, NOT processed yet
    await A.engine.pull();                                                               // remote arrives before the debounce fires

    expect(A.json('nook_notes')[0].title).toBe('A typed this just now');                 // the user's text survives
    await A.settle();
    expect((await serverRows('notes'))[0].data.title).toBe('A typed this just now');     // and it wins on the server
    await B.sync();
    expect(B.json('nook_notes')[0].title).toBe('A typed this just now');
  });
});

describe('deletes', () => {
  it('a delete propagates and does not resurrect', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'keep'), note('n2', 'delete me')]);
    await A.engine.begin(U1); await B.engine.begin(U1);
    // each device has "seen" both notes
    tick();
    A.set('nook_notes', [note('n1', 'keep')]);
    await A.settle();
    expect(await serverRows('notes').then(r => r.find(x => x.id === 'n2').deleted_at)).not.toBeNull();

    await B.sync();
    expect(B.json('nook_notes').map(n => n.id)).toEqual(['n1']);
    await B.sync(); await A.sync();
    expect(A.json('nook_notes').map(n => n.id)).toEqual(['n1']);
  });

  it('an edit made AFTER the other device deleted resurrects the item (last write wins)', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'x')]);
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); A.set('nook_notes', []); await A.settle();                 // A deletes at t+1m
    tick(60_000); B.set('nook_notes', [note('n1', 'B edited later')]); // B edits at t+2m, unaware
    await B.settle();
    await A.sync();
    expect(A.json('nook_notes').map(n => n.title)).toEqual(['B edited later']);
  });

  it('an edit made BEFORE the other device deleted does not resurrect it', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'x')]);
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); B.set('nook_notes', [note('n1', 'B edited early')]);       // t+1m
    tick(60_000); A.set('nook_notes', []);                             // A deletes at t+2m
    await A.settle(); await B.settle();                                // B's older push is rejected
    await B.sync();
    expect(B.json('nook_notes')).toEqual([]);
  });
});

describe('stale-view protection', () => {
  it('a stale save that omits a remote-added item neither loses it nor deletes it in the cloud', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'one')]);
    await A.engine.begin(U1); await B.engine.begin(U1);

    // A adds n2; B pulls it into storage, but B's open Notes view hasn't refreshed yet…
    tick(); A.set('nook_notes', [note('n2', 'two'), note('n1', 'one')]); await A.settle();
    await B.sync();
    expect(B.json('nook_notes').map(n => n.id).sort()).toEqual(['n1', 'n2']);

    // …and the stale view saves its old list (just n1, edited).
    tick(); B.set('nook_notes', [note('n1', 'one edited on B')]);
    await B.settle();

    expect(B.json('nook_notes').map(n => n.id).sort()).toEqual(['n1', 'n2']);               // put back locally
    expect((await serverRows('notes')).find(r => r.id === 'n2').deleted_at).toBeNull();      // NOT deleted remotely
    expect(B.json('nook_notes').find(n => n.id === 'n1').title).toBe('one edited on B');     // the real edit is kept
  });

  it('after the view acknowledges a refresh, deleting that item really deletes it', async () => {
    const A = device('A'), B = device('B');
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); A.set('nook_notes', [note('n2', 'two')]); await A.settle();
    await B.sync();
    B.engine.ack(['notes']);                       // what useSyncApplied does after the view reloads
    tick(); B.set('nook_notes', []); await B.settle();
    expect((await serverRows('notes')).find(r => r.id === 'n2').deleted_at).not.toBeNull();
  });

  it('a stale view cannot resurrect an item another device deleted', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'two')]);
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); A.set('nook_notes', [note('n1', 'one')]); await A.settle();
    await B.sync();                                // n2 removed from B's storage
    tick(); B.set('nook_notes', [note('n1', 'one'), note('n2', 'two')]);   // stale view re-adds it
    await B.settle();
    expect(B.json('nook_notes').map(n => n.id)).toEqual(['n1']);
    expect((await serverRows('notes')).find(r => r.id === 'n2').deleted_at).not.toBeNull();
  });
});

describe('single-document slices (settings, codecs)', () => {
  it('syncs json and raw values, and a fresh device’s defaults never beat real data', async () => {
    const A = device('A'), B = device('B');
    A.set('nook-theme', 'light');                  // JSON "light"
    A.raw('nook-week-start', 'sunday');             // raw string, no JSON quotes
    A.set('nook-settings', { focusDuration: 50, shortDuration: 5, longDuration: 15, customDuration: 25, autoSwitch: false, sound: true });
    await A.engine.begin(U1);

    // B is a brand-new install that already wrote its defaults on first launch
    B.set('nook-theme', 'dark');
    B.raw('nook-week-start', 'monday');
    B.set('nook-settings', { focusDuration: 25, shortDuration: 5, longDuration: 15, customDuration: 25, autoSwitch: false, sound: true });
    await B.engine.begin(U1);

    expect(B.storage.getItem('nook-theme')).toBe('"light"');
    expect(B.storage.getItem('nook-week-start')).toBe('sunday');          // stays raw
    expect(B.json('nook-settings').focusDuration).toBe(50);
  });

  it('a later settings change on one device updates the other', async () => {
    const A = device('A'), B = device('B');
    A.set('nook-theme', 'dark');
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); B.set('nook-theme', 'light'); await B.settle();
    await A.sync();
    expect(A.storage.getItem('nook-theme')).toBe('"light"');
  });
});

describe('journal (one storage key per day)', () => {
  it('syncs per-day entries, edits and deletes', async () => {
    const A = device('A'), B = device('B');
    A.set('nook_journal_2026-03-01', { date: '2026-03-01', content: '<p>day one</p>', createdAt: 'x', updatedAt: new Date(clock.t).toISOString() });
    await A.engine.begin(U1); await B.engine.begin(U1);
    expect(B.json('nook_journal_2026-03-01').content).toBe('<p>day one</p>');

    tick();
    B.set('nook_journal_2026-03-02', { date: '2026-03-02', content: '<p>from B</p>', createdAt: 'y', updatedAt: new Date(clock.t).toISOString() });
    await B.settle(); await A.sync();
    expect(A.json('nook_journal_2026-03-02').content).toBe('<p>from B</p>');

    tick(); A.storage.removeItem('nook_journal_2026-03-01'); await A.settle();
    await B.sync();
    expect(B.storage.getItem('nook_journal_2026-03-01')).toBeNull();
    expect(B.storage.getItem('nook_journal_2026-03-02')).not.toBeNull();
  });

  it('does not touch the non-entry nook_journal_* preference keys', async () => {
    const A = device('A');
    A.storage.setItem('nook_journal_calview', 'week');
    A.set('nook_journal_icons', { '2026-03-01': '😀' });
    await A.engine.begin(U1);
    expect((await serverRows('journal')).length).toBe(0);
    expect((await serverRows('journal_icons')).map(r => r.id)).toEqual(['2026-03-01']);
  });
});

describe('logs and caps', () => {
  it('pomodoro log merges as a union across devices', async () => {
    const A = device('A'), B = device('B');
    A.set('nook-pomo-log', ['2026-03-01T09:00:00.000Z']);
    B.set('nook-pomo-log', ['2026-03-01T11:00:00.000Z']);
    await A.engine.begin(U1); await B.engine.begin(U1); await A.sync();
    for (const d of [A, B]) expect(d.json('nook-pomo-log')).toEqual(['2026-03-01T09:00:00.000Z', '2026-03-01T11:00:00.000Z']);
  });

  it('trimming a capped log locally is NOT read as deleting entries in the cloud', async () => {
    const A = device('A');
    const log = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, module: 'x', created_at: new Date(T0 + i * 1000).toISOString() }));
    A.set('nook-activity-log', log.slice().reverse());
    await A.engine.begin(U1);
    tick();
    A.set('nook-activity-log', log.slice(2).reverse());      // app trimmed the 2 oldest
    await A.settle();
    const rows = await serverRows('activity_log');
    expect(rows.length).toBe(5);
    expect(rows.every(r => r.deleted_at === null)).toBe(true);
  });

  it('wiping the whole log key IS a delete', async () => {
    const A = device('A');
    A.set('nook-activity-log', [{ id: 'e1', created_at: new Date(T0).toISOString() }]);
    await A.engine.begin(U1);
    tick(); A.storage.removeItem('nook-activity-log'); await A.settle();
    expect((await serverRows('activity_log'))[0].deleted_at).not.toBeNull();
  });
});

describe('safety rails', () => {
  it('a corrupt key is skipped, never read as "the user deleted everything"', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'two')]);
    await A.engine.begin(U1);
    tick(); A.storage.setItem('nook_notes', '[{"id":"n1", BROKEN');
    await A.settle();
    const rows = await serverRows('notes');
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.deleted_at === null)).toBe(true);
  });

  it('"Clear all data" (runUntracked) does not wipe the cloud, and the data comes back', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'precious')]);
    await A.engine.begin(U1);
    await A.engine.runUntracked(async () => { A.storage.removeItem('nook_notes'); });
    await A.settle();
    expect((await serverRows('notes'))[0].deleted_at).toBeNull();
    // page reloads with empty storage + no sync meta → a full pull restores it
    const A2 = device('A2'); await A2.engine.begin(U1);
    expect(A2.json('nook_notes')[0].title).toBe('precious');
  });

  it('a wiped localStorage is never read as deletions on the next launch: the cloud copy comes back', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'two')]);
    await A.engine.begin(U1);
    // The notes key is gone (cleared / partially wiped) but the sync bookkeeping survived.
    const A2 = device('A2');
    A2.storage.setItem('nook:sync:meta:notes', A.storage.getItem('nook:sync:meta:notes'));
    A2.storage.setItem(UID_KEY, U1);
    A2.storage.setItem(CURSOR_KEY, String(clock.t + 10_000));            // cursor already past those rows
    await A2.engine.begin(U1);
    const rows = await serverRows('notes');
    expect(rows.length).toBe(2);
    expect(rows.every(r => r.deleted_at === null)).toBe(true);           // nothing tombstoned
    expect(A2.json('nook_notes').map(n => n.id).sort()).toEqual(['n1', 'n2']);   // and it came back
  });

  it('importing a backup is additive: items missing from the file are not deleted in the cloud', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'one'), note('n2', 'created after the backup')]);
    await A.engine.begin(U1);
    tick();
    await A.engine.runAdditive(async () => {                              // import replaces the list wholesale
      A.set('nook_notes', [note('n1', 'one — from backup')]);
    });
    await A.engine.flush();
    const rows = await serverRows('notes');
    expect(rows.find(r => r.id === 'n2').deleted_at).toBeNull();          // not deleted on every device
    expect(rows.find(r => r.id === 'n1').data.title).toBe('one — from backup');   // the backup's copy wins for what it has
    expect(A.storage.getItem(CURSOR_KEY)).toBeNull();                     // next load does a full pull…
    await A.engine.pull();
    expect(A.json('nook_notes').map(n => n.id).sort()).toEqual(['n1', 'n2']);     // …which merges n2 back
  });

  it('is inert before begin(): nothing is observed or pushed', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'x')]);
    await A.settle();
    expect((await serverRows('notes')).length).toBe(0);
    expect(A.engine.isActive()).toBe(false);
  });

  it('pulls more than one page', async () => {
    const A = device('A');
    const many = Array.from({ length: 1250 }, (_, i) => note('m' + String(i).padStart(4, '0'), 't' + i));
    A.set('nook_links', many.map(n => ({ id: n.id, name: n.title })));
    await A.engine.begin(U1);
    const B = device('B'); await B.engine.begin(U1);
    expect(B.json('nook_links').length).toBe(1250);
  }, 60_000);
});

describe('two tabs of the same browser (one localStorage, two engines)', () => {
  it('a stale tab does not re-stamp what the other tab merged in', async () => {
    const A = device('A');                                  // a different device
    const T1 = device('T1');
    const T2 = device('T2', { storage: T1.storage });       // same localStorage, separate in-memory state
    T1.set('nook_notes', [note('n1', 'one')]);
    await T1.engine.begin(U1); await T2.engine.begin(U1);   // both load their bookkeeping now
    await A.engine.begin(U1);

    tick(); A.set('nook_notes', [note('n1', 'one'), note('n2', 'from A')]); await A.settle();
    await T1.sync();                                        // tab 1 merges n2 into the shared storage + meta
    expect(T1.storage.getItem(APPLIED_KEY)).not.toBeNull();   // announced to other tabs
    const stampBefore = (await serverRows('notes')).find(r => r.id === 'n2').updatedAt;

    // the user edits n1 in tab 2, whose in-memory bookkeeping predates n2
    tick();
    T1.storage.hook = (k, r) => T2.engine.notifyWrite(k, r);
    T1.storage.setItem('nook_notes', JSON.stringify([note('n2', 'from A'), note('n1', 'one — edited in tab 2')]));
    await T2.settle();

    const rows = await serverRows('notes');
    expect(rows.find(r => r.id === 'n2').updatedAt).toBe(stampBefore);   // untouched: not mistaken for a new local item
    expect(rows.find(r => r.id === 'n1').data.title).toBe('one — edited in tab 2');
    expect(rows.every(r => r.deleted_at === null)).toBe(true);
  });
});

describe('realtime', () => {
  it('applies a change pushed by another device without a manual pull', async () => {
    const A = device('A', { realtime: true }), B = device('B', { realtime: true });
    A.set('nook_notes', [note('n1', 'one')]);
    await A.engine.begin(U1); await B.engine.begin(U1);
    tick(); A.set('nook_notes', [note('n1', 'one'), note('n2', 'live')]);
    await A.settle();
    await new Promise(r => setTimeout(r, 30));            // let the microtask-delivered event land
    expect(B.json('nook_notes').map(n => n.id).sort()).toEqual(['n1', 'n2']);
  });
});


// ═════════════════════════════════════════════════════════════════════
// Regression tests for defects found in code review.
// ═════════════════════════════════════════════════════════════════════
const isoNow = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

describe('review: a different account on the same browser', () => {
  async function userOneWithData() {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'user ONE private note')]);
    A.set('nook_journal_2026-03-01', { date: '2026-03-01', content: '<p>user one diary</p>', createdAt: 'x', updatedAt: 'x' });
    await A.engine.begin(U1);
    A.engine.end();
    return A;
  }

  it('by default never uploads the previous account’s data, and removes it from the browser', async () => {
    const A = await userOneWithData();
    const B = device('B', { uid: U2, storage: A.storage });            // same browser, now signed in as U2
    await B.engine.begin(U2);
    // account 2 must not have received account 1's content (rows are per-user; query as U2)
    const asU2 = await inDb(U2, async () => (await db.query(`select * from public.synced_items where user_id = auth.uid()`)).rows);
    expect(JSON.stringify(asU2)).not.toContain('user ONE');
    expect(JSON.stringify(asU2)).not.toContain('user one diary');
    expect(A.storage.getItem('nook_notes')).toBe('[]');                 // wiped from this browser
    expect(A.storage.getItem('nook_journal_2026-03-01')).toBeNull();
  });

  it('when the user chooses to keep it, it IS merged into the new account', async () => {
    const A = await userOneWithData();
    const B = device('B', { uid: U2, storage: A.storage, engineOptions: { onAccountSwitch: async () => 'keep' } });
    await B.engine.begin(U2);
    const asU2 = await inDb(U2, async () => (await db.query(`select * from public.synced_items where user_id = auth.uid() and collection = 'notes'`)).rows);
    expect(asU2.map(r => r.data.title)).toEqual(['user ONE private note']);
  });

  it('tells open views to refresh after the wipe, so a stale view cannot re-save the old data', async () => {
    const A = await userOneWithData();
    const B = device('B', { uid: U2, storage: A.storage });
    await B.engine.begin(U2);
    expect(B.events.some(e => e.type === 'applied' && e.names.includes('notes') && e.names.includes('journal'))).toBe(true);
  });
});

describe('review: pushes whose response was lost', () => {
  it('a retry rejected only because the server already has our exact version still ends clean', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'one')]);
    await A.engine.begin(U1);                                           // pushed and acknowledged
    tick(); A.set('nook_notes', [note('n1', 'two')]);
    // first attempt commits on the server but the response never arrives
    const realRpc = A.client.rpc.bind(A.client);
    let calls = 0;
    A.client.rpc = async (...args) => { calls++; const r = await realRpc(...args); return calls === 1 ? { data: null, error: { message: 'network lost' } } : r; };
    await A.settle();
    expect(A.engine.getStatus().pending).toBe(1);                       // still believes it is unsent
    await A.engine.flush();                                             // retry → server says accepted=false (same stamp)
    expect(A.engine.getStatus().pending).toBe(0);                       // …and must not stay "waiting" forever
    expect(A.engine._state({ name: 'notes' }).meta.i.n1[2]).toBe(0);
    const before = calls;
    await A.engine.flush();
    expect(calls).toBe(before);                                         // nothing is re-sent on later flushes
  });
});

describe('review: logs trimmed by their cap', () => {
  it('items dropped by the cap are not "put back" on every later write', async () => {
    // the server keeps more rows than a device's cap (2500 vs 2000)
    await inDb(U1, async () => {
      await db.query(`
        insert into public.synced_items (user_id, collection, id, data, "updatedAt")
        select auth.uid(), 'activity_log', 'e' || lpad(g::text, 5, '0'),
               jsonb_build_object('id', 'e' || lpad(g::text, 5, '0'), 'module', 'x', 'created_at', to_char(timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
               timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval
        from generate_series(1, 2100) g`);
    });
    const B = device('B');
    await B.engine.begin(U1);
    expect(B.json('nook-activity-log').length).toBe(2000);              // capped on arrival

    const appliedBefore = B.events.filter(e => e.type === 'applied').length;
    tick();
    const log = B.json('nook-activity-log');
    B.set('nook-activity-log', [{ id: 'new1', module: 'x', created_at: new Date(clock.t).toISOString() }, ...log].slice(0, 2000));
    await B.settle();
    expect(B.events.filter(e => e.type === 'applied').length).toBe(appliedBefore);   // no restore churn
    expect(B.json('nook-activity-log').length).toBe(2000);
    expect(B.json('nook-activity-log')[0].id).toBe('new1');
  }, 60_000);

  it('first sync of two big logs: entries pushed out by the cap do not stay "waiting to upload"', async () => {
    // Device A's 1800 entries are already in the cloud; device B has never synced and holds
    // 1800 of its own, interleaved in time. Merging 3600 into a 2000-entry log pushes some of
    // B's never-uploaded entries straight back out — they are gone on purpose, not pending.
    const base = Date.parse('2026-03-01T00:00:00.000Z');
    await inDb(U1, async () => {
      await db.query(`
        insert into public.synced_items (user_id, collection, id, data, "updatedAt")
        select auth.uid(), 'activity_log', 'a' || lpad(g::text, 5, '0'),
               jsonb_build_object('id', 'a' || lpad(g::text, 5, '0'), 'module', 'x', 'created_at', to_char(timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
               timestamptz '2026-03-01 00:00:00+00' + (g || ' seconds')::interval
        from generate_series(1, 1800) g`);
    });
    const B = device('B');
    B.set('nook-activity-log', Array.from({ length: 1800 }, (_, i) => {
      const g = 1800 - i;                                           // newest first, like the app writes it
      return { id: 'b' + String(g).padStart(5, '0'), module: 'x', created_at: new Date(base + g * 1000 + 500).toISOString() };
    }));
    await B.engine.begin(U1);
    await B.settle();
    expect(B.json('nook-activity-log').length).toBe(2000);
    expect(B.engine.getStatus().pending).toBe(0);
  }, 60_000);
});

describe('review: a wrong device clock', () => {
  it('the server clamps an absurd future edit time, and the device adopts the stored value', async () => {
    const A = device('A', { engineOptions: { now: () => Date.parse('2099-01-01T00:00:00Z') } });
    await A.engine.begin(U1);
    A.set('nook_notes', [note('n1', 'from a clock set to 2099')]);      // an edit AFTER sign-in is stamped with the device clock
    await A.settle();
    const row = (await serverRows('notes'))[0];
    expect(Date.parse(row.updatedAt)).toBeLessThan(Date.now() + 6 * 60_000);          // clamped to ~now + 5 min
    expect(A.engine._state({ name: 'notes' }).meta.i.n1[2]).toBe(0);
    expect(A.engine._state({ name: 'notes' }).meta.i.n1[0]).toBe(Date.parse(row.updatedAt));   // meta agrees with the server

    // a device with a CORRECT clock editing a little later now wins, instead of being outranked until 2099
    const B = device('B', { engineOptions: { now: () => Date.now() + 10 * 60_000 } });
    await B.engine.begin(U1);
    B.set('nook_notes', [note('n1', 'edited with a correct clock')]);
    await B.settle();
    expect((await serverRows('notes'))[0].data.title).toBe('edited with a correct clock');
  });
});

describe('review: sync status honesty', () => {
  it('a failed pull is not reported as "up to date"', async () => {
    const A = device('A');
    await A.engine.begin(U1);
    const origFrom = A.client.from;
    A.client.from = () => ({ select() { return this; }, gt() { return this; }, order() { return this; }, range() { return this; },
      then(res) { return Promise.resolve({ data: null, error: { message: 'RLS blew up' } }).then(res); } });
    const ok = await A.engine.syncNow();
    A.client.from = origFrom;
    expect(ok).toBe(false);
    expect(A.engine.getStatus().state).toBe('error');
  });
});

describe('review: failing pushes', () => {
  const dirtyNotes = (n) => Array.from({ length: n }, (_, i) => note('n' + String(i).padStart(3, '0'), 't' + i));

  it('a network failure does not fan out into one request per row, and keeps everything pending', async () => {
    const A = device('A');
    await A.engine.begin(U1);
    A.set('nook_notes', dirtyNotes(100));
    let calls = 0;
    A.client.rpc = async () => { calls++; return { data: null, error: { message: 'TypeError: Failed to fetch', code: '' } }; };
    await A.settle();
    expect(calls).toBe(1);
    expect(A.engine.getStatus().pending).toBe(100);
  });

  it('one row the server rejects does not block the others, and is given up on after a few tries', async () => {
    const A = device('A');
    await A.engine.begin(U1);
    A.set('nook_notes', [note('good1', 'a'), note('BAD', 'b'), note('good2', 'c')]);
    const real = A.client.rpc.bind(A.client);
    A.client.rpc = async (fn, args) => args.p_items.some(i => i.id === 'BAD')
      ? { data: null, error: { message: 'row too large', code: '54000' }, status: 400 }
      : real(fn, args);
    for (let i = 0; i < 4; i++) await A.engine.flush();
    expect((await serverRows('notes')).map(r => r.id).sort()).toEqual(['good1', 'good2']);
    expect(A.engine.getStatus().pending).toBe(0);                        // gave up on BAD instead of retrying forever
  });

  it('a flush with nothing dirty does not even read the big slices', async () => {
    const A = device('A');
    A.set('nook-activity-log', [{ id: 'e1', created_at: new Date(T0).toISOString() }]);
    await A.engine.begin(U1);
    let reads = 0;
    const get = A.storage.getItem.bind(A.storage);
    A.storage.getItem = (k) => { if (k === 'nook-activity-log' || k.startsWith('nook_journal_')) reads++; return get(k); };
    await A.engine.flush();
    expect(reads).toBe(0);
  });
});

describe('review: "Clear Local Data" racing a pending edit', () => {
  it('an edit still waiting for its debounce is pushed, not turned into a delete-everything', async () => {
    const A = device('A');
    A.set('nook_notes', [note('n1', 'old'), note('n2', 'also old')]);
    await A.engine.begin(U1);
    tick(); A.set('nook_notes', [note('n1', 'EDITED just before clearing'), note('n2', 'also old')]);   // not processed yet
    await A.engine.runUntracked(async () => { A.storage.removeItem('nook_notes'); });
    await A.engine.processPendingNow(); await A.engine.flush();         // what the debounce timer / pagehide would do
    const rows = await serverRows('notes');
    expect(rows.every(r => r.deleted_at === null)).toBe(true);           // nothing tombstoned
    expect(rows.find(r => r.id === 'n1').data.title).toBe('EDITED just before clearing');   // the last edit made it up
  });
});
