import { describe, it, expect, vi } from 'vitest';
import { makeAppliedHandler } from './useSyncApplied.js';

describe('makeAppliedHandler', () => {
  it('refreshes and acknowledges the names the view cares about', () => {
    const cb = vi.fn(() => undefined);
    const ack = vi.fn();
    makeAppliedHandler(['notes'], () => cb, ack)(['links', 'notes']);
    expect(cb).toHaveBeenCalledWith(['notes']);
    expect(ack).toHaveBeenCalledWith(['notes']);
  });

  it('ignores events that are not about this view', () => {
    const cb = vi.fn(), ack = vi.fn();
    makeAppliedHandler(['notes'], () => cb, ack)(['links']);
    expect(cb).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('does NOT acknowledge when the view deliberately skipped the refresh (returns false)', () => {
    // e.g. the journal editor has unsaved keystrokes, or the chat is mid-reply. The view
    // has not seen the merged data, so the engine must keep guarding it.
    const cb = vi.fn(() => false), ack = vi.fn();
    makeAppliedHandler(['journal'], () => cb, ack)(['journal']);
    expect(cb).toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
  });

  it('always calls the latest callback (it reads it through a getter)', () => {
    let current = vi.fn();
    const ack = vi.fn();
    const handler = makeAppliedHandler(['notes'], () => current, ack);
    const next = vi.fn();
    current = next;
    handler(['notes']);
    expect(next).toHaveBeenCalled();
  });
});
