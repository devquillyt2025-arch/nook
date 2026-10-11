// ─── Which localStorage keys a backup file may write back ───────────────
// A backup (.zip / .json) is untrusted input: it can come from anywhere. Import must
// therefore apply the same exclusions the export side does (utils/backup.js) and a bit
// more — otherwise a crafted file could plant:
//   • nook_gcal_tokens          → Calendar sync would push the user's events to someone
//                                 else's Google account;
//   • nook_gcal_push_queue      → forged pending Calendar writes;
//   • nook_google_tokens, …     → the same for Tasks;
//   • nook_ai_api_key           → a key of the attacker's choosing for the AI assistant.
// Only `nook-` / `nook_` keys are ever written, and never anything token- or PKCE-shaped.

const ALLOWED_PREFIX = /^nook[-_]/;

const BLOCKED_KEYS = new Set([
  'nook_google_tokens', 'nook_pkce_verifier', 'nook_sync_queue', 'nook_deleted_tasks',
  'nook_gcal_push_queue', 'nook_ai_api_key',
]);

/** True if a backup must never write this key (tokens, PKCE, sync queues, the stored API key). */
export function isBlockedImportKey(key) {
  return BLOCKED_KEYS.has(key) || /token|pkce/i.test(key);
}

/** True if a backup may write this key back to localStorage. */
export function isImportableKey(key) {
  return typeof key === 'string' && ALLOWED_PREFIX.test(key) && !isBlockedImportKey(key);
}
