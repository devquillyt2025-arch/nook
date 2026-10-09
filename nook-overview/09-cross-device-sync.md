# 09 — Cross-device sync (everything except tasks / habits / reminders)

Signed-in users get the same data on every device. Tasks and habits have their own typed
Supabase tables and services (`tasksService.js`, `habitsService.js`); reminders are
Supabase-only (`reminders.js`); Google Tasks/Calendar are a separate integration (see
[04](04-google-sync.md) and [05](05-backend.md)). **Everything else** — notes, links,
journal, countdowns, calendar events, trackers, goals, intentions, pomodoro log,
activity log, chat history and the synced settings — syncs through **one generic table
and one engine**, described here.

With `VITE_SUPABASE_*` unset, or nobody signed in, **none of this runs**: no global is
patched, no key is written, the app is exactly the local-only app. Never write code that
assumes a session exists.

## Prerequisites (all three, or nothing syncs)

1. **`VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY`** set (`isAuthConfigured`).
2. **Migration `0012_synced_items.sql` applied** to the project. Without it pushes fail
   quietly and Settings → Connections shows "Couldn't reach the server — N changes
   waiting".
3. **A Supabase session.** `startSync()` only *waits for* one (`getSession()` +
   `onAuthStateChange`); it cannot create one. The app is not login-gated, so the user signs
   in from **Settings → Connections** (`AccountSignIn`; see
   [01 § Auth status](01-architecture.md#auth-status--read-this-first)). The page reloads on
   sign-in and sync begins; supabase-js persists the session so later visits start synced.
   Until then the observer is installed but the engine is inactive and the Connections row
   reads "Waiting for sign-in".

## The contract

- **`localStorage` is still what every view reads and writes, synchronously.** Sync
  never changes a key, a shape, or a view's read path. It *observes* writes and
  *merges remote changes into* localStorage.
- **Per ITEM, last-write-wins, with soft-delete tombstones** — the same model as
  tasks/habits. Two devices editing different notes never touch each other's data.
- Offline edits are kept and pushed when the connection returns.

## Moving parts

| File | Role |
|---|---|
| `supabase/migrations/0012_synced_items.sql` | The `synced_items` table, RLS, the `upsert_synced_items` RPC (atomic LWW, clock clamp, log retention), Realtime publication |
| `utils/syncEngine.js` | The pure core (~800 ln). Diffs a slice against what it last synced, pushes changed items, pulls + merges, tombstones. Takes its environment (storage, supabase, clock, lock, emitter) as arguments so it runs under test. |
| `utils/syncDefs.js` | **What syncs and how.** One "def" per slice: how to read it from storage as `[{id, data}]` and write it back. The list of synced keys lives here. |
| `utils/sync.js` | Browser wiring: the storage observer, auth lifecycle, Realtime channel, focus/online/pagehide triggers, cross-tab forwarding, the account-switch prompt. Entry point `startSync()` (called from `App.jsx`). |
| `utils/useSyncApplied.js` | Hook views use to re-read their slice when a remote change lands (and `makeAppliedHandler`, its testable core). |
| `utils/useSyncStatus.js` | Live engine status for Settings → Connections. |
| `utils/syncEngine.test.js` | The engine tests run the **real migration** in an in-process Postgres (PGlite). `npm test`. |

### The table

```
synced_items(user_id, collection, id, data jsonb, "updatedAt", deleted_at,
             created_at, updated_at)            PK (user_id, collection, id)
```
`collection` is the tab ('notes', 'links', 'journal', 'settings', …); `data` is the item
verbatim from its localStorage shape; `"updatedAt"` (client edit time) drives LWW;
`updated_at` (DB clock) drives the incremental-pull cursor so it never depends on a
device clock. Tombstones carry `{}`. Writes go through `upsert_synced_items`, whose
`ON CONFLICT … WHERE excluded."updatedAt" > s."updatedAt"` makes the compare atomic and
which tells the client when a newer version already existed (`accepted=false` + the
server's row), so it adopts that instead of retrying.

## What syncs (and what deliberately doesn't)

Each row is a "def" in `syncDefs.js`. **Kind** picks how a storage key maps to items:
`list` = array of `{id}` objects · `single` = one value (JSON or raw string) · `keyed` =
one storage key per item · `map` = one object whose keys are items · `stringSet` = array
of strings.

| Def (`name`) | Storage key | Kind | Server `collection` / id | Notes |
|---|---|---|---|---|
| `notes` | `nook_notes` | list | `notes` | |
| `links` | `nook_links` | list | `links` | |
| `countdowns` | `nook_countdowns` | list | `countdowns` | |
| `goals` | `nook_goals` | list | `goals` | read-only today |
| `calendar_events` | `nook-calendar-events` | list | `calendar_events` | |
| `trackers` | `nook-trackers` | list | `trackers` | legacy; name-dedupe is deterministic |
| `journal` | `nook_journal_<YYYY-MM-DD>` | keyed | `journal` / the date | exact-date regex; siblings sharing the prefix are excluded |
| `journal_icons` | `nook_journal_icons` | map | `journal_icons` / the date | |
| `activity_log` | `nook-activity-log` | list | `activity_log` | immutable, newest-first, cap 2000 |
| `pomo_log` | `nook-pomo-log` | stringSet | `pomo_log` | immutable, cap 2000 |
| `chat_history` | `nook_chat_history` | list | `chat_history` | immutable, cap 200 |
| `intentions` | `nook-intentions` | single (JSON) | `intentions` / `current` | |
| `pomo_settings` | `nook-settings` | single (JSON) | `settings` / `pomo_settings` | |
| `theme` | `nook-theme` | single (JSON) | `settings` / `theme` | |
| `week_start` | `nook-week-start` | single (**raw**) | `settings` / `week_start` | |
| `profile_name`, `profile_email` | `nook-profile-name`, `-email` | single (**raw**) | `settings` / … | |
| `profile_avatar` | `nook-profile-avatar` | single (**raw**) | `settings` / `profile_avatar` | skipped if > 250 KB |
| `weekly_reviews` | `nook-weekly-reviews` | single (JSON) | `settings` / `weekly_reviews` | |
| `task_sort` | `nook_task_sort` | single (**raw**) | `settings` / `task_sort` | |
| `countdown_pinned` | `nook_countdown_pinned` | single (**raw**) | `settings` / `countdown_pinned` | |
| `custom_categories` | `nook_custom_categories` | map | `custom_categories` / the key | |

**Not** synced, on purpose: `nook_vault` (leftover Saved Logins data — credentials must
not be uploaded in plaintext), Google/Calendar tokens and sync queues, `nook_ai_api_key`
(a credential), `nook-notif-*` toggles (they depend on this browser's notification
permission), sidebar/active-tab/visit state, journal calendar view prefs, and the hidden
assistant panel's history. Tasks, habits and reminders use their own paths.

Logs (`activity_log`, `pomo_log`, `chat_history`) are immutable and capped identically on
every device; the RPC hard-deletes server rows beyond 2500/2500/300 so a new device doesn't
download years of history. Trimming a log locally is **not** a delete.

## How a change travels

```
view writes localStorage ─► observer (patched Storage.prototype) ─► engine.notifyWrite
   ─► debounced diff (250 ms): hash each item (key-order independent) vs last-synced meta
   ─► changed items stamped with the WRITE time, marked dirty ─► debounced push (1.5 s, RPC)
   ─► Postgres ─► Realtime ─► other device's engine ─► merged into ITS localStorage
   ─► window event 'nook-sync-applied' ─► useSyncApplied() in views re-reads storage
```

**Startup** (`startSync()` from an `App.jsx` effect): install the observer, start the
cross-tab forwarder, then on a session `engine.begin(uid)` → account-switch check →
subscribe to Realtime → one `initial` diff of every def → `syncNow()` (flush pending
touches, **pull**, **push**). Also pulled: on window focus (≥5 s apart), on `online`, and
whenever the Realtime socket (re)subscribes — so a sleeping socket never leaves a device
stale. `visibilitychange→hidden` and `pagehide` trigger a best-effort flush.

Per-slice bookkeeping (`nook:sync:meta:<def>`): `{ i: {id:[editMs, hash, dirty]}, t: {id:[deletedMs, dirty]}, init }`.

### Merging a remote row (`applyToDef`)

- A **pending local edit** (written within the debounce window, not yet diffed) is
  recognised first and stamped with its write time, so an older remote version can't
  overwrite text the user just typed.
- Remote **delete** wins only if it is at least as new as our last edit; remote **live
  row** wins only if strictly newer; equal = converged (usually our own echo).
- New remote items are placed at the **front**; a def's `sort`/`cap` is applied after.
- Anything merged in is recorded as **unacknowledged** until a view refreshes — the
  stale-view guard (rule 1).

### Pushing (`flush`)

Only slices with dirty items are read. Rows go out in chunks (≤100 rows / ~900 KB). A
network/5xx/auth failure stops the whole flush and retries with backoff (20 s → 5 min); a
server *rejection* (4xx / Postgres error) retries the chunk's rows singly, and a row refused
3 times is left on the device until it is next edited. `accepted:false` with **our own
stamp** means an earlier attempt already committed — success, not a conflict.
`accepted:false` with a newer stamp means another device won — adopt its row.

## Rules you must follow

1. **A view that keeps a synced slice in React state must call `useSyncApplied`.**
   `useSyncApplied(['notes'], () => setNotes(loadNotes()))`. Until a view
   acknowledges a refresh, the engine treats items it merged in as "not yet seen by
   the app" and **puts them back** if a stale save drops them — it never reads that as
   the user deleting them. An unwired view therefore can't corrupt the cloud, but it
   will show stale data and fight deletes of remote-added items. The hook acks on mount
   and after every refresh. A callback that deliberately skips a refresh (a chat reply is
   in flight, the journal editor has unsaved keystrokes) must **return `false`** so it is
   not acknowledged.
2. **Adding a synced slice = one entry in `syncDefs.js`** (+ the hook in its view). Don't
   add a second sync path. Pick the def kind (above); for `single`, the `codec`
   (`'json'|'raw'`) must match how the key is really written — e.g. `nook-week-start` is
   a raw string, `nook-theme` is JSON. A wrong codec can't parse the key and the engine
   (correctly) skips it forever.
3. **Never infer deletion from absence on the first pass or during an import.**
   `begin()` runs with `initial:true` and `runAdditive()` wraps import: items missing
   from storage are forgotten locally and re-fetched by a full pull — never tombstoned.
   A wiped/half-restored localStorage must not delete the cloud copy.
4. **A corrupt key is skipped, not treated as empty.** `def.read` throws on invalid
   JSON; the engine skips that pass (`safeRead`).
5. **Don't "clean up" the storage observer.** `sync.js` wraps `Storage.prototype.setItem/
   removeItem` (only for `window.localStorage`, original method runs first, installed
   only when auth is configured). That is how every existing writer — including voice
   commands and import — is synced without each call site opting in, and how a future
   writer can't silently opt out.
6. **Bookkeeping keys use the `nook:` prefix** (`nook:sync:meta:*`, `nook:sync:cursor`,
   `nook:sync:uid`, `nook:sync:applied-at`). Not `nook-`/`nook_` — those prefixes are swept
   by backup export, import's allowlist and the cross-tab banner, and a restored copy
   would carry another device's stale sync state. "Clear Local Data" removes them
   explicitly (`clearLocalSyncState`).
7. **Stamps are write times, not processing times** (a backgrounded tab throttles
   timers). On a device's first pass an item the engine has never seen is stamped with its
   **own timestamp** if the data carries one (`updatedAt`/`createdAt` — notes, journal days,
   events, log entries…), otherwise `0`: strictly older than any pushed value (pushes floor
   at 1 ms). So plain values with no timestamp (theme, week start, profile fields, pomodoro
   settings) lose to the cloud on a first sync, and a tie can never leave two devices
   permanently disagreeing; timestamped items compete on their real edit time.
8. **All engine mutations run under `navigator.locks` and re-read the meta from storage
   first**, so two tabs of one browser (one localStorage, two engines) don't clobber each
   other. A merge by one tab writes `nook:sync:applied-at` first; sibling tabs forward
   the following data-key `storage` events as `nook-sync-applied` (views refresh) and
   the cross-tab banner stays quiet (`isForeignSyncApply`).
9. **Normalising a synced list on load is a delete** — see [08](08-conventions-and-gotchas.md).

## First sign-in on a device that already has data

Nothing about existing data changes shape or location — sync only observes it. What happens
the first time a device with data signs in (verified with a heavy legacy-shaped data set, see
[11](11-testing-and-verification.md)):

- **Everything with an `id` is uploaded once**, and the device pulls whatever the account
  already holds. Different ids on two devices (notes, links, tasks…) simply **union** — no
  duplicates, nothing lost on either side.
- **Same id on both devices** (same journal date, the single settings values, same-id items):
  one version wins. Timestamped items go to the **newer edit**; values without a timestamp go
  to **the cloud** (rule 7). The losing local copy is *replaced*, and the server keeps no
  history. Realistic exposure: a journal day written on two devices before either ever synced.
  **Export a backup (Settings → Data Management) before signing in on a second device that
  already has entries you care about.**
- **Left alone on purpose:** a list entry with **no `id`** (kept untouched locally, never
  uploaded — it can't be keyed), leftover `nook_vault` data (never synced), corrupt keys
  (skipped, not treated as empty), `nook_journal_calview`/`_icons` siblings of the journal prefix.
- **Capped logs** (activity 2000, pomodoro 2000, chat 200) merge to the newest N across
  devices; entries the cap pushes out are simply dropped (they are not deleted in the cloud,
  and they are not left "waiting to upload").
- A first upload of a large profile (~300 notes, ~1,800 log entries, ~1,500 pomodoros) took
  ~13 s against the local mock and goes out in chunks of ≤ 100 rows; Settings → Connections
  reports how many changes are still waiting. (Real-network time will be longer.)
- A reload afterwards is idempotent: no new rows, no re-upload.

## Import / Clear / account switch

- **Import** is additive for signed-in users (`runAdditiveSync` + `settleSync` before
  the reload): the backup wins for items it contains, nothing else is deleted anywhere.
  Signed out, it still replaces local data.
- **Clear Local Data** runs under `runUntrackedSync`, so wiping this device is not read
  as deleting the account's data; the pending edit is pushed first and queued work
  dropped; everything syncs back on the next load.
- Signing in as a *different* account than the one last synced on this browser
  (`nook:sync:uid` mismatch) asks first (`onAccountSwitch`): **OK** (the default if the
  prompt is ever skipped) removes the previous account's synced data from this browser and
  uploads nothing of it; **Cancel** keeps it and uploads it into the new account on purpose.
  Uploading one person's notes/journal into another person's account silently was the bug.
  (Tasks/habits have their own migration and are not covered by this prompt.)

## Sensitive data

Everything in `synced_items` is readable by anyone with database access — it is
protected by RLS, not by encryption. Don't add a synced slice that holds credentials or
secrets. (The Saved Logins tab was removed for this kind of data; an earlier design that
encrypted it client-side before upload was removed with it.)

## Why a Supabase table and not a separate server

An earlier attempt (commit `59dca65`, reverted) added a Hono API server over a Neon
Postgres database, syncing each localStorage key as **one whole JSON value**. It was
replaced because: (1) a stale device overwrote an entire list and silently erased another
device's changes; (2) it only read on page load — no focus refresh or Realtime; (3) it
needed a separately hosted server and `NEON_DATABASE_URL`, which nothing in the repo
deployed; and (4) tasks/habits were written to *both* Neon and Supabase. Supabase already
provided auth, RLS and Realtime and already synced tasks/habits per row, so the remaining
tabs were moved onto the same footing: one extra table, no server of our own.

## Operating it

- Status: Settings → Connections → **Cross-device sync** (state, changes waiting, *Sync
  now*).
- Tombstones are small rows kept in the table; there is no purge job yet.
- Clocks: LWW trusts device clocks (same trade-off as tasks/habits). The RPC clamps an
  edit time to *server now + 5 min*, so a device whose clock is set far ahead cannot
  outrank every honest edit until that date; the device adopts the stamp the server
  stored. A clock that is far *behind* simply loses conflicts.

## Testing

`npm test` — `utils/syncEngine.test.js` applies the real migration to PGlite and runs each
"device" as its own engine + localStorage against it (concurrent edits, deletes, stale
views, corrupt keys, import/clear, pagination, two tabs, realtime, account switch, lost
responses, capped logs, clock skew, failing pushes). `useSyncApplied.test.js` covers the
acknowledge rule and `trackers/trackerUtils.test.js` the deterministic de-dupe. How the
browser integration was exercised is in [11](11-testing-and-verification.md).
