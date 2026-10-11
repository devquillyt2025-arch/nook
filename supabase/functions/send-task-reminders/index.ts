// ═══════════════════════════════════════════════════════════════════
// send-task-reminders — the piece referenced (but never built) by
// public/sw.js and supabase/migrations/0001_reminders.sql.
//
// Runs on a schedule (see supabase/migrations/0002_schedule_reminders.sql),
// finds reminders whose reminder_at has passed and haven't been sent yet,
// delivers each via whichever channel(s) the user opted into — push
// (a push_subscriptions row exists) and/or email (notification_prefs.
// email_reminders_enabled), independently — then marks the reminder sent.
// Expired/unsubscribed push endpoints (404/410/401/403) are deleted from
// push_subscriptions as they're found.
//
// Not user-facing HTTP — triggered only by pg_cron via pg_net, gated by
// a shared secret (X-Cron-Secret) rather than a user JWT, since there is
// no signed-in user in a cron context. Deploy with --no-verify-jwt.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY')!;
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY')!;
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT')!;
const CRON_SECRET = Deno.env.get('CRON_SECRET')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY') ?? '';
const RESEND_FROM = Deno.env.get('RESEND_FROM') || 'Nook <onboarding@resend.dev>';
const SITE_URL = Deno.env.get('SITE_URL') ?? '';

// A subscription that keeps failing without ever returning one of the
// standard revoked/expired codes (404/410/401/403, cleaned up immediately
// below) would otherwise retry every single cron run forever with no way to
// stop — no schema field existed to count consecutive failures at all until
// migration 0007. This bounds it: 5xx/timeouts/etc. get a handful of retries
// (transient errors do happen), a hard-dead endpoint eventually gets pruned.
const PUSH_MAX_CONSECUTIVE_FAILURES = 5;

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// Constant-time comparison of the cron secret: both sides are hashed first, so neither the position of
// the first differing byte nor the secret's length shows in the response time. An empty expected secret
// (env var missing) never matches, even against an empty header.
async function secretsMatch(provided: string | null, expected: string): Promise<boolean> {
  if (!expected || provided === null) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(provided)),
    crypto.subtle.digest('SHA-256', enc.encode(expected)),
  ]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// A reminder row is user-written (RLS lets a user insert any title / source_id), so everything taken
// from it is bounded, and anything placed in a URL is encoded.
const MAX_TITLE = 200;
const clip = (s: unknown, n = MAX_TITLE) => String(s ?? '').slice(0, n);
// An email subject is plain text, not HTML: entity-escaping it would show "&amp;", but control
// characters / newlines have no business in a header.
const plainSubject = (s: unknown) => clip(s, 150).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const reminderPath = (r: { source_type: string; source_id: string }) =>
  r.source_type === 'task' ? `/?reminder=task:${encodeURIComponent(clip(r.source_id, 100))}` : '/';

function reminderBody(reminder: { target_at: string | null }) {
  if (!reminder.target_at) return 'Reminder';
  const d = new Date(reminder.target_at);
  const dateStr = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const timeStr = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  // Task due-dates are anchored to 23:59:59 (no real due *time*) — skip the clock in that case.
  const isDateOnly = d.getHours() === 23 && d.getMinutes() === 59;
  return isDateOnly ? `Due ${dateStr}` : `Due ${dateStr} at ${timeStr}`;
}

// Minimal HTML escaper — prevents a task title containing HTML/script tags from
// being rendered as markup inside the email body (SEC-05).
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function sendReminderEmail(to: string, reminder: { title: string; source_type: string; source_id: string; target_at: string | null }) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY not configured');

  const body = reminderBody(reminder);
  const safeTitle = escapeHtml(clip(reminder.title));
  const url = SITE_URL ? `${SITE_URL.replace(/\/+$/, '')}${reminderPath(reminder)}` : null;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to,
      subject: `Reminder: ${plainSubject(reminder.title)}`,
      html: `
        <div style="font-family: -apple-system, sans-serif; max-width: 480px; margin: 0 auto;">
          <h2 style="margin-bottom: 4px;">${safeTitle}</h2>
          <p style="color: #666; margin-top: 0;">${body}</p>
          ${url ? `<p><a href="${escapeHtml(url)}" style="display:inline-block; background:#7869fc; color:#fff; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:600;">Open in Nook</a></p>` : ''}
        </div>
      `,
    }),
  });

  if (!res.ok) throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
}


