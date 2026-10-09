import { memo, useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { logActivity } from '../utils/activityLog';
import { localDateStr } from '../utils/date';
import { exportJournalDocx } from '../utils/journalDocx';

// ─── Shared SVG props ───────────────────────────────────────────────
const S = { fill:'none', stroke:'currentColor', strokeWidth:'2', strokeLinecap:'round', strokeLinejoin:'round' };
// Framer-motion variants — staggered fade-in for the ambient metadata panel.
const META_CONTAINER = { hidden: {}, show: { transition: { staggerChildren: 0.07, delayChildren: 0.04 } } };
const META_ITEM = { hidden: { opacity: 0, y: 10 }, show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: [0.16, 1, 0.3, 1] } } };

// Scopes offered by the .docx export panel, all anchored to the viewed date.
const EXPORT_SCOPES = [
  { key: 'day',   label: 'Day' },
  { key: 'week',  label: 'Week' },
  { key: 'month', label: 'Month' },
  { key: 'year',  label: 'Year' },
];

// ─── Storage helpers ────────────────────────────────────────────────
const jKey = d => `nook_journal_${d}`;
const ICONS_KEY = 'nook_journal_icons';

function emptyEntry(date) {
  return { date, content: '', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
}

function loadEntry(date) {
  try { const raw = localStorage.getItem(jKey(date)); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function persistEntry(date, entry) {
  try { localStorage.setItem(jKey(date), JSON.stringify({ ...entry, updatedAt: new Date().toISOString() })); } catch {}
}

function loadAllEntries() {
  const out = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith('nook_journal_')) continue;
    try { const e = JSON.parse(localStorage.getItem(key)); if (e?.date) out.push(e); } catch {}
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

function loadIcons() {
  try { return JSON.parse(localStorage.getItem(ICONS_KEY) || '{}'); } catch { return {}; }
}
function persistIcons(map) {
  try { localStorage.setItem(ICONS_KEY, JSON.stringify(map)); } catch {}
}

// ─── Content helpers ────────────────────────────────────────────────
function isHtmlContent(str) {
  return /<[a-z][\s\S]*>/i.test(str);
}

function toHtml(content) {
  if (!content) return '';
  if (isHtmlContent(content)) return content;
  return content.split('\n').map(line =>
    line.trim()
      ? `<p>${line.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}</p>`
      : '<p><br></p>'
  ).join('');
}

function htmlToText(html) {
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  return d.textContent || d.innerText || '';
}

function wordCountFromHtml(html) {
  const text = htmlToText(html).trim();
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function hasContentHtml(e) {
  if (!e) return false;
  return htmlToText(e.content ?? '').trim().length > 0;
}

// ─── Date helpers ───────────────────────────────────────────────────
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}
function fmtDate(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}
function fmtTitleDate(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}
function relLabel(ds, today) {
  const diff = Math.round((new Date(ds + 'T00:00:00') - new Date(today + 'T00:00:00')) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === -1) return 'Yesterday';
  if (diff === 1) return 'Tomorrow';
  const yr = new Date(ds + 'T12:00:00').getFullYear();
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: yr !== new Date().getFullYear() ? 'numeric' : undefined });
}

// ─── Export ranges ──────────────────────────────────────────────────
// All bounds are inclusive [from, to] local date strings. Week is Monday-start,
// matching mondayOf() / App.jsx's getWeekStart convention.
function monthBounds(ds) {
  const d = new Date(ds + 'T12:00:00');
  const y = d.getFullYear(), m = d.getMonth();
  return { from: localDateStr(new Date(y, m, 1)), to: localDateStr(new Date(y, m + 1, 0)) };
}
function yearBounds(ds) {
  const y = new Date(ds + 'T12:00:00').getFullYear();
  return { from: localDateStr(new Date(y, 0, 1)), to: localDateStr(new Date(y, 11, 31)) };
}

function scopeRange(scope, ds) {
  if (scope === 'day')   return { from: ds, to: ds };
  if (scope === 'week')  { const from = mondayOf(ds); return { from, to: addDays(from, 6) }; }
  if (scope === 'month') return monthBounds(ds);
  return yearBounds(ds);
}

// Human title + file slug for a finished export.
function scopeMeta(scope, ds, range) {
  const d = new Date(ds + 'T12:00:00');
  if (scope === 'day')   return { title: `Journal — ${fmtTitleDate(ds)}`, slug: ds };
  if (scope === 'week')  return { title: `Journal — Week of ${fmtDate(range.from)}`, slug: `week-${range.from}` };
  if (scope === 'month') return { title: `Journal — ${d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}`, slug: `${ds.slice(0, 7)}` };
  if (scope === 'year')  return { title: `Journal — ${d.getFullYear()}`, slug: `${d.getFullYear()}` };
  return { title: `Journal — ${fmtDate(range.from)} to ${fmtDate(range.to)}`, slug: `${range.from}_${range.to}` };
}

// ─── Heatmap builder — single Monday-start week ─────────────────────
function wcLevel(wc) {
  if (!wc) return 0;
  if (wc < 100) return 1;
  if (wc < 200) return 2;
  if (wc < 300) return 3;
  return 4;
}

// App convention (App.jsx getWeekStart) is Monday-start weeks.
function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const dow = (d.getDay() + 6) % 7; // 0 = Mon … 6 = Sun
  d.setDate(d.getDate() - dow);
  return localDateStr(d);
}

