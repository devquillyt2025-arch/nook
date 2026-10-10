import { describe, it, expect, beforeEach, vi } from 'vitest';
import { addedAt, saveNote, loadNotes, newNote } from './notesStore';

// A minimal localStorage — notesStore (and the activity log it writes to) only
// need get / set.
beforeEach(() => {
  const store = new Map();
  vi.stubGlobal('localStorage', { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) });
});

// What NotesView does to order the list (default sort).
const ordered = notes => [...notes].sort((a, b) => addedAt(b) - addedAt(a)).map(n => n.title);

const at = (iso, o) => newNote({ createdAt: iso, updatedAt: iso, ...o });

describe('addedAt', () => {
  it('is the creation time', () => {
    expect(addedAt({ createdAt: '2026-10-01T10:00:00.000Z' })).toBe(Date.parse('2026-10-01T10:00:00.000Z'));
  });
  it('falls back to the id (Date.now() at creation) when createdAt is missing or unreadable', () => {
    expect(addedAt({ id: '1790000000000' })).toBe(1790000000000);
    expect(addedAt({ id: '1790000000000', createdAt: 'not a date' })).toBe(1790000000000);
  });
  it('is 0 — never NaN — when nothing parses, so sorting stays well-defined', () => {
    expect(addedAt({})).toBe(0);
    expect(addedAt({ id: 'abc', createdAt: null })).toBe(0);
    expect(addedAt(undefined)).toBe(0);
  });
});

describe('a note keeps its place', () => {
  const seed = () => {
    saveNote(at('2026-10-01T09:00:00.000Z', { id: 'a', title: 'oldest' }));
    saveNote(at('2026-10-02T09:00:00.000Z', { id: 'b', title: 'middle' }));
    saveNote(at('2026-10-03T09:00:00.000Z', { id: 'c', title: 'newest' }));
  };

  it('lists newest-added first', () => {
    seed();
    expect(ordered(loadNotes())).toEqual(['newest', 'middle', 'oldest']);
  });

  it('does not move when it is edited (the editor restamps updatedAt to now)', () => {
    seed();
    const before = ordered(loadNotes());
    const note = loadNotes().find(n => n.id === 'a');
    saveNote({ ...note, title: 'oldest', content: 'edited', updatedAt: new Date().toISOString() });
    expect(ordered(loadNotes())).toEqual(before);
  });

  it('does not move when it is merely opened and closed (saved unchanged, updatedAt restamped)', () => {
    seed();
    const before = ordered(loadNotes());
    const note = loadNotes().find(n => n.id === 'b');
    saveNote({ ...note, updatedAt: new Date(Date.now() + 5000).toISOString() });
    expect(ordered(loadNotes())).toEqual(before);
  });

  it('does not move when it is pinned-toggled or recoloured', () => {
    seed();
    const before = ordered(loadNotes());
    const note = loadNotes().find(n => n.id === 'a');
    saveNote({ ...note, color: 'red', pinned: false, updatedAt: new Date().toISOString() });
    expect(ordered(loadNotes())).toEqual(before);
  });

  it('puts a brand-new note first, and the edited one still where it was', () => {
    seed();
    const note = loadNotes().find(n => n.id === 'a');
    saveNote({ ...note, content: 'edited', updatedAt: new Date().toISOString() });
    saveNote(at('2026-10-04T09:00:00.000Z', { id: 'd', title: 'brand new' }));
    expect(ordered(loadNotes())).toEqual(['brand new', 'newest', 'middle', 'oldest']);
  });

  it('keeps the storage order of an edited note too (saveNote replaces in place)', () => {
    seed();
    const idsBefore = loadNotes().map(n => n.id);
    saveNote({ ...loadNotes().find(n => n.id === 'a'), content: 'x', updatedAt: new Date().toISOString() });
    expect(loadNotes().map(n => n.id)).toEqual(idsBefore);
  });
});
