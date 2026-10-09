# 07 — Build & Setup (rebuild from zero)

This is the practical "stand it up from nothing" guide.

## 1. Bootstrap the project

```bash
npm create vite@latest nook -- --template react   # React + Vite, plain JS
cd nook
npm install
```

Then install what Nook actually uses:

```bash
npm install @supabase/supabase-js chart.js react-chartjs-2 framer-motion \
            canvas-confetti html2canvas jszip
npm install -D vitest @electric-sql/pglite playwright
```

`vitest` runs `npm test`; `@electric-sql/pglite` is a real Postgres in-process that the
sync tests apply the migration to; `playwright` is for manual browser verification (no
Playwright config or suite is checked in — see [11](11-testing-and-verification.md)).

`package.json` scripts are the entire surface:

```json
{ "scripts": { "dev": "vite", "build": "node ./node_modules/vite/bin/vite.js build",
                "preview": "vite preview", "test": "vitest run" } }
```

There is **no TypeScript and no ESLint.** `main.jsx` uses the automatic JSX runtime; no
file imports `React` directly. Vitest reads `vite.config.js` (so `.jsx` and the React
plugin just work); there is no separate `vitest.config`.

## 2. `index.html` responsibilities

- `theme-color` meta `#0d1117`; favicon links (`favicon-32.png`, `nook-favicon.png`) and
  `apple-touch-icon.png`.
- Load **Inter** + **Newsreader** from Google Fonts.
- `<link rel="manifest" href="/manifest.json">` — standalone display, `theme_color
  #6366f1`, SVG icons (`public/`).
- Mount point `<div id="root">` + `<script type="module" src="/src/main.jsx">`.
- **Register the service worker** on load:
  ```html
  <script>
    if ('serviceWorker' in navigator)
      window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(()=>{}));
  </script>
  ```
- Load **canvas-confetti** from CDN (`cdn.jsdelivr.net`).

## 3. `main.jsx` composition

```jsx
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary title="Nook hit an unexpected error"
                   message="Your data is safe in local storage — refreshing the page usually resolves this.">
      <App />
    </ErrorBoundary>
  </StrictMode>
);
```

Plus `window.addEventListener('error' / 'unhandledrejection', …)` loggers so non-React
exceptions don't vanish, and `import './index.css'`.