Deno.serve(async (req) => {
  if (!(await secretsMatch(req.headers.get('X-Cron-Secret'), CRON_SECRET))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: dueReminders, error } = await supabase
    .from('reminders')
    .select('id, user_id, source_type, source_id, title, target_at')
    .lte('reminder_at', new Date().toISOString())
    .eq('reminder_sent', false)
    .limit(200);

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }

  let sent = 0, failed = 0, cleaned = 0, emailSent = 0, emailFailed = 0;
  // Reminders with at least one *confirmed* successful delivery this run —
  // see the reminder_sent write-back below for why this replaced the
  // previous "a channel existed" check.
  const deliveredReminderIds = new Set<string>();

  if (dueReminders && dueReminders.length > 0) {
    const userIds = [...new Set(dueReminders.map(r => r.user_id))];
    const [{ data: allSubs }, { data: allPrefs }] = await Promise.all([
      supabase.from('push_subscriptions').select('id, user_id, endpoint, p256dh_key, auth_key, consecutive_failures').in('user_id', userIds),
      supabase.from('notification_prefs').select('user_id, email_reminders_enabled').in('user_id', userIds),
    ]);

    const subsByUserId: Record<string, any[]> = {};
    for (const sub of allSubs ?? []) {
      if (!subsByUserId[sub.user_id]) subsByUserId[sub.user_id] = [];
      subsByUserId[sub.user_id].push(sub);
    }

    const prefsByUserId: Record<string, any> = {};
    for (const pref of allPrefs ?? []) {
      prefsByUserId[pref.user_id] = pref;
    }

    for (const reminder of dueReminders) {
      const subs = subsByUserId[reminder.user_id];
      const prefs = prefsByUserId[reminder.user_id];

      if (prefs?.email_reminders_enabled) {
        try {
          const { data: userRes } = await supabase.auth.admin.getUserById(reminder.user_id);
          const email = userRes?.user?.email;
          if (email) {
            await sendReminderEmail(email, reminder);
            emailSent++;
            deliveredReminderIds.add(reminder.id);
          }
        } catch {
          emailFailed++;
        }
      }

      const payload = JSON.stringify({
        title: clip(reminder.title),
        body: reminderBody(reminder),
        source_type: reminder.source_type,
        source_id: clip(reminder.source_id, 100),
        url: reminderPath(reminder),
      });

      for (const sub of subs ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh_key, auth: sub.auth_key } },
            payload,
          );
          sent++;
          deliveredReminderIds.add(reminder.id);
          if (sub.consecutive_failures > 0) {
            await supabase.from('push_subscriptions').update({ consecutive_failures: 0 }).eq('id', sub.id);
          }
        } catch (err) {
          failed++;
          const statusCode = (err as { statusCode?: number }).statusCode;
          if (statusCode === 404 || statusCode === 410 || statusCode === 401 || statusCode === 403) {
            // Google/browser itself says this endpoint is gone — no point counting failures first.
            await supabase.from('push_subscriptions').delete().eq('id', sub.id);
            cleaned++;
          } else {
            const nextCount = (sub.consecutive_failures ?? 0) + 1;
            if (nextCount >= PUSH_MAX_CONSECUTIVE_FAILURES) {
              await supabase.from('push_subscriptions').delete().eq('id', sub.id);
              cleaned++;
            } else {
              await supabase.from('push_subscriptions').update({ consecutive_failures: nextCount }).eq('id', sub.id);
            }
          }
        }
      }
    }

    // ─── FLAG-3 (revised): only mark sent on CONFIRMED delivery, not just a
    // channel existing ────────────────────────────────────────────────────
    // FLAG-3 originally stopped marking a reminder sent when the user had no
    // channel configured at all (push sub + email both absent) — that fixed
    // the "silently tombstoned, never delivered" case. But it checked
    // whether a channel *existed*, not whether the send through it actually
    // *succeeded*: a user whose only push subscription is stale (returning
    // some non-cleanup error, so it isn't pruned) or whose Resend send throws
    // still had `hasPush`/`hasEmail` true, so the reminder was marked sent
    // anyway — delivered to no one, and never retried.
    //
    // deliveredReminderIds only gains an entry when webpush.sendNotification
    // or sendReminderEmail actually resolved without throwing (see above).
    // A reminder with a configured channel that failed every attempt this
    // run stays reminder_sent: false, so the next cron run's query
    // (reminder_sent = false) naturally retries it — this *is* the retry
    // mechanism, no separate queue needed. A reminder with no channel at all
    // behaves the same as before: nothing to attempt, stays unmarked until
    // the user configures one.
    const sentIds = dueReminders
      .filter((reminder: any) => deliveredReminderIds.has(reminder.id))
      .map((reminder: any) => reminder.id);
    if (sentIds.length > 0) {
      await supabase.from('reminders').update({ reminder_sent: true }).in('id', sentIds);
    }
  }

  return new Response(
    JSON.stringify({ processed: dueReminders?.length ?? 0, sent, failed, cleaned, emailSent, emailFailed }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});
