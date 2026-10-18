// ═══════════════════════════════════════════════════════════════════
// chat-with-claude — open-ended conversation for the Chat tab.
//
// Deliberately NOT tool-use: this is a plain conversational endpoint, no
// side effects. It cannot add/complete tasks or add notes — that's the
// separate, narrowly-scoped parse-voice-command function. Keeping the two
// apart means the safety-gated 3-tool action router never grows a second,
// less-audited entry point via chat.
//
// User-authenticated: deploy WITH jwt verification, same as the other
// user-invoked functions.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@^0.110.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders } });

// Replies are shown as chat bubbles AND read aloud via the browser's
// speechSynthesis, so the model is told to keep them speakable — short,
// no markdown tables/code fences unless explicitly asked for written content.
const SYSTEM_PROMPT = `You are Nook's chat assistant — a friendly helper embedded in a personal productivity app (tasks, habits, journal, notes, calendar). This is plain conversation: you cannot add tasks, complete tasks, add notes, or change anything in the user's data. If asked to do one of those things, say so and suggest they use the mic/voice-command button or the relevant tab instead.

Your replies are both displayed as text AND read aloud with text-to-speech, so keep them concise and speakable — a few short sentences for most answers, avoid markdown tables, code fences, or long bullet lists unless the user explicitly asks for detailed written content.`;

// Only accept the last N turns — bounds both the request payload and the
// token cost of a long-running conversation. The client keeps full history
// for display; this cap is what actually gets sent to Claude each turn.
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_LEN = 4000;

// Best-effort per-user rate limit. State lives in this isolate's memory, so it bounds a single client
// hammering the endpoint (each call is paid Anthropic usage) but is NOT a hard global cap: separate
// isolates keep separate counters. A DB-backed counter is the follow-up if these features are enabled.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 20;
const recentCalls = new Map<string, number[]>();
function rateLimited(userId: string): boolean {
  const now = Date.now();
  const recent = (recentCalls.get(userId) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  const limited = recent.length >= RATE_MAX;
  if (!limited) recent.push(now);
  recentCalls.set(userId, recent);
  if (recentCalls.size > 5000) {
    for (const [k, v] of recentCalls) if (!v.some(t => now - t < RATE_WINDOW_MS)) recentCalls.delete(k);
  }
  return limited;
}

// Reject oversized bodies before parsing them.
const MAX_BODY_CHARS = 64_000;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  // 1. Verify the caller's Supabase session.
  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'unauthenticated' }, 401);
  if (rateLimited(user.id)) return json({ error: 'Too many requests — try again in a minute.' }, 429);

  // 2. Read + validate the conversation.
  let payload: { messages?: { role?: string; text?: string }[] };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ error: 'payload_too_large' }, 413);
    payload = JSON.parse(text);
  } catch { return json({ error: 'bad_json' }, 400); }
  const raw = Array.isArray(payload.messages) ? payload.messages : [];
  const turns = raw
    .filter(m => (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text.trim())
    .slice(-MAX_HISTORY_MESSAGES)
    .map(m => ({ role: m.role as 'user' | 'assistant', content: m.text!.trim().slice(0, MAX_MESSAGE_LEN) }));
  if (!turns.length || turns[turns.length - 1].role !== 'user') {
    return json({ error: 'messages must end with a user turn' }, 400);
  }

  // 3. Ask Claude to reply.
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 1024,
      output_config: { effort: 'medium' }, // real conversation, not a short extraction — but bounded, this isn't agentic work
      system: SYSTEM_PROMPT,
      messages: turns,
    });
  } catch (err) {
    // Detail stays in the function logs — the SDK's message can carry request ids and account details.
    console.error('[chat-with-claude] llm request failed:', err);
    return json({ error: 'llm_request_failed' }, 502);
  }

  // 4. Collect the text reply.
  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  return json({ reply: text || "I don't have a reply for that." });
});