function buildWeek(today, weekOffset, wcMap) {
  const start = addDays(mondayOf(today), weekOffset * 7);
  const days = [];
  for (let i = 0; i < 7; i++) {
    const ds = addDays(start, i);
    const dObj = new Date(ds + 'T12:00:00');
    const wc = wcMap[ds] || 0;
    days.push({
      date: ds,
      dow: dObj.toLocaleDateString('en-US', { weekday: 'short' }),
      num: dObj.getDate(),
      future: ds > today,
      wc,
      level: wcLevel(wc),
      isToday: ds === today,
    });
  }
  return { days, start, end: addDays(start, 6) };
}

// ─── Month grid builder (Monday-start, same convention as the week strip) ──
function firstOfMonth(today, monthOffset) {
  const d = new Date(today + 'T00:00:00');
  d.setDate(1);
  d.setMonth(d.getMonth() + monthOffset);
  return localDateStr(d);
}

function buildMonth(today, monthOffset, wcMap) {
  const first = firstOfMonth(today, monthOffset);
  const firstDate = new Date(first + 'T00:00:00');
  const monthIdx = firstDate.getMonth();
  const gridStart = mondayOf(first);                       // Monday on/before the 1st
  const daysInMonth = new Date(firstDate.getFullYear(), monthIdx + 1, 0).getDate();
  const lead = Math.round((firstDate - new Date(gridStart + 'T00:00:00')) / 86400000);
  const totalCells = Math.ceil((lead + daysInMonth) / 7) * 7; // 5 or 6 rows, no empty trailing week
  const days = [];
  for (let i = 0; i < totalCells; i++) {
    const ds = addDays(gridStart, i);
    const dObj = new Date(ds + 'T12:00:00');
    const wc = wcMap[ds] || 0;
    days.push({
      date: ds,
      num: dObj.getDate(),
      inMonth: dObj.getMonth() === monthIdx,
      future: ds > today,
      wc,
      level: wcLevel(wc),
      isToday: ds === today,
    });
  }
  return { days, first, monthIdx };
}

