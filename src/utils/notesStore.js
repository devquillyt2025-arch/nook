// ─── Notes create/read (localStorage) ──────────────────────────────────
// Extracted out of NotesView so a note can be created from outside the Notes
// tab (voice commands) without duplicating the read-modify-write + activity
// logging NotesView already did inline. NotesView still owns its own `notes`
// React state (for live filtering/sorting while mounted) and its own
// delete/pin/color-change/migration logic — only note creation/save moved
// here, since that's the only piece the voice-command dispatcher needs.
//
// When a write happens while NotesView happens to be mounted, this module
// fires the 'nook-notes-changed' window event so NotesView's listener can
// reload from localStorage instead of its in-memory state going stale —
// mirrors the 'nook-activity-updated' pattern in utils/activityLog.js.

import { logActivity } from './activityLog';

export const NOTES_STORAGE_KEY = 'nook_notes';

export function loadNotes() {
  try { return JSON.parse(localStorage.getItem(NOTES_STORAGE_KEY) || '[]'); }
  catch { return []; }
}

export function newNote(overrides = {}) {
  return {
    id:        Date.now().toString(),
    title:     '',
    content:   '',
    color:     'default',
    pinned:    false,
    tags:      [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// When a note was ADDED, in ms. The Notes list is ordered by this — not by `updatedAt`,
// which every edit, recolour or pin restamps (cross-device sync's last-write-wins needs
// that) and which the editor also restamps on close even if nothing changed, so sorting
// on it made a note jump to the top just for being opened. Falls back to the id
// (Date.now() at creation) for a note with no usable createdAt; 0 if neither parses.
export function addedAt(note) {
  const t = Date.parse(note?.createdAt);
  return Number.isFinite(t) ? t : (Number(note?.id) || 0);
}

// Create-or-update, read-modify-write against whatever is currently on disk
// (not a caller-held array — the caller may be mounted somewhere that never
// synced with the latest NotesView state, or NotesView may not be mounted at
// all). Persists, logs, notifies, and returns the updated list.
export function saveNote(note) {
  const prev = loadNotes();
  const exists = prev.find(n => n.id === note.id);
  logActivity({ module: 'notes', entity_type: 'note', entity_id: note.id, action: exists ? 'updated' : 'created', title: note.title || '(untitled)' });
  const updated = exists ? prev.map(n => n.id === note.id ? note : n) : [note, ...prev];
  try { localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(updated)); } catch {}
  try { window.dispatchEvent(new Event('nook-notes-changed')); } catch {}
  return updated;
}
