# 02 — Data Model & Storage

This is the exhaustive reference for **what Nook stores and where**, and — new since
the cross-device sync work — **whether each piece follows you to other devices**. If
you rebuild the app, matching these keys and shapes gives you data compatibility.

> **Key-naming is inconsistent and load-bearing.** Some keys use **hyphens**
> (`nook-tasks`), most feature modules use **underscores** (`nook_notes`), and the
> sync bookkeeping uses a **colon** (`nook:sync:…`). This is historical/deliberate and
> must not be "cleaned up" — renaming a key orphans real user data. Always grep the
> literal string before touching a key.

**Sync column legend**

| Value | Meaning |
|---|---|
| **tasks** / **habits** | Synced by `tasksService.js` / `habitsService.js` into the typed Supabase tables (per row, last-write-wins, Realtime). |
| **synced_items: `<def>`** | Synced by the generic engine into `synced_items`; `<def>` is its name in `utils/syncDefs.js`. See [09](09-cross-device-sync.md). |
| **device** | Deliberately never leaves this browser (credentials, per-device preferences, plumbing). |

---

## Every localStorage key

### App-owned content (loaded into `App.jsx` state)

| Key | Shape | Owner | Sync |
|---|---|---|---|
| `nook-tasks` | `Task[]` | `App.jsx` | **tasks** |
| `nook_habits` | `Habit[]` | `habitsStore.js` (held in `App.jsx` state) | **habits** |
| `nook-settings` | Pomodoro settings object | `App.jsx` | synced_items: `pomo_settings` |
| `nook-theme` | `"dark" \| "light"` (**JSON string**) | `App.jsx` | synced_items: `theme` |
| `nook-pomo-log` | `string[]` of ISO timestamps, one per completed focus session (legacy fallback `nook-analytics`) | `App.jsx` | synced_items: `pomo_log` |
| `nook-intentions` | `{ date, items[], history{} }` | `App.jsx` | synced_items: `intentions` |
| `nook-trackers` | `Tracker[]` (legacy — see below) | `trackers/trackerUtils.js` | synced_items: `trackers` |
| `nook-active-tab` | tab id string (nav state only) | `App.jsx` | device |

### Feature-module content (module reads/writes its own key)

| Key | Shape | Owner | Sync |
|---|---|---|---|
| `nook_notes` | `Note[]` | `NotesView` / `notesStore.js` | synced_items: `notes` |
| `nook_links` | `Link[]` | `LinksView` | synced_items: `links` |
| `nook_countdowns` | `Countdown[]` | `CountdownsView` | synced_items: `countdowns` |
| `nook_countdown_pinned` | **raw string** — the pinned countdown's id | `CountdownsView` | synced_items: `countdown_pinned` |
| `nook_goals` | `Goal[]` — **read-only today** (nothing writes it) | `trackers/detailedAnalysis.js`, `aiContext.js` | synced_items: `goals` |
| `nook-calendar-events` | `CalendarEvent[]` (custom events only) | `CalendarView` | synced_items: `calendar_events` |
| `nook_journal_<YYYY-MM-DD>` | `JournalEntry` — **one key per day** | `JournalView` | synced_items: `journal` |
| `nook_journal_icons` | `{ [date]: emoji }` mood map | `JournalView` | synced_items: `journal_icons` |
| `nook-activity-log` | `ActivityEntry[]` (newest first, cap 2000) | `utils/activityLog.js` | synced_items: `activity_log` |
| `nook_chat_history` | `ChatMessage[]` (cap 200) — the **Chat** tab | `utils/chatStore.js` | synced_items: `chat_history` |
| `nook-weekly-reviews` | `WeeklyReview[]` | `App.jsx` / `AnalyticsDashboard` | synced_items: `weekly_reviews` |
| `nook_custom_categories` | `{ [key]: { label, color } }` user-added task lists | `TaskList` | synced_items: `custom_categories` |
| `nook_task_sort` | **raw string** — task sort preference | `TaskList` | synced_items: `task_sort` |

