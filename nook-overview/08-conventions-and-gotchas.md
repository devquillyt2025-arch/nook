# 08 — Conventions & Gotchas

The expensive-to-re-derive, easy-to-get-wrong things. Read the relevant entry
before touching dates, storage keys, or the sync/backup files. None of these are
bugs to fix — each is a real decision with a real cost to "cleaning up".

---

## Read the code, not just the comments: things that are not what they look like

- **The app is login-gated, and the gate is deliberately offline-safe.** `main.jsx` wraps
  `<App />` in `AuthGate`; signing out reloads onto the login page. `AuthGate` lets a user in
  on the strength of a session record still in `localStorage` — it does **not** wait for
  `getSession()`, because supabase-js reports "no session" when the access token has expired
  and the refresh can't reach the server (offline), and that would lock someone out of their
  own local data (and make them wait ~25 s on a spinner). Don't "simplify" it back to
  `getSession()`-only. For a month (from `6d76bfa`, 2026-09-20) the gate was bypassed, no
  sign-in UI existed and nothing ever synced; any note that says "bypassed" or "optional
  sign-in" is stale, as is `backup.js`'s "export only" header. See
  [01 § Auth status](01-architecture.md#auth-status--read-this-first). Don't assume a
  feature is broken because its UI is missing; check whether it's hidden or gated.
- **Hidden ≠ deleted.** Voice commands, the Chat tab and the Gemini assistant are fully
  built but their entry points are commented out in `App.jsx`. Re-enable by uncommenting
  those lines, not by rewriting them. Details in [10](10-ai-voice-chat.md).
- **The keyboard-shortcuts modal is dead UI.** `ShortcutsModal` lists Space/R/1–4/N/A/S/?/D
  but nothing opens it and those keys have no handlers. Only `Esc` and `Ctrl/Cmd+K` work.
- **Reports no longer manages trackers.** It is a read-only dashboard; `nook-trackers` is
  kept but has no screen (see [03](03-tabs-and-features.md)).

## Selects, dates and times are themed components — never native

`<select>`, `<input type="date">` and `<input type="time">` are banned: the browser's
popups ignore the app theme. Use `Select` / `DateInput` / `TimeInput`
([06](06-ui-and-styling.md)); `components/themedControls.test.js` fails if one appears.
Popups must be portaled (`FloatingPopover`) or a modal / the Journal's side panel will
clip them — and a portaled popup must be treated as "inside" by the thing that opened it
(`data-nk-popover`).

---

## Dates: three anchoring conventions, all intentional

1. **Local-noon anchoring** — `new Date(ds + 'T12:00:00')` (no `Z`) is used almost
   everywhere (habits, trackers, journal, countdowns, analytics). At local midnight
   a `-1h` DST shift lands on the *previous* day; local noon never does. It's a DST
   guard, not an accident.
2. **Two different `todayStr()`** — `utils/date.js` returns the **local** date;
   `trackers/trackerUtils.js` returns the **UTC** date (`toISOString()`). The
   comment in `trackerUtils.js` says explicitly: *do not merge them.* Different call
   sites depend on the difference.
3. **Google Tasks payloads use midnight UTC** — the lone exception. See
   [04-google-sync.md](04-google-sync.md). **There is no noon-UTC anchoring
   anywhere**; if you read that somewhere, it's wrong.

## Storage keys: mixed hyphen/underscore is load-bearing

The `SK` map and the trackers store use **hyphens** (`nook-tasks`, `nook-settings`,
`nook-theme`, `nook-pomo-log`, `nook-intentions`, `nook-trackers`,
`nook-calendar-events`, `nook-activity-log`). Most feature modules use
**underscores** (`nook_notes`, `nook_links`, `nook_countdowns`,
`nook_habits`, `nook_journal_*`). **Renaming either family orphans real user
data.** Always grep the literal string before touching a key.

## Two id formats, on purpose

`utils/id.js → genId()` (base36 timestamp + random) for entities;
`utils/activityLog.js` uses a hyphenated `${Date.now()}-${rand}`. Not consolidated.

## Habits exist twice, on purpose

`nook_habits` (Habits tab + Today) and `type:'habit'` rows in `nook-trackers`
(Reports) are **separate stores** with different shapes (date-string array vs
`{date,value}` logs). A one-time `migrateFromTrackers()` (flag
`nook_habits_migrated`) *copied* — did not move — habit trackers into the habits
store, so the same habit can appear in both. Don't "dedupe" them without an
explicit product decision.

## The cross-tab banner has no dismiss — that's deliberate

Reload is the only exit. Verified with two real tabs: dismissing without reloading
leaves that tab's in-memory state stale, and its **next save silently overwrites**
whatever the other tab wrote — worse than no banner, because it teaches the user
the banner is safe to wave away. If a dismiss is ever reintroduced, it must
re-sync the tab's in-memory state from disk (at minimum for the changed key), not
just hide the UI. Don't "helpfully" re-add a `×`.

The one exception is a **sync merge**: when another tab's sync engine writes a remote
change into the shared localStorage (it announces it with `nook:sync:applied-at`
first), the banner is suppressed (`isForeignSyncApply`) and this tab's views are told
to refresh instead — that's a coordinated write, not a competing edit.

## Data-integrity files — refactor *around*, never *through*

Treat conflict-resolution / sync / auth logic in these as read-only unless the task
is explicitly to change that behaviour, and never auto-resolve conflicts in them:

- `utils/googleTasksSync.js`, `utils/googleCalendarSync.js`
- `utils/reminders.js`, `utils/notificationPrefs.js`, `utils/pushSubscription.js`
- `utils/backup.js`, `utils/driveBackup.js`, `utils/autoBackup.js`
- `utils/authClient.js`, `components/AuthGate.jsx`, `components/AuthPage.jsx`

Specifics that look like bugs but are correct:
- The **empty `else if (localUpdated > gUpdated) {}`** in `pullTasksFromGoogle` is
  intentional — it documents that local already-correct state wins and the queued
  push will carry it up. Don't delete it as dead code.
- **Never widen the Google Tasks pull allowlist** without deciding which Nook-only
  fields you'll lose (see [04-google-sync.md](04-google-sync.md)).
- Any **unlocked shared-key read-modify-write races across tabs** regardless of how
  simple the data model looks — add the `navigator.locks` mutex like the existing
  queues do.

## `FocusCompanion` is deliberately NOT `memo()`-wrapped

It derives `todayStr` from the wall clock at render. The midnight rollover in
`App.jsx` only calls `setIntentions`, which changes none of FocusCompanion's props
— so `memo()` would block the re-render and pin it to yesterday's pomodoro count
until an unrelated prop changed. The `useSyncExternalStore` tick hides this while a
timer runs, which is why it *looks* safe and isn't.

## Chart.js registers itself where it is used

`AnalyticsDashboard` calls `ChartJS.register(...)` for exactly the components it draws
(the unused `TrackerCharts.jsx` does the same). `register()` is idempotent, so any overlap
is harmless. Don't move registration to one shared point (that regression previously made
`AnalyticsDashboard` work only by import-order luck).

