# 11 — Testing & verification

Nook has **no TypeScript and no ESLint**, so the compiler never catches a typo'd identifier,
a missing import or a bad prop. `vite build` will happily bundle a component that throws a
`ReferenceError` the moment it renders. That makes verification a deliberate, layered
habit — and **"it builds" is never the finish line.**

| Layer | Command | What it proves | What it can't |
|---|---|---|---|
| Unit / integration | `npm test` (`vitest run`, ~5 s) | Sync engine against the **real migration**, the themed-control guard, tracker de-dupe, voice matcher, ack rule | Anything that renders |
| Compile | `npm run build` | Syntax, imports resolve, bundle builds | Runtime errors — render-time `ReferenceError`s sail through |
| Drive the app | Dev server + a real browser (Playwright) | The thing actually renders and behaves | Needs a harness; see below |
| Browser + cloud | The above plus a mock Supabase | Cross-device sync end to end | Real network/RLS quirks; do a final manual pass against a real project |

## 1. `npm test`

Vitest reads `vite.config.js` (so JSX and the React plugin work); there is no separate
vitest config. Everything is colocated as `*.test.js`:

| File | Tests | What it covers |
|---|---|---|
| `utils/syncEngine.test.js` | 42 | The sync engine against **real Postgres** (PGlite) with the **real `0012_synced_items.sql`** applied. Each "device" is its own engine + `localStorage` talking to it through a fake supabase-js that turns calls into SQL, so last-write-wins, tombstones and the `upsert_synced_items` RPC run for real; only the transport is simulated |
| `utils/useSyncApplied.test.js` | 4 | The acknowledge rule behind the stale-view guard (`makeAppliedHandler`) |
| `trackers/trackerUtils.test.js` | 6 | Deterministic `dedupeTrackers` (oldest `createdAt`, then id) |
| `components/themedControls.test.js` | 4 | **Fails if a native `<select>` or `<input type="date\|time\|…">` appears in any `.jsx`**; plus date/time display formatting (incl. DST days) |
| `utils/voiceCommandMatch.test.js` | 11 | The `complete_task` match-count gate that decides auto-execute ([10](10-ai-voice-chat.md)) |

The engine suite is grouped by failure mode, which is how to read it before changing the
engine: *basic two-device sync · the whole-blob failure mode this replaces · a local edit not
yet diffed · deletes · stale-view protection · single-document slices & codecs · journal
(one key per day) · logs and caps · safety rails (corrupt keys, initial/additive passes,
pagination) · two tabs of one browser · realtime · a different account on the same browser ·
lost push responses · capped logs (incl. a first sync where two big logs overflow the cap) ·
wrong device clock · sync-status honesty · failing pushes · "Clear Local Data" racing a pending
edit.* Add a test in the matching group when you fix a
sync bug — most of those groups exist because a real bug was found there.

Conventions worth keeping:

- **Test against the real migration**, not a re-implementation of its logic. PGlite is a
  single connection, so the harness serialises `set_config('request.jwt.claim.sub', …)` +
  query per call so two devices can't run each other's query under the wrong `auth.uid()`.
- Inject the clock, timers, lock and storage (`createSyncEngine({ now, setTimer, lock,
  storage, … })`) — the engine has no hidden globals, which is what makes this possible.
- If you add a migration that touches `synced_items`, extend the suite rather than hoping.
  PGlite needs a stub `auth` schema and `auth.uid()`; copy the setup at the top of the file.
- The themed-control guard is a plain regex over source; if you have a legitimate new wrapper
  component, add it to its `ALLOWED` set deliberately (currently `Select`, `DateInput`,
  `TimeInput`).

## 2. `npm run build`

Useful as a syntax/import check, and to confirm the production bundle still produces. Build
to a throwaway directory so you don't clobber a `dist/` you care about:

```bash
npm run build -- --outDir "<some temp dir>" --emptyOutDir
```

Loading `vite.config.js` also copies `nook-favicon.png` into `public/` and `src/` (a quirk of
the config, documented in [07](07-build-and-setup.md)) and prints "Successfully copied
favicon…" — expected, and the reason those two files can show as modified in `git status`.

## 3. Driving the real app

The rule from `CLAUDE.md`: **drive the actual app and look at it.** For a UI change that means
loading it in a browser, exercising the path (click, type, reload), watching the console for
`pageerror` / `console.error`, and for layout work checking geometry or a screenshot — dark
**and** light theme, a narrow and a desktop viewport.

### Gate-free ("pure local") mode

With `VITE_SUPABASE_*` absent, every cloud helper no-ops and the sync layer never installs —
the cleanest way to test local behaviour. If your real `.env.local` defines those vars, don't
edit or move it; point Vite's `envDir` at a directory containing an **empty `.env`**. Vite has
no CLI flag for this, so use a small scratch config next to the repo's:

