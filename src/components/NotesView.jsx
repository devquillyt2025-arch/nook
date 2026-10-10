import { memo, useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { logActivity } from '../utils/activityLog';
import { useSyncApplied } from '../utils/useSyncApplied';
import { NOTES_STORAGE_KEY, loadNotes, newNote, addedAt, saveNote as storeSaveNote } from '../utils/notesStore';
import Select from './Select';
import ErrorBoundary from './ErrorBoundary';
import { sameDay, startOfDay, endOfDay } from '../utils/date';

const STORAGE_KEY = NOTES_STORAGE_KEY;

const NOTE_COLORS = [
  { id: 'default', label: 'Default', bg: 'var(--bg-input)',       border: 'var(--border)' },
  { id: 'red',     label: 'Red',     bg: 'rgba(239,68,68,0.12)',  border: 'rgba(239,68,68,0.4)' },
  { id: 'orange',  label: 'Orange',  bg: 'rgba(249,115,22,0.12)', border: 'rgba(249,115,22,0.4)' },
  { id: 'yellow',  label: 'Yellow',  bg: 'rgba(234,179,8,0.12)',  border: 'rgba(234,179,8,0.4)' },
  { id: 'green',   label: 'Green',   bg: 'rgba(34,197,94,0.12)',  border: 'rgba(34,197,94,0.4)' },
  { id: 'teal',    label: 'Teal',    bg: 'rgba(20,184,166,0.12)', border: 'rgba(20,184,166,0.4)' },
  { id: 'blue',    label: 'Blue',    bg: 'rgba(59,130,246,0.12)', border: 'rgba(59,130,246,0.4)' },
  { id: 'purple',  label: 'Purple',  bg: 'rgba(168,85,247,0.12)', border: 'rgba(168,85,247,0.4)' },
  { id: 'pink',    label: 'Pink',    bg: 'rgba(236,72,153,0.12)', border: 'rgba(236,72,153,0.4)' },
];

// Solid accent color per note color id — used for tag pill text and toolbar swatch
const COLOR_ACCENT = {
  default: null,
  red:     'var(--color-red)',
  orange:  '#f97316',
  yellow:  '#eab308',
  green:   'var(--color-green)',
  teal:    '#14b8a6',
  blue:    'var(--color-blue)',
  purple:  '#a855f7',
  pink:    '#ec4899',
};

function getColor(id) {
  return NOTE_COLORS.find(c => c.id === id) || NOTE_COLORS[0];
}

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7)  return `${d}d ago`;
  return new Date(iso).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

// ── Content deduplication ────────────────────────────────────────────────
// Removes storage-level duplication: content = A + B where B is a prefix of A.
// Only fires when B is ≥20 chars so normal notes with repeated short phrases
// are never touched. This is a safe one-time migration for a specific data
// corruption pattern (second occurrence cut off mid-sentence).
//
// Previously used an O(n²) loop over every possible split point — replaced
// with a single midpoint check that is O(n) and covers the only known
// corruption pattern (split always falls near the midpoint).
function deduplicateContent(content) {
  if (!content || content.length < 40 || content.length > 20000) return content;
  const half = Math.floor(content.length / 2);
  // Exact duplication: content = A + A
  if (content.length % 2 === 0 && content.slice(half) === content.slice(0, half)) {
    return content.slice(0, half);
  }
  // Truncated duplication: content = A + B where B (≥20 chars) is a prefix of A.
  // The known corruption always splits near the midpoint — one check suffices.
  const tail = content.slice(half);
  if (tail.length >= 20 && content.startsWith(tail)) return content.slice(0, half);
  return content;
}


