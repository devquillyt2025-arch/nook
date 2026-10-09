import { describe, it, expect } from 'vitest';
import { dedupeTrackers } from './trackerUtils.js';

const T = (id, name, createdAt, extra = {}) => ({ id, name, createdAt, type: 'habit', logs: [], config: {}, ...extra });

describe('dedupeTrackers', () => {
  it('keeps everything when there are no duplicates, in order', () => {
    const list = [T('a', 'Water', '2026-01-01'), T('b', 'Run', '2026-01-02')];
    expect(dedupeTrackers(list).map(t => t.id)).toEqual(['a', 'b']);
  });

  it('drops a repeated id (keeps the first)', () => {
    const list = [T('a', 'Water', '2026-01-01'), T('a', 'Water', '2026-01-01', { logs: [1] })];
    expect(dedupeTrackers(list)).toHaveLength(1);
  });

  it('treats names case-insensitively and ignores surrounding spaces', () => {
    const list = [T('a', 'Water', '2026-01-01'), T('b', '  water ', '2026-01-02')];
    expect(dedupeTrackers(list).map(t => t.id)).toEqual(['a']);
  });

  it('picks the SAME survivor whatever order the devices hold the list in', () => {
    // Two devices each created a tracker called "Water" while apart, then synced.
    // Device 1 sees [its own, the remote one]; device 2 sees them the other way round.
    // If each kept "the first", device 1 would delete the remote copy and device 2 its
    // own — and cross-device sync would then delete BOTH. They must agree.
    const x1 = T('x1', 'Water', '2026-03-01T09:00:00Z');
    const x2 = T('x2', 'Water', '2026-03-01T09:00:05Z');
    const onDevice1 = dedupeTrackers([x2, x1]);          // remote item merged to the front
    const onDevice2 = dedupeTrackers([x1, x2]);
    expect(onDevice1.map(t => t.id)).toEqual(['x1']);
    expect(onDevice2.map(t => t.id)).toEqual(['x1']);
  });

  it('falls back to the id when createdAt ties or is missing', () => {
    expect(dedupeTrackers([T('b', 'Run'), T('a', 'Run')]).map(t => t.id)).toEqual(['a']);
    expect(dedupeTrackers([T('b', 'Run', '2026-01-01'), T('a', 'Run', '2026-01-01')]).map(t => t.id)).toEqual(['a']);
  });

  it('keeps the survivor where it was in the list and drops only the losers', () => {
    const list = [T('c', 'Read', '2026-01-03'), T('a', 'Water', '2026-01-01'), T('b', 'Water', '2026-01-02')];
    expect(dedupeTrackers(list).map(t => t.id)).toEqual(['c', 'a']);
  });
});