function monthLabel(monthOffset, firstStr) {
  if (monthOffset === 0) return 'This month';
  if (monthOffset === -1) return 'Last month';
  return new Date(firstStr + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ─── Atmosphere: time-of-day mood + premium date formatting ─────────
// Returns a greeting + a phase key that drives the sun/moon glyph and the
// warmth of the ambient canvas glow. Based on the *current* hour (the mood of
// the writing session), shown only for today's entry.
function timeMood(hour) {
  if (hour >= 5  && hour < 12) return { label: 'Morning',   phase: 'dawn'  };
  if (hour >= 12 && hour < 17) return { label: 'Afternoon', phase: 'day'   };
  if (hour >= 17 && hour < 21) return { label: 'Evening',   phase: 'dusk'  };
  return { label: 'Night', phase: 'night' };
}

// "July 13, 2026"
function fmtPremiumDate(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}
// "Monday" — shown as a small companion label beside the date heading.
function fmtWeekday(ds) {
  return new Date(ds + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' });
}

// Last N days ending today, flagged by whether an entry exists — the streak "chain".
function buildStreakDots(today, wcMap, n = 7) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const ds = addDays(today, -i);
    out.push({ date: ds, active: !!wcMap[ds], isToday: ds === today });
  }
  return out;
}

function computeStreak(today, wcMap) {
  // Count consecutive days with an entry, ending today (or yesterday if today is still blank).
  let cursor = today;
  if (!wcMap[cursor]) cursor = addDays(today, -1);
  let streak = 0;
  while (wcMap[cursor]) {
    streak += 1;
    cursor = addDays(cursor, -1);
  }
  return streak;
}

// ─── Component ──────────────────────────────────────────────────────
export default memo(function JournalView() {
  const todayDate = localDateStr();

  const [viewingDate, setViewingDate] = useState(todayDate);
  const [history,     setHistory]     = useState(loadAllEntries);
  const [iconMap,     setIconMap]     = useState(loadIcons);
  const [currentWc,   setCurrentWc]   = useState(0);
  const [saveStatus,  setSaveStatus]  = useState('idle'); // 'idle' | 'saving' | 'saved'

  const [weekOffset,  setWeekOffset]  = useState(0);
  const [monthOffset, setMonthOffset] = useState(0);
  const [viewMode,    setViewMode]    = useState(() => {
    try { return localStorage.getItem('nook_journal_calview') === 'week' ? 'week' : 'month'; } catch { return 'month'; }
  });
  const [selToolbar,  setSelToolbar]  = useState({ show: false, x: 0, y: 0 });
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);

  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [rangeOpen, setRangeOpen] = useState(false);
  const [rangeFrom, setRangeFrom] = useState(() => addDays(todayDate, -30));
  const [rangeTo,   setRangeTo]   = useState(todayDate);
  const [exporting, setExporting] = useState(null); // scope key while building
  const [exportMsg, setExportMsg] = useState('');

  const editorRef        = useRef(null);
  const savedTimerRef    = useRef(null);
  const autoSaveTimerRef = useRef(null);
  const exportMsgTimerRef = useRef(null);
  const exportMenuRef    = useRef(null);
  const viewingDateRef   = useRef(viewingDate);

  const isToday = viewingDate === todayDate;

  useEffect(() => { viewingDateRef.current = viewingDate; }, [viewingDate]);

  // ── Word-count map + derived heatmap/streak (single source: history) ──
  const wcMap = useMemo(() => {
    const m = {};
    history.forEach(e => { const wc = wordCountFromHtml(toHtml(e.content ?? '')); if (wc > 0) m[e.date] = wc; });
    return m;
  }, [history]);

  const week        = useMemo(() => buildWeek(todayDate, weekOffset, wcMap), [todayDate, weekOffset, wcMap]);
  const month       = useMemo(() => buildMonth(todayDate, monthOffset, wcMap), [todayDate, monthOffset, wcMap]);
  const prevMonthLabel = useMemo(() => monthLabel(monthOffset - 1, firstOfMonth(todayDate, monthOffset - 1)), [todayDate, monthOffset]);
  const nextMonthLabel = useMemo(() => monthLabel(monthOffset + 1, firstOfMonth(todayDate, monthOffset + 1)), [todayDate, monthOffset]);
  const streak      = useMemo(() => computeStreak(todayDate, wcMap), [todayDate, wcMap]);
  const totalEntries = useMemo(() => Object.keys(wcMap).length, [wcMap]);
  const monthEntries = useMemo(() => {
    const ym = month.first.slice(0, 7); // 'YYYY-MM'
    return Object.keys(wcMap).filter(d => d.startsWith(ym)).length;
  }, [wcMap, month.first]);
  // Last 3 other entries with content, newest first (history is already sorted
  // that way) — excludes the day currently being viewed since that's already
  // the whole right-hand canvas, not something worth also linking to itself.
  const recentEntries = useMemo(() => (
    history.filter(e => e.date !== viewingDate && hasContentHtml(e)).slice(0, 3)
  ), [history, viewingDate]);

  // Persist the chosen calendar view
  useEffect(() => { try { localStorage.setItem('nook_journal_calview', viewMode); } catch {} }, [viewMode]);



  // ── Load content into editor when the viewed date changes ──
  useEffect(() => {
    const e = loadEntry(viewingDate) ?? emptyEntry(viewingDate);
    const html = toHtml(e.content ?? '');
    if (editorRef.current) {
      const el = editorRef.current;
      el.innerHTML = html;
      const isEmpty = !htmlToText(html).trim();
      el.dataset.empty = isEmpty ? 'true' : '';
      setCurrentWc(wordCountFromHtml(html));
      // Cinematic parallax fade-in on day change (restart the CSS animation)
      el.classList.remove('jnx-entry-in');
      void el.offsetWidth;
      el.classList.add('jnx-entry-in');
    }
    setSelToolbar(s => (s.show ? { ...s, show: false } : s));
    setSaveStatus('idle');
  }, [viewingDate]);

  // ── Save helpers ──
  const flagSaved = useCallback(() => {
    setSaveStatus('saved');
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current);
    savedTimerRef.current = setTimeout(() => setSaveStatus('idle'), 2000);
  }, []);

  const saveCurrentEntry = useCallback((html) => {
    const date = viewingDateRef.current;
    // Every day's entry is editable — save whichever date is being viewed.
    const existing = loadEntry(date) ?? emptyEntry(date);
    const isNew = !hasContentHtml(existing);
    persistEntry(date, { ...existing, content: html });
    if (isNew && htmlToText(html).trim()) {
      logActivity({ module: 'journal', entity_type: 'journal_entry', entity_id: date, action: 'created', title: `Journal — ${date}` });
    } else if (!isNew) {
      logActivity({ module: 'journal', entity_type: 'journal_entry', entity_id: date, action: 'updated', title: `Journal — ${date}` });
    }
    flagSaved();
    setTimeout(() => setHistory(loadAllEntries()), 0);
  }, [flagSaved]);

  // ── Editor events ──
  const handleEditorInput = useCallback(() => {
    if (!editorRef.current) return;
    const html = editorRef.current.innerHTML;
    setCurrentWc(wordCountFromHtml(html));
    editorRef.current.dataset.empty = !editorRef.current.textContent?.trim() ? 'true' : '';
    setSaveStatus('saving');
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      if (editorRef.current) saveCurrentEntry(editorRef.current.innerHTML);
    }, 1000);
  }, [saveCurrentEntry]);

  const handleEditorBlur = useCallback(() => {
    if (!editorRef.current) return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    if (saveStatus === 'saving') saveCurrentEntry(editorRef.current.innerHTML);
  }, [saveCurrentEntry, saveStatus]);

  useEffect(() => () => {
    clearTimeout(autoSaveTimerRef.current);
    clearTimeout(savedTimerRef.current);
    clearTimeout(exportMsgTimerRef.current);
  }, []);

  // ── .docx export ──
  const flashExportMsg = useCallback((msg) => {
    setExportMsg(msg);
    if (exportMsgTimerRef.current) clearTimeout(exportMsgTimerRef.current);
    exportMsgTimerRef.current = setTimeout(() => setExportMsg(''), 4000);
  }, []);

  // scope: 'day' | 'week' | 'month' | 'year' | 'range'. Everything but 'range' is
  // anchored to the date being viewed, not to the calendar's month offset.
  const runExport = useCallback(async (scope, custom) => {
    const range = scope === 'range' ? custom : scopeRange(scope, viewingDate);
    if (range.from > range.to) return flashExportMsg('Start date is after end date');

    // The editor may hold unsaved keystrokes; history lags behind it by the
    // autosave debounce, so flush first or the current day exports stale.
    if (editorRef.current && saveStatus === 'saving') {
      clearTimeout(autoSaveTimerRef.current);
      saveCurrentEntry(editorRef.current.innerHTML);
    }

    setExporting(scope);
    try {
      const picked = loadAllEntries()
        .filter(e => e.date >= range.from && e.date <= range.to && hasContentHtml(e))
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(e => {
          const html = toHtml(e.content ?? '');
          return { date: e.date, heading: fmtTitleDate(e.date), html, wordCount: wordCountFromHtml(html), icon: iconMap[e.date] };
        });

      if (!picked.length) return flashExportMsg('No entries in that range');

      const { title, slug } = scopeMeta(scope, viewingDate, range);
      const words = picked.reduce((s, e) => s + e.wordCount, 0);
      const subtitle = `${picked.length} ${picked.length === 1 ? 'entry' : 'entries'} · ${words.toLocaleString()} words · ${fmtDate(range.from)} – ${fmtDate(range.to)}`;

      await exportJournalDocx({ title, subtitle, entries: picked, filename: `nook-journal-${slug}.docx` });
      logActivity({ module: 'journal', entity_type: 'journal_export', entity_id: slug, action: 'exported', title: `${title} (${picked.length} ${picked.length === 1 ? 'entry' : 'entries'})` });
      flashExportMsg(`Downloaded ${picked.length} ${picked.length === 1 ? 'entry' : 'entries'} ✓`);
    } catch {
      flashExportMsg('Export failed — try again');
    } finally {
      setExporting(null);
    }
  }, [viewingDate, iconMap, saveStatus, saveCurrentEntry, flashExportMsg]);

  // ── Formatting toolbar ──
  const execFormat = useCallback((cmd, value = null) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, value);
    handleEditorInput();
  }, [handleEditorInput]);

  // ── Navigation ──
  // ── Atmosphere derived values ──
  const mood       = useMemo(() => timeMood(new Date().getHours()), []);
  const nowTime    = useMemo(() => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), []);
  const streakDots = useMemo(() => buildStreakDots(todayDate, wcMap, 7), [todayDate, wcMap]);
  // Wall-clock check, not memoized — same "derive at render" pattern as FocusCompanion
  // (see CLAUDE.md §Tab-specific quirks), so it stays fresh across re-renders without
  // needing its own ticking store.
  const streakAtRisk = streak > 0 && !wcMap[todayDate] && new Date().getHours() >= 17;
  // Ambient glow intensity — the canvas "breathes brighter" as the entry grows (full ~350 words).
  const auraIntensity = Math.min(1, currentWc / 350);

  const goToToday = () => setViewingDate(todayDate);
  const goPrev = () => setViewingDate(d => addDays(d, -1));
  const goNext = () => setViewingDate(d => addDays(d, 1)); // any date, incl. future
  const canGoNext = true;

  // ── Command palette (Cmd/Ctrl+K) ──
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen(o => !o); }
      if (e.key === 'Escape') { setPaletteOpen(false); setIconPickerOpen(false); setExportMenuOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportMenuOpen) return;
    const handler = (e) => { if (exportMenuRef.current && !exportMenuRef.current.contains(e.target)) { setExportMenuOpen(false); setRangeOpen(false); } };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [exportMenuOpen]);

  // ── Floating selection toolbar — appears only when text is selected in the canvas ──
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;

    const hide = () => setSelToolbar(s => (s.show ? { ...s, show: false } : s));
    const update = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return hide();
      const range = sel.getRangeAt(0);
      if (!editor.contains(range.commonAncestorContainer)) return hide();
      const rect = range.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return;
      setSelToolbar({ show: true, x: rect.left + rect.width / 2, y: rect.top });
    };

    const onMouseUp = () => setTimeout(update, 0);
    const onKeyUp  = (e) => { if (e.shiftKey || e.key === 'Shift' || e.key.startsWith('Arrow')) setTimeout(update, 0); };
    editor.addEventListener('mouseup', onMouseUp);
    editor.addEventListener('keyup', onKeyUp);
    document.addEventListener('selectionchange', update);
    window.addEventListener('scroll', hide, true);
    return () => {
      editor.removeEventListener('mouseup', onMouseUp);
      editor.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('selectionchange', update);
      window.removeEventListener('scroll', hide, true);
    };
  }, []);

  // ── Emoji / icon per entry ──
  const setEntryIcon = (emoji) => {
    setIconMap(prev => {
      const next = { ...prev };
      if (emoji) next[viewingDate] = emoji; else delete next[viewingDate];
      persistIcons(next);
      return next;
    });
    setIconPickerOpen(false);
  };

  const jumpTo = (date) => { setViewingDate(date); setPaletteOpen(false); };

  const entryIcon = iconMap[viewingDate];

  return (
    <div
      className={`jnx-page jnx-mood-${mood.phase}`}
      style={{ '--jnx-aura': auraIntensity }}
    >
      <div className="jnx-split">

        {/* ══════════════════════════════════════════════════
            LEFT COLUMN — Pure Writing Sanctuary
            Date heading + editable text area, plus a hairline divider between
            them — no other chrome. Word count lives only in the right panel's
            stats row now; a second live counter here was redundant. */}
        <main className="jnx-write-panel">
          {/* Ambient glow layer — must be a direct child of .jnx-write-panel: its
              position:absolute is scoped by .jnx-write-panel's position:relative
              (see index.css), and .jnx-write-panel > *:not(.jnx-aura) relies on this
              exact nesting too. Living anywhere else (e.g. sibling of .jnx-split)
              lets it escape to the nearest positioned ancestor up the tree instead,
              ballooning it across the full page width/height. */}
          <div className="jnx-aura" aria-hidden="true" />
          <div className="jnx-canvas">
            <div className="jnx-title-row">
              <div className="jnx-title-group">
                <h1 className="jnx-title">{fmtPremiumDate(viewingDate)}</h1>
                <span className="jnx-title-weekday">{fmtWeekday(viewingDate)}</span>
              </div>
              <div className="jnx-title-nav">
                <button className="jnx-nav-arrow" onClick={goPrev} title="Previous day" aria-label="Previous day">
                  <svg width="16" height="16" viewBox="0 0 24 24" {...S}><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button className="jnx-nav-arrow" onClick={goNext} disabled={!canGoNext} title="Next day" aria-label="Next day">
                  <svg width="16" height="16" viewBox="0 0 24 24" {...S}><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>
            </div>
            <div className="jnx-divider jnx-write-divider" aria-hidden="true" />
            <div
              ref={editorRef}
              className="journal-rich-editor jnx-editor"
              contentEditable
              suppressContentEditableWarning
              onInput={handleEditorInput}
              onBlur={handleEditorBlur}
              data-placeholder={isToday
                ? (streak > 0 ? `Keep your ${streak}-day streak alive — begin where you are…` : 'Begin where you are. Write your thoughts, reflections, or notes for today…')
                : 'Write your reflections for this day…'}
              data-empty="true"
              spellCheck
            />
          </div>
        </main>

        {/* ══════════════════════════════════════════════════
            RIGHT COLUMN — Unified Control + Metadata Hub
            ══════════════════════════════════════════════════ */}
        <motion.aside
          className="jnx-meta"
          aria-label="Journal controls and activity"
          variants={META_CONTAINER}
          initial="hidden"
          animate="show"
        >

          {/* ── Row 1: Controls (search, autosave) ── */}
          <motion.div className="jnx-right-controls" variants={META_ITEM}>
            <div className="jnx-right-cluster">
              <div className="jnx-right-actions">
                <button className="jnx-icon-action" onClick={() => setPaletteOpen(true)} title="Search entries (Ctrl+K)" aria-label="Search entries">
                  <JIcoSearch />
                </button>
                {/* Today + Export + Autosave grouped in one non-wrapping unit: if the row
                    is too narrow for everything, this whole group drops to its own line
                    together (still Today-Export-Autosave side by side) instead of Autosave
                    splitting off alone — the exact "disconnected" problem this is fixing.
                    Only this outer placement changed — the export dropdown's own
                    contents/logic below are untouched. */}
                <div className="jnx-right-today-group">
                <button
                  className={`jnx-today-btn${isToday ? ' jnx-today-btn-current' : ''}`}
                  onClick={goToToday}
                  disabled={isToday}
                  title={isToday ? 'Viewing today' : 'Jump to today'}
                >Today</button>
            <div className="jnx-export-dropdown" ref={exportMenuRef}>
              <button
                className="jnx-export-trigger"
                onClick={() => setExportMenuOpen(o => !o)}
                disabled={!!exporting}
                aria-haspopup="true"
                aria-expanded={exportMenuOpen}
                title="Export journal as .docx"
              >
                {exporting ? <span className="jnx-export-spin" aria-hidden="true" /> : <JIcoDoc />}
                Export
                <JIcoChevronDown />
              </button>

              {exportMenuOpen && (
                <div className="jnx-export-menu" role="menu">
                  <div className="jnx-export-menu-label">Download .docx · from {fmtDate(viewingDate)}</div>

                  {EXPORT_SCOPES.map(s => {
                    const r = scopeRange(s.key, viewingDate);
                    return (
                      <button
                        key={s.key}
                        className="jnx-export-item"
                        role="menuitem"
                        onClick={() => runExport(s.key)}
                        disabled={!!exporting}
                        title={`${fmtDate(r.from)}${r.from === r.to ? '' : ` – ${fmtDate(r.to)}`}`}
                      >
                        <span>{s.label}</span>
                        <span className="jnx-export-item-range">{fmtDate(r.from)}{r.from === r.to ? '' : `–${fmtDate(r.to)}`}</span>
                      </button>
                    );
                  })}

                  <div className="jnx-export-menu-sep" />

                  <button
                    className={`jnx-export-item${rangeOpen ? ' jnx-export-item-active' : ''}`}
                    role="menuitem"
                    onClick={() => setRangeOpen(o => !o)}
                    disabled={!!exporting}
                    aria-expanded={rangeOpen}
                  >
                    <span>Custom range…</span>
                    <JIcoChevronDown style={{ transform: rangeOpen ? 'rotate(180deg)' : 'none' }} />
                  </button>

                  {rangeOpen && (
                    <div className="jnx-export-range">
                      <label className="jnx-export-field">
                        <span>From</span>
                        <input type="date" value={rangeFrom} max={rangeTo} onChange={e => setRangeFrom(e.target.value)} />
                      </label>
                      <label className="jnx-export-field">
                        <span>To</span>
                        <input type="date" value={rangeTo} min={rangeFrom} onChange={e => setRangeTo(e.target.value)} />
                      </label>
                      <button
                        className="jnx-export-go"
                        onClick={() => { runExport('range', { from: rangeFrom, to: rangeTo }); }}
                        disabled={!!exporting || !rangeFrom || !rangeTo}
                      >
                        {exporting === 'range' ? <><span className="jnx-export-spin" aria-hidden="true" /> Building…</> : <><JIcoDoc /> Download .docx</>}
                      </button>
                    </div>
                  )}

                  {exportMsg && <div className="jnx-export-msg" role="status" aria-live="polite">{exportMsg}</div>}
                </div>
              )}
            </div>
                <span className={`jnx-status jnx-status-${saveStatus}`}>
                  {saveStatus === 'saving' && <><span className="jnx-status-dot" /> Saving…</>}
                  {saveStatus === 'saved' && <><JIcoCheck /> Saved</>}
                  {saveStatus === 'idle' && <span className="jnx-status-idle">Autosave</span>}
                </span>
                </div>
              </div>
            </div>
          </motion.div>

          {/* ── Row 2: Context (mood badge + week range) ── */}
          <motion.div className="jnx-meta-context-header" variants={META_ITEM}>
            <div className="jnx-meta-context-title">
              <span className="jnx-meta-eyebrow">
                <span className="jnx-mood-glyph" aria-hidden="true"><MoodGlyph phase={mood.phase} /></span>
                {isToday ? mood.label : relLabel(viewingDate, todayDate)}
              </span>
            </div>
            <div className="jnx-meta-context-range">
              Week of {fmtDate(scopeRange("week", viewingDate).from)} – {fmtDate(scopeRange("week", viewingDate).to)}
            </div>
          </motion.div>

          {/* ── Row 3: KPI Metrics ── */}
          <motion.div className="jnx-kpi-grid" variants={META_ITEM}>
            <div className="jnx-kpi-card">
              <span className="jnx-kpi-num">{currentWc}</span>
              <span className="jnx-kpi-label">WORDS</span>
            </div>
            <div className="jnx-kpi-card">
              <span className="jnx-kpi-num">{totalEntries}</span>
              <span className="jnx-kpi-label">ENTRIES</span>
            </div>
            <div className={`jnx-kpi-card jnx-kpi-streak${streak > 0 ? ' jnx-streak-lit' : ''}${streakAtRisk ? ' jnx-streak-risk' : ''}`}>
              <span className="jnx-kpi-num">
                {streak}
                {streak > 0 && <JIcoFlame className="jnx-streak-flame" />}
              </span>
              <span className="jnx-kpi-label">
                STREAK
                {streakAtRisk && <span className="jnx-streak-risk-tag" title="Write today to keep your streak alive">at risk</span>}
              </span>
            </div>
          </motion.div>

          {/* ── Row 4: Activity Calendar ── */}
          <motion.div className="jnx-meta-cal jnx-meta-cal-divided" variants={META_ITEM}>
            <div className="jnx-meta-cal-head">
              <span className="jnx-meta-label">Activity</span>
              <div className="jnx-week-nav">
                <button className="jnx-nav-arrow jnx-nav-arrow-sm" onClick={() => setMonthOffset(o => o - 1)} title={`Previous month — ${prevMonthLabel}`} aria-label={`Previous month — ${prevMonthLabel}`}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                <button className="jnx-nav-arrow jnx-nav-arrow-sm" onClick={() => setMonthOffset(o => o + 1)} title={`Next month — ${nextMonthLabel}`} aria-label={`Next month — ${nextMonthLabel}`}>
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>
            </div>

            <div className="jnx-heatmap-body">
              <div className="jnx-heatmap-body-inner">
                <div className="jnx-meta-cal-sub">
                  {/* key forces remount on month change so the fade-in animation restarts */}
                  <span className="jnx-meta-period" key={monthOffset}>{monthLabel(monthOffset, month.first)} · {monthEntries} entr{monthEntries === 1 ? "y" : "ies"}</span>
                </div>

                <div className="jnx-month">
                  <div className="jnx-month-dows">
                    {["M", "T", "W", "T", "F", "S", "S"].map((l, i) => (
                      <span className="jnx-month-dow" key={i}>{l}</span>
                    ))}
                  </div>
                  <div className="jnx-month-grid">
                    {month.days.map(d => (
                      <button
                        key={d.date}
                        className={`jnx-mcell${d.wc ? ` jnx-has-entry jnx-lvl-${d.level}` : ""}${d.isToday ? " jnx-today" : ""}${d.date === viewingDate ? " jnx-active" : ""}${!d.inMonth ? " jnx-out" : ""}`}
                        onClick={() => setViewingDate(d.date)}
                        title={`${fmtDate(d.date)} — ${d.wc ? `${d.wc} words` : "no entry"}`}
                        aria-label={`${fmtDate(d.date)}, ${d.wc ? `${d.wc} words` : "no entry"}`}
                      >
                        <span className="jnx-mcell-num">{d.num}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>

          {/* ── Row 5: Recent Entries — gives the space below the calendar a job
              instead of trailing into empty rows; hidden entirely rather than
              showing an empty-state when there's nothing else to link to yet. ── */}
          {recentEntries.length > 0 && (
            <motion.div className="jnx-meta-section" variants={META_ITEM}>
              <span className="jnx-meta-label">Recent Entries</span>
              <ul className="jnx-recent-list">
                {recentEntries.map(e => {
                  const preview = htmlToText(toHtml(e.content ?? '')).trim();
                  return (
                    <li key={e.date}>
                      <button className="jnx-recent-item" onClick={() => jumpTo(e.date)}>
                        <span className="jnx-recent-date">{relLabel(e.date, todayDate)}</span>
                        <span className="jnx-recent-prev">{preview || 'No preview'}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </motion.div>
          )}

        </motion.aside>

      </div>{/* /jnx-split */}

      {/* ── Floating selection toolbar ── */}
      {selToolbar.show && createPortal(
        <div
          className="jnx-fab"
          style={{ left: selToolbar.x, top: selToolbar.y }}
          role="toolbar"
          aria-label="Text formatting"
          onMouseDown={e => e.preventDefault()}
        >
          <button className="jnx-fab-btn" title="Bold (Ctrl+B)"   onClick={() => execFormat('bold')}><strong>B</strong></button>
          <button className="jnx-fab-btn jnx-fab-italic" title="Italic (Ctrl+I)" onClick={() => execFormat('italic')}><em>I</em></button>
          <button className="jnx-fab-btn" title="Underline (Ctrl+U)" onClick={() => execFormat('underline')}><u>U</u></button>
          <span className="jnx-fab-sep" />
          <button className="jnx-fab-btn jnx-fab-mono" title="Heading 1" onClick={() => execFormat('formatBlock', '<h1>')}>H1</button>
          <button className="jnx-fab-btn jnx-fab-mono" title="Heading 2" onClick={() => execFormat('formatBlock', '<h2>')}>H2</button>
          <button className="jnx-fab-btn jnx-fab-mono" title="Heading 3" onClick={() => execFormat('formatBlock', '<h3>')}>H3</button>
          <span className="jnx-fab-sep" />
          <button className="jnx-fab-btn" title="Bullet list"   onClick={() => execFormat('insertUnorderedList')}><JIcoUL /></button>
          <button className="jnx-fab-btn" title="Numbered list" onClick={() => execFormat('insertOrderedList')}><JIcoOL /></button>
          <button className="jnx-fab-btn" title="Quote"         onClick={() => execFormat('formatBlock', '<blockquote>')}><JIcoQuote /></button>
        </div>, document.body)}

      {/* ── COMMAND PALETTE ── */}
      {paletteOpen && createPortal(
        <CommandPalette
          entries={history}
          todayDate={todayDate}
          onClose={() => setPaletteOpen(false)}
          onJump={jumpTo}
        />, document.body)}
    </div>
  );
});

// ─── Command palette ────────────────────────────────────────────────
function CommandPalette({ entries, todayDate, onClose, onJump }) {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const list = [];
    // Always allow jumping to today
    const seen = new Set();
    entries.forEach(e => seen.add(e.date));
    const base = [...entries];
    if (!seen.has(todayDate)) base.unshift({ date: todayDate, content: '' });
    const query = q.toLowerCase().trim();
    for (const e of base) {
      const preview = htmlToText(toHtml(e.content ?? '')).trim();
      if (query) {
        const hit = e.date.includes(query)
          || fmtDate(e.date).toLowerCase().includes(query)
          || relLabel(e.date, todayDate).toLowerCase().includes(query)
          || preview.toLowerCase().includes(query);
        if (!hit) continue;
      }
      list.push({ date: e.date, preview: preview.slice(0, 80) });
    }
    return list.slice(0, 40);
  }, [entries, q, todayDate]);

  useEffect(() => { setActive(0); }, [q]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(a + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(a - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[active]) onJump(results[active].date); }
  };

  return (
    <div className="jnx-palette-overlay" onClick={onClose}>
      <div className="jnx-palette" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="jnx-palette-search">
          <JIcoSearch />
          <input
            ref={inputRef}
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Jump to a date or search entries…"
            className="jnx-palette-input"
          />
          <span className="jnx-kbd">Esc</span>
        </div>
        <div className="jnx-palette-list">
          {results.length === 0 ? (
            <div className="jnx-palette-empty">No entries match "{q}"</div>
          ) : results.map((r, i) => (
            <button
              key={r.date}
              className={`jnx-palette-item${i === active ? ' jnx-palette-item-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => onJump(r.date)}
            >
              <div className="jnx-palette-item-top">
                <span className="jnx-palette-date">{fmtTitleDate(r.date)}</span>
                <span className="jnx-palette-rel">{relLabel(r.date, todayDate)}</span>
              </div>
              <span className="jnx-palette-preview">{r.preview || 'No entry yet…'}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Atmosphere components ──────────────────────────────────────────


// Sun / moon glyph reflecting the time of day.
function MoodGlyph({ phase }) {
  if (phase === 'night' || phase === 'dusk') {
    // Crescent moon (+ a small star at night)
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" {...S}>
        <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        {phase === 'night' && <path d="M18 4l.6 1.4L20 6l-1.4.6L18 8l-.6-1.4L16 6l1.4-.6z" fill="currentColor" stroke="none" />}
      </svg>
    );
  }
  // Sun
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" {...S}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </svg>
  );
}

// ─── Icons ──────────────────────────────────────────────────────────


function JIcoDoc() {
  return <svg width="13" height="13" viewBox="0 0 24 24" {...S} style={{ flexShrink: 0 }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><polyline points="9 15 12 18 15 15"/></svg>;
}
function JIcoChevronDown({ style } = {}) {
  return <svg width="11" height="11" viewBox="0 0 24 24" {...S} style={{ flexShrink: 0, transition: 'transform 0.2s ease', ...style }}><polyline points="6 9 12 15 18 9"/></svg>;
}
function JIcoSearch() {
  return <svg width="15" height="15" viewBox="0 0 24 24" {...S} style={{ flexShrink: 0 }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>;
}
function JIcoBook() {
  return <svg width="22" height="22" viewBox="0 0 24 24" {...S} style={{ color: 'var(--accent)' }}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>;
}
function JIcoUL() {
  return <svg width="14" height="14" viewBox="0 0 24 24" {...S}><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>;
}
function JIcoOL() {
  return <svg width="14" height="14" viewBox="0 0 24 24" {...S}><line x1="10" y1="6" x2="21" y2="6"/><line x1="10" y1="12" x2="21" y2="12"/><line x1="10" y1="18" x2="21" y2="18"/><path d="M4 6h1v4"/><path d="M4 10h2"/><path d="M6 18H4c0-1 2-2 2-3s-1-1.5-2-1"/></svg>;
}
function JIcoQuote() {
  return <svg width="14" height="14" viewBox="0 0 24 24" {...S}><path d="M3 21c3 0 7-1 7-8V5c0-1.25-.756-2.017-2-2H4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2 1 0 1 0 1 1v1c0 1-1 2-2 2s-1 .008-1 1.031V20c0 1 0 1 1 1z"/><path d="M15 21c3 0 7-1 7-8V5c0-1.25-.757-2.017-2-2h-4c-1.25 0-2 .75-2 1.972V11c0 1.25.75 2 2 2h.75c0 2.25.25 4-2.75 4v3c0 1 0 1 1 1z"/></svg>;
}
function JIcoLock() {
  return <svg width="11" height="11" viewBox="0 0 24 24" {...S}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function JIcoCheck() {
  return <svg width="12" height="12" viewBox="0 0 24 24" {...S} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>;
}
function JIcoFlame({ className }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" className={className} aria-hidden="true">
      <path fill="currentColor" d="M12 2c1 3-2 4-2 7a3 3 0 0 0 6 0c0-1-.5-2-.5-2 2 1 3.5 3.5 3.5 6a7 7 0 1 1-14 0c0-5 3-7 4-8 1-.8 2-1.6 3-3z" />
    </svg>
  );
}

