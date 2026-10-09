# 01 — Architecture

## localStorage is the source of truth

Nook is a **client-only SPA with no backend of its own.** Every feature's primary
data lives in `localStorage`, is loaded synchronously into React state on mount, and
the app is fully functional with no network and no account. When signed in, that
data is *mirrored* to Supabase so it follows you across devices (see
[09-cross-device-sync.md](09-cross-device-sync.md)).

```
                     ┌──────────────────────────────────────────────┐
   UI (React views)  │  reads + writes localStorage, synchronously  │  ← always works, offline, no account
                     └───────────────┬──────────────────────────────┘
                                     │ observed / merged into
                ┌────────────────────┴─────────────────────┐
                │                                          │
   tasks, habits (typed services)            everything else (generic sync engine)
   tasksService / habitsService              utils/syncEngine.js via utils/sync.js
        │  per-row LWW + Realtime                  │  per-item LWW + Realtime
        ▼                                          ▼
   Supabase `tasks`, `habits`                Supabase `synced_items`
                                     
   + Google Tasks / Calendar (utils/google*Sync.js, independent, optional)
   + reminders / push / Drive backup (Supabase tables + edge functions)
   + Claude/Gemini features (edge functions; currently hidden — see 10)
```

Three consequences drive most of the design:

1. **State lives in `App.jsx`** (~2100 lines) and flows down as props. Views are
   code-split with `lazy()` per tab, but they are not independently stateful stores —
   most of them receive their data and setters from `App.jsx`. A few feature modules
   (Journal, Notes, Links, Countdowns, Habits-store, Trackers) read/write their own
   localStorage keys directly instead of routing through `App.jsx`.

2. **Anything cloud-backed is an *addition* to localStorage, never a replacement.**
   If the cloud is unconfigured or offline, the app must still work. Never write code
   that assumes a Supabase session exists.

3. **No cross-tab merge of user edits.** Two tabs open at once is last-write-wins on
   whatever localStorage key either one touches — there is no reconciliation. (What
   *is* coordinated across tabs is the sync engine itself: it takes a `navigator.locks`
   mutex per slice, and a remote change merged by one tab refreshes the other tabs'
   views instead of raising the banner below.)

### The load → state → persist loop (the pattern to copy)

In `App.jsx`, each slice follows the same shape:

```js
// keys are centralised for the App-owned slices:
const SK = {
  tasks: 'nook-tasks', settings: 'nook-settings',
  theme: 'nook-theme', pomoLog: 'nook-pomo-log',
  intentions: 'nook-intentions',
};
function persist(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

// load (lazy initial state):
const [tasks, setTasks] = useState(loadTasks);
// persist on change:
useEffect(() => { persist(SK.tasks, tasks); }, [tasks]);
```

Every localStorage access is wrapped in `try {} catch {}` — private-mode / quota /
disabled-storage failures degrade silently rather than crashing a render.

### State ownership

| Owned by `App.jsx` (state + persist effect) | Owned by the feature module itself |
|---|---|
| tasks, pomodoro settings, theme, pomodoro log, intentions, habits, trackers, profile name/email/avatar, active tab, sidebar state, toasts, modals | notes (`NotesView`/`notesStore.js`), links, countdowns, journal, calendar custom events, activity log, chat history, goals (read-only), settings preferences (`SettingsView`), custom task categories/sort (`TaskList`) |

When a remote change from another device lands, the sync engine writes it into
`localStorage` and emits `nook-sync-applied`; `App.jsx` re-reads the slices it holds
in state, and each view re-reads its own via `useSyncApplied` (see 09).

---

## Auth status — read this first

`utils/authClient.js` sets:

```js
isAuthConfigured = Boolean(VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY)
```

When **false** every Supabase-backed helper early-returns and the app is purely local.
When **true**, helpers act only if a Supabase **session** exists.

