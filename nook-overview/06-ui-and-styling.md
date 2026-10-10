# 06 — UI & Styling

## One stylesheet

The entire app is styled by a single **`src/index.css`** (~8600 lines), imported
once in `main.jsx`. There is **no CSS framework, no CSS modules, no Tailwind, no
preprocessor.** Alongside the class-based styles, **inline `style={{}}` objects are
idiomatic** and used heavily — repeated inline style objects are accepted here and
should not be hoisted into shared constants.

## Theming (CSS custom properties + `data-theme`)

Colours are CSS variables on `:root`. The app ships **dark by default**; a light
theme overrides the same variables under `:root[data-theme="light"]`. The theme
choice is stored in `localStorage.nook-theme` and applied by stamping
`data-theme` on the root element.

Representative tokens (dark):
```css
:root {
  --bg-base:      #0a0a0a;
  --text-primary: #f5f5f5;
  --accent:       #7869fc;   /* Nook purple */
  /* …plus --bg-elevated, --bg-input, --bg-hover, --border, --border-strong,
     --text-secondary, --text-muted, --text-faint, --accent-glow, color-* etc. */
}
:root[data-theme="light"] { --bg-base: #f9fafb; --text-primary: #222; /* … */ }
```

When adding UI, use existing variables (`--bg-hover`, `--jnx-line`, `--accent`,
etc.). A few tokens referenced in old code (`--surface-2`, `--border-soft`) are
**never actually defined** — don't rely on them.

## Fonts

Loaded from Google Fonts in `index.html`: **Inter** (UI) and **Newsreader**
(serif display, used for journal/day headings). `theme-color` meta is `#0d1117`.

## Animation

**framer-motion** drives tab transitions (`AnimatePresence` around the active tab
in `App.jsx`), modal/popup enter-exit, and small entrance/stagger animations (e.g.
journal metadata via `variants`). Note the tab wrapper uses an **opacity-only** transition on purpose:
animating `y` leaves an inline transform that becomes a containing block and breaks
`position:sticky` descendants. **canvas-confetti** (CDN in `index.html`) fires on
celebratory moments.

## The sidebar rail (added version5)

The sidebar is an **always-mounted icon rail**, not a mount/unmount toggle:

- `sidebarOpen` (App state) persists to `localStorage.nook-sidebar-open`.
- `true` → full 240px sidebar; `false` → 60px icon-only rail (`.main-nav--rail`).
- The `.app` root gets `.sidebar-open` or `.sidebar-rail`; both drive `margin-left`
  on `.app-body` via `--sidebar-width` (240px) / `--sidebar-rail-width` (60px).
- `nook-sidebar-open` is in `CROSS_TAB_IGNORE_KEYS` — a UI preference, so toggling
  it must not fire the cross-tab data-changed banner.
- `useIsRail()` in `SidebarFlyout.jsx` watches `.main-nav`'s class list with a
  **`MutationObserver`** (not a media query) so the search trigger collapses in
  sync with the JS toggle.
- CSS-only tooltips: `data-tooltip` + `::after` pseudo-element with
  `transition-delay: 0.3s`.
- **Mobile (≤768px):** `.main-nav` is `display:none` regardless of state; the
  mobile bottom nav handles navigation. Do not change this.

See [03-tabs-and-features.md](03-tabs-and-features.md) for the nav section arrays.

## Selects, dates and times — themed controls only

The browser draws native `<select>` lists and `<input type="date|time">` popups itself, and
they ignore the app theme. So Nook has none: every dropdown, date and time field is one of

| Need | Use | Notes |
|---|---|---|
| Dropdown | `components/Select.jsx` | `options=[{value,label,color?}]`; `onChange` gets `{ target: { value } }` |
| Date | `components/DateInput.jsx` | drop-in for `<input type="date">`: `value` `'YYYY-MM-DD'`, `min`/`max`, `required`; opens `CalendarDatePicker` |
| Time | `components/TimeInput.jsx` | drop-in for `<input type="time">`: `value` `'HH:MM'`; opens the scroll-wheel `TimePicker`; optional times get a "Clear" |

`DateInput`/`TimeInput` take `className`/`style` on their trigger button, so a field keeps its
existing look (`form-inp`, `cdp-date-display`, …). Their popups render through
`FloatingPopover` — **into `<body>`**, `position: fixed`, placed from the trigger, kept inside the
window and flipped above it when there's no room. Don't render a picker "inline" (absolute inside
its field): modals and scrolling side panels clip that, which is how the Journal export menu's
date popup ended up cut off. A click inside a popup must not count as "outside" for the thing that
opened it — popups carry `data-nk-popover` for outside-click handlers to check (see JournalView's
export menu). `components/themedControls.test.js` fails if a native control is added back.

## Pinned headers (sticky toolbars)

