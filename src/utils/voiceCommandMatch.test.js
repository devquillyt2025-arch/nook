import { describe, it, expect } from 'vitest';
import { matchIncompleteTasks, normalizeTitle } from './voiceCommandMatch';

function task(name, completed = false) {
  return { id: name, name, completed };
}

describe('matchIncompleteTasks — complete_task auto-execute gate', () => {
  // The only thing allowed to trigger auto-execute is exactly one match here.
  // These cases prove the 0-match and 2+-match paths fail SAFE (fall back to
  // confirm-UI) rather than fail OPEN (guess a task to complete).

  it('returns exactly one match for an exact title — the only case eligible for auto-execute', () => {
    const tasks = [task('Call the plumber'), task('Buy groceries')];
    const matches = matchIncompleteTasks('call the plumber', tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('Call the plumber');
  });

  it('returns zero matches for a phrase matching no task — must fall back, never guess', () => {
    const tasks = [task('Call the plumber'), task('Buy groceries')];
    const matches = matchIncompleteTasks('water the plants', tasks);
    expect(matches).toHaveLength(0);
  });

  it('returns two matches when two incomplete tasks share the same normalized name — must fall back, not pick one', () => {
    const tasks = [task('Call the plumber'), task('call the plumber')];
    const matches = matchIncompleteTasks('call the plumber', tasks);
    expect(matches).toHaveLength(2);
  });

  it('returns multiple matches when the query fuzzily matches several distinct tasks — must fall back', () => {
    const tasks = [task('Email Sarah'), task('Email Sam'), task('Buy groceries')];
    const matches = matchIncompleteTasks('email sa', tasks);
    // Substring containment matches both "Email Sarah" and "Email Sam" — ambiguous, not auto-executed.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  it('ignores completed tasks entirely, even on an exact title match', () => {
    const tasks = [task('Call the plumber', true), task('Buy groceries')];
    const matches = matchIncompleteTasks('call the plumber', tasks);
    expect(matches).toHaveLength(0);
  });

  it('matches near-exact phrasing (case, trailing punctuation) as a single candidate', () => {
    const tasks = [task('Call the plumber'), task('Buy groceries')];
    const matches = matchIncompleteTasks('Call the plumber.', tasks);
    expect(matches).toHaveLength(1);
  });

  it('matches a minor typo within the near-exact distance threshold', () => {
    const tasks = [task('Call the plumber'), task('Buy groceries')];
    const matches = matchIncompleteTasks('call the plumer', tasks); // one dropped letter
    expect(matches).toHaveLength(1);
  });

  it('prefers exact matches over fuzzy ones — an exact hit is never diluted by a loose one', () => {
    const tasks = [task('Call the plumber'), task('Call the plummer')]; // second is a fuzzy near-miss of the query
    const matches = matchIncompleteTasks('call the plumber', tasks);
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe('Call the plumber');
  });

  it('returns zero matches for an empty query', () => {
    const tasks = [task('Call the plumber')];
    expect(matchIncompleteTasks('', tasks)).toHaveLength(0);
    expect(matchIncompleteTasks('   ', tasks)).toHaveLength(0);
  });

  it('handles an empty task list without throwing', () => {
    expect(matchIncompleteTasks('anything', [])).toHaveLength(0);
    expect(matchIncompleteTasks('anything', undefined)).toHaveLength(0);
  });
});

describe('normalizeTitle', () => {
  it('lowercases, trims, collapses whitespace, and drops trailing punctuation', () => {
    expect(normalizeTitle('  Call   the Plumber!  ')).toBe('call the plumber');
    expect(normalizeTitle('Buy groceries.')).toBe('buy groceries');
  });
});
