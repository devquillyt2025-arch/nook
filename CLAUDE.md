# CLAUDE.md — Nook

Read this first. It is the working brief: enough to orient and act safely on most
tasks. **It is deliberately not the whole story.** The complete reference lives in
[`nook-overview/`](nook-overview/README.md) — architecture, the full data model,
every tab, Google sync internals, the Supabase backend, styling, and a
build-from-scratch guide.

> **Auto-redirect rule.** The moment a task needs more than what's on this page —
> an exact entity shape, a storage key you're about to touch, how a sync/backup
> path actually resolves, why an oddity exists — **open the matching
> `nook-overview/` file below and read it before acting.** Don't guess from this
> summary or from the code alone; the depth you need is already written down.
> Better understanding in ⇒ better output out.

### Where to go deeper (jump table)

| If you're working on… | Read |
|---|---|
| Core model, state flow, cross-tab, what Supabase is (and isn't) used for | [01-architecture.md](nook-overview/01-architecture.md) |
| **Any** localStorage key or entity shape (task, habit, tracker, journal, note, event, goal…) | [02-data-model.md](nook-overview/02-data-model.md) |
| A specific tab / view and its quirks | [03-tabs-and-features.md](nook-overview/03-tabs-and-features.md) |
| Google Tasks or Calendar sync | [04-google-sync.md](nook-overview/04-google-sync.md) |
| Supabase tables, RLS, edge functions, push, backup, env vars | [05-backend.md](nook-overview/05-backend.md) |
| Cross-device sync of notes / journal / links / settings… (the `synced_items` engine and the rules views must follow) | [09-cross-device-sync.md](nook-overview/09-cross-device-sync.md) |
| Voice commands, the Chat tab, the Gemini assistant, edge-function AI | [10-ai-voice-chat.md](nook-overview/10-ai-voice-chat.md) |
| Theming, CSS conventions, sidebar rail, icons, popups/clipping | [06-ui-and-styling.md](nook-overview/06-ui-and-styling.md) |
| Standing the app up, deps, env, deploy | [07-build-and-setup.md](nook-overview/07-build-and-setup.md) |
| `npm test`, driving the app, the mock-backend harness, what to verify per change | [11-testing-and-verification.md](nook-overview/11-testing-and-verification.md) |
| **Before touching dates, storage keys, or sync/backup files** | [08-conventions-and-gotchas.md](nook-overview/08-conventions-and-gotchas.md) |

---

## The mental model (30 seconds)

Nook is a **client-only React 18 + Vite SPA. All real user data lives in
`localStorage`.** `App.jsx` (~2100 ln) loads each slice synchronously into state on
mount, passes it down as props, and writes it back with a `useEffect` on change.
Each tab is a `lazy()`-loaded view. Plain JS/JSX — **no TypeScript, no ESLint.**
Scripts: `npm run dev | build | preview | test` (`npm test` = vitest: the sync engine
against a real in-process Postgres, the themed-control guard, tracker de-dupe, voice
matching — not the UI; see [11](nook-overview/11-testing-and-verification.md)).

Supabase is **optional**. It does two jobs: what a client-only app can't do (fire
reminders while the tab is closed, prove identity, hold an OAuth secret, run
scheduled Drive backups), and **cross-device sync** — typed `tasks`/`habits` tables
plus one generic `synced_items` table (per-item last-write-wins) for everything else;
`localStorage` stays what the UI reads and cloud is only ever an addition to it.
With `VITE_SUPABASE_*` unset every cloud helper no-ops. **Never write code that assumes
a session exists.** → [01](nook-overview/01-architecture.md), [05](nook-overview/05-backend.md)