// ── Note Editor Modal ──────────────────────────────────────────────────────
export function NoteModal({ note, onSave, onClose, onDelete, onColorChange }) {
  const [title,   setTitle]   = useState(note.title);
  const [content, setContent] = useState(note.content);
  const [color,   setColor]   = useState(note.color);
  const [pinned,  setPinned]  = useState(note.pinned);
  const [tagInput, setTagInput] = useState('');
  const [tags,    setTags]    = useState(note.tags || []);
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [copied, setCopied] = useState(false);
  const colorBtnRef  = useRef(null);
  const contentRef   = useRef(null);
  const [colorPopupPos, setColorPopupPos] = useState(null);

  useEffect(() => { contentRef.current?.focus(); }, []);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
  }, [content]);

  useEffect(() => {
    if (!showColorPicker) return;
    const close = (e) => {
      if (colorBtnRef.current && !colorBtnRef.current.contains(e.target))
        setShowColorPicker(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [showColorPicker]);

  const handleSave = () => {
    if (!title.trim() && !content.trim()) { onClose(); return; }
    onSave({ ...note, title: title.trim(), content, color, pinned, tags, updatedAt: new Date().toISOString() });
    onClose();
  };

  const addTag = (e) => {
    if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
      e.preventDefault();
      const t = tagInput.trim().replace(/^#/, '').toLowerCase();
      if (t && !tags.includes(t)) setTags(prev => [...prev, t]);
      setTagInput('');
    }
    if (e.key === 'Backspace' && !tagInput && tags.length) {
      setTags(prev => prev.slice(0, -1));
    }
  };

  const handleCopy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const colStyle   = getColor(color);
  const accentHex  = COLOR_ACCENT[color] ?? null;
  const isNew      = !note.createdAt || note.id === note.createdAt;
  const modalBg    = 'var(--bg-elevated)';

  return (
    <motion.div
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 300, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={handleSave}>
      <motion.div
        initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 20 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        onClick={e => e.stopPropagation()}
        style={{
          background: modalBg,
          border: `1px solid ${colStyle.border}`,
          borderTop: accentHex ? `3px solid ${accentHex}` : `1px solid ${colStyle.border}`,
          borderRadius: 20,
          width: '100%', 
          maxWidth: 800,
          minHeight: 400,
          boxShadow: '0 10px 25px rgba(0,0,0,0.1), 0 20px 48px rgba(0,0,0,0.2)',
          display: 'flex', flexDirection: 'column',
          maxHeight: '88vh',
          overflowY: 'auto',
        }}>

        <div style={{ padding: '24px 24px 0', flexShrink: 0 }}>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="Title"
            style={{ width: '100%', background: 'none', border: 'none', outline: 'none', fontSize: '1.25rem', fontWeight: 700, color: 'var(--text-primary)', fontFamily: 'inherit', boxSizing: 'border-box' }}
          />
        </div>

        <hr style={{ border: 'none', borderBottom: '1px solid var(--border)', margin: '16px 24px 0', flexShrink: 0 }} />

        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', flex: 1 }}>
            <textarea
              ref={contentRef}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="Take a note…"
              spellCheck="true"
              autoCorrect="on"
              style={{
                resize: 'none',
                minHeight: 150,
                overflow: 'hidden',
                border: 'none',
                background: 'transparent',
                outline: 'none',
                padding: '24px',
                color: 'var(--text-primary)',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
                fontSize: '0.875rem',
                whiteSpace: 'pre-wrap',
                lineHeight: 1.7,
                boxSizing: 'border-box',
                width: '100%',
                flex: 1
              }}
            />
          </div>

          <div style={{ padding: '0 24px 24px', display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            {tags.map(t => (
              <span key={t} style={{ display: 'flex', alignItems: 'center', gap: 4, background: 'var(--accent-glow)', color: 'var(--accent)', padding: '3px 10px', borderRadius: 20, fontSize: '0.75rem', fontWeight: 600 }}>
                #{t}
                <button onClick={() => setTags(prev => prev.filter(x => x !== t))} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, fontSize: '0.8rem', lineHeight: 1, marginLeft: 2 }}>×</button>
              </span>
            ))}
            <input
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={addTag}
              placeholder={tags.length ? '' : '+ add tag'}
              style={{ background: 'none', border: 'none', outline: 'none', fontSize: '0.75rem', color: 'var(--text-muted)', fontFamily: 'inherit', minWidth: 60, flex: 1 }}
            />
          </div>
        </div>

        <div style={{ padding: '16px', borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0, position: 'sticky', bottom: 0, background: modalBg, zIndex: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={handleCopy} title="Copy"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', padding: '6px', display: 'flex', alignItems: 'center', opacity: 1, transition: 'opacity 0.15s ease' }}
              onMouseEnter={e => e.currentTarget.style.opacity = 0.8}
              onMouseLeave={e => e.currentTarget.style.opacity = 1}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
              </svg>
            </button>
            <div ref={colorBtnRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setShowColorPicker(!showColorPicker)}
                title="Change Color"
                style={{ width: 24, height: 24, borderRadius: '50%', background: accentHex ?? '#fff', border: accentHex ? 'none' : '1.5px solid #d1d5db', cursor: 'pointer', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', transform: 'scale(1)', transition: 'transform 0.15s ease' }}
                onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
              >
                {!accentHex && (
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round">
                    <line x1="4" y1="4" x2="20" y2="20"/>
                  </svg>
                )}
              </button>
              {showColorPicker && (
                <div
                  style={{
                    position: 'absolute', bottom: 36, left: 0,
                    background: 'var(--bg-elevated)', border: '1px solid var(--border)',
                    borderRadius: 12, padding: 12, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8,
                    boxShadow: '0 4px 20px rgba(0,0,0,0.15)', zIndex: 100
                  }}
                >
                  {/* No Color swatch */}
                  <button
                    onClick={() => { setColor('default'); setShowColorPicker(false); if (onColorChange) onColorChange('default'); }}
                    title="No Color"
                    style={{
                      width: 24, height: 24, borderRadius: '50%', padding: 0,
                      background: '#fff',
                      border: color === 'default' ? 'none' : '1.5px solid #d1d5db',
                      boxShadow: color === 'default' ? '0 0 0 2px var(--bg-elevated), 0 0 0 4px #9ca3af' : 'none',
                      display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, overflow: 'hidden',
                      transform: 'scale(1)', transition: 'transform 0.15s ease',
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="2.5" strokeLinecap="round">
                      <line x1="4" y1="4" x2="20" y2="20"/>
                    </svg>
                  </button>
                  {NOTE_COLORS.slice(1).map(c => (
                    <button
                      key={c.id}
                      onClick={() => {
                        setColor(c.id);
                        setShowColorPicker(false);
                        if (onColorChange) onColorChange(c.id);
                      }}
                      style={{
                        width: 24, height: 24, borderRadius: '50%', padding: 0, border: 'none',
                        background: COLOR_ACCENT[c.id],
                        boxShadow: color === c.id ? `0 0 0 2px var(--bg-elevated), 0 0 0 4px ${COLOR_ACCENT[c.id]}` : 'none',
                        transform: 'scale(1)', transition: 'transform 0.15s ease',
                      }}
                      onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.1)'}
                      onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                    />
                  ))}
                </div>
              )}
            </div>
            {!isNew && (
              <button onClick={() => { if (confirm('Delete this note?')) { onDelete(note.id); onClose(); } }} title="Delete note"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-red)', padding: '6px', display: 'flex', alignItems: 'center', opacity: 1, transition: 'opacity 0.15s ease' }}
                onMouseEnter={e => e.currentTarget.style.opacity = 0.8}
                onMouseLeave={e => e.currentTarget.style.opacity = 1}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/>
                </svg>
              </button>
            )}
          </div>
          <button onClick={handleSave}
            style={{ background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 10, padding: '10px 24px', fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', opacity: 1, transition: 'opacity 0.15s ease' }}
            onMouseEnter={e => e.currentTarget.style.opacity = 0.8}
            onMouseLeave={e => e.currentTarget.style.opacity = 1}>
            Done
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── Note Card ─────────────────────────────────────────────────────────────
export function NoteCard({ note, onOpen, onPin, onDelete, onTagClick, onColorSelect, viewMode = 'grid' }) {
  const [hovered, setHovered] = useState(false);
  const [showColors, setShowColors] = useState(false);
  const isColored = note.color && note.color !== 'default';
  const colStyle = getColor(note.color);
  const accent = COLOR_ACCENT[note.color];

  // Reset on id change to prevent stuck hover after grid reflow
  useEffect(() => { setHovered(false); setShowColors(false); }, [note.id]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{
        opacity: 1,
        y: hovered ? -5 : 0,
        boxShadow: hovered
          ? `0 18px 36px -16px ${accent || 'var(--accent)'}, 0 8px 20px -12px rgba(0,0,0,0.55)`
          : '0 1px 2px rgba(0,0,0,0.18)',
      }}
      exit={{ opacity: 0, y: 4 }}
      transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); setShowColors(false); }}
      onPointerLeave={() => { setHovered(false); setShowColors(false); }}
      onClick={() => onOpen(note)}
      style={{
        background: isColored ? colStyle.bg : 'var(--bg-card)',
        border: `1px solid ${hovered ? (accent || 'var(--border-accent)') : (isColored ? colStyle.border : 'var(--border)')}`,
        borderRadius: 14,
        padding: '14px',
        cursor: 'pointer',
        height: viewMode === 'list' ? 'auto' : 182,
        minHeight: viewMode === 'list' ? 62 : undefined,
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: viewMode === 'list' ? 'row' : 'column',
        gap: viewMode === 'list' ? 16 : undefined,
        alignItems: viewMode === 'list' ? 'center' : undefined,
        position: 'relative',
        overflow: 'hidden',
        transition: 'border-color 0.18s ease',
      }}>

      {/* Colored accent bar */}
      <div aria-hidden="true" style={{
        position: 'absolute', top: 0, left: 0, right: 0, height: 3,
        background: accent || 'var(--accent)',
        opacity: isColored ? 0.9 : (hovered ? 0.6 : 0.28),
        transition: 'opacity 0.2s ease',
      }} />

      {/* Pinned indicator */}
      {note.pinned && (
        <div style={{ position: 'absolute', top: 12, right: 12, color: 'var(--accent)', opacity: 0.6 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="white"/></svg>
        </div>
      )}

      {/* ── Top block: title + tags + body, grows to fill available space ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1, minHeight: 0 }}>

      {/* Title — max 1 line, then ellipsis */}
      <div style={{
        fontSize: '0.9rem', fontWeight: 700, color: 'var(--text-primary)',
        lineHeight: 1.35, paddingRight: note.pinned ? 20 : 0,
        display: '-webkit-box', WebkitLineClamp: 1,
        WebkitBoxOrient: 'vertical', overflow: 'hidden', flexShrink: 0,
      }}>
        {note.title || 'Untitled'}
      </div>

      {/* Content preview — expands to fill card body, clamped at 4 lines */}
      {note.content && (
        <div style={{
          display: '-webkit-box',
          WebkitLineClamp: viewMode === 'list' ? 1 : 4,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          fontSize: '0.81rem',
          color: 'var(--text-secondary)',
          lineHeight: 1.6,
          wordBreak: 'break-word',
          flex: 1,
          minHeight: 0,
        }}>
          {note.content}
        </div>
      )}


      </div>

      {/* Footer — always pinned at the card bottom */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingTop: 6, borderTop: `1px solid ${isColored ? colStyle.border : 'var(--border)'}`, flexShrink: 0 }}>
        <span style={{ fontSize: '0.67rem', color: 'var(--text-muted)', letterSpacing: '0.01em' }}>{timeAgo(note.updatedAt)}</span>
        <AnimatePresence>
          {hovered && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.1 }}
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              {!showColors ? (
                <>
                  <button onClick={e => { e.stopPropagation(); onPin(note.id); }}
                    aria-label={note.pinned ? 'Unpin note' : 'Pin note'}
                    title={note.pinned ? 'Unpin' : 'Pin'}
                    style={{ background: 'var(--accent-glow2)', border: 'none', cursor: 'pointer', color: note.pinned ? 'var(--accent)' : 'var(--text-muted)', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill={note.pinned?'currentColor':'none'} stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </button>
                  <button onClick={e => { e.stopPropagation(); setShowColors(true); }}
                    aria-label="Change note color"
                    title="Change Color"
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', padding: 2, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <span aria-hidden="true" style={{
                      display: 'block',
                      width: 18, height: 18,
                      borderRadius: '50%',
                      background: accent ?? '#ffffff',
                      border: `2px solid ${accent ? 'rgba(0,0,0,0.15)' : '#d1d5db'}`,
                      boxShadow: accent ? `0 0 0 1px rgba(255,255,255,0.5) inset` : 'none',
                      transition: 'transform 0.15s ease',
                    }} />
                  </button>
                  <button onClick={e => { e.stopPropagation(); if (confirm('Delete this note?')) onDelete(note.id); }}
                    aria-label="Delete note"
                    title="Delete"
                    style={{ background: 'rgba(239,68,68,0.08)', border: 'none', cursor: 'pointer', color: 'var(--color-red)', width: 28, height: 28, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>
                  </button>
                </>
              ) : (
                <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                  {NOTE_COLORS.slice(1).map(c => (
                    <button
                      key={c.id}
                      onClick={e => { e.stopPropagation(); onColorSelect && onColorSelect(note.id, c.id); setShowColors(false); }}
                      title={c.label}
                      style={{
                        width: 18, height: 18, borderRadius: '50%', padding: 0, border: 'none', cursor: 'pointer',
                        background: COLOR_ACCENT[c.id],
                        boxShadow: note.color === c.id ? `0 0 0 2px var(--bg-surface), 0 0 0 3px ${COLOR_ACCENT[c.id]}` : 'none',
                        transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                        flexShrink: 0,
                      }}
                      onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.2)'}
                      onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                    />
                  ))}
                  <button
                    onClick={e => { e.stopPropagation(); onColorSelect && onColorSelect(note.id, 'default'); setShowColors(false); }}
                    title="No Color"
                    style={{
                      width: 18, height: 18, borderRadius: '50%', padding: 0, cursor: 'pointer', flexShrink: 0,
                      background: '#ffffff',
                      border: (note.color === 'default' || !note.color) ? 'none' : '2px solid #e5e7eb',
                      boxShadow: (note.color === 'default' || !note.color) ? '0 0 0 2px var(--bg-surface), 0 0 0 3px #9ca3af' : 'none',
                      transition: 'transform 0.15s ease, box-shadow 0.15s ease',
                    }}
                    onMouseEnter={e => e.currentTarget.style.transform = 'scale(1.2)'}
                    onMouseLeave={e => e.currentTarget.style.transform = 'scale(1)'}
                  />
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ── Main NotesView ─────────────────────────────────────────────────────────
export default memo(function NotesView({ onOpenNoteEditor, globalSearchQuery = '' }) {
  const [localSearchQuery, setLocalSearchQuery] = useState('');
  const [notes,       setNotes]       = useState(loadNotes);
  // Another device edited notes: re-read what the sync engine merged into storage.
  useSyncApplied(['notes'], () => setNotes(loadNotes()));
  const [sortOrder,   setSortOrder]   = useState('added');   // 'added' (newest first) | 'oldest' | 'alpha' — nothing sets it today
  const [activeTag,   setActiveTag]   = useState(null);
  const [activeColor, setActiveColor] = useState(null);
  const [viewMode,    setViewMode]    = useState('grid'); // 'grid' | 'list'
  const [quickTitle,  setQuickTitle]  = useState('');
  const quickRef = useRef(null);
  const quickSubmittingRef = useRef(false); // guards a same-frame double-submit (held-Enter)
  
  const [dateRange, setDateRange] = useState({ start: null, end: null });
  const [hoverColor, setHoverColor] = useState(null);
  const [dateOpen, setDateOpen] = useState(false);
  const dateBtnRef = useRef(null);

  const persist = (updated) => {
    setNotes(updated);
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
  };

  // Bug 3 fix: one-time migration that removes content duplicated at the data
  // level (stored note has the text block twice, second copy possibly truncated).
  // Runs once on mount, only persists when something actually changed.
  useEffect(() => {
    const cleaned = notes.map(n => ({
      ...n,
      content: deduplicateContent(n.content),
    }));
    if (JSON.stringify(cleaned) !== JSON.stringify(notes)) {
      persist(cleaned);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── CRUD ───────────────────────────────────────────────────────────
  // Delegates to utils/notesStore so a note can also be created from outside
  // this component (voice commands, dispatched from App.jsx while this tab
  // isn't even mounted) without duplicating the read-modify-write + activity
  // logging. The listener below picks up writes that happen while this IS
  // mounted but originated elsewhere (e.g. this same voice path, if the user
  // is on the Notes tab when they use it).
  const saveNote = (note) => setNotes(storeSaveNote(note));

  useEffect(() => {
    const onChange = () => setNotes(loadNotes());
    window.addEventListener('nook-notes-changed', onChange);
    return () => window.removeEventListener('nook-notes-changed', onChange);
  }, []);

  const updateNoteColor = (id, newColor) => {
    setNotes(prev => {
      const updated = prev.map(n => n.id === id ? { ...n, color: newColor, updatedAt: new Date().toISOString() } : n);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  };

  const deleteNote = (id) => {
    // Functional update avoids stale closure when called via App.jsx-level modal context.
    setNotes(prev => {
      const note = prev.find(n => n.id === id);
      if (note) logActivity({ module: 'notes', entity_type: 'note', entity_id: id, action: 'deleted', title: note.title || '(untitled)' });
      const updated = prev.filter(n => n.id !== id);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  };

  const togglePin = (id) => {
    // Functional update (like saveNote/deleteNote) so it can't overwrite a
    // concurrent change with a stale `notes` snapshot from the closure.
    setNotes(prev => {
      const target = prev.find(n => n.id === id);
      if (target) logActivity({ module: 'notes', entity_type: 'note', entity_id: id, action: 'updated', title: `${target.pinned ? 'Unpinned' : 'Pinned'}: ${target.title || '(untitled)'}` });
      const updated = prev.map(n => n.id === id ? { ...n, pinned: !n.pinned, updatedAt: new Date().toISOString() } : n);
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(updated)); } catch {}
      return updated;
    });
  };

  const openNew = (overrides = {}) => onOpenNoteEditor({ note: newNote(overrides), onSave: saveNote, onDelete: deleteNote });
  const openEdit = (note) => onOpenNoteEditor({ note, onSave: saveNote, onDelete: deleteNote, onColorChange: (newColor) => updateNoteColor(note.id, newColor) });

  // Quick create from the top bar input
  const handleQuickCreate = (e) => {
    e.preventDefault();
    if (!quickTitle.trim() || quickSubmittingRef.current) return;
    quickSubmittingRef.current = true;
    requestAnimationFrame(() => { quickSubmittingRef.current = false; });
    const note = newNote({ title: quickTitle.trim() });
    saveNote(note);
    setQuickTitle('');
    onOpenNoteEditor({ note, onSave: saveNote, onDelete: deleteNote }); // immediately open for more editing
  };

  // ── Derived data ───────────────────────────────────────────────────
  const allTags = useMemo(() => {
    const set = new Set();
    notes.forEach(n => n.tags?.forEach(t => set.add(t)));
    return [...set].sort();
  }, [notes]);

  const filtered = useMemo(() => {
    let result = [...notes];
    const searchStr = (localSearchQuery || globalSearchQuery).trim().toLowerCase();
    if (searchStr) {
      result = result.filter(n =>
        (n.title && n.title.toLowerCase().includes(searchStr)) ||
        (n.content && n.content.toLowerCase().includes(searchStr)) ||
        n.tags?.some(t => t.toLowerCase().includes(searchStr))
      );
    }
    if (activeTag)   result = result.filter(n => n.tags?.includes(activeTag));
    if (activeColor) result = result.filter(n => n.color === activeColor);
    
    if (dateRange.start) {
      result = result.filter(n => new Date(n.updatedAt) >= dateRange.start);
    }
    if (dateRange.end) {
      const eOfDay = new Date(dateRange.end); eOfDay.setHours(23, 59, 59, 999);
      result = result.filter(n => new Date(n.updatedAt) <= eOfDay);
    }
    
    // By when the note was added, not last edited: a note keeps its place when it's opened,
    // edited, recoloured or pinned (see addedAt in notesStore). New notes land first.
    if (sortOrder === 'alpha') result.sort((a,b) => (a.title || '').localeCompare(b.title || ''));
    else if (sortOrder === 'oldest') result.sort((a,b) => addedAt(a) - addedAt(b));
    else result.sort((a,b) => addedAt(b) - addedAt(a));
    
    return result;
  }, [notes, localSearchQuery, globalSearchQuery, activeTag, activeColor, sortOrder, dateRange]);

  const pinned   = filtered.filter(n => n.pinned);
  const unpinned = filtered.filter(n => !n.pinned);

  const gridStyle = viewMode === 'grid'
    ? { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 16, alignItems: 'start' }
    : { display: 'flex', flexDirection: 'column', gap: 10 };

  return (
    <ErrorBoundary title="Notes failed to load" message="An unexpected error occurred in the Notes view. Try refreshing.">
    <div style={{ display: 'flex', flexDirection: 'column', background: 'transparent' }}>

      {/* ── Top Bar — pinned (position:sticky, see .nv-bar) while the notes scroll under it.
          The root above must not set overflow/height: either would turn it into the sticky
          bar's scroll container and stop it pinning to the tab's scroll area. ── */}
      <div className="nv-bar">

        {/* ROW 1: search → palette → all tags → date range → view toggle → count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 }}>

          {/* 1. Search — first in the row; shrinks before the controls wrap */}
          <div style={{ position: 'relative', display: 'flex', alignItems: 'center', flex: '1 1 220px', minWidth: 180, maxWidth: 340 }}>
            <svg style={{ position: 'absolute', left: 9, color: 'var(--text-muted)', pointerEvents: 'none' }} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input
              type="search"
              aria-label="Search notes"
              placeholder="Search notes..."
              value={localSearchQuery}
              onChange={e => setLocalSearchQuery(e.target.value)}
              style={{ width: '100%', padding: '7px 10px 7px 28px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', outline: 'none', fontSize: '0.8rem', height: 34, boxSizing: 'border-box' }}
            />
          </div>

          {/* New Note — primary action, after search */}
          <button type="button" className="hv-new-btn" onClick={() => openNew()}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 16px', border: 'none', borderRadius: 10, fontFamily: 'inherit', fontSize: '0.82rem', fontWeight: 700, color: '#fff', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0, background: 'linear-gradient(135deg, var(--accent) 0%, var(--accent-light) 100%)', boxShadow: '0 10px 22px -8px var(--accent), inset 0 1px 0 rgba(255,255,255,0.22)' }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            New Note
          </button>

          {/* 3. Color palette — compact 22 px swatches */}
          <div role="group" aria-label="Filter by color" style={{ display: 'flex', gap: 3, alignItems: 'center', background: 'var(--bg-input)', padding: '0 8px', height: 34, borderRadius: 9999, border: '1px solid var(--border)', flexShrink: 0, boxSizing: 'border-box' }}>
            <button
              type="button"
              onClick={() => setActiveColor(null)}
              aria-label="Show all colors"
              aria-pressed={!activeColor}
              title="All Colors"
              style={{ width: 22, height: 22, borderRadius: '50%', background: 'var(--bg-surface)', border: !activeColor ? '2px solid var(--accent)' : '1px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.15s', flexShrink: 0, padding: 0 }}
            >
              {!activeColor && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>}
            </button>
            {NOTE_COLORS.slice(1).map(c => {
              const isActive = activeColor === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-label={`Filter by ${c.label}`}
                  aria-pressed={isActive}
                  title={c.label}
                  onClick={() => setActiveColor(isActive ? null : c.id)}
                  style={{ width: 22, height: 22, borderRadius: '50%', background: COLOR_ACCENT[c.id], display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', transition: 'all 0.15s', transform: isActive ? 'scale(1.18)' : (hoverColor === c.id ? 'scale(1.05)' : 'scale(1)'), boxShadow: isActive ? `0 0 0 2px var(--bg-surface), 0 0 0 3px ${COLOR_ACCENT[c.id]}` : 'none', flexShrink: 0, opacity: hoverColor === c.id || isActive ? 1 : 0.75, border: 'none', padding: 0 }}
                  onMouseEnter={() => setHoverColor(c.id)}
                  onMouseLeave={() => setHoverColor(null)}
                >
                  {isActive && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>}
                </button>
              );
            })}
          </div>

          {/* 4. All Tags */}
          <Select
            value={activeTag || 'all'}
            options={[{value:'all',label:'All Tags'}, ...allTags.map(t => ({value:t, label:`#${t}`}))]}
            onChange={e => setActiveTag(e.target.value === 'all' ? null : e.target.value)}
            style={{ width: 130, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, height: 34, padding: '0 12px', fontSize: '0.8rem', flexShrink: 0, whiteSpace: 'nowrap', boxSizing: 'border-box' }}
          />

          {/* 5. Date range */}
          <div style={{ position: 'relative', flexShrink: 0 }}>
            <button
              ref={dateBtnRef}
              type="button"
              onClick={() => setDateOpen(!dateOpen)}
              style={{ height: 34, padding: '0 12px', borderRadius: 8, border: '1px solid var(--border)', background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '0.8rem', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', whiteSpace: 'nowrap', boxSizing: 'border-box' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
              {fmtRangeLabel(dateRange)}
            </button>
            {dateOpen && (
              <DateRangePicker
                dateRange={dateRange}
                triggerRef={dateBtnRef}
                onChange={r => { setDateRange(r); setDateOpen(false); }}
                onClose={() => setDateOpen(false)}
              />
            )}
          </div>

          {/* 5b. View mode toggle */}
          <div role="group" aria-label="View mode" style={{ marginLeft: 'auto', display: 'flex', gap: 0, background: 'var(--bg-input)', borderRadius: 8, height: 34, border: '1px solid var(--border)', flexShrink: 0, overflow: 'hidden', boxSizing: 'border-box' }}>
            <button
              type="button"
              onClick={() => setViewMode('grid')}
              aria-label="Grid view"
              aria-pressed={viewMode === 'grid'}
              title="Grid view"
              style={{ padding: '0 11px', height: '100%', background: viewMode === 'grid' ? 'var(--accent)' : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: viewMode === 'grid' ? '#fff' : 'var(--text-muted)', transition: 'all 0.15s' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              aria-label="List view"
              aria-pressed={viewMode === 'list'}
              title="List view"
              style={{ padding: '0 11px', height: '100%', background: viewMode === 'list' ? 'var(--accent)' : 'transparent', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', color: viewMode === 'list' ? '#fff' : 'var(--text-muted)', transition: 'all 0.15s' }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            </button>
          </div>

          {/* 6. Entry count — sits right after the view toggle; the pair is pushed to the far right */}
          <span style={{ fontSize: '0.72rem', fontWeight: 500, color: 'var(--text-muted)', whiteSpace: 'nowrap', flexShrink: 0, textAlign: 'right', minWidth: 110 }}>
            {(localSearchQuery.trim() || globalSearchQuery.trim() || activeTag || activeColor || dateRange.start || dateRange.end)
              ? `${filtered.length} of ${notes.length} entries`
              : `${notes.length} entries`}
          </span>

        </div>

      </div>

      {/* ── Notes Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '20px 16px 40px', scrollbarWidth: 'thin', scrollbarColor: 'var(--border) transparent' }}>

        {notes.length === 0 ? (
          /* Empty state */
          <div className="hv-empty">
            <div className="hv-empty-orb" aria-hidden="true">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>
              </svg>
            </div>
            <p className="hv-empty-title">Capture your first note</p>
            <p className="hv-empty-sub">Ideas, reminders, and things worth remembering — all in one place.</p>
            <button className="hv-new-btn hv-empty-btn" onClick={() => openNew()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              New Note
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '40%', gap: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <div style={{ fontWeight: 600, color: 'var(--text-secondary)' }}>No notes match your search</div>
            <button onClick={() => { setLocalSearchQuery(''); setActiveTag(null); setActiveColor(null); setDateRange({ start: null, end: null }); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontWeight: 600, fontSize: '0.85rem' }}>Clear filters</button>
          </div>
        ) : (
          <>
            {/* Pinned section */}
            {pinned.length > 0 && (
              <div style={{ marginBottom: 24 }}>
                <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 6 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="var(--text-muted)"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3" fill="var(--bg-surface)"/></svg>
                  Pinned
                </div>
                <div style={gridStyle}>
                  <AnimatePresence>
                    {pinned.map(n => <NoteCard key={n.id} note={n} onOpen={openEdit} onPin={togglePin} onDelete={deleteNote} onTagClick={setActiveTag} onColorSelect={updateNoteColor} viewMode={viewMode} />)}
                  </AnimatePresence>
                </div>
              </div>
            )}

            {/* All / Other notes */}
            {unpinned.length > 0 && (
              <div>
                {pinned.length > 0 && (
                  <div style={{ fontSize: '0.72rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.1em', marginBottom: 12 }}>
                    {localSearchQuery || activeTag || activeColor ? 'Results' : 'Others'}
                  </div>
                )}
                <div style={gridStyle}>
                  <AnimatePresence>
                    {unpinned.map(n => <NoteCard key={n.id} note={n} onOpen={openEdit} onPin={togglePin} onDelete={deleteNote} onTagClick={setActiveTag} onColorSelect={updateNoteColor} viewMode={viewMode} />)}
                  </AnimatePresence>
                </div>
              </div>
            )}
          </>
        )}
      </div>

    </div>
    </ErrorBoundary>
  );
});


// ── Date helpers ──────────────────────────────────────────────────
// sameDay / startOfDay / endOfDay now come from utils/date.js (shared).
function thisWeekRange() {
  const end   = new Date();
  const start = startOfDay(new Date()); start.setDate(start.getDate() - 6);
  return { start, end };
}

function fmtRangeLabel({ start, end }) {
  if (!start && !end) return 'Date Range';
  const o = { month: 'short', day: 'numeric' };
  const s = start ? start.toLocaleDateString('en-US', o) : '…';
  const e = end   ? end.toLocaleDateString('en-US', o)   : '…';
  if (start && end && sameDay(start, end)) return s;
  return `${s} – ${e}`;
}

// ── Date range picker popover ─────────────────────────────────────
function DateRangePicker({ dateRange, triggerRef, onChange, onClose }) {
  const menuRef = useRef(null);

  useEffect(() => {
    const onDown = (e) => {
      if (triggerRef.current?.contains(e.target)) return;
      if (menuRef.current?.contains(e.target)) return;
      onClose();
    };
    const onScroll = () => onClose();
    document.addEventListener('mousedown', onDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [onClose, triggerRef]);

  const [calMonth,  setCalMonth]  = useState(() => {
    const d = dateRange.start || new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [tempRange, setTempRange] = useState({ start: dateRange.start, end: dateRange.end });
  const [picking,   setPicking]   = useState('start');
  const [hoverDay,  setHoverDay]  = useState(null);

  const yr  = calMonth.getFullYear();
  const mo  = calMonth.getMonth();
  const firstDow    = new Date(yr, mo, 1).getDay();
  const daysInMonth = new Date(yr, mo + 1, 0).getDate();
  const DOW = ['Su','Mo','Tu','We','Th','Fr','Sa'];

  const quick = (type) => {
    const now = new Date();
    if (type === 'all')   { onChange({ start: null, end: null }); return; }
    if (type === 'today') { onChange({ start: startOfDay(now), end: now }); return; }
    if (type === 'week')  { onChange(thisWeekRange()); return; }
    if (type === 'month') { onChange({ start: new Date(now.getFullYear(), now.getMonth(), 1), end: now }); return; }
  };

  const handleDayClick = (day) => {
    const d = new Date(yr, mo, day);
    if (picking === 'start' || !tempRange.start) {
      setTempRange({ start: d, end: null });
      setPicking('end');
    } else {
      const s = tempRange.start;
      onChange({ start: d < s ? d : s, end: d < s ? s : d });
    }
  };

  const effectiveEnd = tempRange.end || hoverDay;

  const dayClass = (day) => {
    const d    = new Date(yr, mo, day);
    const isSel  = (tempRange.start && sameDay(d, tempRange.start)) || (tempRange.end && sameDay(d, tempRange.end));
    const isHov  = hoverDay && sameDay(d, hoverDay) && picking === 'end';
    const isBet  = tempRange.start && effectiveEnd && d > tempRange.start && d < effectiveEnd;
    const isTod  = sameDay(d, new Date());
    return ['al-cal-day', isSel ? 'sel' : isHov ? 'hov' : '', isBet ? 'bet' : '', isTod ? 'tod' : '']
      .filter(Boolean).join(' ');
  };

  return (
    <div ref={menuRef} className="al-cal-pop"
      style={{ position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 50 }}>
      <div className="al-cal-qs">
        {[['today','Today'],['week','This Week'],['month','This Month'],['all','All Time']].map(([v, l]) => (
          <button key={v} className="al-cal-sc" onClick={() => quick(v)}>{l}</button>
        ))}
      </div>
      <div className="al-cal-hr" />

      <div className="al-cal-nav">
        <button className="al-cal-nb" onClick={() => setCalMonth(new Date(yr, mo - 1))}>‹</button>
        <span className="al-cal-ml">{calMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}</span>
        <button className="al-cal-nb" onClick={() => setCalMonth(new Date(yr, mo + 1))}>›</button>
      </div>

      <div className="al-cal-grid">
        {DOW.map(d => <span key={d} className="al-cal-dow">{d}</span>)}
        {Array.from({ length: firstDow }).map((_, i) => <span key={`_${i}`} />)}
        {Array.from({ length: daysInMonth }).map((_, i) => {
          const day = i + 1;
          return (
            <button key={day} className={dayClass(day)}
              onMouseEnter={() => picking === 'end' && setHoverDay(new Date(yr, mo, day))}
              onMouseLeave={() => setHoverDay(null)}
              onClick={() => handleDayClick(day)}>
              {day}
            </button>
          );
        })}
      </div>

      <div className="al-cal-hint">
        <span>{picking === 'start' ? 'Select start date' : 'Select end date'}</span>
        {tempRange.start && picking === 'end' && (
          <button className="al-cal-rst"
            onClick={() => { setTempRange({ start: null, end: null }); setPicking('start'); }}>
            Reset
          </button>
        )}
      </div>
    </div>
  );
}