```js
// vite.sandbox.config.js  (machine-local scratch file — do not commit)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
export default defineConfig({
  plugins: [react()],
  envDir: '<absolute path to a dir that holds an empty .env>',
  server: { port: 5260, strictPort: true },
})
```
```bash
npx vite --config vite.sandbox.config.js
```
(The repo root already contains one such file with a hard-coded temp path — it is machine
scratch, not part of the app.) A browser pointed at that port is a pure-local Nook.

### Testing anything that needs a session (sync, tasks/habits cloud, voice/chat)

With Supabase configured the app is behind the login page (`AuthGate`,
[01 § Auth status](01-architecture.md#auth-status--read-this-first)), so a test either drives
that page or **seeds a session**. supabase-js persists it in `localStorage` under
`sb-<first label of the Supabase host>-auth-token` (for a mock at `http://localhost:54399`
that is `sb-localhost-auth-token`); the harness writes that key before the app loads —
Playwright's `context.addInitScript` does it cleanly. Seeding is much faster for sync tests;
drive the real login page (below) when you change `AuthGate`, `AuthPage` or sign-out.

For cross-device sync, run a **mock Supabase** and point the app at it with a second `envDir`
whose `.env` sets `VITE_SUPABASE_URL=http://localhost:<port>` and a dummy
`VITE_SUPABASE_ANON_KEY`. The mock used during development was a ~170-line Node script
(not checked in) that:

- runs **PGlite** with the real migration applied (same stub `auth` schema as the unit tests);
- implements just the endpoints the app touches: `/auth/v1/token` and `/auth/v1/user`
  (self-minted unsigned JWTs are fine — the mock reads `sub` from them),
  `/rest/v1/synced_items` (column filters, `order`, `limit`/`offset` paging, `HEAD`),
  `/rest/v1/rpc/upsert_synced_items`, and
  empty `200`s for the tasks/habits/reminders tables so those services stay quiet;
- speaks enough of the Phoenix **Realtime WebSocket** protocol (`phx_join`, `postgres_changes`,
  heartbeat) to push changes between "devices", **routing events by table and id** (broadcasting
  every event to every channel pollutes tasks/habits and produces phantom failures);
- exposes a debug route returning the raw `synced_items` rows so a test can assert what the
  server actually holds, not just what the UI shows.

Two Playwright browser contexts signed in as the same user are two devices. The flows that were
exercised this way, and are worth re-running after touching `sync*.js`, `App.jsx`'s sync wiring,
or any view's `useSyncApplied`:

1. Create / edit / delete in each synced tab on device A → appears (and deletions propagate)
   on device B, with reload on B after.
2. Concurrent edits to *different* items on both devices both survive (the old whole-blob
   failure mode); concurrent edits to the *same* item converge to the newer.
3. Offline edit on A, reconnect → pushed; B converges.
4. Import a backup while signed in → additive, nothing deleted anywhere; Clear Local Data →
   wipes only this device and everything returns on the next load.
5. Sign in as a different account on the same browser → the account-switch prompt, both
   answers.
6. A view that holds a synced slice in state refreshes when the remote change lands, without a
   banner, while a sibling tab of the same browser shows no "data changed" banner either.
7. Zero `pageerror` / unexpected `console.error` across every tab, including the 13-tab smoke
   (visit each `TAB_IDS` entry; confirm it renders).
8. **The login wall** (`AuthGate` + `AuthPage`), with auth configured:
   - **Signed out** you see the login page and *none* of the app (no nav, no Settings); a wrong
     password shows an error and stays put with no session stored; an empty submit makes no
     request; create-account shows the inbox notice when confirmation is needed; **google**
     requests `/auth/v1/authorize?provider=google`.
   - **Sign in** opens the app without a manual reload, local data is there, sync starts
     (`nook:sync:uid` appears).
   - **Sign out** (Settings → Account card, and the bottom **Log Out**, also with the
     `/auth/v1/logout` request aborted) removes the session and **lands on the login page**;
     local data is still on the device; a reload stays on the login page; signing back in
     restores the same data and shows no stray toast.
   - **Returning user** goes straight to the app and the login page never flashes (watch the DOM
     with a `MutationObserver`; don't just assert the end state).
   - **Offline + expired access token** (seed `expires_at` in the past and abort `**/auth/v1/**`):
     the app opens within a second, is *still* the app after 30 s (supabase-js's refresh retries
     last ~25 s), and the stored session is kept. And the opposite: a refresh the server refuses
     for good (`refresh_token_not_found`) closes the gate onto the login page and clears the
     session.
   - No horizontal overflow on the login page at phone width; with `VITE_SUPABASE_*` unset the
     gate passes through and there is no Account card.
   This needs a mock whose `/auth/v1/token` can reject a password and that answers
   `/auth/v1/signup`. The Google leg is only verified up to the redirect — it has not been
   exercised against a real Google/Supabase provider.

### "There is already data" — test against a realistic, legacy-shaped data set

Empty-profile tests miss the failures that matter to a real user. Before shipping anything
that touches storage, sync, or load-time normalisation, seed a **heavy, awkward** data set
and load it three ways — no account, signed in, and as a *second* device that already has
different data:

- ~300 notes, ~120 journal days, ~1,800 activity-log entries, ~1,500 pomodoro timestamps, plus
  tasks, habits, links, countdowns, events, goals, a legacy tracker, settings;
- the awkward ones: a **note with no `id`**, `nook_journal_calview` (shares the journal prefix),
  leftover **`nook_vault`** credentials, activity entries from the removed `vault` module, and a
  stored `nook-active-tab` of `'vault'`;
- seed with `addInitScript` guarded by a `sessionStorage` flag so reloads don't re-seed.

Assert: every tab renders with zero `pageerror`; nothing is uploaded or bookkept while signed out;
after sign-in every item with an id reaches the server exactly once (compare counts per
collection, not "some rows exist"), the vault and the id-less note **stay on the device and are
not dropped**, `calview` isn't mistaken for an entry, a reload is idempotent (no new rows), and
nothing is left "waiting to upload" (read the dirty flags in `nook:sync:meta:*`). For the
second-device case also check the union of ids, no duplicates, and report what happens to a
journal day that exists on both. This run is what found the cap-overflow "changes waiting" bug
(fixed in `applyToDef`, regression test in `syncEngine.test.js`). The only console noise it
should produce is React's "unique key" warning for the id-less note — that is a legacy-data
artefact in `NotesView`, not a sync problem.

### Pitfalls the harness hit (so you don't re-discover them)

- **CSS `text-transform: uppercase` changes what a text matcher sees.** Assert on the DOM text
  (`textContent`), or match case-insensitively, not on what the screen shows.
- Strict-mode locators fail when a label matches two elements (e.g. two "Edit" buttons) —
  scope to a container.
- Dates in fixtures: don't hard-code a calendar date and expect it on screen; generate it
  relative to `todayStr()` or the picker will be on another month.
- Windows: `pkill` doesn't stop node processes. Free a port with
  `Get-NetTCPConnection -LocalPort <p> | % { Stop-Process -Id $_.OwningProcess -Force }`
  (PowerShell), and leave no dev server or mock running when you finish.
- Many repo files use CRLF line endings; scripted exact-string edits need to normalise them.

## 4. Verifying the backend

- **Migrations**: apply to a scratch project or PGlite first. Verify read-only afterwards
  (`list_tables`, `get_advisors`) rather than by writing test rows into the user's real tables.
  Known, deliberate advisor warnings: `set_updated_at` has a mutable `search_path`
  (migration `0001`, not edited retroactively) and leaked-password protection is off.
- **Edge functions**: invoke with a real user JWT and check the error branches (`401`, `400`,
  `502`) as well as the happy path; `send-task-reminders` must be called with `X-Cron-Secret`
  ([05](05-backend.md)).
- **Secrets**: before shipping, grep the built bundle for anything that looks like a key
  (`VITE_GEMINI_API_KEY` is the one known leak — don't set it, [10](10-ai-voice-chat.md)).

## 5. A change-type checklist

| You changed… | Do at least |
|---|---|
| A view's markup/CSS | Load it in dark + light, narrow + wide; check the console; `npm test` (the guard) |
| A dropdown, date or time field | Use `Select` / `DateInput` / `TimeInput`; open it inside a modal and check it isn't clipped; keyboard (arrows, Esc) |
| A storage key or entity shape | Grep the literal key everywhere ([08](08-conventions-and-gotchas.md)); decide sync / backup / import impact |
| Anything in `sync*.js`, `syncDefs.js`, migration `0012` | `npm test`; add a case to the matching engine group; run the two-device flow above |
| A synced view | Confirm it calls `useSyncApplied`; test "remote change arrives while the view is open" |
| Sign-in, sign-out, `AuthGate` | Flow 8 above, **including the offline-with-an-expired-token case**; never touch `AuthGate`/`AuthPage`/`authClient.js` casually (data-integrity files) |
| A data-integrity file (see `CLAUDE.md`) | Don't auto-resolve conflicts; exercise the real flow, not just the build |
| Date logic | Re-read the three conventions in [08](08-conventions-and-gotchas.md); test around DST and local midnight |
| Voice / chat / edge function | The matcher tests; confirm a 401 is handled without a session ([10](10-ai-voice-chat.md)) |
