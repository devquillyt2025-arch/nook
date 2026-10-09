# Nook — Complete Overview

This folder is the **full reference for the Nook app**. It is written so that
someone who has never seen the code can rebuild Nook from scratch, and so that
someone maintaining it understands every moving part and the reasons behind the
non-obvious decisions.

Nook is a **personal productivity workspace** — a single-page app that bundles
tasks, a calendar, habits, a journal, notes, a focus timer, analytics, reminders,
links, countdowns and an activity log into one interface. Its defining
architectural choice: **all real user data lives in the browser's `localStorage`,
and the UI reads it synchronously** — the app is fully usable with no network and
no account. When Supabase is configured and you are signed in, a sync layer
*mirrors* that data across your devices (per item, last-write-wins) and a few
server-side jobs run for things a client-only app physically cannot do (fire a
reminder while the tab is closed, hold an OAuth secret, run scheduled Drive
backups, call an LLM with a private key). Cloud is always an addition to
localStorage, never a replacement.

> **Read [01-architecture.md § Auth status](01-architecture.md#auth-status--read-this-first)
> before relying on sign-in.** The app is not login-gated (`AuthGate` is not mounted in
> `main.jsx`); sign-in is **optional and lives in Settings → Connections**, and nothing
> cloud-backed (sync, reminders, push, Drive backup, voice/chat) activates until someone
> signs in there.

---

## How to read this

| Doc | What it covers |
|---|---|
| [01-architecture.md](01-architecture.md) | The core model: localStorage-as-truth, the layers around it, state ownership in `App.jsx`, **auth status**, cross-tab behaviour, background work |
| [02-data-model.md](02-data-model.md) | **Every** localStorage key — what owns it, whether/how it syncs — and the exact shape of every entity |
| [03-tabs-and-features.md](03-tabs-and-features.md) | The 13 tabs, what is live vs hidden vs legacy, per-tab behaviour, shared widgets, navigation |
| [04-google-sync.md](04-google-sync.md) | Google Tasks + Google Calendar two-way sync, and how it coexists with the Supabase task sync |
| [05-backend.md](05-backend.md) | Supabase: every table and migration, RLS, the 6 edge functions, Web Push, backup, all env vars |
| [06-ui-and-styling.md](06-ui-and-styling.md) | Theming, CSS conventions, the sidebar rail, themed select/date/time controls, popups, icons |
| [07-build-and-setup.md](07-build-and-setup.md) | Rebuild from zero: dependencies, env, scripts, migrations, deploy, repo layout notes |
| [08-conventions-and-gotchas.md](08-conventions-and-gotchas.md) | The traps — things that are expensive to re-derive and easy to get wrong. Read before touching dates, storage keys, sync/backup files, or the cross-device sync layer. |
| [09-cross-device-sync.md](09-cross-device-sync.md) | How notes, journal, links, settings… sync across devices: the `synced_items` table, the engine, the rules views must follow |
| [10-ai-voice-chat.md](10-ai-voice-chat.md) | Voice commands, the Claude Chat tab and the Gemini AI assistant — all currently **hidden** — how they work and how to re-enable them |
| [11-testing-and-verification.md](11-testing-and-verification.md) | What `npm test` covers, and how to verify changes by driving the real app (gate-free and signed-in) |

---

## Tech stack at a glance

- **React 18.3** + **Vite 5** — plain JS/JSX, **no TypeScript**, no ESLint config.
- **framer-motion** — page/tab transitions and micro-interactions.
- **chart.js** + **react-chartjs-2** — the Reports charts.
- **@supabase/supabase-js** — auth, cross-device sync, Realtime, edge-function calls
  (all optional; the app runs fully without it).
- **canvas-confetti** (CDN in `index.html`), **html2canvas**, **jszip** — confetti,
  image export, backup `.zip` + journal `.docx` export.
- **vitest** — `npm test`. **@electric-sql/pglite** (dev) runs the real SQL migration
  in-process for the sync tests. **playwright** (dev) is used for manual/browser
  verification; there is no checked-in Playwright config or suite.
- **Scripts:** `npm run dev | build | preview | test`.
- **Backend:** Supabase (Postgres + RLS + Realtime + Deno edge functions). No server of
  our own. (A Hono + Neon server was tried and removed — see
  [09-cross-device-sync.md](09-cross-device-sync.md#why-a-supabase-table-and-not-a-separate-server).)

## Repo layout at a glance

```
index.html              App entry; registers /sw.js; loads fonts + confetti
vite.config.js          Vite config (also copies nook-favicon.png into public/ and src/ on load)
public/                 manifest.json, icons, sw.js (offline cache + Web Push)
src/
  main.jsx              Mounts <ErrorBoundary><App/></ErrorBoundary>  (no AuthGate; optional sign-in is in Settings — see 01)
  App.jsx               ~2100 lines. Holds most state; routes the 13 tabs; starts sync.
  index.css             The entire stylesheet (~8600 lines).
  habitsStore.js        Habits data layer (nook_habits).
  components/           One file per view + shared widgets (see 03). ~45 files.
  utils/                Auth, Supabase services, Google sync, cross-device sync, backup,
                        reminders, notifications, dates, ids, activity log, voice/chat/AI.
  trackers/             Tracker data + the Reports analytics maths.
supabase/
  functions/            6 Deno edge functions (see 05).
  migrations/           0001 … 0012. 0012 = the generic cross-device sync table.
nook-overview/          This documentation.
landing/                SEPARATE Next.js marketing site — OFF-LIMITS for app changes.
```

Root-level extras you may trip over (none are part of the app): `nook_mobile_audit.md`
(a one-off mobile responsiveness audit), `style.css` (an old stylesheet nothing
imports), `vite.sandbox.config.js` (machine-local scratch config pointing at a temp
dir), `nook-favicon1.png`, `test-results/` (empty).

> **`landing/` is a standalone Next.js marketing app.** It shares nothing with the SPA
> except a *planned* SSO token handoff (see [05-backend.md](05-backend.md)) that is
> currently dead because `AuthGate` (the thing that consumes it) is not mounted. Do not
> change app behaviour there.

---

## The one-paragraph mental model

`App.jsx` loads every localStorage-backed slice synchronously into React state on
mount, passes it down as props, and writes each slice back with a `useEffect` on
change. Each tab is a `lazy()`-loaded view. A thin observer on `localStorage` mirrors
changed items to Supabase and merges other devices' changes back in; tasks and habits
use their own typed Supabase services instead. Cloud features are **additive** — if
Supabase is unconfigured, nobody is signed in, or the network is down, every cloud
helper early-returns and the app is fully usable. That single rule (local-first,
cloud-optional) explains almost every design decision in the codebase.