The Activity Log, Notes, Links and Countdowns keep their toolbar on screen with a `border-bottom`
line under it while the content scrolls beneath. The scroll container is **`.tab-content`** (the
page itself, on phones too), so this is plain `position: sticky; top: 0; z-index: 30;
background: var(--bg-base)` on the header — `.al-toolbar`, `.nv-bar` + `.lk-bar` (one shared rule),
`.cdp-head`. To pin another tab's header the same way: add `<tab>-tab-active` to the wrapper in
`App.jsx`, add it to the `padding-top: 0` rule in `index.css`, and give the header the sticky rule.
The traps:

- **Drop the tab shell's top padding** (`.sunsama-tab-transition.<tab>-tab-active { padding-top: 0 }`,
  class added in `App.jsx`'s wrapper `className`). Otherwise the header travels the 32px of padding
  upward before it pins, which reads as "moving on first scroll". The header then supplies its own
  top padding (24px). The page wrapper (`.cdp-page`, `.al-view`) gets no top padding either.
- **No `overflow` / fixed `height` between the header and `.tab-content`.** NotesView's root used to
  be `height:100%; overflow:hidden` — that makes the root the sticky element's scroll container, so
  it never pins. Same reason the tab wrapper's animation is opacity-only (a transform would become
  the containing block).
- **A pinned block must stay small.** Pinned headers cost screen height (Notes wraps to two rows below
  ~1450px; Countdowns' stats + one filter row is ~155px). Countdowns uses `display: contents` on
  `.cdp-head` at ≤768px so the stat cards scroll away and only `.cdp-filterbar` (now a direct child of
  the page, so it can still pin) stays.
- **`Select` is as wide as its wrapper**: `width: style.width || '100%'`. In a wrapping toolbar a
  `Select` with no `width` becomes a full-row item and forces its own line — pass `style.width`.
- Dropdowns opened from a pinned header are fine: the header has no `overflow` and the `Select` list
  has `z-index: 9999` inside the header's own stacking context, so it paints over the scrolling content.

## Popups, menus and clipping

Three things in this app bite anyone who adds a dropdown or popup:

1. **`overflow` clips absolutely-positioned children.** The Journal's right panel, modal
   bodies and the app shell (`overflow: hidden`) all clip. A menu positioned `absolute`
   inside them is cut off at the container edge.
2. **A scrolling container with a `transform` is its own stacking context**, so even an
   un-clipped menu can render *under* a sibling panel.
3. **A document-level "click outside closes me" handler treats a portaled popup as
   outside.**

The fix, used for the Journal export menu and every `DateInput`/`TimeInput` popup: render
the popup into `<body>` with `createPortal`, `position: fixed`, placed from the trigger's
`getBoundingClientRect()` (kept inside the window, flipped above the trigger when there's
no room, re-placed on scroll/resize — listen in the **capture** phase because scrolling
containers don't bubble), `z-index` far above modals (`FloatingPopover` uses 10050).
Mark the popup with `data-nk-popover` and make the opener's outside-click handler treat
`e.target.closest('[data-nk-popover]')` as inside. Escape should close the popup only:
listen in the capture phase and `stopPropagation()` (see `FloatingPopover`).

Portaling also loses scoped CSS variables. The Journal's `--jnx-*` tokens are defined on
`.jnx-page`, so the portaled export menu (`.jnx-export-menu`) is added to that selector
list (and its light-theme twin). Check any variable your popup uses is defined on `:root`
or on the popup itself.

`Select.jsx`'s list is `absolute` inside its trigger's wrapper. It is fine in the places
it is used today (verified in the task panel, the add-link modal and the voice-confirm
modal), but if you put one inside a new clipping container, portal it the same way.

## Icons

Icons are **local `function IcoX()` / `NavIcoX()` components** that return inline
SVG, each file using a shared `const S` / `SI` spread-props object. Duplicating
that props object across files is accepted — there is no shared icon library.

## Responsive strategy

Desktop uses the sidebar rail + multi-column layouts; at ≤768px the app switches to
a stacked, page-scrolling layout with a hardcoded bottom nav. Several tabs
(tasks/habits/journal) use a **contained-scroll** layout on ≥768px: the app shell
is locked to `100dvh` (`html,body{overflow:hidden}`) and each tab wrapper is
bounded to the viewport via a `*-tab-active` class so only the inner content
scrolls, not the page. Mobile keeps normal page scroll.

## Conventions to match (don't "improve")

- Terse style: aligned `const` blocks, single-line guards, `try {} catch {}` around
  every localStorage access, `?.`/`??` over defensive `if`s.
- JSX uses the **automatic runtime** — no file imports `React` directly.
- Route-level views are `lazy()`-loaded, one chunk per tab.
- Commit convention: `type(scope): lowercase imperative summary`, scope is the tab
  (`tasks`, `journal`, `activity-log`, `reports`, `daily`, `shared`). One commit per tab.
- Destructive actions (delete a note/task/event, clear completed tasks, clear a chat)
  ask with `confirm()` first; that is the house style for confirmation, not a custom modal.