> **`AuthGate` is not in this tree today** (bypassed since `6d76bfa`); sign-in is optional
> and lives in Settings → Connections (`AccountSignIn`). To require sign-in instead, wrap the
> app: `<AuthGate><App /></AuthGate>`. See
> [01-architecture.md § Auth status](01-architecture.md#auth-status--read-this-first).

## 4. Build the data layer first

The app is only as good as its storage contract. Implement, in this order:
1. `utils/id.js`, `utils/date.js`, `utils/activityLog.js` — primitives.
2. `App.jsx` load→state→persist loop for the App-owned slices (`SK` map).
3. Feature stores that own their own keys: `habitsStore.js`, `utils/notesStore.js`,
   `trackers/trackerUtils.js`, and the per-view keys (links, countdowns, journal).

Match the **exact key names and entity shapes** in
[02-data-model.md](02-data-model.md) for data compatibility with existing Nook data.

## 5. Run WITHOUT the cloud (the default path)

With no `VITE_SUPABASE_*` set, `isAuthConfigured` is false and every cloud helper
no-ops. **The whole app works offline, no account.** This is the mode to build and
test in first.

```bash
npm run dev      # http://localhost:5173
```

> **Gate-free verification** — if your `.env.local` has `VITE_SUPABASE_*`, run with an
> `envDir` pointed at a directory holding an *empty* `.env` so those vars are absent.
> Do not edit or move the real `.env.local`. (With today's `main.jsx` there is no login
> gate to bypass, but the sync layer, Supabase services and the Chat/voice entry points
> all key off `isAuthConfigured`, so an empty env is still how you get "pure local".)

## 6. Add the cloud layer (optional)

Needed for: reminders while the tab is closed, **cross-device sync of everything**,
Google Tasks/Calendar sync, Web Push, scheduled Drive backups, and the Claude features.
See [05-backend.md](05-backend.md) for schema and functions. Steps:

1. Create a Supabase project. Apply **every** migration in `supabase/migrations/` in
   order: `0001, 0003, 0004, 0006, 0007, 0008, 0009, 0010, 0011, 0012` (the gaps are
   intentional). `0012` is the cross-device sync table; nothing syncs without it.
2. Set client env in `.env.local`:
   ```
   VITE_SUPABASE_URL=...
   VITE_SUPABASE_ANON_KEY=...
   VITE_GOOGLE_CLIENT_ID=...        # optional: Google integrations
   VITE_VAPID_PUBLIC_KEY=...        # optional: Web Push
   ```
   (`VITE_GEMINI_API_KEY` is read by the hidden Gemini assistant but **should not be set**
   — it would be shipped in the bundle; see 05/10.)
3. Deploy the six edge functions with the correct JWT flags:
   ```bash
   supabase functions deploy google-oauth          # verify jwt (default)
   supabase functions deploy connect-drive         # verify jwt (default)
   supabase functions deploy drive-backup          # verify jwt (default)
   supabase functions deploy parse-voice-command   # verify jwt (default)
   supabase functions deploy chat-with-claude      # verify jwt (default)
   supabase functions deploy send-task-reminders --no-verify-jwt
   ```
4. Set the **server-only** secrets (never `VITE_`): `GOOGLE_CLIENT_SECRET`,
   `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `CRON_SECRET`, `ANTHROPIC_API_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (auto), plus optional `RESEND_API_KEY` /
   `RESEND_FROM` / `SITE_URL`.
5. Store the cron secret in Vault and enable the pg_cron schedule (`0003`).
6. Generate a VAPID key pair; the public half is `VITE_VAPID_PUBLIC_KEY`, the private half
   is the function's `VAPID_PRIVATE_KEY`.
7. **Sign in** from Settings → Connections (the form appears once `VITE_SUPABASE_*` is set;
   see 01 § Auth status). Until a session exists none of the above activates. The account
   must already exist or be created from that form; Supabase Auth → Providers must have Google
   enabled for "Continue with Google" to work, and there is no in-app password reset.

## 7. Build & deploy

```bash
npm run build      # outputs to dist/  (git-ignored)
npm run preview    # serve the build locally
```

Deploy `dist/` as a static site (any static host). The service worker and manifest
must be served from the site root. `vite.config.js` also copies `nook-favicon.png` into
`public/` and `src/` whenever the config loads (dev **and** build) — harmless when the
files are identical, but it is why `git status` can show those two as modified.

> **`vite build` passing is NOT sufficient verification.** It type-checks nothing
> (no TS, no lint) and will happily build a `ReferenceError` that throws only at
> render time. Always verify by driving the real app, and run `npm test`
> ([11](11-testing-and-verification.md)).

## Security notes for a rebuild

- **Don't store credentials in localStorage.** The old Saved Logins tab did, in
  plaintext, and was removed; leftover `nook_vault` data in an existing browser is still
  plaintext (see [02](02-data-model.md)). If a credential store is ever reintroduced it
  needs real client-side encryption, not a "convenience" label. Anything in
  `synced_items` is readable by anyone with database access (RLS, not encryption).
- **Never put a secret behind a `VITE_` prefix** — Vite inlines those into the
  shipped bundle, exposing them to every user. Client secrets (Google client
  secret, VAPID private key, cron secret, service role key, Anthropic key) belong only
  in edge function env. (`VITE_GEMINI_API_KEY` is the existing violation — don't use it.)
- RLS is the only thing protecting Supabase rows — keep every table's policies
  scoped to `auth.uid() = user_id`.
- Turn on **leaked-password protection** in Supabase Auth if you use email/password.

## Repo hygiene

- **`landing/` is a separate Next.js app and is off-limits for SPA changes.**
- Commit per tab (`type(scope): summary`) so a bad change is bisectable; never
  force-push.
- `dist/`, `node_modules/`, `.env*`, `*.local`, `.mcp.json` (holds a Supabase access
  token) and `supabase/.temp` are git-ignored.
- Root clutter that is **not** part of the app: `nook_mobile_audit.md` (a one-off
  responsive audit), `style.css` (an old stylesheet nothing imports),
  `vite.sandbox.config.js` (a machine-local scratch config with a hard-coded temp path),
  `nook-favicon1.png`, an empty `test-results/`.
