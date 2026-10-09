// ─── Journal data layer (Neon + localStorage fallback) ────────────
// The journal is stored as a single object keyed by date in the cloud:
//   { "2026-07-20": { date, content, createdAt, updatedAt }, ... }
// Icons are stored separately under 'journal_icons'.

import { cloudGet, cloudSet, lsGet, lsSet } from './api';

const CLOUD_KEY       = 'journal';
const CLOUD_ICONS_KEY = 'journal_icons';
const LS_ICONS_KEY    = 'nook_journal_icons';

function lsKeyForDate(date) { return `nook_journal_${date}`; }

// ── Entries ──────────────────────────────────────────────────────

let _entriesCache = null;

export async function loadAllEntries() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) {
    _entriesCache = cloud;
    return Object.values(cloud).sort((a, b) => b.date.localeCompare(a.date));
  }
  // Fallback: scan localStorage for nook_journal_* keys
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('nook_journal_')) continue;
    try { const e = JSON.parse(localStorage.getItem(key)); if (e?.date) out.push(e); } catch {}
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export async function loadEntry(date) {
  if (_entriesCache) return _entriesCache[date] || null;
  const all = await cloudGet(CLOUD_KEY);
  if (all != null) return all[date] || null;
  // localStorage fallback
  try { const raw = localStorage.getItem(lsKeyForDate(date)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export async function saveEntry(date, entry) {
  // Read current map, update, write back
  let all = await cloudGet(CLOUD_KEY);
  if (all == null) {
    // Bootstrap from localStorage
    all = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('nook_journal_')) continue;
      try { const e = JSON.parse(localStorage.getItem(key)); if (e?.date) all[e.date] = e; } catch {}
    }
  }
  const updated = { ...entry, updatedAt: new Date().toISOString() };
  all[date] = updated;
  _entriesCache = all;
  await cloudSet(CLOUD_KEY, all);
  // Keep localStorage copy for offline access
  try { localStorage.setItem(lsKeyForDate(date), JSON.stringify(updated)); } catch {}
}

// ── Icons ─────────────────────────────────────────────────────────

export async function loadIcons() {
  const cloud = await cloudGet(CLOUD_ICONS_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_ICONS_KEY, {});
}

export async function saveIcons(icons) {
  await cloudSet(CLOUD_ICONS_KEY, icons);
  lsSet(LS_ICONS_KEY, icons);
}
