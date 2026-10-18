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
- **The page changes size once when the sidebar toggles — it must never animate.** `.app-body`'s
  `margin-left` has **no transition** (it used to ease over 250ms, so every tab re-laid-out on every frame:
  the Journal's calendar/export card, charts and rows all visibly shrank and grew). Only the fixed sidebar
  animates its own width. Side cards inside a tab (e.g. the Journal's right panel) should be sized from
  the window (`vw` / fixed `clamp()`), not as an `fr` share of what's left, or they resize with the sidebar. Second cause: framer-motion `layout` rows (task rows, compact Links rows) animate
  a *container* resize as a layout change — it only suppresses that when the *window* width changes. So
  `App` calls `freezeLayoutAnimations()` (`utils/layoutFreeze.js`) just before flipping the sidebar and those
  rows pass `layout={useLayoutAnimations()}`; they keep their glide for add / remove / reorder. Any new
  `motion … layout` element in a view that sits beside the sidebar needs the same hook.
- `nook-sidebar-open` is in `CROSS_TAB_IGNORE_KEYS` — a UI preference, so toggling
  it must not fire the cross-tab data-changed banner.
- `useIsRail()` in `SidebarFlyout.jsx` watches `.main-nav`'s class list with a
  **`MutationObserver`** (not a media query) so the search trigger collapses in
  sync with the JS toggle.
- **The rail is the full sidebar, narrower — one shared geometry.** `.main-nav` has the same 6px
  side padding in both states, so the logo, the search icon and every nav icon sit at **x=30** (the
  centre of the 60px rail) and at the same y; rows are the same height, and the section dividers, the
  head's bottom line and Settings' top line stay. Toggling only changes the width and **fades** the text
  (`.nav-label`, section labels, brand name, search placeholder + shortcut — `opacity`, kept in layout;
  `display:none` can't animate and used to re-centre the icons in the still-wide panel, so they swooped
  across it while it shrank). Don't give the rail its own padding / button padding / `display:none` text
  again, and check any theme override of `.main-nav` padding: the old light-theme rule
  (`:root[data-theme="light"] .main-nav { padding: … }`) out-ranked the rail's and left its icons ~10px
  off-centre. Search is **one** pill element in both states (it shrinks to its icon); the collapse toggle
  stays mounted and is hidden (`visibility`) on the rail. The rail items use `title` for their names
  (the old `data-tooltip` `::after`/`::before` rules were dead — nothing set the attribute — and the
  `::before` one hid the active item's accent bar in the rail, so they're gone).
- **Pinned head, scrolling list.** `.main-nav` itself doesn't scroll (`overflow: hidden`). The logo
  row and the search sit in `.sidebar-head` — pinned, with a line under it; Main / More / Utility sit
  in `.nav-scroll`, the only part that scrolls (scrollbar hidden, wheel / keyboard focus still work);
  Settings sits below it, pinned to the bottom. `.nav-scroll` is `flex: 0 1 auto`, so it only shrinks
  (and scrolls) when the window is too short — a tall window looks as it always did. Two traps:
  it must be a **flex column** (as a plain block the buttons' `margin: 3px 0` collapses and the list
  packs ~56px tighter), and its box reaches into `.main-nav`'s padding (negative margin + matching
  padding; 6px in the rail) or the active item's glow is clipped at the edges.
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

The Activity Log, Notes, Links, Countdowns and Today keep their toolbar on screen with a
`border-bottom` line under it while the content scrolls beneath. The scroll container is
**`.tab-content`** (the page itself, on phones too), so this is plain `position: sticky; top: 0;
z-index: 30; background: var(--bg-base)` on the header — `.al-toolbar`, `.nv-bar` + `.lk-bar` (one
shared rule), `.cdp-head`, `.today-head`. To pin another tab's header the same way: add
`<tab>-tab-active` to the wrapper in `App.jsx` (Today's shell class is the older `yartu-tab-active`),
add it to the `padding-top: 0` rule in `index.css`, and give the header the sticky rule. Today's
greeting card is trimmed while pinned (smaller padding) and on a phone shrinks to the name, a 2×2
grid of counts and a slim toggle (~190px, ~22% of the screen, down from ~300px) — measure a pinned
block before shipping it.
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

### The mobile layer (≤768px)

One block at the very **end of `index.css`** (`/* ═══ MOBILE APP LAYER`) turns the desktop layouts into a
phone app. It sits last on purpose — it overrides the per-view rules above instead of editing each — and it is
all inside one `@media (max-width: 768px)`, so desktop is untouched. The rules that hold it together:

- **The tab shell owns the gutter.** `.sunsama-tab-transition` is 16px on the sides; a view must not pad itself
  sideways on top of it (that stacked 36px + 11–24px and put content ~55px in on a 390px screen). Pinned bars
  (`.nv-bar`, `.lk-bar`, `.al-toolbar`, `.cdp-filterbar`) go full-bleed with `margin-inline: -16px;
  width: calc(100% + 32px); padding-inline: 16px`. Set the **width** too — an explicit `width: 100%` otherwise
  shifts the bar left and leaves it 16px short on the right.
- **Everything page-scrolls.** Tasks and Habits are contained-scroll on desktop (locked page, an inner card
  scrolls). On a phone that clipped the Pending Tasks card to ~100px and hid the whole task list, so the layer
  releases `overflow`/`flex` on `.tasks-tab-active` / `.habits-tab-active` and their inner cards.
- **A pinned bar must stay small.** Filters that wrapped onto four rows become one **scrolling chip row**.
  Where the controls were loose siblings they are wrapped in `.nv-filters` (Notes) / `.al-filters` (Activity
  Log): `display: contents` on desktop (the original flat row, unchanged), a `display: flex; overflow-x: auto`
  row on phones. Do the same for any new toolbar rather than letting it wrap.
- **Inline styles need `!important`.** Many toolbars set sizes inline (`flex`, `width`, `fontSize`,
  `gridTemplateColumns`); the layer matches them with `!important` or an attribute selector
  (`[style*="repeat(7, 1fr)"]` for the Calendar grids, where `1fr` lets one long event title widen a column).
- **`height: 100%` inside a wrapping flex/grid toolbar is a trap** — it resolves against the toolbar's own
  height. `.al-count-txt` did, came out 208px tall, and drew a stray line down the log with the gear and refresh
  buttons landing on the rows. The mobile toolbar gives it `height: auto`.
- **Bottom tab bar:** equal-width items; the active one is an accent pill behind the icon (no bordered box);
  `env(safe-area-inset-bottom)` padding. `viewport-fit=cover` is set in `index.html` and `.app` pads for the
  other insets. The **More** sheet is a 3-column grid (nine destinations = 3×3).
- **A task row is two lines** (title; then icons · category · due date) via CSS grid. The desktop single line
  has fixed 96px + 118px columns that left the title 0px wide at 390px.

Verify a phone change at **360, 390 and 428** (and 768), dark and light, and *look at the screenshot*: the
overflow check (`scrollWidth > clientWidth`) passed on every tab while Tasks was showing no tasks at all.

## Conventions to match (don't "improve")

- Terse style: aligned `const` blocks, single-line guards, `try {} catch {}` around
  every localStorage access, `?.`/`??` over defensive `if`s.
- JSX uses the **automatic runtime** — no file imports `React` directly.
- Route-level views are `lazy()`-loaded, one chunk per tab.
- Commit convention: `type(scope): lowercase imperative summary`, scope is the tab
  (`tasks`, `journal`, `activity-log`, `reports`, `daily`, `shared`). One commit per tab.
- **Every delete asks in the shared themed popup, never inline and never with the native
  `confirm()`.** `await askConfirm({ title, message, confirmLabel? })` from `utils/confirmDialog.js`
  resolves `true` (confirmed) / `false` (cancelled); `<ConfirmHost/>` (`components/ConfirmDialog.jsx`,
  mounted once in `App.jsx`) draws it. It is portaled to `<body>` at `z-index: 10060` (over every modal
  and `FloatingPopover`), Escape cancels **only** the popup (capture phase + `stopPropagation`, so the
  note editor / task side panel underneath stays open), focus starts on **Cancel** and Tab stays inside
  it, and a backdrop click within 350 ms of opening is ignored (a double-click on a trash icon lands its
  second click there). The handler is async — `if (await askConfirm({...})) onDelete(id)` — so re-read
  anything stale after the `await`. Don't bring back an in-row "Delete? Yes / No" strip (Tasks and Links
  had one) or a `window.confirm`. Not deletes, so still native: log out, disconnect Google Calendar,
  restore a backup, and sync's account-switch prompt. The Activity Log's type-`DELETE` clear keeps its own
  stricter modal.
