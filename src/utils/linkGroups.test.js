import { describe, it, expect } from 'vitest';
import { UNCAT, UNCAT_LABEL, catKeyOf, groupLinks } from './linkGroups';

const L = (id, category, extra = {}) => ({ id, name: id, url: `https://${id}.com`, category, ...extra });

describe('catKeyOf', () => {
  it('is the trimmed, lower-cased category', () => {
    expect(catKeyOf({ category: 'Work' })).toBe('work');
    expect(catKeyOf({ category: '  Read Later ' })).toBe('read later');
  });
  it('is UNCAT for a missing, blank or non-string category', () => {
    for (const c of [undefined, null, '', '   ', 5, {}]) expect(catKeyOf({ category: c })).toBe(UNCAT);
    expect(catKeyOf(undefined)).toBe(UNCAT);
  });
});

describe('groupLinks', () => {
  it('makes one group per category', () => {
    const g = groupLinks([L('a', 'Dev'), L('b', 'Tools'), L('c', 'Dev')]);
    expect(g.map(x => [x.label, x.links.map(l => l.id)])).toEqual([['Dev', ['a', 'c']], ['Tools', ['b']]]);
  });

  it('merges spellings that differ only by case or surrounding space, labelled with the most common one', () => {
    const g = groupLinks([L('a', 'work'), L('b', 'Work'), L('c', 'Work '), L('d', ' WORK')]);
    expect(g).toHaveLength(1);
    expect(g[0].key).toBe('work');
    expect(g[0].label).toBe('Work');   // 'Work' is used twice (the trimmed 'Work ' counts with it), the others once
    expect(g[0].links).toHaveLength(4);
  });

  it('breaks a spelling tie in favour of the first one seen', () => {
    expect(groupLinks([L('a', 'dev'), L('b', 'Dev')])[0].label).toBe('dev');
  });

  it('puts links with no category in Uncategorised, always last', () => {
    const g = groupLinks([L('a', ''), L('b', 'Zebra'), L('c', undefined), L('d', 'Apple')]);
    expect(g.map(x => x.label)).toEqual(['Apple', 'Zebra', UNCAT_LABEL]);
    expect(g[2]).toMatchObject({ key: UNCAT, label: UNCAT_LABEL });
    expect(g[2].links.map(l => l.id)).toEqual(['a', 'c']);
  });

  it('sorts A–Z ignoring case, so tile positions are stable as links are added', () => {
    const g = groupLinks([L('a', 'banana'), L('b', 'Apple'), L('c', 'cherry')]);
    expect(g.map(x => x.label)).toEqual(['Apple', 'banana', 'cherry']);
  });

  it('lists starred links first inside a group and otherwise keeps the given order', () => {
    const g = groupLinks([L('a', 'Dev'), L('b', 'Dev', { starred: true }), L('c', 'Dev'), L('d', 'Dev', { starred: true })]);
    expect(g[0].links.map(l => l.id)).toEqual(['b', 'd', 'a', 'c']);
  });

  it('does not change or reorder the input', () => {
    const input = [L('a', 'Dev'), L('b', 'Dev', { starred: true })];
    const copy = JSON.stringify(input);
    groupLinks(input);
    expect(JSON.stringify(input)).toBe(copy);
  });

  it('copes with empty and malformed input', () => {
    expect(groupLinks([])).toEqual([]);
    expect(groupLinks(undefined)).toEqual([]);
    expect(groupLinks('nope')).toEqual([]);
    const g = groupLinks([null, undefined, 'x', 7, L('a', 'Dev')]);
    expect(g).toHaveLength(1);
    expect(g[0].links.map(l => l.id)).toEqual(['a']);
  });

  it('every link lands in exactly one group', () => {
    const links = Array.from({ length: 40 }, (_, i) => L('l' + i, ['Dev', 'dev', 'Tools', '', undefined, 'News'][i % 6]));
    const g = groupLinks(links);
    expect(g.reduce((n, x) => n + x.links.length, 0)).toBe(40);
    expect(new Set(g.flatMap(x => x.links.map(l => l.id))).size).toBe(40);
  });
});
