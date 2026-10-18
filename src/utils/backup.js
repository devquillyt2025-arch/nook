// ─── Nook backup / restore ─────────────────────────────────────────────
// Full-account backup for worst-case recovery (browser wipe, new device,
// migration, accidental deletion). Nook's real content lives in browser
// localStorage; Supabase only holds reminder scheduling metadata and a
// notification-prefs row. A "complete" backup therefore bundles BOTH.
//
// This module currently implements the EXPORT (read-only) half only. Restore
// is intentionally not here yet — the destructive delete+insert path and its
// transactional RPC are pending review.

import JSZip from 'jszip';
import { supabase } from './authClient';

export const BACKUP_SCHEMA_VERSION = 1;

// localStorage keys that must NEVER travel in a backup: OAuth secrets and
// transient device-only sync bookkeeping. Restoring these onto another device
// or project would be a security risk or would corrupt sync state.
const EXCLUDED_LOCAL_KEYS = new Set([
  'nook_google_tokens',   // Google OAuth access/refresh tokens (secret)
  'nook_pkce_verifier',   // transient OAuth PKCE verifier
  'nook_sync_queue',      // transient, device-local Google Tasks sync queue
  'nook_deleted_tasks',   // device-local sync tombstones
  'nook_ai_api_key',      // the user's own Gemini API key (a credential; backups also go to Drive)
]);
// Any key containing one of these fragments is also excluded (defensive: catches
// token keys — e.g. Google Calendar — regardless of their exact name).
const EXCLUDED_LOCAL_FRAGMENTS = ['token', 'pkce'];

function isBackupableLocalKey(key) {
  if (!key) return false;
  if (!(key.startsWith('nook-') || key.startsWith('nook_'))) return false;
  if (EXCLUDED_LOCAL_KEYS.has(key)) return false;
  const lower = key.toLowerCase();
  if (EXCLUDED_LOCAL_FRAGMENTS.some(f => lower.includes(f))) return false;
  return true;
}

// Collect every backupable localStorage entry. Values are strings in
// localStorage; we parse JSON where possible so the backup stays human-readable
// and round-trips losslessly, falling back to the raw string otherwise.
function collectLocalData() {
  const local = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!isBackupableLocalKey(key)) continue;
    const raw = localStorage.getItem(key);
    try { local[key] = JSON.parse(raw); }
    catch { local[key] = raw; }
  }
  return local;
}

// Fetch the user-scoped Supabase rows that belong in a backup. RLS on the
// authenticated client already restricts every query to auth.uid(); we never
// use a service role from the client. push_subscriptions is intentionally
// excluded — its endpoints are per-browser and carry a global unique(endpoint)
// constraint, so they must not be carried between devices.
async function collectRemoteData() {
  const remote = { reminders: [], notification_prefs: [] };
  if (!supabase) return { remote, userId: null };

  const { data: userData } = await supabase.auth.getUser();
  const userId = userData?.user?.id ?? null;
  if (!userId) return { remote, userId: null };

  const [rem, prefs] = await Promise.all([
    supabase.from('reminders').select('*'),
    supabase.from('notification_prefs').select('*'),
  ]);
  if (rem.error) throw new Error(`Failed to read reminders: ${rem.error.message}`);
  if (prefs.error) throw new Error(`Failed to read notification_prefs: ${prefs.error.message}`);

  remote.reminders = rem.data ?? [];
  remote.notification_prefs = prefs.data ?? [];
  return { remote, userId };
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Assemble the unified backup object (schemaVersion 1) without downloading or
// mutating anything. Shared source of truth for both the manual .zip export and
// the automated Drive backup, so the two formats can never diverge. Read-only.
export async function buildBackup() {
  const local = collectLocalData();
  const { remote, userId } = await collectRemoteData();

  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    app: 'nook',
    exportedAt: new Date().toISOString(),
    userId,
    counts: {
      local: Object.keys(local).length,
      reminders: remote.reminders.length,
      notification_prefs: remote.notification_prefs.length,
    },
    data: { local, remote },
  };
}

// Build the unified backup and trigger a .zip download. Read-only — never
// mutates localStorage or Supabase. Returns the manifest counts so the caller
// can surface a summary to the user.
export async function exportBackup() {
  const backup = await buildBackup();

  const zip = new JSZip();
  zip.file('backup.json', JSON.stringify(backup, null, 2));
  const blob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  const date = new Date().toISOString().split('T')[0];
  triggerDownload(blob, `nook-backup-${date}.zip`);

  return backup.counts;
}
