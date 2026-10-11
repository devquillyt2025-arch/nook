# 05 — Backend (Supabase)

Nook has **no server of its own for your content** — the UI always reads
`localStorage`. Supabase does two jobs:

1. **The things a client-only app can't do** — fire a reminder while the tab is closed,
   keep an OAuth client secret (or an LLM API key) off the client, deliver Web Push,
   run scheduled Drive backups.
2. **Cross-device sync** of the user's content — typed `tasks` / `habits` tables, plus
   one generic `synced_items` table for everything else (below, and in full in
   [09-cross-device-sync.md](09-cross-device-sync.md)).

Everything here is **optional**: with `VITE_SUPABASE_*` unset, every helper below
early-returns. **And it only acts when a session exists.** With Supabase configured the app
is login-gated (`AuthGate` in `main.jsx` shows the login page until someone signs in) — see
[01-architecture.md § Auth status](01-architecture.md#auth-status--read-this-first).

`utils/authClient.js`:
```js
export const isAuthConfigured = Boolean(
  import.meta.env.VITE_SUPABASE_URL && import.meta.env.VITE_SUPABASE_ANON_KEY
);
```

---

## Migrations (`supabase/migrations/`) — apply in order

Numbers `0002` and `0005` were never used; the sequence has gaps, not missing files.

| File | Adds |
|---|---|
| `0001_reminders.sql` | `reminders`, `push_subscriptions`, RLS, and the shared `set_updated_at()` trigger function |
| `0003_schedule_reminders.sql` | `pg_cron` + `pg_net` schedule that calls `send-task-reminders` every minute |
| `0004_notification_prefs.sql` | `notification_prefs` |
| `0006_drive_backup.sql` | `drive_backup`, `backup_runs`, the Vault-backed token functions |
| `0007_push_failure_tracking.sql` | `push_subscriptions.consecutive_failures` |
| `0008_tasks.sql` | `tasks`, `upsert_tasks()`, Realtime publication |
| `0009_habits.sql` | `habits`, `upsert_habits()`, Realtime publication |
| `0010_upsert_reminders.sql` | `upsert_reminders()` — backup-wins bulk restore of reminders |
| `0011_restore_and_null_updatedat_guard.sql` | NULL-safe LWW guard for tasks/habits (and a repair of frozen rows); `restore_tasks()` / `restore_habits()` |
| `0012_synced_items.sql` | `synced_items`, `upsert_synced_items()`, Realtime publication — the generic cross-device sync store |

All tables have **Row-Level Security** enabled; policies scope every row to
`auth.uid() = user_id`, so client reads never need an explicit `user_id` filter.

## The tables

### `reminders` — `0001_reminders.sql`
When/where to fire a notification for a task or calendar event. **Not** a copy of
the task.
```
id, user_id,
source_type text check in ('task','calendar'),
source_id text,                     -- the localStorage task id or gcal event id
title text,                         -- snapshot for the notification payload
target_at timestamptz,              -- the due/start time
reminder_at timestamptz,            -- when to fire
reminder_offset_minutes int null,   -- non-null = computed as target_at - N min
reminder_sent boolean default false,
created_at, updated_at,
unique (user_id, source_type, source_id)   -- one reminder per task/event
```
Partial index `idx_reminders_due on (reminder_at) where reminder_sent=false` — the
cron function's hot query.

### `push_subscriptions` — `0001` + `0007`
Web Push endpoints, one per device.
```
id, user_id, endpoint (unique), p256dh_key, auth_key, device_label,
consecutive_failures int default 0,   -- added 0007; stop retrying dead endpoints
created_at
```

### `notification_prefs` — `0004`
```
user_id (pk), email_reminders_enabled boolean default false, updated_at
```
Push opt-in is implied by the existence of a `push_subscriptions` row, so it needs
no column here.

### `drive_backup` — `0006`
Per-user scheduled-backup settings. **The Google refresh token is never stored
here in plaintext** — it lives in Supabase **Vault**; this table holds only the
Vault secret's id.
```
user_id (pk), frequency check in ('off','daily','weekly') default 'off',
drive_folder_id, refresh_secret_id uuid, last_backup_at, last_status, last_error,
updated_at
```
Two `SECURITY DEFINER` functions (`set_drive_refresh_token`,
`get_drive_refresh_token`) are the **only** way to touch the token, and are granted
to `service_role` only.

### `backup_runs` — `0006`
Audit trail: `id, user_id, ran_at, status ('success'|'error'), file_name, counts
jsonb, error`. Users can read their own rows; only the edge function (service role)
inserts.

### `tasks` — `0008` (+ `0011`)
The cross-device copy of `nook-tasks`. Task-field columns are **quoted camelCase so they
match the JS object 1:1** (no hand-maintained field map that could silently drop
`googleTaskId`, `lastSyncedAt`, `syncConflict` or `updatedAt`). PK `(user_id, id)` —
client ids are `genId()` strings, not uuids, so scoping the key by user removes a
cross-user collision class. `deleted_at` is a soft-delete tombstone. The app's
`"updatedAt"` (drives last-write-wins) is **kept distinct** from the audit
`created_at`/`updated_at` columns, which a trigger bumps on every server write and so
must never be used for LWW. Writes go through `upsert_tasks(p_tasks jsonb)` — an atomic,
LWW-guarded bulk upsert whose guard is NULL-safe since 0011 (a NULL `updatedAt` used to
freeze a row so it could never be updated or deleted again). **Callers must send full
rows**: the RPC maps each object with `jsonb_populate_record`, which nulls any absent
column. `restore_tasks()` is the backup-wins variant used by import (clears tombstones;
never deletes). In the `supabase_realtime` publication.

### `habits` — `0009` (+ `0011`)
Same design as `tasks`: `upsert_habits()`, `restore_habits()`, soft delete, quoted
camelCase columns, `frequency` as `jsonb` (it is a string *or* a number array),
`completions` merged by pure LWW (a completion ticked on another device inside the same
offline window can be lost — a decided trade-off). Habits originally had no `updatedAt`;
the client now stamps it on every write and the one-time migration backfills it.

### `synced_items` — `0012_synced_items.sql`
Generic per-item sync store for every tab that isn't tasks/habits/reminders.
```
user_id, collection text, id text, data jsonb,
"updatedAt" timestamptz   -- client edit time; drives last-write-wins
deleted_at timestamptz    -- soft-delete tombstone ({} data)
created_at, updated_at    -- updated_at = DB clock (trigger); the pull cursor
PK (user_id, collection, id)        RLS: auth.uid() = user_id
```
Writes go through `upsert_synced_items(p_items jsonb)` — atomic LWW
(`ON CONFLICT … WHERE excluded."updatedAt" > s."updatedAt"`), returning per item
`accepted` plus the server's row when a newer version already existed. Edit times are
clamped to server `now() + 5 min` (a wrong device clock can't outrank honest edits). It
also hard-deletes log rows beyond 2500 (`activity_log`, `pomo_log`) / 300
(`chat_history`). The table is in the `supabase_realtime` publication. Full design:
[09-cross-device-sync.md](09-cross-device-sync.md).

### Scheduling — `0003_schedule_reminders.sql`
Uses `pg_cron` + `pg_net` to `POST` the `send-task-reminders` function **every
minute**. The cron secret is stored via Supabase Vault (`vault.create_secret(...,
'cron_secret')`), never in the migration file, and passed as an `X-Cron-Secret`
header.

> **Applying a migration is a manual step** (SQL editor, `supabase db push`, or the
> Supabase MCP). Until `0012` is applied, cross-device sync pushes fail quietly and
> Settings → Connections shows "Couldn't reach the server — N changes waiting"; the
> app itself is unaffected.

---

## The 6 edge functions (`supabase/functions/<name>/index.ts`, Deno)

| Function | Trigger | JWT | Purpose |
|---|---|---|---|
| `google-oauth` | Browser `functions.invoke` | **verify** | Server-side Google OAuth token exchange/refresh for **Tasks & Calendar**. Holds `GOOGLE_CLIENT_SECRET`; returns tokens to the client (which stores them in localStorage). Grants: `authorization_code` and `refresh_token`. |
| `connect-drive` | Browser `functions.invoke` | **verify** | One-time Drive "offline access" consent exchange (`scope=drive.file`, `access_type=offline`). Stores the long-lived refresh token in Vault; it **never** returns to the client. |
| `drive-backup` | Browser (client builds the backup from localStorage and POSTs it) | **verify** | Mints a fresh Drive access token from the Vault refresh token, ensures a "Nook Backups" folder, uploads `nook-backup-<date>.json`, prunes to newest 7, records a `backup_runs` row. Payload is forwarded to Drive, never persisted in Supabase. |
| `send-task-reminders` | `pg_cron` via `pg_net`, every minute | **--no-verify-jwt** (gated by `X-Cron-Secret`) | Finds due unsent reminders, delivers via push (if a subscription exists) and/or email (if `email_reminders_enabled`), independently, marks them sent. Deletes expired push endpoints (404/410/401/403). Uses `web-push` and (optionally) Resend for email. |
| `parse-voice-command` | Browser `functions.invoke` | **verify** | Turns a spoken transcript into one of three structured actions (`add_task` / `complete_task` / `add_note`) via a single Claude tool-use call. **Only parses** — never writes data. See [10](10-ai-voice-chat.md). |
| `chat-with-claude` | Browser `functions.invoke` | **verify** | Plain conversation for the Chat tab. No tools, no side effects; last 20 turns, 4000 chars each. See [10](10-ai-voice-chat.md). |

> **Why `google-oauth` and `connect-drive` differ:** both keep the client secret
> server-side, but `google-oauth` *returns* tokens (Tasks/Calendar call
> googleapis.com from the browser), whereas `connect-drive` *keeps* the refresh
> token in Vault (only the server ever needs it for scheduled backups).

The two Claude functions are deliberately separate: the narrow, confirm-gated action
router never grows a second, less-audited entry point via chat.

---

## Web Push & the service worker (`public/sw.js` + `utils/pushSubscription.js`)

- `index.html` registers `/sw.js` on load.
- `sw.js` does two jobs: an **offline app-shell cache** (`nook-v1`, network-first with
  cache fallback; only same-origin `200` responses are stored; precaches `/`,
  `index.html`, the manifest and the two SVG icons) and **Web Push** (`push` shows the notification, `notificationclick`
  focuses/opens a Nook window at the payload `url`, e.g. `/?reminder=task:<id>`, which
  `App.jsx` parses to open that task on its Scheduling tab).
- `utils/pushSubscription.js` subscribes the browser using `VITE_VAPID_PUBLIC_KEY` and
  upserts the endpoint into `push_subscriptions`.
- `send-task-reminders` signs pushes with the VAPID key pair (`VAPID_PUBLIC_KEY` /
  `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT`) and delivers them.
- Local (non-push) notifications for morning/streak/pomodoro use the Notifications API
  directly via `utils/notificationUtils.js` and are scheduled from `App.jsx`.

## Backup / export / import (`utils/backup.js`, `driveBackup.js`, `autoBackup.js`)

- `buildBackup()` serialises **every** `nook-`/`nook_` localStorage key except tokens/
  PKCE/queues into one manifest — `{ schemaVersion: 1, app, exportedAt, userId, counts,
  data: { local, remote: { reminders, notification_prefs } } }` — and `exportBackup()`
  downloads it as a `.zip`. The `nook:` sync-bookkeeping keys and everything under the
  `nook:` prefix are intentionally outside the sweep.
- **Import** (`handleImportData` in `App.jsx`) writes the keys back, restores reminders
  and — when signed in — tasks/habits through `restore_tasks`/`restore_habits`, then
  reloads. With cross-device sync active the import is **additive**: it is merged into
  the account (backup wins for items it contains) and never deletes anything on other
  devices. A rollback export is downloaded automatically first.
- **Reminders and notification prefs are re-fetched from Supabase on export** — they are
  tied to per-user rows, not localStorage.
- `autoBackup.js` enforces the *schedule* client-side (only the browser can read
  localStorage) — `maybeRunAutoBackup()` runs on load and window focus, and when a
  daily/weekly backup is due it invokes `drive-backup` with a freshly built payload.
- A backup still contains any leftover `nook_vault` entries (plaintext) — see 02.

---

## Environment variables

### Client (Vite — `VITE_` prefix, **inlined into the bundle**, so public-safe only)

| Var | Used for |
|---|---|
| `VITE_SUPABASE_URL` | Supabase project URL. Absence ⇒ auth off, all cloud helpers no-op. |
| `VITE_SUPABASE_ANON_KEY` | Supabase anon key. |
| `VITE_GOOGLE_CLIENT_ID` | Public Google OAuth client id (Tasks/Calendar/Drive consent). |
| `VITE_VAPID_PUBLIC_KEY` | Web Push public key. |
| ~~`VITE_GEMINI_API_KEY`~~ | **No longer read.** It was inlined into the public bundle (anyone could read the key). The hidden Gemini assistant now uses only the per-device key typed in Settings (`nook_ai_api_key`, never synced, never in a backup), sent in an `x-goog-api-key` header. If this var was ever set for a build you deployed, treat that key as exposed and rotate it. |

> A `VITE_`-prefixed secret is shipped to every user. The Google **client secret**,
> VAPID **private** key, cron secret, service role key and the Anthropic key are
> therefore **only** ever set as edge-function env — never `VITE_`.

### Edge functions (Deno env, never shipped to client)

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`,
`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `VAPID_PUBLIC_KEY`,
`VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET`, `ANTHROPIC_API_KEY`
(`parse-voice-command`, `chat-with-claude`), `RESEND_API_KEY` (optional),
`RESEND_FROM` (optional), `SITE_URL`.

---

## Security posture

What is enforced, where, and what is deliberately left open. Read this before adding an endpoint, a
third-party script/font, or anything that turns stored text into HTML or a URL.

**Stored data is untrusted.** Anything read back from `localStorage` can have arrived from another device
(sync), a backup file, or the landing app — not only from this user's keyboard.

| Risk | Where it is handled |
|---|---|
| Stored XSS through journal HTML | `utils/sanitizeHtml.js`: `sanitizeJournalHtml()` (DOMPurify + a tag allowlist; `style` limited to a few plain properties) before anything reaches `innerHTML`; `htmlToPlainText()` / `parseHtmlInert()` (DOMParser) wherever text is only *read*. **Never** `div.innerHTML = stored` — an `<img onerror>` fires even on a detached element, and the calendar re-reads every entry. Pasted HTML is sanitised too (`onPaste` in `JournalView`). Notes are plain text and rendered by React, so they are safe. |
| `javascript:` / `data:` URLs | `utils/safeUrl.js`: `openSafeUrl()` / `safeHttpUrl()` — only http(s) is ever opened. The add-link form's `https://` prefix guards only what the form wrote, not what was synced or restored. |
| A backup file planting secrets | `utils/importKeys.js`: import writes only `nook-`/`nook_` keys and never anything containing `token` / `pkce`, nor the sync queues or `nook_ai_api_key`. (The old allowlist missed `nook_gcal_tokens`, which would have pointed Calendar sync at someone else's Google account.) Export applies the same exclusions, so credentials also stay out of Drive backups. |
| Secrets in the public bundle | No `VITE_` secret — see the env table above. `VITE_GEMINI_API_KEY` is no longer read at all; the assistant uses the per-device Settings key, sent in an `x-goog-api-key` header rather than the URL. |
| Third-party script | None. `canvas-confetti` comes from npm (lazy `import()`); the old CDN `<script>` had no SRI and was unused. The service-worker registration is a same-origin file (`public/register-sw.js`), so no inline script exists. |
| Clickjacking, MIME sniffing, referrer leaks | `vercel.json` headers: `X-Frame-Options`, CSP `frame-ancestors 'none'`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`. |
| Injected script / exfiltration | `vercel.json` CSP: `script-src 'self'` (no inline, no eval), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, and a `connect-src` limited to Supabase + the Google APIs the app calls. `style-src` keeps `'unsafe-inline'` (React inline styles); `img-src` allows `https:` (link favicons). |
| Service worker | Ignores non-GET and **cross-origin** requests. A request made *by the worker* is checked against the worker's own `connect-src`, which blocks Google Fonts and favicons — and those blocks never reach the page's `securitypolicyviolation` event, so a clean console is not proof. Notification clicks only navigate same-origin. |
| Database | RLS on every table; RPCs are `SECURITY INVOKER` with a pinned `search_path`, force `user_id := auth.uid()` and raise for an unauthenticated caller. `upsert_reminders`, `restore_*` and `upsert_synced_items` also revoke `anon` execute (`upsert_tasks` / `upsert_habits` keep the default grant and rely on that check — a revoke in a new migration would be tidier). Token functions are `service_role` only. |
| Edge functions | JWT verified on all but `send-task-reminders` (cron secret, compared in constant time; an unset secret never matches). Reminder text and ids are bounded and URL-encoded; the email subject is plain text. The two Claude functions return a generic error, cap the body, and rate-limit per user **best-effort** (in-memory, per isolate — a bound on one client, not a global cap). |

**Changing the CSP.** A new cross-origin endpoint (an API, a CDN, a font host) needs a matching entry in
`vercel.json` or it will be blocked in production while working in `npm run dev`. To test: build, serve it
with the same headers (`vite preview` + `preview.headers` read from `vercel.json`), drive every tab, and
listen for `securitypolicyviolation`. Supabase and Google traffic needs a real project to exercise
(a custom Supabase domain would need adding to `connect-src`).

**Known and deliberate / still open**
- **SSO hash handoff (`AuthGate`) accepts a session from any link** (`#sb_access_token=…`). A crafted link
  can sign a victim into the *sender's* account (login CSRF), after which their data syncs to it. The
  account-switch prompt only protects a browser that has already synced as someone else. Fix options:
  confirm the email being signed in, or bind the handoff to the landing origin (needs the landing app).
  `AuthGate` is a protected file — not changed.
- Edge-function CORS is `*`. Calls are authenticated with a bearer token, not cookies, so this is not
  exploitable on its own; restricting it to `SITE_URL` is defence in depth.
- `chat-with-claude` / `parse-voice-command` are deployed although their UI is hidden — any signed-up
  account can call them. The in-memory limit only slows a single client; a DB-backed counter (or not
  deploying them until the UI ships) is the real fix.
- Supabase Auth: leaked-password protection is off (dashboard toggle). `public.set_updated_at` has a
  mutable `search_path` (migration 0001).
- `synced_items.data` has no size cap; Google and Supabase tokens live in `localStorage`, as in any SPA
  (so XSS prevention above is what protects them).
- `npm audit` still reports Vite 5 / Vitest 3 / esbuild / tinypool — build and test tooling only, nothing
  ships to browsers; clearing them means Vite 8 / Vitest 5 majors. The dev server should not be exposed
  beyond localhost.

## SSO handoff from the `landing/` app

`AuthGate` reads `#sb_access_token=...&sb_refresh_token=...` from the URL hash
(set by the marketing site after login), establishes the Supabase session, then
scrubs the hash. Those custom hash keys deliberately avoid Supabase's native
OAuth/magic-link hash format (handled by `detectSessionInUrl`). Don't rename them
on one side only. Works because `AuthGate` is mounted (it is what consumes the hash).

## Advisor notes (live project, last checked after migration 0012)

Supabase's security advisor reported nothing about `synced_items`. Two pre-existing
warnings: `public.set_updated_at` (from `0001`) has a mutable `search_path`, and
**leaked-password protection is disabled** in Auth settings (a dashboard toggle worth
enabling for email/password accounts).
