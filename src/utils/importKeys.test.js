import { describe, it, expect } from 'vitest';
import { isImportableKey, isBlockedImportKey } from './importKeys';

describe('backup import key policy', () => {
  it('lets ordinary Nook data back in', () => {
    for (const k of [
      'nook-tasks', 'nook_habits', 'nook_notes', 'nook_links', 'nook_countdowns', 'nook-calendar-events',
      'nook_journal_2026-10-11', 'nook_journal_icons', 'nook-theme', 'nook-settings', 'nook-profile-name',
      'nook-activity-log', 'nook-pomo-log',
    ]) {
      expect(isImportableKey(k)).toBe(true);
    }
  });

  it('never writes OAuth tokens — including the Calendar ones the old list missed', () => {
    for (const k of ['nook_google_tokens', 'nook_gcal_tokens', 'nook_some_future_token', 'NOOK_GCAL_TOKENS']) {
      expect(isBlockedImportKey(k)).toBe(true);
      expect(isImportableKey(k)).toBe(false);
    }
  });

  it('never writes PKCE verifiers', () => {
    for (const k of ['nook_pkce_verifier', 'nook_gcal_pkce_verifier']) {
      expect(isImportableKey(k)).toBe(false);
    }
  });

  it('never writes sync queues or the stored API key', () => {
    for (const k of ['nook_sync_queue', 'nook_gcal_push_queue', 'nook_deleted_tasks', 'nook_ai_api_key']) {
      expect(isImportableKey(k)).toBe(false);
    }
  });

  it('never writes a key outside the nook-/nook_ families', () => {
    for (const k of ['sb-abc-auth-token', 'supabase.auth.token', 'theme', 'nook', 'nook:sync:uid', 'xnook-tasks', '', '__proto__', 'constructor']) {
      expect(isImportableKey(k)).toBe(false);
    }
  });

  it('rejects non-string keys', () => {
    for (const k of [null, undefined, 1, {}, []]) expect(isImportableKey(k)).toBe(false);
  });
});
