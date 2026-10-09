import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatPickedDate } from './DateInput.jsx';
import { formatPickedTime } from './TimeInput.jsx';

const dir = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(dir, '..');

// The browser draws native <select> lists and <input type="date|time"> popups itself, and
// they ignore the app theme (dark/light, accent, fonts). Every such control in Nook is
// built from Select / DateInput / TimeInput instead. This fails the build the moment a
// native one is added back, so the UI can't silently drift out of step again.
function* jsxFiles(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') yield* jsxFiles(p); }
    else if (/\.jsx$/.test(e.name)) yield p;
  }
}
// the three components that legitimately wrap or mention the native elements
const ALLOWED = new Set(['Select.jsx', 'DateInput.jsx', 'TimeInput.jsx']);
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, '');

describe('no native select / date / time controls', () => {
  const offenders = [];
  for (const f of jsxFiles(srcRoot)) {
    if (ALLOWED.has(path.basename(f))) continue;
    const code = stripComments(fs.readFileSync(f, 'utf8'));
    if (/<select[\s>]/.test(code)) offenders.push(`${path.relative(srcRoot, f)}: <select>  → use <Select>`);
    if (/type\s*=\s*["'{`]*\s*["'`]?(date|time|datetime-local|month|week)["'`]/.test(code)) offenders.push(`${path.relative(srcRoot, f)}: <input type="date|time…">  → use <DateInput>/<TimeInput>`);
  }
  it('uses the themed Select / DateInput / TimeInput everywhere', () => {
    expect(offenders).toEqual([]);
  });
});

describe('picker display formatting', () => {
  it('formats a date the way the field shows it', () => {
    expect(formatPickedDate('2026-10-09')).toBe('Oct 9, 2026');
    expect(formatPickedDate('2026-01-01')).toBe('Jan 1, 2026');
    expect(formatPickedDate('')).toBe('');
  });
  it('does not shift the day across a DST change (anchored at local noon)', () => {
    expect(formatPickedDate('2026-03-08')).toBe('Mar 8, 2026');    // US spring-forward
    expect(formatPickedDate('2026-11-01')).toBe('Nov 1, 2026');    // US fall-back
  });
  it('formats a 24h time as 12h with AM/PM', () => {
    expect(formatPickedTime('00:00')).toBe('12:00 AM');
    expect(formatPickedTime('09:05')).toBe('9:05 AM');
    expect(formatPickedTime('12:00')).toBe('12:00 PM');
    expect(formatPickedTime('14:30')).toBe('2:30 PM');
    expect(formatPickedTime('23:59')).toBe('11:59 PM');
    expect(formatPickedTime('')).toBe('');
  });
});
