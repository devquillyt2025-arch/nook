// Journal → .docx export.
//
// A .docx is a zip of OOXML parts, and jszip is already a dependency (backup.js),
// so this builds a real Word document rather than pulling in a docx library or
// shipping an HTML file under a .docx name (Word warns on those).
//
// Read-only: this never touches localStorage. Callers pass the entries in.
import JSZip from 'jszip';
import { parseHtmlInert } from './sanitizeHtml';

// ─── XML helpers ────────────────────────────────────────────────────
const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const NUM_BULLET = 1;
const NUM_ORDERED = 2;
const BLOCK_STYLE = { h1:'Heading1', h2:'Heading2', h3:'Heading3', h4:'Heading3', h5:'Heading3', h6:'Heading3', blockquote:'Quote' };

function runXml(text, fmt = {}) {
  if (!text) return '';
  const rPr = [fmt.b && '<w:b/>', fmt.i && '<w:i/>', fmt.u && '<w:u w:val="single"/>', fmt.strike && '<w:strike/>'].filter(Boolean).join('');
  return `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>`;
}

function paraXml(runs, { style, numId, level = 0 } = {}) {
  const pPr = [
    style && `<w:pStyle w:val="${style}"/>`,
    numId && `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>`,
  ].filter(Boolean).join('');
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ''}${runs.join('')}</w:p>`;
}

const pageBreak = () => '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

// ─── HTML → WordprocessingML ────────────────────────────────────────
// Inline runs for a node, skipping any nested block-level children (those are
// walked separately so a <ul> inside an <li> doesn't collapse into its parent).
function collectRuns(node, fmt, out) {
  node.childNodes.forEach(ch => {
    if (ch.nodeType === 3) { if (ch.nodeValue) out.push(runXml(ch.nodeValue, fmt)); return; }
    if (ch.nodeType !== 1) return;
    const t = ch.tagName.toLowerCase();
    if (t === 'br') { out.push('<w:r><w:br/></w:r>'); return; }
    if (t === 'ul' || t === 'ol' || t === 'li') return;
    const next = { ...fmt };
    if (t === 'b' || t === 'strong') next.b = true;
    if (t === 'i' || t === 'em') next.i = true;
    if (t === 'u' || t === 'ins') next.u = true;
    if (t === 's' || t === 'strike' || t === 'del') next.strike = true;
    collectRuns(ch, next, out);
  });
}

function walkBlocks(node, ctx, out) {
  node.childNodes.forEach(ch => {
    if (ch.nodeType === 3) {
      if (ch.nodeValue.trim()) out.push(paraXml([runXml(ch.nodeValue)], ctx));
      return;
    }
    if (ch.nodeType !== 1) return;
    const t = ch.tagName.toLowerCase();

    if (t === 'ul' || t === 'ol') {
      walkBlocks(ch, { numId: t === 'ol' ? NUM_ORDERED : NUM_BULLET, level: ctx.numId ? Math.min((ctx.level ?? 0) + 1, 8) : 0 }, out);
      return;
    }
    if (t === 'li') {
      const runs = [];
      collectRuns(ch, {}, runs);
      out.push(paraXml(runs.length ? runs : [runXml('')], ctx));
      // Nested lists: re-enter through the ul/ol branch so the level increments.
      ch.childNodes.forEach(g => {
        if (g.nodeType === 1 && /^(ul|ol)$/i.test(g.tagName)) walkBlocks({ childNodes: [g] }, ctx, out);
      });
      return;
    }
    if (t === 'div' && !ch.querySelector('p, h1, h2, h3, h4, h5, h6, blockquote, ul, ol')) {
      const runs = [];
      collectRuns(ch, {}, runs);
      out.push(paraXml(runs));
      return;
    }
    if (t === 'div') { walkBlocks(ch, ctx, out); return; }

    const style = BLOCK_STYLE[t];
    if (style || t === 'p') {
      const runs = [];
      collectRuns(ch, {}, runs);
      out.push(paraXml(runs, { style }));
      return;
    }
    // Anything else (span, a, formatting wrappers at top level) — inline it.
    const runs = [];
    collectRuns(ch, {}, runs);
    if (runs.length) out.push(paraXml(runs));
  });
}

// Journal content is either rich-text HTML or legacy plain text (see toHtml in
// JournalView) — the caller normalises to HTML before handing it over.
function blocksFromHtml(html) {
  // Inert parse: `div.innerHTML = html` would load <img> and run its onerror (see sanitizeHtml.js).
  const host = parseHtmlInert(html);
  const out = [];
  walkBlocks(host, {}, out);
  return out.length ? out : [paraXml([runXml('')])];
}

// ─── Package parts ──────────────────────────────────────────────────
const CONTENT_TYPES = `${XML_DECL}
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
</Types>`;

const ROOT_RELS = `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;

