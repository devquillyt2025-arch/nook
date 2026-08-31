// ─── Chat history (localStorage) ───────────────────────────────────────
// One continuous conversation, capped like the app's other logs
// (nook-pomo-log, nook-activity-log). Capped lower than those (200, not
// 2000) because each entry here is a full message body, not a log line —
// unbounded growth would eat localStorage quota fast.

export const CHAT_STORAGE_KEY = 'nook_chat_history';
const MAX_MESSAGES = 200;

export function loadChatHistory() {
  try { return JSON.parse(localStorage.getItem(CHAT_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

// Persists the given message list, trimmed to the cap (oldest dropped
// first). Returns the (possibly trimmed) list so the caller's state stays
// in sync with what was actually written.
export function saveChatHistory(messages) {
  const capped = messages.length > MAX_MESSAGES ? messages.slice(messages.length - MAX_MESSAGES) : messages;
  try { localStorage.setItem(CHAT_STORAGE_KEY, JSON.stringify(capped)); } catch {}
  return capped;
}

export function clearChatHistory() {
  try { localStorage.removeItem(CHAT_STORAGE_KEY); } catch {}
}
