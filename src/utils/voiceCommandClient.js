// ─── Voice command parsing — client side ───────────────────────────────
// Sends a speech-to-text transcript to the parse-voice-command Edge Function,
// which holds the Anthropic API key server-side (never VITE_-prefixed) and
// returns a structured { tool, params, confidence, ambiguous, transcript }
// envelope. This module ONLY parses — it never writes a task/note itself.
// The dispatcher (App.jsx) decides what to do with the result, including the
// complete_task match-count check, which this module has no part in.

import { supabase } from './authClient';
import { todayStr } from './date';

// supabase-js hides an Edge Function's JSON error body on a non-2xx response —
// it only sets a generic FunctionsHttpError message and stashes the raw
// Response on error.context. Pull the real { error } out of it so failures are
// actionable instead of "returned a non-2xx status code". (Same pattern as
// googleOAuthClient.js / driveBackup.js — duplicated per-file by convention.)
async function edgeErrorDetail(error, fallback) {
  try {
    const ctx = error?.context;
    if (ctx && typeof ctx.clone === 'function') {
      const body = await ctx.clone().json().catch(() => null);
      if (body?.error) return body.error;
    }
  } catch { /* fall through */ }
  return error?.message || fallback;
}

// Resolves to { tool, params, confidence, ambiguous, transcript }, or throws.
export async function parseVoiceCommand(transcript) {
  if (!supabase) throw new Error('Sign-in is not configured, so voice commands cannot run server-side.');
  // currentDate is computed here, in the browser's local timezone — matches
  // the local-noon/todayStr() convention used everywhere else in the app
  // (utils/date.js), never a UTC-anchored guess. The edge function resolves
  // relative phrases ("tomorrow") against exactly this string.
  const { data, error } = await supabase.functions.invoke('parse-voice-command', {
    body: { transcript, currentDate: todayStr() },
  });
  if (error) throw new Error(await edgeErrorDetail(error, 'voice command parsing failed'));
  if (data?.error) throw new Error(data.error);
  if (!data?.tool) throw new Error('voice command parsing returned no result');
  return data;
}
