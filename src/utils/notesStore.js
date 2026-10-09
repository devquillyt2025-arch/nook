// ─── Notes data layer (Neon cloud + localStorage fallback) ────────
// Cloud key: 'notes'  |  Local fallback key: 'nook_notes'

import { logActivity } from './activityLog';
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

export const NOTES_STORAGE_KEY = 'nook_notes';
const CLOUD_KEY = 'notes';

// ── Load ──────────────────────────────────────────────────────────
export async function loadNotes() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  // fallback to localStorage when offline / unauthenticated
  return lsGet(NOTES_STORAGE_KEY, []);
}

// ── Save ──────────────────────────────────────────────────────────
export async function saveNotesList(notes) {
  await cloudSet(CLOUD_KEY, notes);
  lsSet(NOTES_STORAGE_KEY, notes); // keep local cache in sync
}

// ── Helpers ───────────────────────────────────────────────────────
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

// Create-or-update: reads current list, merges, saves, notifies.
export async function saveNote(note) {
  const prev = await loadNotes();
  const exists = prev.find(n => n.id === note.id);
  logActivity({
    module: 'notes', entity_type: 'note', entity_id: note.id,
    action: exists ? 'updated' : 'created',
    title: note.title || '(untitled)',
  });
  const updated = exists
    ? prev.map(n => n.id === note.id ? note : n)
    : [note, ...prev];
  await saveNotesList(updated);
  try { window.dispatchEvent(new Event('nook-notes-changed')); } catch {}
  return updated;
}
