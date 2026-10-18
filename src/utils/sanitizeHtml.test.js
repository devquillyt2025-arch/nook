// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { sanitizeJournalHtml, htmlToPlainText, parseHtmlInert } from './sanitizeHtml';

// Parse the sanitiser's OUTPUT and assert nothing executable or loadable survived — checking the
// tree (not a string match) is what catches mutation-XSS, where markup re-parses into something else.
function expectInert(html) {
  const out = sanitizeJournalHtml(html);
  const doc = new DOMParser().parseFromString(out, 'text/html');
  const bad = [...doc.querySelectorAll('script,style,img,svg,math,iframe,object,embed,form,input,a,link,meta,base,noscript,template,video,audio')];
  expect(bad.map(n => n.tagName)).toEqual([]);
  for (const el of doc.querySelectorAll('*')) {
    for (const a of el.attributes) {
      expect(a.name.startsWith('on')).toBe(false);
      expect(/javascript:|data:text|vbscript:/i.test(a.value)).toBe(false);
    }
  }
  return out;
}

describe('sanitizeJournalHtml', () => {
  it('keeps everything the editor produces', () => {
    const html = '<p>Hello <b>bold</b> <i>it</i> <u>under</u></p><h1>One</h1><h2>Two</h2><h3>Three</h3>'
      + '<blockquote>quoted</blockquote><ul><li>a</li><li>b</li></ul><ol><li>c</li></ol><p><br></p><div>line</div>';
    expect(sanitizeJournalHtml(html)).toBe(html);
  });

  it('removes script, event handlers, javascript: links, iframes and svg', () => {
    for (const evil of [
      '<p>x</p><script>window.__pwned=1</script>',
      '<img src=x onerror="window.__pwned=1">',
      '<svg onload="window.__pwned=1"></svg>',
      '<a href="javascript:window.__pwned=1">click</a>',
      '<iframe src="https://evil.example"></iframe>',
      '<p onclick="window.__pwned=1">x</p>',
      '<body onload="window.__pwned=1">',
      '<form action="https://evil.example"><input name=pw></form>',
      '<object data="https://evil.example"></object><embed src="https://evil.example">',
      '<link rel="stylesheet" href="https://evil.example/x.css"><meta http-equiv="refresh" content="0;url=https://evil.example">',
    ]) {
      expectInert(evil);
    }
  });

  it('resists known mutation-XSS vectors', () => {
    for (const evil of [
      '<svg></p><style><a id="</style><img src=1 onerror=window.__pwned=1>">',
      '<noscript><p title="</noscript><img src=x onerror=window.__pwned=1>">',
      '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=window.__pwned=1&gt;">',
      '<form><math><mtext></form><form><mglyph><style></math><img src onerror=window.__pwned=1>',
      '<p>a<template><img src=x onerror=window.__pwned=1></template></p>',
      '<div><svg><desc><![CDATA[</desc><script>window.__pwned=1</script>]]></svg></div>',
    ]) {
      expectInert(evil);
    }
  });

  it('keeps the text of a stripped element but not its markup', () => {
    expect(sanitizeJournalHtml('<p>keep <script>drop()</script>this</p>')).toBe('<p>keep this</p>');
    expect(htmlToPlainText(sanitizeJournalHtml('<custom-tag>words</custom-tag>'))).toBe('words');
  });

  it('drops class, id, data- and aria- attributes', () => {
    expect(sanitizeJournalHtml('<p class="a" id="b" data-x="1" aria-label="c">t</p>')).toBe('<p>t</p>');
  });

  describe('style', () => {
    it('keeps plain formatting declarations', () => {
      const out = sanitizeJournalHtml('<span style="color: red; font-weight: bold; text-align: center">x</span>');
      expect(out).toContain('color: red');
      expect(out).toContain('font-weight: bold');
      expect(out).toContain('text-align: center');
    });

    it('keeps rgb()/hsl()/hex colours', () => {
      expect(sanitizeJournalHtml('<span style="background-color: rgb(255, 255, 0)">x</span>')).toContain('rgb(255, 255, 0)');
      expect(sanitizeJournalHtml('<span style="color:#ff0000">x</span>')).toContain('#ff0000');
    });

    it('drops anything that could load a resource or restyle the page', () => {
      for (const style of [
        'background: url(https://evil.example/track.gif)',
        'background-color: url(https://evil.example/x)',
        'color: red; background-image: url(//evil.example/x)',
        'position: fixed; inset: 0; z-index: 9999',
        'width: expression(alert(1))',
        'color: \\72 ed',
        'color: var(--accent)',
        '@import url(https://evil.example/x.css)',
        'font-family: "x"; behavior: url(x.htc)',
      ]) {
        const out = sanitizeJournalHtml(`<span style="${style}">x</span>`);
        expect(out).not.toMatch(/url|expression|position|inset|z-index|import|behavior|image/i);
      }
    });

    it('keeps the safe declaration when a dangerous one sits beside it', () => {
      const out = sanitizeJournalHtml('<span style="color: red; background: url(https://evil.example/x)">x</span>');
      expect(out).toContain('color: red');
      expect(out).not.toMatch(/url|evil/i);
    });

    it('removes the attribute entirely when nothing safe is left', () => {
      expect(sanitizeJournalHtml('<span style="position: fixed">x</span>')).toBe('<span>x</span>');
    });
  });

  it('is idempotent', () => {
    const evil = '<p style="color:red; background:url(x)">a<img src=x onerror=1><b>b</b></p>';
    const once = sanitizeJournalHtml(evil);
    expect(sanitizeJournalHtml(once)).toBe(once);
  });

  it('turns null, undefined and empty into an empty string', () => {
    expect(sanitizeJournalHtml(null)).toBe('');
    expect(sanitizeJournalHtml(undefined)).toBe('');
    expect(sanitizeJournalHtml('')).toBe('');
  });

  it('treats a non-string as text, not markup', () => {
    expect(sanitizeJournalHtml(42)).toBe('42');
  });
});

describe('htmlToPlainText', () => {
  it('returns the visible text', () => {
    expect(htmlToPlainText('<p>Hello <b>world</b></p><p>again</p>')).toBe('Hello worldagain');
  });
  it('ignores markup it does not understand and handles empties', () => {
    expect(htmlToPlainText('<img src=x onerror="window.__pwned=1">just text')).toBe('just text');
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText('')).toBe('');
  });
});

describe('parseHtmlInert', () => {
  it('returns a body whose children can be walked, without running anything', () => {
    const body = parseHtmlInert('<p>a</p><script>window.__pwned=1</script><ul><li>b</li></ul>');
    expect(body.childNodes.length).toBeGreaterThan(0);
    expect(body.querySelector('ul li').textContent).toBe('b');
    expect(globalThis.__pwned).toBeUndefined();
  });
  it('copes with null', () => {
    expect(parseHtmlInert(null).childNodes.length).toBe(0);
  });
});
