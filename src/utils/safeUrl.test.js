import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeHttpUrl, openSafeUrl } from './safeUrl';

describe('safeHttpUrl', () => {
  it('accepts http and https and normalises', () => {
    expect(safeHttpUrl('https://example.com')).toBe('https://example.com/');
    expect(safeHttpUrl('  https://example.com/a?b=1#c  ')).toBe('https://example.com/a?b=1#c');
    expect(safeHttpUrl('http://localhost:5173/x')).toBe('http://localhost:5173/x');
  });

  it('rejects script-bearing and non-web schemes, whatever the case or padding', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)',
      '\tjavascript:alert(1)',
      'java\nscript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'file:///etc/passwd',
      'blob:https://example.com/uuid',
      'ftp://example.com',
      'chrome://settings',
    ]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });

  it('rejects things that are not absolute URLs', () => {
    for (const bad of ['', '   ', 'example.com', '//evil.example', '/relative', 'not a url', null, undefined, 42, {}, []]) {
      expect(safeHttpUrl(bad)).toBeNull();
    }
  });
});

describe('openSafeUrl', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('opens a safe URL in a new tab with no opener and no referrer', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    expect(openSafeUrl('https://example.com')).toBe(true);
    expect(open).toHaveBeenCalledWith('https://example.com/', '_blank', 'noopener,noreferrer');
  });

  it('does nothing for an unsafe URL', () => {
    const open = vi.fn();
    vi.stubGlobal('window', { open });
    expect(openSafeUrl('javascript:alert(1)')).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
});
