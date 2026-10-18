// ─── Safe URLs ──────────────────────────────────────────────────────────
// Links (and anything else a user's data can point a browser at) arrive from storage,
// sync and backup files, so a stored `url` is untrusted. `javascript:`, `data:` and
// `vbscript:` URLs must never reach window.open / location / href. The add-link form
// forces an https:// prefix on save, but that only guards what the form wrote — not
// what was synced in or restored.

/** The URL if it is a plain http(s) URL, normalised; otherwise null. */
export function safeHttpUrl(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Opens `value` in a new tab, with no opener and no referrer, if it is a safe http(s) URL. */
export function openSafeUrl(value) {
  const url = safeHttpUrl(value);
  if (!url) return false;
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}
