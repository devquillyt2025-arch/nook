// ─── Neon cloud data client ────────────────────────────────────────
// Thin wrapper around the /api/data REST endpoints backed by Neon.
// Falls back to localStorage when auth is not configured or the user
// is not signed in, so the app stays usable without an account.

import { supabase, isAuthConfigured } from './authClient';

// ── Auth token ─────────────────────────────────────────────────────
async function getToken() {
  if (!isAuthConfigured || !supabase) return null;
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch { return null; }
}

// True only when a signed-in session exists.
export async function isCloudAvailable() {
  const token = await getToken();
  return Boolean(token);
}

// ── Core API call ──────────────────────────────────────────────────
async function apiCall(path, options = {}) {
  const token = await getToken();
  if (!token) return null;

  try {
    const res = await fetch(`/api/data${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      console.warn('[api]', res.status, path);
      return null;
    }
    return res.json();
  } catch (e) {
    console.warn('[api] fetch error:', e?.message);
    return null;
  }
}

// ── Public API ─────────────────────────────────────────────────────

/** Fetch a single value by key. Returns the parsed value or null. */
export async function cloudGet(key) {
  const result = await apiCall(`/${encodeURIComponent(key)}`);
  return result != null ? result.value : null;
}

/** Upsert a value by key. Returns true on success, false on failure. */
export async function cloudSet(key, value) {
  const result = await apiCall(`/${encodeURIComponent(key)}`, {
    method: 'PUT',
    body: JSON.stringify({ value }),
  });
  return result?.ok === true;
}

/** Delete a key. Returns true on success. */
export async function cloudDelete(key) {
  const result = await apiCall(`/${encodeURIComponent(key)}`, { method: 'DELETE' });
  return result?.ok === true;
}

/** Fetch ALL keys for the current user (for export/migration). */
export async function cloudGetAll() {
  const result = await apiCall('');
  return result?.data || null;
}

// ── localStorage fallback helpers ─────────────────────────────────
// Used by each store as the fallback path when cloud is unavailable.

export function lsGet(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw != null ? JSON.parse(raw) : fallback;
  } catch { return fallback; }
}

export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