**The app is not login-gated.** `main.jsx` renders `<App />` directly (since commit
`6d76bfa`, 2026-09-20, with the comment *"Temporarily bypassing AuthGate since this is
used only locally"*). `components/AuthGate.jsx` (hard gate + SSO handoff) and
`components/AuthPage.jsx` (full-screen sign-in / sign-up / reset / Google) are complete
but **unmounted** — kept for a possible future gate. They are data-integrity files: don't
edit them as part of unrelated work.

**Sign-in is optional and lives in Settings → Connections.** While signed out (and only
when `isAuthConfigured`), the Account row reads "Signed out" and `components/AccountSignIn.jsx`
renders under it: email + password **Sign in**, **Create an account**, and **Continue with
Google** — the same three Supabase calls `AuthPage` makes (`signInWithPassword`, `signUp`,
`signInWithOAuth`). Facts worth knowing:

- A successful password sign-in **reloads the page.** Several cloud features initialise
  once on mount and look for a session then (task/habit hydrate + Realtime, push,
  reminders); a reload puts the app in the state it was in when it was only ever mounted
  behind a gate, rather than a half-initialised one. Google sign-in redirects away and
  back, which has the same effect.
- Sign-up that needs email confirmation shows an inbox notice and returns to sign-in; one
  that returns a session signs in at once.
- **Sign out** is the existing **Log Out** button at the bottom of Settings
  (`handleLogout`: disconnects the Google integrations, `signOut()`, reload). Local data
  stays on the device; sync stops (`SIGNED_OUT` → `engine.end()`).
- There is **no "forgot password" flow.** A recovery link would create a session but nothing
  in the running app prompts for a new password (`AuthPage`'s reset button relied on the same
  missing step). Reset passwords from the Supabase dashboard.
- The Account row follows `onAuthStateChange`, so it updates on sign-in/out, including from
  another tab. It shows "Checking…" until the first answer so a signed-in user never sees the
  form flash.
- With `VITE_SUPABASE_*` unset there is no form and the row says "Local only — no cloud
  features". The credentials are **never** hard-coded; whoever signs in is whoever the
  Supabase project says they are.

What a signed-in session switches on: cross-device sync of everything (`synced_items`),
the tasks/habits Supabase sync + Realtime, reminders, Web Push, Drive backup, the Google
OAuth token exchange (`google-oauth` verifies the caller's session), and the voice/Chat edge
functions. **Without a session they all degrade to "do nothing"** — which is why no code may
assume one exists.

The `landing/` → app **SSO handoff** (`#sb_access_token=…` in the URL hash) is still dead:
`AuthGate` is what consumes it, and it is not mounted. Its custom key names deliberately
differ from Supabase's own OAuth / magic-link hash format (which `detectSessionInUrl`
handles natively) so they don't collide — don't rename them on one side only. Reviving the
handoff means mounting `AuthGate` again:

```jsx
<ErrorBoundary …><AuthGate><App /></AuthGate></ErrorBoundary>
```

With `VITE_SUPABASE_*` set that is a **hard gate** (login before anything else; the
local-first "just open it" experience is gone on a fresh browser). It is a product decision,
not a bug fix — the optional Settings sign-in was chosen instead.

---

## What Supabase is used for

Two different jobs, kept separate.

**1. Things a client-only app physically cannot do** — something must run while the
browser is closed, a secret must stay off the client, or identity must be proven:

| Table / function | Written by | Why it can't be local |
|---|---|---|
| `reminders` | `utils/reminders.js` | An edge function must fire the reminder while the tab is shut |
| `notification_prefs` | `utils/notificationPrefs.js` | The same server-side sender needs to read prefs |
| `push_subscriptions` | `utils/pushSubscription.js` | Web Push endpoints are per-device and server-delivered |
| `drive_backup`, `backup_runs` | `utils/driveBackup.js`, `utils/autoBackup.js` | Holds Drive OAuth state for scheduled backups |
| edge fns `google-oauth`, `connect-drive` | `utils/googleOAuthClient.js`, `driveBackup.js` | A Google client secret must never ship in the bundle |
| edge fns `parse-voice-command`, `chat-with-claude` | `utils/voiceCommandClient.js`, `chatClient.js` | The Anthropic API key must stay server-side |

**2. Cross-device sync of the user's content.** `localStorage` stays the source the UI
reads; Supabase holds the copy that follows you between devices, reconciled per item,
last-write-wins, with soft-delete tombstones:

| Table | Written by | Covers |
|---|---|---|
| `tasks` | `utils/tasksService.js` | Tasks (own typed table, beside the Google Tasks sync) |
| `habits` | `utils/habitsService.js` | Habits |
| `synced_items` | `utils/syncEngine.js` (via `sync.js`) | **Everything else** — notes, links, journal, countdowns, calendar events, trackers, goals, intentions, logs, settings. One generic table; see [09](09-cross-device-sync.md). |

Either way, **cloud is an addition to localStorage, never a replacement**; every helper
no-ops without a configured project and a signed-in session. See
[05-backend.md](05-backend.md) for schema, RLS and edge functions.

---

## Component composition

`main.jsx` currently mounts:

```jsx
<StrictMode>
  <ErrorBoundary title="Nook hit an unexpected error" message="Your data is safe in local storage …">
    <App />                      {/* AuthGate is bypassed — see "Auth status" above */}
  </ErrorBoundary>
</StrictMode>
```

- **`ErrorBoundary`** — catches render errors and shows a recovery screen. `main.jsx`
  also installs `window.onerror` / `unhandledrejection` handlers so exceptions from
  event handlers/timers/promises are logged rather than vanishing.
- **`App`** — the whole app (nav shell, 13 routed views, modals, background effects).

## Code-splitting

Every route-level view is `lazy()`-loaded in `App.jsx`, one Vite chunk per tab, so
a tab's JS only downloads when first opened:

```js
const ReportsView    = lazy(() => import('./components/ReportsView'));
const CalendarView   = lazy(() => import('./components/CalendarView'));
const TaskList       = lazy(() => import('./components/TaskList'));
// …one per tab; NoteModal is a named-export lazy chunk of NotesView
```

Views render inside a `<Suspense>` boundary.

## Cross-tab detect-and-warn (not a merge)

`App.jsx` listens for the `storage` event (which fires only in *other* tabs of the
same origin) and shows a **persistent top banner** ("Your data changed in another tab")
on any `nook-`/`nook_`-prefixed key **except** plumbing listed in
`CROSS_TAB_IGNORE_KEYS`:

```
nook_google_tokens, nook_pkce_verifier, nook_sync_queue, nook_deleted_tasks,
nook_last_pull_sync, nook_sync_enabled, nook-notif-state, nook-visits,
nook-install-dismissed, nook-analytics, nook_cleaned_w_duplicates,
nook_habits_migrated, nook_tasks_migrated, nook_habits_sync_migrated,
nook-sidebar-open, nook-last-export, nook-active-tab
```

(The cross-device sync bookkeeping uses `nook:`-prefixed keys, which this `nook[-_]`
check never matches, so they need no entry.)

This is **detect-and-warn, not a fix**. The banner has **no dismiss button** — Reload
is the only exit — and that is intentional (see
[08-conventions-and-gotchas.md](08-conventions-and-gotchas.md)). The one exception is a
write by *another tab's sync engine*, which refreshes this tab's views instead.

## Where "background" work happens

`App.jsx` wires these cross-cutting effects (in file order):

- **OAuth callbacks on mount** — `handleAuthCallback` (Google Tasks),
  `handleCalendarAuthCallback` (Calendar), `handleDriveBackupCallback` (Drive) complete
  any pending redirect.
- **Auto-backup** — `maybeRunAutoBackup()` checks on load and window focus whether a
  scheduled Drive backup is due.
- **One-time duplicate cleanup** for a historical keystroke bug (`nook_cleaned_w_duplicates`).
- **Google focus sync** — `syncTasks()` on window focus (30s debounced), when Google Tasks is connected.
- **Supabase tasks sync** — one-time migration, hydrate + reconcile on mount and on
  focus, live Realtime subscription. **Supabase habits sync** — the same, for habits.
- **Persistence** — one `useEffect` per slice writing it back to localStorage.
- **Midnight rollover** — a timeout to local midnight (computed via UTC midnight, see
  the date gotchas) that rolls daily intentions to a fresh day *in place* (no reload)
  so an open note/task isn't lost.
- **PWA install prompt / visit tracking**.
- **Scheduled local notifications** — morning briefing / streak / pomodoro, driven by
  settings, via the Notifications API.
- **Cross-tab change detection** (above) and **Escape closes the topmost modal**.
- **Timer** — external tick store; see 08.
- **Cross-device sync** — `startSync()` and the `useSyncApplied` handler for the slices
  `App.jsx` holds in state (09).
