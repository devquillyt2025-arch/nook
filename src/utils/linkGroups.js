// ─── Link groups ───────────────────────────────────────────────────
// The Links tab's first screen is one tile per category. This is the pure grouping
// behind it (kept out of LinksView so it can be tested).
//
// Categories are free text typed in the add-link modal, so "work" and "Work" would
// otherwise become two tiles. Groups are keyed case-insensitively on the trimmed
// category and labelled with the spelling used most often. A link with no category
// goes in an "Uncategorised" group so it is never hidden at the top level.

export const UNCAT = '__uncategorised__';
export const UNCAT_LABEL = 'Uncategorised';

// The group a link belongs to: its trimmed, lower-cased category, or UNCAT.
export function catKeyOf(link) {
  const c = typeof link?.category === 'string' ? link.category.trim() : '';
  return c ? c.toLowerCase() : UNCAT;
}

// → [{ key, label, links }]  A–Z by label (case-insensitive) with Uncategorised last.
// Within a group, starred links come first and the rest keep the order they were given.
export function groupLinks(links) {
  const byKey = new Map();
  for (const l of Array.isArray(links) ? links : []) {
    if (!l || typeof l !== 'object') continue;
    const key = catKeyOf(l);
    let g = byKey.get(key);
    if (!g) { g = { key, spellings: new Map(), links: [] }; byKey.set(key, g); }
    if (key !== UNCAT) { const s = l.category.trim(); g.spellings.set(s, (g.spellings.get(s) || 0) + 1); }
    g.links.push(l);
  }
  const groups = [...byKey.values()].map(g => {
    let label = UNCAT_LABEL, best = 0;
    if (g.key !== UNCAT) for (const [s, n] of g.spellings) if (n > best) { label = s; best = n; }   // ties keep the first spelling seen
    return { key: g.key, label, links: [...g.links.filter(l => l.starred), ...g.links.filter(l => !l.starred)] };
  });
  return groups.sort((a, b) => (a.key === UNCAT) - (b.key === UNCAT) || a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }));
}
