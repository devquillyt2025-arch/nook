# 04 — Google Sync (Tasks & Calendar)

Two independent integrations. **Tasks sync is the single most intricate file in
the repo** (`utils/googleTasksSync.js`, ~1000 lines). Calendar
(`utils/googleCalendarSync.js`, ~330 lines) is smaller and one-directional-ish.
Both are two-way for the entities they own; **only tasks and calendar events are
synced *to Google* — habits, goals, journal, notes, and trackers are never sent there.**

> **Not to be confused with cross-device sync.** Google sync links Nook to *Google's*
> apps. Moving your Nook data between *your own devices* is a separate system: tasks go
> through `utils/tasksService.js` (Supabase `tasks` table) and everything else through
> the `synced_items` engine ([09](09-cross-device-sync.md)). The two task systems run
> side by side — see [Coexisting with the Supabase task sync](#coexisting-with-the-supabase-task-sync).

> These are **data-integrity files**. Treat the conflict-resolution / push-pull /
> auth logic as read-only unless the task is explicitly to change that behaviour,
> and never auto-resolve conflicts inside them.

---

## Google Tasks (`utils/googleTasksSync.js`)

### Auth
PKCE OAuth against scope `https://www.googleapis.com/auth/tasks`, with
`prompt=consent` to force a refresh token. Tokens are stored in
`localStorage.nook_google_tokens` as `{accessToken, refreshToken, expiresAt}`.
`getValidAccessToken()` refreshes when under 60s of life remains and calls
`disconnectGoogleTasks()` on a failed refresh.

**The token exchange and refresh are done server-side** by the `google-oauth`
edge function, to keep `GOOGLE_CLIENT_SECRET` out of the client bundle. This means
**Tasks & Calendar sync require Supabase configured and the user signed in.**

### Date anchoring — read before touching dates

There are **two conventions and they are not interchangeable:**

- **Google Tasks payloads use midnight UTC.** `nookToGoogleTask()` writes a
  date-only due as `` `${task.dueDate}T00:00:00.000Z` ``. `extractDueDateTime()`
  round-trips it by special-casing exactly that suffix and taking `split('T')[0]`,
  which keeps a date-only task from drifting a day. A task *with* a time is
  converted local→UTC via `toISOString()` and back via local getters.
- **Everything else in the app anchors date strings at local noon**
  (`new Date(ds + 'T12:00:00')`, no `Z`). This is a DST/timezone guard.

There is **no noon-UTC anchoring anywhere.**

### Field ownership — the pull allowlist

On pull, a remote task **only overwrites this allowlist:**

```
name, notes, dueDate, time, completed, status, completedAt, lastSyncedAt, updatedAt
```

Everything else survives via `...t` (spread) because Google Tasks has no concept
of it: `category`, `priority`, `timeEstimate`, `timeLogged`, `pomodorosCompleted`,
`recurrence`, `recurrenceDays`, `subtasks`, `id`.

> **Widening this allowlist will silently destroy Nook-only data on the next
> pull.** Never widen it without deciding exactly which Nook-only fields you are
> willing to lose.

### Conflict resolution — last-write-wins

Google wins only when it is newer than *both* the last sync and the local edit:

```js
if (gUpdated > localSynced && gUpdated > localUpdated) { /* apply remote */ }
else if (localUpdated > gUpdated) { /* local wins: intentionally a no-op */ }
```

The empty `else if` is **deliberate** — local state is already correct and the
queued push will carry it up. Do not delete it as dead code. Deletes resolve the
same way: a task deleted on Google but edited locally is kept and tagged
`syncConflict` rather than removed.

### Orchestration

`syncTasks()` = **push queue → pull**, in that order, guarded by a
`syncInProgress` flag and a 30s debounce on window-focus triggers.

- `pushSyncQueue({type, taskId})` enqueues an op (CREATE/UPDATE/DELETE) on every
  local edit and collapses repeat ops per task.
- `pushLocalChangesToGoogle()` drains the queue with a network call per op, 100ms
  slept between requests.
- Deleted Google ids are tombstoned in `nook_deleted_tasks` so a pull can't
  resurrect them.
- `429/401/5xx` are re-queued with exponential backoff (`requeueWithBackoff`,
  capped at 5 min, dropped after 8 attempts).
- `syncTaskField()` is a **separate immediate single-field PATCH** used by the
  Scheduling tab for instant feedback — it bypasses the queue and returns a tagged
  result: `unauthenticated | no_google_id | api_error | network_error`.

### Cross-tab mutex on the sync queue

`nook_sync_queue` / `nook_deleted_tasks` are read-modify-written from two places
that can race across tabs — `pushSyncQueue()` (fast, per edit) and
`pushLocalChangesToGoogle()`'s write-back (slow, after a batch). Both go through
`withSyncQueueLock()` using `navigator.locks.request('nook-sync-queue', ...)`, and
the write-back **merges by `qid` against the queue's *current* contents** rather
than overwriting with a start-of-batch snapshot (otherwise a concurrent tab's
write during the batch is silently dropped). Verified fail-open: a tab holding the
lock that is closed mid-lock releases it, and the other tab resolves in under a
second.

### Known limitations (documented in-file — do not "fix" accidentally)

- **The Google *connection* is per-device.** Tokens, the push queue, the delete
  tombstones and the last-pull time are all localStorage (and deliberately never
  synced or backed up). Your *tasks* now reach other devices through Supabase, but a
  device you haven't connected to Google won't push or pull Google changes, and
  connecting a second device to the same Google account can still produce
  duplicates on first pull (the in-file header says so).
- **Recurrence is local-only.** The Google Tasks REST API has no recurrence field;
  any RRULE is silently dropped. Nook creates the next occurrence itself.
- **Supabase auth required** for the OAuth token exchange/refresh (see Auth above).

### Coexisting with the Supabase task sync

Both systems read and write the **same local `nook-tasks` array** and reconcile with
last-write-wins on the app-level `updatedAt`. They are otherwise independent (see the
header of `utils/tasksService.js`), with exactly **one** intentional coupling:
`googleTasksSync` imports `softDeleteTask`. A task deleted on the Google side used to be
filtered out of local state with no Supabase tombstone, so the Supabase row stayed live
and the next hydrate re-adopted it as a remote-only task forever. A delete has to be
agreed by both systems or neither owns it. Related fixes in the history:
`e846c71` (Google pull minted duplicate tasks on every pull), `11b3d6f` (the pull merge
must be able to *express* a deletion), `ec746fc` (tombstone gap in Google sync + backup
restore, null-`updatedAt` freeze).

When you change anything here, check both layers still agree on `updatedAt`: it is the
only clock either one trusts.

---

## Google Calendar (`utils/googleCalendarSync.js`)

Same PKCE OAuth pattern, own storage keys: `nook_gcal_tokens`,
`nook_gcal_pkce_verifier`, `nook_gcal_enabled`. Exposes `isGCalConnected`,
`connectGoogleCalendar`, `disconnectGoogleCalendar`, and
`handleCalendarAuthCallback` (run on mount by `App.jsx`).

Calendar events are **fetched live** into `CalendarView` state and rendered as an
overlay on the month grid — they are **not** persisted to localStorage (only
Nook's own custom events in `nook-calendar-events` are). Creating an event pushes
to Google via a queue.

### The identical cross-tab lock

`nook_gcal_push_queue` uses the same lock pattern (`navigator.locks.request(
'nook-gcal-push-queue', ...)`) for the same reason as the Tasks queue. It was
initially added *without* a lock on the reasoning that "it only pushes on create,
one op at a time" — that describes the entity model, not tab concurrency.

> **Any unlocked shared-key read-modify-write has this race regardless of how
> simple the data model is.** If you add another queue like this, add the lock —
> don't assume simplicity implies safety.