### Preferences / UI state

| Key | Meaning | Sync |
|---|---|---|
| `nook-week-start` | **raw string**: first day of week | synced_items: `week_start` |
| `nook-profile-name` / `-email` / `-avatar` | **raw strings**: local profile display (avatar is an emoji or a `data:` URL, synced only if ≤ 250 KB) | synced_items: `profile_*` |
| `nook-notif-master` / `-morning` / `-morning-time` / `-streak` / `-pomo` | notification toggles + times (depend on this browser's notification permission) | **device** |
| `nook-sidebar-open` | `true`/`false` — sidebar full vs icon rail | **device** |
| `nook_journal_calview` / `nook_journal_calcollapsed` | journal calendar view mode / collapsed flag | **device** |
| `nook-last-export` | timestamp of the last manual backup export | **device** |
| `nook-visits` | visit counter (PWA install nudge) | **device** |
| `nook-install-dismissed` | PWA install prompt dismissal | **device** |
| `nook_ai_api_key` | the user's Gemini key, typed in Settings (**a credential**) | **device** — never synced |
| `nook_ai_chat_history` | the hidden Gemini assistant panel's messages | **device** |

> `nook-session-visited` is a **sessionStorage** key (per-tab-session), not localStorage.

### Cross-device sync bookkeeping — `nook:` prefix (NOT `nook-`/`nook_`)

| Key | Meaning |
|---|---|
| `nook:sync:meta:<def>` | Per-slice sync state: last-synced stamp + content hash + dirty flag per item, tombstones |
| `nook:sync:cursor` | Server-time cursor for the incremental pull |
| `nook:sync:uid` | Which account this browser last synced as (a different one triggers the account-switch prompt) |
| `nook:sync:applied-at` | Written just before the engine merges remote data, so other tabs know the writes that follow are a sync |

Deliberately **not** `nook-`/`nook_`: those prefixes are swept by backup export,
import's allowlist and the cross-tab banner, and a restored copy would carry another
device's stale sync state. Which content keys are synced is defined in one place,
`utils/syncDefs.js`; renaming a synced key or changing its codec (JSON vs raw string)
breaks its sync — see [09-cross-device-sync.md](09-cross-device-sync.md).

### Google sync / one-time-migration plumbing (all in `CROSS_TAB_IGNORE_KEYS`, all **device**)

| Key | Meaning |
|---|---|
| `nook_google_tokens` | Google **Tasks** OAuth tokens `{accessToken, refreshToken, expiresAt}` |
| `nook_pkce_verifier` | PKCE verifier during Tasks OAuth |
| `nook_sync_enabled` | Google Tasks sync on/off |
| `nook_sync_queue` | pending Google Tasks push ops |
| `nook_deleted_tasks` | tombstones so Google pulls can't resurrect deleted tasks |
| `nook_last_pull_sync` | timestamp of last Google Tasks pull |
| `nook_gcal_tokens` | Google **Calendar** OAuth tokens |
| `nook_gcal_pkce_verifier` | PKCE verifier during Calendar OAuth |
| `nook_gcal_enabled` | Calendar sync on/off |
| `nook_gcal_push_queue` | pending Calendar push ops |
| `nook-notif-state` | notification scheduler bookkeeping |
| `nook-analytics` | legacy pomodoro log (fallback source for `nook-pomo-log`) |
| `nook_cleaned_w_duplicates` | one-time data-clean flag |
| `nook_habits_migrated` | one-time copy of habit-trackers → `nook_habits` |
| `nook_tasks_migrated`, `nook_habits_sync_migrated` | one-time local→Supabase seeding done on this device |

### Legacy (nothing reads or writes it any more)

| Key | Notes |
|---|---|
| `nook_vault` | The **Saved Logins** tab was removed. Entries saved earlier are left in place, in **plaintext**, are **not** synced, and a full backup still sweeps them up (`backup.js` takes every `nook_` key). Settings → Data Management shows an "Old saved logins" count with a **Delete** button while any remain; "Clear Local Data" also removes them. |

---

## Entity shapes

### Task (`nook-tasks`)

```js
{
  id: genId(),                 // base36 timestamp + random (utils/id.js)
  name: 'Write docs',
  category: 'work',            // learning | fitness | mental | work | growth (+ custom)
  priority: 'medium',          // high | medium | low | none
  timeEstimate: 25,            // minutes, clamped 1..480
  notes: '',
  dueDate: '2026-07-20',       // YYYY-MM-DD (or '' none)
  time: '14:30',               // optional time-of-day (scheduling)
  endTime: '15:30',            // optional
  isAllDay: false,
  completed: false,
  status: 'needsAction',       // Google Tasks status: needsAction | completed
  completedAt: null,           // ISO string when completed
  timeLogged: 0,               // minutes logged via focus timer
  pomodorosCompleted: 0,
  recurrence: null,            // 'daily'|'weekdays'|'weekly'|'monthly'|'custom' (not sent to Google)
  recurrenceDays: [],          // days-of-week for 'custom' recurrence
  subtasks: [ { id, text, completed } ],   // optional
  createdAt: '<ISO>',
  updatedAt: '<ISO>',          // drives last-write-wins (Supabase AND Google)
  // Google Tasks sync bookkeeping:
  googleTaskId: null,
  lastSyncedAt: null,
  syncConflict: null,          // set to a marker when a delete/edit conflict is kept
}
```

**Field ownership matters for Google sync** — see [04-google-sync.md](04-google-sync.md).
On a Google pull, only an allowlist of fields is overwritten; everything else
(category, priority, timeEstimate, timeLogged, pomodorosCompleted, recurrence,
subtasks…) survives because Google Tasks has no concept of it. The Supabase `tasks`
table carries the **whole** object (columns mirror the keys 1:1, quoted camelCase) plus
a `deleted_at` tombstone.

### Habit (`nook_habits`) — `habitsStore.js`

```js
{
  id: '<base36+random>',
  name: 'Meditate',
  category: 'health',          // health|work|finance|personal|learning|fitness
  frequency: 'daily',          // 'daily'|'weekdays'|'weekends'| [0..6] day array
  timeTag: null,               // optional 'morning'/'evening' style tag
  color: '#818cf8',
  reminderEnabled: false,
  reminderTime: null,          // 'HH:MM'
  completions: ['2026-07-19', '2026-07-20'],  // plain LOCAL date strings
  createdAt: '<ISO>',
  updatedAt: '<ISO>',          // stamped on every write by App's handlers (drives LWW);
                               // absent on a brand-new habit until its first write
  archived: false,             // optional; exists in the Supabase `habits` schema and App's
                               // activity-log wording, but no screen sets it today
}
```

Streaks, best-streak, success-rate, the 7-day strip and 12-week (84-cell) heatmap
are all **derived** from `completions` in `habitsStore.js`. Non-scheduled days are
skipped in streak math; today-not-yet-done does not break a streak.

### Tracker (`nook-trackers`) — `trackers/trackerUtils.js` — *legacy UI*

Trackers still exist in storage and still feed some Today-dashboard numbers
(`isScheduledToday` / `isLoggedToday`), but **Reports no longer lists or manages
them** (it is a read-only dashboard built from Habits, Tasks, Focus and Journal), and
nothing currently calls the "add tracker" entry point. The data is retained.

```js
{
  id, name,
  type: 'habit',               // habit | target | average | project
  category: 'health',          // health | work | finance | personal
  createdAt: '<ISO>',
  logs: [ { date: '2026-07-20', value: true } ],  // value: boolean|number
  config: { /* per type, below */ },
}
```

| Type | `config` | `logs[].value` | "logged today" means |
|---|---|---|---|
| `habit` | `{ schedule, timeTag }` | `true`=done, `false`=skip | a log today with `value===true` |
| `target` | `{ targetValue, unit, startValue, targetDate }` | number | any log today |
| `average` | `{ unit, targetAverage, schedule, timeTag }` | number | any log today |
| `project` | `{ milestones:[{id,done,doneAt}], targetDate }` | — | all milestones done |

`logs` are kept date-sorted ascending and **capped at 2000 entries per tracker**
(oldest dropped) in `saveTrackers`. `loadTrackers` de-dupes by id, then by
case-insensitive name — keeping the **oldest** (`createdAt`, then lowest `id`)
duplicate, so every device drops the *same* one (see
[08](08-conventions-and-gotchas.md): normalising a synced list on load is a delete).

> **Habits exist twice on purpose.** A one-time `migrateFromTrackers()` (flagged by
> `nook_habits_migrated`) copied `type:'habit'` trackers into `nook_habits` — it did
> not delete them. So the same habit can legitimately appear in both `nook_habits` and
> `nook-trackers`. The shapes differ (date-string array vs `{date,value}` logs). Do not
> "dedupe" them.

### Journal entry (`nook_journal_<YYYY-MM-DD>`)

**One localStorage key per day.** Anything enumerating entries must scan keys by
the `nook_journal_` prefix — and match `^nook_journal_\d{4}-\d{2}-\d{2}$` exactly,
because `nook_journal_icons`, `_calview` and `_calcollapsed` share the prefix.

```js
{ date: '2026-07-20', content: '<html>', createdAt: '<ISO>', updatedAt: '<ISO>' }
```

`content` is rich-text HTML (contentEditable). `nook_journal_icons` maps a date →
mood emoji separately. Export to `.docx` is handled by `utils/journalDocx.js`.

### Note (`nook_notes`) — `NotesView`

```js
{
  id: Date.now().toString(),
  title: '', content: '',      // content is rich HTML
  color: 'default',            // default|red|orange|yellow|green|teal|blue|purple|pink
  pinned: false,
  tags: [],
  createdAt: '<ISO>', updatedAt: '<ISO>',
}
```

Created through `utils/notesStore.js` (`newNote`, `saveNote`) — shared with the voice
command path so a note made by voice is identical to one made in the editor.

### Link (`nook_links`) — `LinksView`

```js
{ id, name, url, category, starred: false, createdAt: '<ISO>' }
```

Bookmarks grouped by category; favicons are fetched from
`https://www.google.com/s2/favicons?domain=<host>&sz=32` (a 404 there for an unknown
domain is harmless). `url` always has an `https://` prefix forced on save.

### Countdown (`nook_countdowns`) — `CountdownsView`

```js
{ id, name, category,            // Personal|Work|Health|Learning|Travel|Other
  priority,                      // low|medium|high
  notes,                         // ≤ 500 chars
  startDate, endDate,            // 'YYYY-MM-DD'
  milestones: [ { id, name, targetDate } ],
  completed: false, createdAt: '<ISO>' }
```

The pinned countdown's id lives separately in `nook_countdown_pinned` (a raw string).

### Calendar custom event (`nook-calendar-events`) — `CalendarView`

```js
{ id: genId(), title, date: 'YYYY-MM-DD', time: 'HH:MM', endTime: 'HH:MM',
  isAllDay: bool, category: 'growth', notes: '' }
```

The Calendar merges **three sources**: tasks with a `dueDate`, these custom events, and
live Google Calendar events (fetched, not stored — only held transiently in state).

### Goal (`nook_goals`) — *read-only today*

```js
{ id, title, milestones: [ { id, done } ], manualProgress: 0, /* 0..100 when no milestones */
  category, targetDate, completed, createdAt }
```

Progress = `milestones.length ? round(done/total*100) : manualProgress`. **No screen creates
or edits goals**, and Today no longer shows them; the key is read by the Detailed Analysis and
`aiContext.js` only.

### Intentions (`nook-intentions`) — `App.jsx`

```js
{
  date: '2026-07-20',
  items: [ { id: '1', text: '', done: false }, /* seeded with 3 blank items */ ],
  history: { '2026-07-19': true /* whether any item was done that day */ },
}
```

Rolled over to a new day *in place* at local midnight; the previous day's
"anything done?" flag is pushed into `history`. (`DailyIntentions.jsx`, the editor for
these, is no longer imported anywhere, and Today no longer reads them either — nothing displays
this key now, though it still rolls over and syncs.)

### Pomodoro log (`nook-pomo-log`, legacy `nook-analytics`)

A **flat array of ISO timestamp strings**, one per completed focus session, capped at
`MAX_POMO_LOG = 2000`. Consumers (Stats, DailyGoalsView, AnalyticsDashboard) only read
the last 7/30 days. The legacy `nook-analytics` map (`{ 'YYYY-MM-DD': { pomodoros } }`)
is converted on first load if `nook-pomo-log` is absent.

### Settings (`nook-settings`) — `App.jsx`

```js
{ focusDuration: 25, shortDuration: 5, longDuration: 15, customDuration: 25,
  autoSwitch: false, sound: true }
```

### Weekly review (`nook-weekly-reviews`) — newest first

```js
{ date: '<ISO>', wentWell, wasHard, nextFocus, rating, focusHabits: [habitId, ≤3], focusTarget }
```

### Activity log entry (`nook-activity-log`) — `utils/activityLog.js`

```js
{
  id: `${Date.now()}-${rand}`,   // NOTE: distinct id format from genId()
  module: 'tasks',               // tasks|calendar|habits|notes|links|countdowns|journal|focus|…
  entity_type: 'task',
  entity_id: '<id>',
  action: 'created',             // created|updated|deleted|completed|archived|restored|exported…
  title: 'Write docs',
  field_changes: [ { field, from, to } ] | null,  // via diffObjects()
  status: 'success',
  created_at: '<ISO>',
}
```

Newest-first (`unshift`), capped at `MAX_ENTRIES = 2000`. Every write dispatches a
`window` event `nook-activity-updated` so `ActivityLogView` live-reloads without
polling. **The activity log is write-only from the app's perspective** — reads live
entirely inside `ActivityLogView`; never route it through `App.jsx` state. Entries with
`module: 'vault'` from the removed tab still render (label "Saved Logins", no link).

### Chat message (`nook_chat_history`)

```js
{ id: genId(), role: 'user' | 'assistant', text, createdAt: '<ISO>' }
```

Oldest-dropped at 200. Only the last 20 turns are sent to Claude per request.

---

## ID generation — two deliberately different formats

- `utils/id.js → genId()` = `Date.now().toString(36) + Math.random().toString(36).slice(2)`.
  Used for tasks, calendar events, trackers, links, countdowns, chat messages, etc.
  (`NotesView` uses `Date.now().toString()`; habits use the same base36 recipe inline.)
- `utils/activityLog.js` uses a **hyphenated** `${Date.now()}-${rand}` format on
  purpose. It is **not** consolidated with `genId()`.

## Date anchoring — two conventions (do not merge)

- **`utils/date.js → todayStr()` / `localDateStr()`** produce the **local**
  calendar date. Used almost everywhere (habits, journal, countdowns, pickers).
- **`trackers/trackerUtils.js → todayStr()`** is **UTC-based**
  (`toISOString().split('T')[0]`). Intentionally distinct; different call sites
  depend on the difference.
- Date strings elsewhere are anchored at **local noon** (`new Date(ds+'T12:00:00')`)
  as a DST guard.
- **Google Tasks payloads** are the lone exception, anchored at **midnight UTC**.

Full explanation in [08-conventions-and-gotchas.md](08-conventions-and-gotchas.md).