const DOC_RELS = `${XML_DECL}
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
</Relationships>`;

// Sizes are half-points (w:sz) and twentieths of a point (w:spacing/w:ind).
const STYLES = `${XML_DECL}
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>
<w:rFonts w:ascii="Georgia" w:hAnsi="Georgia" w:cs="Georgia"/><w:sz w:val="22"/><w:szCs w:val="22"/>
</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="52"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="480"/></w:pPr><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:color w:val="7A7A7A"/><w:sz w:val="20"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="EntryDate"><w:name w:val="Entry Date"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:before="80" w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="34"/><w:color w:val="1F1F1F"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="EntryMeta"><w:name w:val="Entry Meta"/><w:basedOn w:val="Normal"/>
<w:pPr><w:spacing w:after="280"/><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="6" w:color="D8D2C6"/></w:pBdr></w:pPr>
<w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:caps/><w:color w:val="9A8F7D"/><w:sz w:val="16"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="280" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="30"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="1"/><w:spacing w:before="240" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/>
<w:pPr><w:outlineLvl w:val="2"/><w:spacing w:before="200" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/>
<w:pPr><w:ind w:left="480"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="10" w:color="C9A227"/></w:pBdr></w:pPr>
<w:rPr><w:i/><w:color w:val="5A5A5A"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="EmptyNote"><w:name w:val="Empty Note"/><w:basedOn w:val="Normal"/>
<w:rPr><w:i/><w:color w:val="9A9A9A"/></w:rPr></w:style>
</w:styles>`;

function lvlXml(i, ordered) {
  const ind = 360 + i * 360;
  return ordered
    ? `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%${i + 1}."/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind + 360}" w:hanging="360"/></w:pPr></w:lvl>`
    : `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${['•','◦','▪'][i % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${ind + 360}" w:hanging="360"/></w:pPr></w:lvl>`;
}

const LEVELS = Array.from({ length: 9 }, (_, i) => i);
const NUMBERING = `${XML_DECL}
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${LEVELS.map(i => lvlXml(i, false)).join('')}</w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${LEVELS.map(i => lvlXml(i, true)).join('')}</w:abstractNum>
<w:num w:numId="${NUM_BULLET}"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="${NUM_ORDERED}"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

function coreXml(title) {
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return `${XML_DECL}
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${esc(title)}</dc:title><dc:creator>Nook</dc:creator><cp:lastModifiedBy>Nook</cp:lastModifiedBy>
<dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

// A4 portrait, 1" margins.
const SECT_PR = '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>';

function documentXml(bodyXml) {
  return `${XML_DECL}
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<w:body>${bodyXml}${SECT_PR}</w:body></w:document>`;
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Public API ─────────────────────────────────────────────────────
// entries: [{ date:'YYYY-MM-DD', html, wordCount, icon }] — caller-normalised,
// already filtered to the range and sorted oldest → newest.
export async function buildJournalDocx({ title, subtitle, entries }) {
  const parts = [
    paraXml([runXml(title)], { style: 'Title' }),
    paraXml([runXml(subtitle)], { style: 'Subtitle' }),
  ];

  entries.forEach((e, i) => {
    if (i > 0) parts.push(pageBreak());
    parts.push(paraXml([runXml(`${e.icon ? `${e.icon}  ` : ''}${e.heading}`)], { style: 'EntryDate' }));
    parts.push(paraXml([runXml(`${e.wordCount} ${e.wordCount === 1 ? 'word' : 'words'}`)], { style: 'EntryMeta' }));
    parts.push(...blocksFromHtml(e.html));
  });

  if (!entries.length) parts.push(paraXml([runXml('No journal entries in this range.')], { style: 'EmptyNote' }));

  const zip = new JSZip();
  zip.file('[Content_Types].xml', CONTENT_TYPES);
  zip.folder('_rels').file('.rels', ROOT_RELS);
  zip.folder('docProps').file('core.xml', coreXml(title));
  const word = zip.folder('word');
  word.file('document.xml', documentXml(parts.join('')));
  word.file('styles.xml', STYLES);
  word.file('numbering.xml', NUMBERING);
  word.folder('_rels').file('document.xml.rels', DOC_RELS);

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
  });
}

export async function exportJournalDocx({ title, subtitle, entries, filename }) {
  const blob = await buildJournalDocx({ title, subtitle, entries });
  triggerDownload(blob, filename);
  return { entries: entries.length, words: entries.reduce((s, e) => s + e.wordCount, 0) };
}
