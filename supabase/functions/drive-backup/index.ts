// ═══════════════════════════════════════════════════════════════════
// drive-backup — uploads a Nook backup to the user's Google Drive.
//
// Triggered by the CLIENT (not pg_cron): only the browser can read the
// localStorage that makes up data.local, so the browser builds the backup
// (buildBackup() in src/utils/backup.js) and POSTs it here. This function
// mints a fresh Google access token from the Vault-stored refresh token,
// ensures a "Nook Backups" folder, uploads nook-backup-<date>.json,
// prunes to the newest 7 files, and records the run in backup_runs.
//
// The backup payload is forwarded to Drive and is NEVER persisted in
// Supabase. User-authenticated: deploy WITH jwt verification.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'npm:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GOOGLE_CLIENT_ID = Deno.env.get('GOOGLE_CLIENT_ID')!;
const GOOGLE_CLIENT_SECRET = Deno.env.get('GOOGLE_CLIENT_SECRET')!;
const KEEP = 7;
// A backup is localStorage JSON (a few MB at most). Refuse anything wildly larger rather than relay it to Drive.
const MAX_BODY_CHARS = 25_000_000;

// Browser-invoked (supabase.functions.invoke), so CORS must be handled: the
// preflight OPTIONS carries no auth header and is let through by the platform
// regardless of verify_jwt, so the function itself must answer it.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

// deno-lint-ignore no-explicit-any
async function accessTokenFor(admin: any, userId: string): Promise<string> {
  const { data: refresh, error } = await admin.rpc('get_drive_refresh_token', { p_user: userId });
  if (error) throw new Error(`vault_read_failed: ${error.message}`);
  if (!refresh) throw new Error('drive_not_connected');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refresh,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`token_refresh_failed: ${await res.text()}`);
  return (await res.json()).access_token;
}

// deno-lint-ignore no-explicit-any
async function ensureFolder(token: string, admin: any, userId: string): Promise<string> {
  const { data: row } = await admin.from('drive_backup').select('drive_folder_id').eq('user_id', userId).single();
  if (row?.drive_folder_id) return row.drive_folder_id;

  const res = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nook Backups', mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!res.ok) throw new Error(`folder_create_failed: ${await res.text()}`);
  const folder = await res.json();
  await admin.from('drive_backup').update({ drive_folder_id: folder.id }).eq('user_id', userId);
  return folder.id;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // 1. Verify the caller's session.
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'unauthenticated' }, 401);

  // 2. Validate the payload (same shape buildBackup() produces).
  let body: { backup?: { schemaVersion?: number; counts?: unknown } };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ error: 'payload_too_large' }, 413);
    body = JSON.parse(text);
  } catch { return json({ error: 'bad_json' }, 400); }
  const backup = body.backup;
  if (!backup || backup.schemaVersion !== 1) return json({ error: 'bad_payload' }, 400);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
  const fileName = `nook-backup-${new Date().toISOString().slice(0, 10)}.json`;

  try {
    const token = await accessTokenFor(admin, user.id);
    const folderId = await ensureFolder(token, admin, user.id);

    // 3. Multipart upload: metadata part + JSON media part.
    const boundary = 'nook' + crypto.randomUUID();
    const reqBody =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      JSON.stringify({ name: fileName, parents: [folderId] }) +
      `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      JSON.stringify(backup) +
      `\r\n--${boundary}--`;

    const up = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body: reqBody,
    });
    if (!up.ok) throw new Error(`upload_failed: ${await up.text()}`);

    // 4. Record success now, before retention runs — the backup itself is what
    //    this status means. Retention (below) is a separate best-effort cleanup
    //    step; a network hiccup pruning old files must not retroactively mark
    //    an upload that already succeeded as a failed run.
    await admin.from('drive_backup').update({
      last_backup_at: new Date().toISOString(), last_status: 'success', last_error: null,
    }).eq('user_id', user.id);
    await admin.from('backup_runs').insert({
      user_id: user.id, status: 'success', file_name: fileName, counts: backup.counts,
    });

    // 5. Retention: keep the newest KEEP files, delete the rest. Best-effort —
    //    caught and swallowed on its own so a failure here can't flip the run
    //    recorded above into an error; next run's list will just include one
    //    extra stale file and try again.
    try {
      const q = `'${folderId}' in parents and trashed=false`;
      const list = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}` +
        `&orderBy=createdTime desc&fields=files(id,name,createdTime)&spaces=drive`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      if (list.ok) {
        const files = (await list.json()).files ?? [];
        for (const f of files.slice(KEEP)) {
          await fetch(`https://www.googleapis.com/drive/v3/files/${f.id}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
        }
      }
    } catch (pruneErr) {
      console.error('[drive-backup] retention prune failed (non-fatal):', (pruneErr as Error).message);
    }

    return json({ ok: true, file: fileName, counts: backup.counts });
  } catch (err) {
    const msg = (err as Error).message;
    await admin.from('drive_backup').update({ last_status: 'error', last_error: msg }).eq('user_id', user.id);
    await admin.from('backup_runs').insert({ user_id: user.id, status: 'error', file_name: fileName, error: msg });
    return json({ error: msg }, 500);
  }
});
