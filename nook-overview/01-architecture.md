# 01 — Architecture

## localStorage is the source of truth

Nook is a **client-only SPA with no backend of its own.** Every feature's primary
data lives in `localStorage`, is loaded synchronously into React state in
round-trip for normal reads/writes, and the app is fully functional with no
network and no account.

Three consequences drive most of the design:

1. **State lives in `App.jsx`** (~1750 lines) and flows down as props. Views are
   code-split with `lazy()` per tab, but they are not independently stateful
   stores — most of them receive their data and setters from `App.jsx`. A few
   feature modules (Journal, Notes, Links, Vault, Countdowns, Habits-store,
   Trackers) read/write their own localStorage keys directly instead of routing
   through `App.jsx`.

2. **Anything cloud-backed is an *addition* to localStorage, never a
   replacement.** If the cloud is unconfigured or offline, the app must still
   work. Never write code that assumes a Supabase session exists.

3. **No cross-tab merge.** Two tabs open at once is last-write-wins on whatever
   localStorage key either one touches — there is no reconciliation.

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
const [tasks, setTasks] = useState(() => load(SK.tasks, []));
// persist on change:
useEffect(() => { persist(SK.tasks, tasks); }, [tasks]);
```

Every localStorage access is wrapped in `try {} catch {}` — private-mode / quota /
disabled-storage failures degrade silently rather than crashing a render.

### Cross-tab detect-and-warn (not a merge)

`App.jsx` listens for the `storage` event (which fires only in *other* tabs of the
same origin) and shows a **persistent top banner** ("data changed in another tab")
on any `nook-`/`nook_`-prefixed key **except** sync-internal plumbing listed in
`CROSS_TAB_IGNORE_KEYS`:

```
nook_google_tokens, nook_pkce_verifier, nook_sync_queue, nook_deleted_tasks,
nook_last_pull_sync, nook_sync_enabled, nook-notif-state, nook-visits,
nook-install-dismissed, nook-analytics, nook_cleaned_w_duplicates,
nook_habits_migrated, nook-sidebar-open
```

This is **detect-and-warn, not a fix**. The banner has **no dismiss button** —
Reload is the only exit — and that is intentional (see
[08-conventions-and-gotchas.md](08-conventions-and-gotchas.md) for why re-adding a
dismiss is actively harmful).

---

## Supabase scope — and why it is this narrow

Supabase is used **only where a client-only app physically cannot do the job**:
something must run while the browser is closed, or identity must be proven. It is
*not* a general sync layer, and **task/note/journal/habit data is never stored
there.**

Five tables, and nothing else:

| Table | Written by | Why it can't be local |
|---|---|---|
| `reminders` | `utils/reminders.js` | An edge function must fire the reminder while the tab is shut |
| `notification_prefs` | `utils/notificationPrefs.js` | The same server-side sender needs to read prefs |
| `push_subscriptions` | `utils/pushSubscription.js` | Web Push endpoints are per-device and server-delivered |
| `drive_backup` | `utils/driveBackup.js`, `utils/autoBackup.js` | Holds Drive OAuth state for scheduled backups |
| `backup_runs` | `utils/driveBackup.js` | Audit trail of backup runs |

See [05-backend.md](05-backend.md) for the schema, RLS, and edge functions.

### Auth is optional by design

`utils/authClient.js` sets:

```js
isAuthConfigured = Boolean(VITE_SUPABASE_URL && VITE_SUPABASE_ANON_KEY)
```

When **false**, `AuthGate` renders the app with **no login gate at all**, and
every Supabase-backed helper early-returns. RLS scopes all queries to the
signed-in user, so reads don't filter on `user_id` explicitly.

`AuthGate` also consumes a **cross-origin SSO handoff** from the `landing/` app via
`#sb_access_token=...` / `sb_refresh_token=...` in the URL hash, then scrubs the
hash. Those custom key names deliberately differ from Supabase's own OAuth /
magic-link hash format (which `detectSessionInUrl` handles natively) so they don't
collide. Don't rename them on one side only.

---

## Component composition

`main.jsx` mounts:

```jsx
<StrictMode>
  <ErrorBoundary ...>
    <AuthGate>
      <App />
    </AuthGate>
  </ErrorBoundary>
</StrictMode>
```

- **`ErrorBoundary`** — catches render errors and shows a recovery screen ("Your
  data is safe in local storage — refreshing usually resolves this"). `main.jsx`
  also installs `window.onerror` / `unhandledrejection` handlers so exceptions
  from event handlers/timers/promises are logged rather than vanishing.
- **`AuthGate`** — the optional login gate + SSO handoff (above).
- **`App`** — the whole app.

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

## Where "background" work happens

`App.jsx` wires several cross-cutting effects on mount:

- **Midnight rollover** — a timeout to local midnight (computed via UTC midnight,
  see the date gotchas) that rolls daily intentions to a fresh day *in place*
  (no reload) so an open note/task isn't lost.
- **Google auth callbacks** — `handleAuthCallback` (Tasks),
  `handleCalendarAuthCallback` (Calendar), `handleDriveBackupCallback` (Drive) run
  on mount to complete any pending OAuth redirect.
- **Auto-backup** — `maybeRunAutoBackup()` checks whether a scheduled Drive backup
  is due.
- **Focus-triggered sync** — `syncTasks()` runs on window focus (30s debounced).
- **Notifications** — morning/streak/pomodoro local notifications are scheduled
  from settings.
