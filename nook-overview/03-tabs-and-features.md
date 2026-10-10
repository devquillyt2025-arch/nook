# 03 — Tabs & Features

Nook has **13 tabs**. Tab ids come from `TAB_IDS` in `App.jsx`. The id → label mapping
is **not** 1:1 — two ids read differently in the UI: `daily`→"Today",
`timer`→"Focus". (A "Saved Logins" tab, id `vault`, existed and was removed; a stored
`nook-active-tab` of `vault` falls back to Today.) The active tab is persisted in
`nook-active-tab` so a reload lands where you left off.

| id | Label | Owns | Key files | Storage |
|---|---|---|---|---|
| `daily` | Today | Today at a glance: three charts over the cards you act on (below) | `DailyGoalsView`, `TodayCharts`, `trackers/todayStats.js` | reads tasks, habits, journal, pomodoro log, calendar events, custom categories, weekly reviews |
| `tasks` | Tasks | Tasks, subtasks, scheduling, Google Tasks entry point | `TaskList` (~1800 ln), `AddTaskModal`, `ReminderField` | `nook-tasks`, `nook_task_sort`, `nook_custom_categories` |
| `calendar` | Calendar | Month / Week / Day views, custom events, Google Calendar overlay, an "Inbox" of unscheduled tasks | `CalendarView`, `utils/googleCalendarSync.js` | `nook-calendar-events`, `nook_gcal_*` |
| `habits` | Habits | Habit tracking | `HabitsView`, `habitsStore.js` | `nook_habits` |
| `journal` | Journal | Per-day entries, week/month calendar, `.docx` export | `JournalView` | `nook_journal_<date>`, `nook_journal_icons` |
| `reminders` | Reminders | Supabase-backed reminders (see 05) | `RemindersView`, `utils/reminders.js` | **Supabase only** |
| `notes` | Notes | Rich-text notes + the `NoteModal` editor | `NotesView`, `utils/notesStore.js` | `nook_notes` |
| `timer` | Focus | Pomodoro + focus companion | `Timer`, `FocusCompanion`, `utils/timerTickStore.js` | `nook-pomo-log` (legacy `nook-analytics`) |
| `links` | Links | Bookmarks + categories + favourites | `LinksView` | `nook_links` |
| `countdowns` | Countdowns | Date countdowns, milestones, pinning | `CountdownsView` | `nook_countdowns`, `nook_countdown_pinned` |
| `reports` | Reports | **Read-only** analytics: an Overview and a Detailed Analysis | `ReportsView` → `AnalyticsDashboard` (Overview), `DetailedAnalysis`; maths in `trackers/reportsAnalytics.js` and `trackers/detailedAnalysis.js` | reads habits, tasks, pomodoro log, journal, weekly reviews — and, for the Detailed Analysis, notes, links, countdowns, calendar events, goals, the activity log and custom categories |
| `activity` | Activity Log | Cross-module audit trail | `ActivityLogView`, `utils/activityLog.js` | `nook-activity-log` |
| `settings` | Settings | Profile, notifications, integrations, backup, sync status | `SettingsView`, `utils/backup.js`, `driveBackup.js` | `nook-settings`, `nook-profile-*`, `nook-notif-*`, `nook-theme`, `nook-week-start` |

Every tab's data syncs across devices when signed in (see the **Sync** column in
[02-data-model.md](02-data-model.md)); only Reminders is Supabase-only.

## What is live, hidden, or legacy

Not everything in `src/` is reachable. Know this before "fixing" something that has no
UI:

