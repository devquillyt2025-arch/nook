// ─── complete_task match resolution — client-side, authoritative ──────────
// The parse-voice-command Edge Function has no access to the user's task
// list, so it cannot know whether a spoken taskQuery matches zero, one, or
// several tasks. That check has to happen here, against live state, and it
// is the ONLY thing allowed to trigger the complete_task auto-execute
// carve-out — the model's own `ambiguous`/`confidence` fields are irrelevant
// to that decision (they're display-only in the confirm UI). Auto-execute
// fires when and only when this returns exactly one match.

// Lowercase, trim, collapse internal whitespace, drop trailing punctuation —
// so "Call the plumber." and "call the plumber" compare equal.
export function normalizeTitle(s) {
  return (s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.,!?;:'"]+$/g, '');
}

// Classic edit-distance, no dependency — inputs here are short task titles.
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
    }
    prev = cur;
  }
  return prev[n];
}

// Matches `query` against incomplete tasks only, by exact-or-near-exact
// title. Exact normalized matches always win outright (if any exist, fuzzy
// candidates are never mixed in) — so two tasks that happen to share an
// exact name correctly fall back to "2 matches", not silently pick one.
export function matchIncompleteTasks(query, tasks) {
  const q = normalizeTitle(query);
  if (!q) return [];
  const incomplete = (tasks || []).filter(t => !t.completed);

  const exact = incomplete.filter(t => normalizeTitle(t.name) === q);
  if (exact.length) return exact;

  return incomplete.filter(t => {
    const n = normalizeTitle(t.name);
    if (!n) return false;
    if (n.includes(q) || q.includes(n)) return true;
    const dist = levenshtein(n, q);
    const maxLen = Math.max(n.length, q.length);
    return maxLen > 0 && dist / maxLen <= 0.2;
  });
}
