// ─── Chat — client side ─────────────────────────────────────────────────
// Sends the recent conversation to the chat-with-claude Edge Function and
// gets back a plain-text reply. No tools, no side effects — see the edge
// function's header comment for why this is deliberately kept separate
// from parse-voice-command.

import { supabase } from './authClient';

// Same edgeErrorDetail duplication as googleOAuthClient.js / driveBackup.js /
// voiceCommandClient.js — established per-file convention in this codebase.
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

// messages: [{ role: 'user'|'assistant', text }], ending in the latest user
// turn. Resolves to the reply string, or throws.
export async function sendChatMessage(messages) {
  if (!supabase) throw new Error('Sign-in is not configured, so chat cannot run server-side.');
  const { data, error } = await supabase.functions.invoke('chat-with-claude', { body: { messages } });
  if (error) throw new Error(await edgeErrorDetail(error, 'chat request failed'));
  if (data?.error) throw new Error(data.error);
  if (typeof data?.reply !== 'string') throw new Error('chat returned no reply');
  return data.reply;
}