| Feature | Status | Notes |
|---|---|---|
| 13 tabs above | **Live** | |
| **Chat** tab (`chat`, `ChatView`) | **Hidden** | Lazy-imported and routed in `App.jsx`, but `'chat'` isn't in `TAB_IDS` and its nav entries are commented out ("Hidden for now per user request"). See [10](10-ai-voice-chat.md). |
| **Voice commands** (`VoiceCommandButton`) | **Hidden** | The `<VoiceCommandButton …/>` element beside the search box is commented out. |
| **AI Assistant** panel (`AssistantChat`, Gemini) | **Hidden** | Mounted, but only the commented-out nav entry toggles it. The Settings card "AI Assistant Integration" (API key field) is still visible. |
| **Saved Logins** tab | **Removed** | Leftover plaintext data is surfaced in Settings (see 02). |
| **Trackers** (`nook-trackers`, `AddTrackerModal`) | **Legacy** | Data retained; Reports no longer shows trackers; nothing calls `openAddTracker`. |
| **Daily intentions** editor (`DailyIntentions`) | **Legacy** | Component not imported; `nook-intentions` is still rolled at midnight but nothing displays it (Today used to count it as "events to do" — blank placeholders made that read 3 on a new account). |
| **Goals** (`nook_goals`) | **Legacy** | Nothing creates them and Today no longer shows them (its Goals card was removed); only the Detailed Analysis and the AI context read them. |
| **Keyboard shortcuts modal** (`ShortcutsModal`) | **Unwired** | Never opened (no `setOpenModal('shortcuts')`), and its listed keys (Space, R, 1–4, N, A, S, ?, D) have no handlers. Real shortcuts: `Esc` closes modals/menus, `Ctrl/Cmd+K` opens search (and the journal's entry palette on that tab). |
| `AnalyticsModal`, `TrackerCharts`, `DailyIntentions` components | **Dead** | Not imported anywhere. Kept; deleting a module is a product decision. |

---

## What each tab does

### Today (`daily`)
The landing dashboard, titled "Welcome back, <profile name>", with a one-line summary
(calendar events today, tasks due with how many are overdue, habits due, journal pending).
Below it, three small charts (`TodayCharts.jsx` — plain CSS/SVG, no Chart.js, because this view
is on the main bundle): **Today** (a ring: tasks + habits done out of what was planned today),
**Last 7 days** (stacked bars: tasks and habits completed per day; carries the **Weekly review**
and **Reports →** buttons) and **This week by category** (a ring of tasks completed, by
category). Then the cards you act on: **Tasks** (overdue + due today, or the next 7 days),
**Habits Due**, **Pomodoro Timer**, **Journal** and **Active Streaks**. A Viewing/Editing toggle
switches the Tasks card between a summary and in-place task management. The greeting, the
summary line and that toggle are **pinned** (`.today-head`) with a line under them; everything
below scrolls ([06 § Pinned headers](06-ui-and-styling.md#pinned-headers-sticky-toolbars)). On a
phone the order is the Today ring, the action cards, then the other two charts.

All numbers come from the pure `buildToday()` in `trackers/todayStats.js` (tested). "Today" is the
viewer's **local** day (Reports buckets timestamps by UTC prefix; Today deliberately doesn't).
The 1-second timer value comes from the external tick store so the card re-renders without
re-rendering the app. The previous Today was rebuilt because several cards were wrong — focus
sessions are plain ISO strings but it read `.timestamp` off them (so "focus today" was always 0 and
fell back to the sum of every task's estimate), "This Week" was all-time, "Recent Activity" listed old
completions, and the Goals card's "View All" linked to a tab that doesn't exist. Don't reintroduce
a fallback that shows made-up minutes. `DailyGoalsView` ignores several props `App.jsx` still passes
(trackers, intentions, …); they're harmless.

The **Weekly review** (`WeeklyReviewModal`, opened from the Last-7-days card) works on the real
Habits / Tasks / Focus data with the same maths as Reports; it had been unreachable since Today lost
its button, and still read the legacy trackers. It writes `nook-weekly-reviews`, which Reports shows.

### Tasks (`tasks`)
The largest view. A dashboard grid with a **Pending** card (grouped into
Overdue / Today / Upcoming, each independently scrollable) and a **Completion
Analytics** card. Each task row has a three-dot kebab menu, inline metadata icons
(recurrence, subtasks, notes, time logged, pomodoros, sync conflict), and a detail
panel with three tabs: **Details**, **Scheduling** (due date/time, **Repeat**, reminder),
**Subtasks**. Scheduling edits push instantly to Google via `syncTaskField()` (bypasses
the queue). Recurrence is **local-only** — Nook creates the next occurrence itself.
Deleting a task or clearing completed tasks asks for confirmation. Custom task lists
are stored in `nook_custom_categories`.

### Calendar (`calendar`)
**Month / Week / Day** views (opens on Day) merging **three event sources**: tasks with
a `dueDate`, custom events (`nook-calendar-events`), and live Google Calendar events.
Supports drag-to-reschedule (updates the task's `dueDate`/`time` or the event). An
**Inbox** panel lists unscheduled tasks. Google Calendar events are read live and not
persisted. Deleting a custom event asks for confirmation.

### Habits (`habits`)
Habit tracker (`nook_habits`). Sticky stats/filter header (All / Daily / Weekdays /
Weekends) over a scrollable habit list. Each habit shows a 7-day strip, a 12-week
(84-cell) heatmap, current/best streak, and success rate — all derived in
`habitsStore.js`. Detail/edit modals are centered glass panels; the reminder time uses
the themed `TimeInput`.

### Journal (`journal`)
Per-day rich-text journaling. **One localStorage key per day**
(`nook_journal_<YYYY-MM-DD>`). Left: a contentEditable editor with a pinned
date/day header (autosaves ~1s after you stop typing); right: a metadata panel (mood
badge, word/entry/streak stats, a week/month calendar of entries). **Export** opens a
menu — Day / Week / Month / Year / Custom range — that builds a `.docx` through
`utils/journalDocx.js`; the menu is rendered into `<body>` (see 06) and the custom range
uses the themed date picker. Ctrl/Cmd+K opens an entry search palette. A remote edit of
the day you have open is applied only when you aren't typing in it.

### Reminders (`reminders`)
The **only** tab that is a pure Supabase read/write with no local mirror. Lists
reminders grouped Overdue / Today / Upcoming. **Empty when `isAuthConfigured` is false
or nobody is signed in.** A reminder stores only *when* to fire and *where* to send the
user — the task/event remains the source of truth for its content.

### Notes (`notes`)
Grid of colour-coded rich-text notes with pin + tags, search, tag/colour/date-range
filters and grid/list views. `NoteModal` (a lazy named export of `NotesView`, hosted by
`App.jsx`) is the editor. Includes a one-time content-dedup migration for a specific
historical corruption pattern. Deleting a note asks for confirmation. **Order:** notes are listed
newest-*added* first (`addedAt()` in `utils/notesStore.js` — `createdAt`, falling back to the id),
**not** by last edit, so a note keeps its place when it's opened, edited, recoloured or pinned (a
brand-new note lands first). Don't sort by `updatedAt`: the editor's `handleSave` restamps it on
every close **even if nothing changed** (so merely opening a note used to fling it to the top), and
sync's last-write-wins needs `updatedAt` to keep moving. The Date Range filter still filters on
`updatedAt` (last modified). The toolbar (search,
New Note, colour palette, tags, date range, view toggle, count) is **pinned** (`.nv-bar`) with a
line under it while the notes scroll beneath — the Activity Log pattern, see
[06 § Pinned headers](06-ui-and-styling.md#pinned-headers-sticky-toolbars). It wraps onto a
second row on narrower screens instead of clipping.

### Focus (`timer`)
Pomodoro timer (focus / short / long / custom durations from settings, long break
after 4 focus sessions) plus a `FocusCompanion`. Completed sessions append an ISO
timestamp to `nook-pomo-log`. **The 1-second tick is an external store**
(`utils/timerTickStore.js`) read via `useSyncExternalStore`, so ticking re-renders
only `Timer` / `FocusCompanion` / `DailyGoalsView`, not the whole app. The countdown is
derived from a `timerEndAt` wall-clock delta (not accumulated intervals) so
background-tab throttling can't drift it.

### Links (`links`)
Bookmark manager: categories (a custom dropdown for the filter, the themed `Select` in
the add/edit modal), auto-fetched favicons, and starring favourites. The first screen is
**Groups**: a tile per category (`utils/linkGroups.js` — grouped case-insensitively on the trimmed
category and labelled with the most-used spelling, A–Z, with an *Uncategorised* tile last so links
with no category are never hidden at the top level). A tile opens that category's links under a
"← All groups" breadcrumb; **Grid** and **List** remain the flat all-links views. Typing in search
leaves the tiles (global at the top level, scoped to the open group inside one); *Add Link* from
inside a group starts in that category; a group whose last link is deleted simply disappears (a
filter on a group that no longer exists counts as no filter). The view mode isn't persisted — Links
always opens on the tiles. The toolbar (search,
Add Link, grid/list toggle, category filter, count) is **pinned** (`.lk-bar`) with a line under
it while the links scroll beneath, and wraps onto more rows when narrow
([06 § Pinned headers](06-ui-and-styling.md#pinned-headers-sticky-toolbars)). Favicon lookups
for unknown domains 404 at Google's service — harmless console noise.

### Countdowns (`countdowns`)
Countdown-to-date cards with category colours, priority and milestones; pinned
countdowns surface first. Start/end/milestone dates use the themed `DateInput`. The stat
cards and the filter row are **pinned** together (`.cdp-head`) with a line under them while the
cards scroll beneath ([06 § Pinned headers](06-ui-and-styling.md#pinned-headers-sticky-toolbars)).
At ≤768px only the filter row stays pinned — the stat cards alone are ~230px and scroll away.

### Reports (`reports`)
A **read-only** analytics dashboard (`AnalyticsDashboard`, maths in
`trackers/reportsAnalytics.js`), synthesised from Habits, Tasks, Focus and Journal. A
"This Week / This Month / Custom" range (custom uses two `DateInput`s) drives:
**Period Overview**, **Habit Performance** (consistency, trend vs previous period,
streak history), **Focus & Time**, **Daily Productivity Score**, completions by
category, a 12-week **Consistency Heatmap**, and the **Weekly Review Journal**. A
"Weekly Review" flow (`WeeklyReviewModal`, opened from Today) writes `nook-weekly-reviews`.
There is a print-to-PDF button. `AnalyticsDashboard` registers the Chart.js components
it needs itself (`register()` is idempotent — don't centralise it).

A switch at the top of Reports flips between that **Overview** and a **Detailed Analysis**
(`DetailedAnalysis.jsx`). `ReportsView` owns the time range (`{mode, customStart, customEnd}`,
rendered by `ReportRangeControl`) and hands it to both, so switching keeps the period.
The Detailed Analysis walks every tab over that range, each with the previous same-length
period alongside: **Highlights** (plain-language readouts), **At a glance**, **Tasks**
(created vs completed, overdue, on-time rate, cycle time, category / priority / weekday,
estimated vs logged time), **Habits** (per-habit consistency with streaks and trend, weekday
and time-of-day patterns, perfect days, needs-attention), **Focus** (by day / hour / part of
day, streaks), **Journal** (words, coverage, streaks, mood), **Notes, links & countdowns**,
**Calendar** (custom events + goals), **Activity**, **Productivity score**, **Weekly
reviews**, and **All time** (ignores the range). All the maths is the pure
`buildAnalysis()` in `trackers/detailedAnalysis.js`; it reuses `reportsAnalytics.js` for every
number the Overview also shows, so the two can't disagree (one deliberate difference: the
Analysis prints focus time as `4h 10m` where the Overview prints `4.2h`). Notes:
- It reads the non-prop slices straight from localStorage (`loadAnalysisSources`) and
  re-reads them through `useSyncApplied` when another device's change lands.
- Ranges over 731 days are clamped to the most recent 731 (flagged in the header) — anchored on
  *today*, not on a custom end date that's still in the future, and never reaching back before the
  start that was picked; anything over 45 days is bucketed weekly so charts stay readable.
- Dates are read strictly as `YYYY-MM-DD` (`ymd` / `isoDay` in `detailedAnalysis.js`): a malformed
  due date, countdown end date or timestamp counts as "no date" instead of turning into `NaN`
  ("NaN days late"). A countdown with no usable end date is counted but never placed on the timeline.
- The **Productivity score** section shows an empty state until there's something to score:
  `dailyScoreH` otherwise awards 50 free habit points to every day with no habits scheduled.
- Journal "entries" use the Overview's rule (non-empty after stripping tags), so an
  `&nbsp;`-only day counts as an entry with zero words.
- Task / focus timestamps are bucketed by their ISO **date prefix** (UTC), exactly as the
  Overview does — near local midnight a session can land on the neighbouring day. Hour-of-day
  uses the local hour.
- Chart.js can't resolve `var(--x)` on a canvas, so the Detailed Analysis reads its chart
  colours from the live theme (`themeColors()`); it registers its own Chart.js components too.
  `ReportsView` is memoised and `App.jsx` only flips `data-theme` on the root, so the view
  re-renders on that attribute (`useThemeVersion`) — otherwise a theme toggle from the sidebar would
  leave the axis / grid colours on the old theme. List keys include the position: labels repeat
  (two reviews on one day, a custom task list named "Work").

### Activity Log (`activity`)
Cross-module audit trail (`nook-activity-log`): filter by module / status / date range,
search, paginate, **Clear** (type `DELETE` to confirm) with a 10-second **Undo**.
Live-reloads on the `nook-activity-updated` window event and cross-tab `storage` events,
throttled to once per 1.5s, and on `nook-sync-applied` when another device's entries
arrive. Read-only from the app's perspective.

### Settings (`settings`)
A grid of cards, **Account first** (only when Supabase is configured: "Signed in as … /
**Sign out**" — signing out lands on the login page), then
**Profile** (name/email/avatar), **Connections** (a status row per integration: Account,
**Cross-device sync** with a *Sync now* button, Google Tasks, Google Calendar, Drive backup,
Push, Email reminders), **Notifications** (master +
morning briefing time/streak/pomo toggles), **Google Tasks Sync**, **Google Calendar
Sync**, **AI Assistant Integration** (the Gemini key — see 10), **App Preferences**
(theme, week start, timer presets and durations), **Data Management** (export/import backup, Drive backup
schedule, "Clear Local Data", and the leftover-saved-logins notice), and an About card.
**Log out** sits below the grid (shown only while signed in; the Account card has a **Sign out**
button too).

---

## Shared widgets / components (not tabs)

| File | Role |
|---|---|
| `SidebarSearch.jsx` | Command-palette search (Ctrl/Cmd+K) across tasks, habits, notes, countdowns, journal, links. Exports `useNookSearch`, `ResultsList`. |
| `SidebarFlyout.jsx` | Flyout menus off the collapsed icon rail; `useIsRail()` watches `.main-nav` class via `MutationObserver`. |
| `Select.jsx` | Themed dropdown — **use instead of `<select>`**. |
| `DateInput.jsx` / `TimeInput.jsx` | Themed date / time fields — **use instead of `<input type="date\|time">`**. Open `CalendarDatePicker` / `TimePicker` through `FloatingPopover`. |
| `CalendarDatePicker.jsx` / `TimePicker.jsx` | The popup calendar and scroll-wheel time picker themselves. |
| `FloatingPopover.jsx` | Renders a popup into `<body>`, positioned from its trigger, so nothing can clip it. See 06. |
| `ReminderField.jsx` | Reminder picker used by tasks (writes to Supabase `reminders`). |
| `Stats.jsx` | Small stat tiles (pomodoro/day summaries), shown on the Focus tab. |
| `WeeklyReviewModal.jsx` | Weekly review flow (`nook-weekly-reviews`). |
| `AddTaskModal.jsx` | Task creation modal. (`AddTrackerModal.jsx` is legacy.) |
| `VoiceConfirmModal.jsx` | Confirm-before-commit dialog for a parsed voice command (hidden feature). |
| `ErrorBoundary.jsx` | Top-level render-error recovery. |
| `AuthGate.jsx` / `AuthPage.jsx` | The login wall: `AuthGate` (mounted in `main.jsx`) shows `AuthPage` (sign in / create account / forgot / Google) when there is no session, consumes the `landing/` SSO handoff, and is offline-safe (see 01). Protected files. |

## Navigation structure (desktop rail)

Defined by three inline arrays in the `<nav className="main-nav">` block of
`App.jsx`, each under a `.nav-section-label` (rendered UPPERCASE via CSS), with dividers
before More and Utility. Settings is pinned at the bottom, outside the sections.

- **Main:** Today, Tasks, Calendar, Habits, Journal, Reminders, Notes
- **More:** Focus (`timer`), Links, Countdowns *(a commented-out "AI Assistant" entry lives here)*
- **Utility:** Reports, Activity Log

Only Main rows carry badges (`daily`→ unlogged-today count, `tasks`→ incomplete
count). The **mobile bottom nav** (Today, Tasks, Journal, Habits + More) is a
**separate hardcoded list**, and the **More drawer** (`MobileMoreModal`: Notes,
Calendar, Reminders, Links, Countdowns, Focus, Reports, Activity Log, Settings, plus
search) is a third list — neither follows the desktop arrays. On screens ≤768px the
desktop rail is `display:none` regardless of open/rail state. See
[06-ui-and-styling.md](06-ui-and-styling.md) for the sidebar rail mechanics.
