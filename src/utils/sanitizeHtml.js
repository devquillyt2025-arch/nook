// ─── HTML sanitising for the Journal ────────────────────────────────────
// A journal entry is rich-text HTML kept in localStorage, synced between devices
// (synced_items) and restorable from a backup file. So the HTML that comes back out
// of storage is UNTRUSTED: anything that reaches `innerHTML` unfiltered runs in the
// app's origin, where the Supabase session and the Google tokens live. An
// `<img src=x onerror=…>` in one entry used to execute the moment the Journal tab
// opened (the calendar re-reads every entry through htmlToText).
//
// Two rules follow from that:
//   1. Text is read through an inert parser (DOMParser) — never `div.innerHTML = html`,
//      because an <img> in a detached element still loads and still fires onerror.
//   2. HTML that is going to be *rendered* goes through sanitizeJournalHtml() first.
//
// The allowlist is what the editor can produce (bold / italic / underline, H1–H3,
// quote, lists) plus the neighbours a browser adds on paste. No links, images, forms,
// svg/math or custom attributes; `style` survives only as a few plain declarations.

import DOMPurify from 'dompurify';

const ALLOWED_TAGS = [
  'p', 'div', 'br', 'span', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'sub', 'sup',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'hr',
];

const SAFE_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-weight', 'font-style',
  'text-decoration', 'text-decoration-line', 'text-align',
]);
// Plain values only: words, numbers, #hex, rgb(...)/hsl(...). No ':' '/' ';' quotes or '\'
// means no url(), no escapes, no smuggled second declaration.
const SAFE_STYLE_VALUE = /^[#\w\s.,%()-]+$/;
const UNSAFE_STYLE_VALUE = /url|expression|image|var\(|@|\\/i;

function cleanStyle(style) {
  return String(style)
    .split(';')
    .map(d => d.trim())
    .filter(Boolean)
    .filter(d => {
      const i = d.indexOf(':');
      if (i < 1) return false;
      const prop = d.slice(0, i).trim().toLowerCase();
      const value = d.slice(i + 1).trim();
      return SAFE_STYLE_PROPS.has(prop) && SAFE_STYLE_VALUE.test(value) && !UNSAFE_STYLE_VALUE.test(value);
    })
    .join('; ');
}

if (DOMPurify.isSupported) {
  DOMPurify.addHook('afterSanitizeAttributes', node => {
    if (!node.getAttribute) return;
    const style = node.getAttribute('style');
    if (style == null) return;
    const clean = cleanStyle(style);
    if (clean) node.setAttribute('style', clean); else node.removeAttribute('style');
  });
}

/** HTML that is safe to assign to innerHTML. Always returns a string. */
export function sanitizeJournalHtml(html) {
  if (html == null || html === '') return '';
  if (!DOMPurify.isSupported) return escapeText(String(html));   // no DOM: never pass markup through
  return DOMPurify.sanitize(String(html), {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    KEEP_CONTENT: true,
  });
}

/** The visible text of some HTML, read through an inert document (nothing loads or runs). */
export function htmlToPlainText(html) {
  if (html == null || html === '') return '';
  const doc = new DOMParser().parseFromString(String(html), 'text/html');
  return doc.body.textContent || '';
}

/** The <body> of an inert document built from `html` — for walkers that only read the tree. */
export function parseHtmlInert(html) {
  return new DOMParser().parseFromString(String(html ?? ''), 'text/html').body;
}

function escapeText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
