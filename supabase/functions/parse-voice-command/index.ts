// ═══════════════════════════════════════════════════════════════════
// parse-voice-command — turns a spoken transcript into one of three
// structured actions (add_task / complete_task / add_note) via a single
// Claude tool-use call.
//
// This function ONLY parses. It never writes to Supabase or touches
// task/note data, and it never decides whether an action auto-executes.
// In particular, for complete_task it has no access to the user's task
// list, so it cannot know whether `taskQuery` matches zero, one, or many
// tasks — that match-count check is the client's job (see
// src/utils/voiceCommandMatch.js) and is the only thing allowed to
// trigger the complete_task auto-execute carve-out. This function's own
// `ambiguous` flag only reflects whether the transcript itself named a
// clear referent, which is a different question.
//
// User-authenticated: deploy WITH jwt verification (do NOT use
// --no-verify-jwt), same as google-oauth/connect-drive.
// ═══════════════════════════════════════════════════════════════════

import { createClient } from 'npm:@supabase/supabase-js@2';
import Anthropic from 'npm:@anthropic-ai/sdk@^0.110.0';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY')!;

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

// Mirrors utils/categoryMeta.js / utils/priorityMeta.js. Only the 5 built-in
// categories are offered — per-user custom categories (nook_custom_categories)
// live in localStorage and are invisible to this function.
const CATEGORIES = ['learning', 'fitness', 'mental', 'work', 'growth'];
const PRIORITIES = ['high', 'medium', 'low', 'none'];

// Best-effort per-user rate limit. State lives in this isolate's memory, so it bounds a single client
// hammering the endpoint (each call is paid Anthropic usage) but is NOT a hard global cap: separate
// isolates keep separate counters. A DB-backed counter is the follow-up if these features are enabled.
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 30;
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

// strict:true requires every property to be listed in `required` — so the
// model always fills a value (using '' for "nothing said") rather than
// omitting a field, which keeps `params` a complete, directly-usable object
// on the client instead of one the caller has to defensively fill in.
const TOOLS = [
  {
    name: 'add_task',
    description: 'Create a new task from a spoken command.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Trimmed task title.' },
        dueDate: { type: 'string', description: "Resolved YYYY-MM-DD against the given current date, or '' if no date was said." },
        time: { type: 'string', description: "HH:MM 24h time-of-day, or '' if none was said." },
        priority: { type: 'string', enum: PRIORITIES, description: "Defaults to 'medium' if unspecified." },
        category: { type: 'string', enum: CATEGORIES, description: "Best-guess built-in category; defaults to 'work' if unclear." },
        notes: { type: 'string', description: "Any extra detail beyond the title, or ''." },
        confidence: { type: 'number', description: 'Your own 0-1 confidence in this parse.' },
        ambiguous: { type: 'boolean', description: 'True only if name had to be guessed.' },
      },
      required: ['name', 'dueDate', 'time', 'priority', 'category', 'notes', 'confidence', 'ambiguous'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description: 'Mark an existing task as done.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        taskQuery: { type: 'string', description: "The task title/phrase exactly as the user said it — do not normalize or guess at a task you can't see." },
        confidence: { type: 'number', description: 'Your own 0-1 confidence in this parse.' },
        ambiguous: { type: 'boolean', description: 'True if the transcript itself had no clear referent (e.g. "mark it done").' },
      },
      required: ['taskQuery', 'confidence', 'ambiguous'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_note',
    description: 'Create a new note from a spoken command.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Trimmed note title.' },
        content: { type: 'string', description: "Note body, or '' if the user only gave a title." },
        confidence: { type: 'number', description: 'Your own 0-1 confidence in this parse.' },
        ambiguous: { type: 'boolean', description: 'True only if title had to be guessed.' },
      },
      required: ['title', 'content', 'confidence', 'ambiguous'],
      additionalProperties: false,
    },
  },
];

function systemPrompt(currentDate: string) {
  return `You are the voice-command parser for Nook, a task/notes app. Convert the user's spoken transcript into exactly one tool call: add_task, complete_task, or add_note.

If the transcript doesn't clearly ask for one of those three actions, do NOT call a tool — reply with a short plain-text sentence instead.

Today's date in the user's local timezone is ${currentDate} (YYYY-MM-DD). Resolve relative dates ("today", "tomorrow", "next Friday") against this date and return an absolute YYYY-MM-DD. Never shift to UTC.

Fill in every field of whichever tool you call:
- Use '' for a date/time/notes/content field nothing was said about — never invent one.
- confidence is your own honest 0-1 estimate of how well the transcript maps to what you filled in.
- ambiguous is true only when a REQUIRED field (name / taskQuery / title) had to be guessed because the transcript didn't clearly state it.

For complete_task, taskQuery is the task phrase exactly as spoken — you cannot see the user's actual task list, so quote what they said rather than guessing which task they mean.`;
}

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

  // 2. Read the transcript + the client's local "today" (must be computed
  //    client-side in the user's own timezone — see voiceCommandClient.js —
  //    so "tomorrow" near midnight resolves the way the user meant it, not
  //    however this server happens to see UTC).
  let payload: { transcript?: string; currentDate?: string };
  try {
    const text = await req.text();
    if (text.length > MAX_BODY_CHARS) return json({ error: 'payload_too_large' }, 413);
    payload = JSON.parse(text);
  } catch { return json({ error: 'bad_json' }, 400); }
  const transcript = (payload.transcript || '').trim().slice(0, 500);
  const currentDate = /^\d{4}-\d{2}-\d{2}$/.test(payload.currentDate || '')
    ? payload.currentDate!
    : new Date().toISOString().slice(0, 10);
  if (!transcript) return json({ error: 'missing transcript' }, 400);

  // 3. Ask Claude to parse it into one of the three tools (or plain text = none).
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  let response;
  try {
    response = await client.messages.create({
      model: 'claude-opus-5',
      max_tokens: 4096,
      output_config: { effort: 'low' }, // short extraction task, not agentic work
      system: systemPrompt(currentDate),
      tools: TOOLS,
      messages: [{ role: 'user', content: transcript }],
    });
  } catch (err) {
    console.error('[parse-voice-command] llm request failed:', err);
    return json({ error: 'llm_request_failed' }, 502);
  }

  // 4. Extract whichever tool_use block (if any) Claude produced.
  const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
  if (!toolUse) {
    return json({ tool: 'none', params: {}, confidence: 0, ambiguous: true, transcript });
  }

  const input = toolUse.input as Record<string, unknown>;
  const { confidence, ambiguous, ...params } = input;

  // 5. Return only what the client needs, camelCase throughout — this is a
  //    Nook-native contract, not a proxy for an external API's field names
  //    (unlike google-oauth's access_token/refresh_token), so it stays
  //    consistent with the rest of the app's shapes.
  return json({
    tool: toolUse.name,
    params,
    confidence: typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0,
    ambiguous: typeof ambiguous === 'boolean' ? ambiguous : true,
    transcript,
  });
});