> **`AuthGate` is NOT mounted — the app is not login-gated.** `main.jsx` renders `<App />`
> directly (since `6d76bfa`). Sign-in is **optional and lives in Settings → Connections**
> (`AccountSignIn.jsx`; a successful sign-in reloads the page). Everything that needs a
> session — cross-device sync, tasks/habits cloud sync, reminders, push, Drive backup,
> Google token exchange, voice/Chat — is inert until someone signs in there. Comments and
> old notes that say "login-gated" are stale. Don't re-mount the gate without a product
> decision. → [01 § Auth status](nook-overview/01-architecture.md#auth-status--read-this-first)

There are **13 tabs**; ids ≠ labels for two (`daily`→"Today", `timer`→"Focus
Timer"). Full table in
[03](nook-overview/03-tabs-and-features.md).

## Hard constraints (do not violate)

- **No native `<select>` / `<input type="date|time">`.** The browser's popups ignore the theme.
  Use `Select` / `DateInput` / `TimeInput` (popups are portaled by `FloatingPopover` so a modal
  or side panel can't clip them); `themedControls.test.js` enforces it. →
  [06](nook-overview/06-ui-and-styling.md)
- **`landing/` is a separate Next.js marketing app and is OFF-LIMITS** for app
  changes. Everything to change lives in `src/`.
- **Stop before each commit.** One commit per tab (`type(scope): summary`, scope =
  the tab or `shared`) so a bad change is bisectable.
- **Never force-push.** Never auto-resolve conflicts in the data-integrity files:
  `utils/googleTasksSync.js`, `googleCalendarSync.js`, `reminders.js`,
  `notificationPrefs.js`, `pushSubscription.js`, `backup.js`, `driveBackup.js`,
  `autoBackup.js`, `authClient.js`, `AuthGate.jsx`, `AuthPage.jsx`. Refactor
  *around* them, never *through*. → [04](nook-overview/04-google-sync.md),
  [05](nook-overview/05-backend.md)
- **Never widen the Google Tasks pull allowlist** without deciding which Nook-only
  fields you'll lose. → [04](nook-overview/04-google-sync.md)
- **Never rename a localStorage key** without grepping the literal first — the
  mixed hyphen/underscore naming is load-bearing; renaming orphans user data.
  → [02](nook-overview/02-data-model.md), [08](nook-overview/08-conventions-and-gotchas.md)
- **Never put a secret behind a `VITE_` prefix** — Vite inlines it into the shipped
  bundle. Client secrets belong only in edge-function env.
  → [05](nook-overview/05-backend.md), [07](nook-overview/07-build-and-setup.md)
- **`vite build` passing is NOT verification.** No TS/lint — it will build a
  render-time `ReferenceError`. Verify by driving the real app. To run gate-free,
  point Vite's `envDir` at a dir holding an empty `.env`; do **not** edit or move
  the real `.env.local`.

## Things that look like bugs but are correct — do NOT "fix"

Full reasons in [08-conventions-and-gotchas.md](nook-overview/08-conventions-and-gotchas.md).
If you're about to "clean up" any of these, read that file first.

- **Three date conventions:** local-noon anchoring nearly everywhere; **two**
  different `todayStr()` (local in `utils/date.js`, UTC in `trackerUtils.js` — do
  not merge); Google Tasks payloads use midnight UTC. No noon-UTC anywhere.
- **Mixed hyphen/underscore storage keys** are intentional.
- **Habits exist twice** (`nook_habits` vs `type:'habit'` in `nook-trackers`) —
  different shapes, copied not moved by a one-time migration. Don't dedupe.
- **`sync.js` wraps `Storage.prototype.setItem/removeItem`** (only `localStorage`,
  only when auth is configured) so every writer is synced without opting in. And
  **`nook:`-prefixed keys** are sync bookkeeping, deliberately outside the
  `nook-`/`nook_` families so backups/import/the banner ignore them. A view holding a
  synced slice in state must call `useSyncApplied`. → [09](nook-overview/09-cross-device-sync.md)
- **The cross-tab banner has no dismiss** — reload is the only exit, by design.
- **The empty `else if (localUpdated > gUpdated) {}`** in the task pull is
  deliberate (local already wins; the queued push carries it up).
- **`FocusCompanion` is intentionally not `memo()`-wrapped**; Chart.js is
  registered in two files (idempotent); `trackers/insightsEngine.js` is orphaned on
  purpose (as are a few other unused components — list in 08).
- **Voice commands, the Chat tab and the Gemini assistant are built but hidden**
  (entry points commented out in `App.jsx`). Uncomment, don't rewrite; the
  `id:'chat'` nav entries drive the *Gemini* panel, not `ChatView`. → [10](nook-overview/10-ai-voice-chat.md)
- **Saved Logins was removed** (leftover `nook_vault` data is never synced and is
  deleted only by an explicit Settings button). Don't reintroduce a plaintext credential
  store. → [02](nook-overview/02-data-model.md)
- Unlocked shared-key read-modify-writes race across tabs regardless of how simple
  the data looks — add the `navigator.locks` mutex like the existing sync queues.