## Timer tick is an external store, not App state

The 1s tick lives in `utils/timerTickStore.js` and is read via
`useSyncExternalStore`, specifically so ticking re-renders only
`Timer`/`FocusCompanion`/`DailyGoalsView` and not the whole app. Don't route the
tick through `App.jsx` state. The countdown is derived from a `timerEndAt`
wall-clock delta (not accumulated intervals) so background-tab throttling can't
drift it.

## Activity log is write-only from the app

`logActivity()` writes `nook-activity-log` and fires a `nook-activity-updated`
window event. `ActivityLogView` owns all reads (live-reload throttled to 1.5s).
**Don't route the activity log through App state.**

## Journal is one key per day

`nook_journal_<YYYY-MM-DD>` — anything enumerating entries must scan localStorage
keys by the `nook_journal_` prefix, not read a single array.

## Cross-device sync traps (full reference: [09](09-cross-device-sync.md))

- **`sync.js` wraps `Storage.prototype.setItem/removeItem`.** Intentional: it is how
  every writer is synced without opting in. Only `window.localStorage` is observed, the
  original runs first, and it is installed only when auth is configured. Don't replace
  it with per-call-site "also sync" calls — the next writer would silently not sync.
- **A view holding a synced slice in state must use `useSyncApplied`.** Without it the
  view goes stale and fights deletes of remote-added items (the engine restores them
  until the view acknowledges a refresh). It also acks on mount.
- **Absence is never a delete on the first pass or during an import.** A wiped or
  restored localStorage must not tombstone the cloud copy. If you add a code path that
  removes many keys at once, wrap it in `runUntrackedSync` like "Clear Local Data".
- **Sync bookkeeping keys use `nook:`**, on purpose (see [02](02-data-model.md)). Don't
  rename them to `nook_…` "for consistency": they'd start appearing in backups and
  raising the cross-tab banner.
- **Raw vs JSON codecs matter.** `nook-week-start` is a raw string, `nook-theme` is
  JSON (`"dark"`). A def with the wrong codec can't parse the key and the engine
  (correctly) skips it forever.
- **Capped logs trim by dropping, not deleting.** Don't turn a trim into a tombstone.
- **Normalising a synced list on load is a delete.** Anything that drops items when it
  loads a synced slice and then re-saves the shorter list (the tracker name-dedupe) is read
  as the user deleting those items — everywhere. The normalisation must be a pure function
  of the data (`dedupeTrackers` keeps the oldest `createdAt`, then lowest id) so every device
  drops the *same* ones; "keep the first" differs per device and would delete both copies.

## Deliberately-kept dead-ish code

None of these is imported by anything live; they are kept because deleting a whole module
is a product decision:

- `trackers/insightsEngine.js` (~143 ln) — its only importer was removed.
- `components/AnalyticsModal.jsx`, `components/TrackerCharts.jsx`,
  `components/DailyIntentions.jsx` — superseded by the Reports dashboard / Today cards.
- `components/ShortcutsModal.jsx` — imported and mounted by `App.jsx` but never opened.
- Root `style.css` — an old stylesheet nothing imports.
- `AddTrackerModal.jsx` is imported and mounted, but nothing calls `openAddTracker`.
- **`TaskList`'s `showTimePicker` state is permanently `false`** (only ever set to
  false; `timePickerRef` is attached to nothing). Removing it touches a `useState`
  and a `useEffect` dep array — out of scope for zero-behaviour passes.

## Verification discipline

- **`vite build` passing is not verification** — no TS, no lint; it will build a
  render-time `ReferenceError`. Drive the real app, and run `npm test`
  ([11](11-testing-and-verification.md)).
- To run gate-free, point Vite's `envDir` at a dir with an empty `.env`. Don't edit
  the real `.env.local`.
- **`landing/` is off-limits** for app changes.
- Commit per tab; never force-push; never auto-resolve conflicts in the
  data-integrity files above.
