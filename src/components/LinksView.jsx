import { memo, useState, useMemo, useRef, useEffect } from 'react';
import Select from './Select';
import { motion, AnimatePresence } from 'framer-motion';
import { logActivity } from '../utils/activityLog';
import { useSyncApplied } from '../utils/useSyncApplied';
import { genId } from '../utils/id';
import { UNCAT, catKeyOf, groupLinks } from '../utils/linkGroups';
import { openSafeUrl } from '../utils/safeUrl';
import { askConfirm } from '../utils/confirmDialog';
import { useLayoutAnimations } from '../utils/layoutFreeze';

const STORAGE_KEY = 'nook_links';
const BASE_CATS = ['Personal', 'Work', 'Finance', 'Read Later', 'Entertainment'];

function load()  { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function save(e) { localStorage.setItem(STORAGE_KEY, JSON.stringify(e)); }

function domain(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function faviconSrc(url) {
  const d = domain(url);
  return d ? `https://www.google.com/s2/favicons?domain=${d}&sz=32` : null;
}

// ── Favicon with fallback ─────────────────────────────────────────
function FaviconIcon({ url, size = 28 }) {
  const [err, setErr] = useState(false);
  const src = faviconSrc(url);
  if (!src || err) {
    return (
      <div style={{ width: size, height: size, borderRadius: 7, background: 'var(--accent-glow)', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
        <svg width={size * .56} height={size * .56} viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
      </div>
    );
  }
  return <img src={src} alt="" width={size} height={size} onError={() => setErr(true)} style={{ borderRadius: 7, flexShrink: 0, objectFit: 'contain' }} />;
}

// ── Copy button ───────────────────────────────────────────────────
function CopyBtn({ text }) {
  const [ok, setOk] = useState(false);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1800); });
  };
  return (
    <button onClick={copy} aria-label="Copy URL" title="Copy URL"
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: ok ? 'var(--color-green)' : 'var(--text-muted)', padding: 6, display: 'flex', borderRadius: 6, flexShrink: 0, transition: 'color .15s' }}>
      {ok
        ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
}

// ── Category colour map ───────────────────────────────────────────
const CAT_COLORS = {
  personal:      { bg: 'var(--accent-glow)',  color: 'var(--accent)' },
  work:          { bg: 'rgba(245,158,11,.1)',  color: 'var(--color-amber)' },
  finance:       { bg: 'rgba(16,185,129,.1)',  color: '#059669' },
  'read later':  { bg: 'rgba(236,72,153,.1)',  color: '#db2777' },
  entertainment: { bg: 'var(--color-red-bg)',   color: '#dc2626' },
};
function catStyle(cat) {
  return CAT_COLORS[(cat || '').toLowerCase()] || { bg: 'rgba(107,114,128,.1)', color: 'var(--text-secondary)' };
}

// ── Custom Category Dropdown ──────────────────────────────────────
function CategoryDropdown({ value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // options: plain strings, or { value, label } where the stored group key differs from what's shown.
  const allOptions = [{ value: '', label: 'All categories' }, ...options.map(o => (typeof o === 'string' ? { value: o, label: o } : o))];
  const selected = allOptions.find(o => o.value === value) || allOptions[0];

  const choose = (val) => { onChange(val); setOpen(false); };

  return (
    <div ref={wrapRef} style={{ position: 'relative', flexShrink: 0 }}>
      {/* Trigger */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Filter by category"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          height: 36, padding: '0 12px',
          background: value ? 'var(--accent-glow)' : 'var(--bg-input)',
          border: `1px solid ${value ? 'var(--border-accent)' : 'var(--border)'}`,
          borderRadius: 8, cursor: 'pointer', fontSize: '0.82rem',
          color: value ? 'var(--accent)' : 'var(--text-secondary)',
          fontWeight: value ? 600 : 400,
          fontFamily: 'inherit', whiteSpace: 'nowrap',
          transition: 'border-color .13s, background .13s',
          minWidth: 140,
        }}
      >
        {value && (
          <span style={{ width: 7, height: 7, borderRadius: '50%', background: catStyle(value).color, flexShrink: 0 }} />
        )}
        <span style={{ flex: 1, textAlign: 'left' }}>{selected.label}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"
          aria-hidden="true" style={{ flexShrink: 0, transition: 'transform .18s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Menu */}
      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            aria-label="Category filter options"
            initial={{ opacity: 0, y: -6, scale: .97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: .97 }}
            transition={{ duration: .14, ease: 'easeOut' }}
            style={{
              position: 'absolute', top: 'calc(100% + 6px)', left: 0,
              minWidth: '100%', listStyle: 'none', margin: 0, padding: '4px',
              background: 'var(--bg-elevated)', border: '1px solid var(--border)',
              borderRadius: 10, boxShadow: '0 6px 18px rgba(0,0,0,.12)',
              zIndex: 60,
            }}
          >
            {allOptions.map(opt => {
              const isActive = opt.value === value;
              const cs = opt.value ? catStyle(opt.value) : null;
              return (
                <li key={opt.value} role="option" aria-selected={isActive}>
                  <button
                    type="button"
                    onClick={() => choose(opt.value)}
                    style={{
                      width: '100%', display: 'flex', alignItems: 'center', gap: 9,
                      padding: '7px 10px', border: 'none', borderRadius: 7, cursor: 'pointer',
                      fontSize: '0.83rem', fontFamily: 'inherit', textAlign: 'left',
                      background: isActive ? 'var(--accent-glow)' : 'transparent',
                      color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                      fontWeight: isActive ? 600 : 400,
                      transition: 'background .12s',
                    }}
                    onMouseEnter={e => { if (!isActive) e.currentTarget.style.background = 'var(--bg-hover)'; }}
                    onMouseLeave={e => { if (!isActive) e.currentTarget.style.background = 'transparent'; }}
                    onKeyDown={e => { if (e.key === 'Escape') setOpen(false); }}
                  >
                    {cs
                      ? <span style={{ width: 8, height: 8, borderRadius: '50%', background: cs.color, flexShrink: 0 }} />
                      : <span style={{ width: 8, height: 8, flexShrink: 0 }} />
                    }
                    <span style={{ flex: 1 }}>{opt.label}</span>
                    {isActive && (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                        <polyline points="20 6 9 17 4 12"/>
                      </svg>
                    )}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Group tile — one per category; opens that category's links ────
function GroupTile({ group, onOpen }) {
  const uncat = group.key === UNCAT;
  const cs = uncat ? { bg: 'rgba(107,114,128,.12)', color: 'var(--text-secondary)' } : catStyle(group.label);
  const n = group.links.length, starred = group.links.filter(l => l.starred).length;
  const preview = group.links.slice(0, 4), more = n - preview.length;
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: .98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: .96 }}
      transition={{ duration: .16 }}
      onClick={onOpen} role="button" tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(); } }}
      aria-label={`Open ${group.label}: ${n} link${n === 1 ? '' : 's'}`}
      whileHover={{ boxShadow: '0 4px 14px rgba(0,0,0,.1)', y: -1 }}
      className="links-tile"
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 14, cursor: 'pointer', minWidth: 0 }}
    >
      <div className="links-tile-head" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ width: 36, height: 36, borderRadius: 10, background: cs.bg, color: cs.color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
        </span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{group.label}</div>
          <div style={{ fontSize: '0.76rem', color: 'var(--text-muted)', marginTop: 2 }}>
            {n} link{n === 1 ? '' : 's'}{starred > 0 && <span style={{ color: 'var(--color-amber)' }}> · ★ {starred}</span>}
          </div>
        </div>
      </div>
      <div className="links-tile-fav" style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
        {preview.map(l => <FaviconIcon key={l.id} url={l.url} size={22} />)}
        {more > 0 && <span style={{ fontSize: '0.74rem', fontWeight: 600, color: 'var(--text-muted)', marginLeft: 2 }}>+{more}</span>}
      </div>
    </motion.div>
  );
}

// ── Link Card ─────────────────────────────────────────────────────
function LinkCard({ link, onEdit, onDelete, onToggleStar, compact }) {
  const layoutAnim = useLayoutAnimations();   // off while the sidebar toggles (see utils/layoutFreeze.js)
  const cs = catStyle(link.category);

  // A stored url can come from sync or a backup, so only http(s) is ever opened (no javascript:/data:).
  const openLink = () => { openSafeUrl(link.url); };

  const iconBtn = (label, col, hBg, hCol, svg, onClick) => (
    <button onClick={e => { e.stopPropagation(); onClick(); }} aria-label={label} title={label}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: col, padding: 5, display: 'flex', borderRadius: 6, flexShrink: 0, transition: 'all .12s' }}
      onMouseEnter={e => { e.currentTarget.style.background = hBg; e.currentTarget.style.color = hCol; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = col; }}>
      {svg}
    </button>
  );

  const starBtn = (
    <button onClick={e => { e.stopPropagation(); onToggleStar(link.id); }}
      aria-label={link.starred ? 'Unstar' : 'Star'}
      title={link.starred ? 'Remove from favourites' : 'Add to favourites'}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: link.starred ? 'var(--color-amber)' : 'var(--text-muted)', padding: compact ? 5 : 4, display: 'flex', borderRadius: 5, transition: 'color .15s', flexShrink: 0 }}>
      <svg width="14" height="14" viewBox="0 0 24 24" fill={link.starred ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
    </button>
  );

  const deleteSection = iconBtn('Delete', 'var(--text-muted)', 'var(--color-red-bg)', 'var(--color-red)',
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>,
      async () => { if (await askConfirm({ title: 'Delete this link?', message: `"${link.name || link.url}" will be deleted. This can't be undone.` })) onDelete(link.id); }
    );

  const actions = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
      <CopyBtn text={link.url} />
      {iconBtn('Edit', 'var(--text-muted)', 'var(--bg-hover)', 'var(--accent)',
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>,
        () => onEdit(link)
      )}
      {deleteSection}
    </div>
  );

  // ── Compact list row ──
  if (compact) {
    return (
      <motion.div layout={layoutAnim} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={{ duration: .14 }}
        onClick={openLink} role="link" tabIndex={0}
        onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLink(); } }}
        aria-label={`Open ${link.name}`}
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer', boxShadow: '0 1px 3px rgba(0,0,0,.05)', transition: 'background .12s', marginBottom: 16 }}
        onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-hover)')}
        onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-card)')}>
        <FaviconIcon url={link.url} size={22} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: '0.88rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{link.name}</span>
          <span style={{ fontSize: '0.74rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{domain(link.url) || link.url}</span>
        </div>
        {link.category && <span style={{ borderRadius: 9999, background: cs.bg, color: cs.color, padding: '2px 9px', fontSize: '0.7rem', fontWeight: 600, whiteSpace: 'nowrap', flexShrink: 0 }}>{link.category}</span>}
        {starBtn}
        {actions}
      </motion.div>
    );
  }

  // ── Grid card ──
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8, scale: .98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: .96 }}
      transition={{ duration: .16 }}
      onClick={openLink}
      role="link"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openLink(); } }}
      aria-label={`Open ${link.name}`}
      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 14, padding: '16px 18px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: 'none', cursor: 'pointer', transition: 'box-shadow .15s, transform .12s', position: 'relative' }}
      whileHover={{ boxShadow: '0 4px 14px rgba(0,0,0,.1)', y: -1 }}
    >
      {/* Star */}
      <div style={{ position: 'absolute', top: 12, right: 12 }}>{starBtn}</div>

      {/* Top row: favicon + name */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, paddingRight: 24 }}>
        <FaviconIcon url={link.url} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: '0.93rem', color: 'var(--text-primary)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{link.name}</div>
          <div style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>{domain(link.url) || link.url}</div>
        </div>
      </div>

      {/* Bottom row: category pill + actions */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        {link.category ? (
          <span style={{ borderRadius: 9999, background: cs.bg, color: cs.color, padding: '3px 10px', fontSize: '0.72rem', fontWeight: 600, whiteSpace: 'nowrap' }}>{link.category}</span>
        ) : <span />}
        {actions}
      </div>
    </motion.div>
  );
}

// ── Add / Edit Modal ──────────────────────────────────────────────
function LinksModal({ entry, existingCats, defaultCategory = '', onSave, onClose }) {
  const [name,     setName]     = useState(entry?.name     || '');
  const [url,      setUrl]      = useState(entry?.url      || '');
  const [catSel,   setCatSel]   = useState(entry?.category || defaultCategory);   // adding from inside a group starts in that group
  const [newCat,   setNewCat]   = useState('');
  const [addingCat, setAddingCat] = useState(false);
  const firstRef = useRef(null);
  const submittingRef = useRef(false); // guards a same-frame double-submit (double-Enter)
  useEffect(() => { firstRef.current?.focus(); }, []);

  const allCats = useMemo(() => {
    const merged = [...new Set([...BASE_CATS, ...existingCats])];
    return merged.sort();
  }, [existingCats]);

  const effectiveCat = addingCat ? newCat.trim() : catSel;

  const submit = (e) => {
    e.preventDefault();
    if (!name.trim() || !url.trim() || submittingRef.current) return;
    submittingRef.current = true;
    let finalUrl = url.trim();
    if (!/^https?:\/\//i.test(finalUrl)) finalUrl = 'https://' + finalUrl;
    onSave({
      id:        entry?.id || genId(),
      name:      name.trim(),
      url:       finalUrl,
      category:  effectiveCat,
      starred:   entry?.starred || false,
      createdAt: entry?.createdAt || new Date().toISOString(),
    });
    onClose();
  };

  const inp = { style: { width: '100%', padding: '11px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '0.88rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', transition: 'border-color .13s' }, onFocus: e => (e.target.style.borderColor = 'var(--accent)'), onBlur: e => (e.target.style.borderColor = 'var(--border)') };
  const lbl = { style: { display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.05em' } };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.55)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 20, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20 }}
        transition={{ duration: .2 }}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-elevated)', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,.35)', width: '100%', maxWidth: 480 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>{entry ? 'Edit Link' : 'Add Link'}</h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'flex', borderRadius: 6 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <form onSubmit={submit} style={{ padding: '18px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label {...lbl}>Name *</label>
            <input ref={firstRef} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. My Google Drive" required {...inp} />
          </div>
          <div>
            <label {...lbl}>URL *</label>
            <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." required {...inp} />
          </div>
          <div>
            <label {...lbl}>Category</label>
            {addingCat ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input value={newCat} onChange={e => setNewCat(e.target.value)} placeholder="New category name" autoFocus
                  style={{ ...inp.style, flex: 1 }} onFocus={inp.onFocus} onBlur={inp.onBlur} />
                <button type="button" onClick={() => { setAddingCat(false); if (!newCat.trim()) setCatSel(''); }}
                  style={{ background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, padding: '0 12px', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: '0.8rem', fontWeight: 600, whiteSpace: 'nowrap' }}>
                  Cancel
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <Select value={catSel} onChange={e => setCatSel(e.target.value)}
                  options={[{ value: '', label: '— None —' }, ...allCats.map(c => ({ value: c, label: c }))]}
                  placeholder="— None —"
                  style={{ ...inp.style, flex: 1 }} />
                <button type="button" onClick={() => { setAddingCat(true); setCatSel(''); }}
                  aria-label="Add new category"
                  style={{ width: 40, flexShrink: 0, background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, cursor: 'pointer', color: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.2rem', fontWeight: 700, transition: 'background .12s' }}
                  onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-glow)')}
                  onMouseLeave={e => (e.currentTarget.style.background = 'var(--bg-input)')}>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                </button>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <button type="submit" style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 0', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', transition: 'background .13s' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-dark)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
              {entry ? 'Save Changes' : 'Add Link'}
            </button>
            <button type="button" onClick={onClose} style={{ flex: 1, background: 'transparent', color: 'var(--text-secondary)', border: '1px solid var(--border)', borderRadius: 8, padding: '11px 0', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer' }}>
              Cancel
            </button>
          </div>
        </form>
      </motion.div>
    </motion.div>
  );
}

// ── Main LinksView ────────────────────────────────────────────────
export default memo(function LinksView() {
  const [links,     setLinks]     = useState(load);
  useSyncApplied(['links'], () => setLinks(load()));   // another device's change, merged into storage
  const [query,     setQuery]     = useState('');
  const [catFilter, setCatFilter] = useState('');   // a group key (see utils/linkGroups), '' = none
  const [modal,     setModal]     = useState(null); // null | 'add' | entry
  const [viewMode,  setViewMode]  = useState('groups'); // 'groups' (a tile per category — the first screen) | 'grid' | 'list' (all links, flat)

  const saveLink = (link) => {
    setLinks(prev => {
      const exists = prev.find(l => l.id === link.id);
      const next = exists ? prev.map(l => l.id === link.id ? link : l) : [link, ...prev];
      logActivity({ module: 'links', entity_type: 'link', entity_id: link.id, action: exists ? 'updated' : 'created', title: link.name || link.url });
      save(next); return next;
    });
  };

  const deleteLink = (id) => {
    setLinks(prev => {
      const existing = prev.find(l => l.id === id);
      if (existing) logActivity({ module: 'links', entity_type: 'link', entity_id: id, action: 'deleted', title: existing.name || existing.url });
      const next = prev.filter(l => l.id !== id);
      save(next);
      return next;
    });
  };

  const toggleStar = (id) => {
    setLinks(prev => {
      const next = prev.map(l => l.id === id ? { ...l, starred: !l.starred } : l);
      const existing = next.find(l => l.id === id);
      if (existing) logActivity({ module: 'links', entity_type: 'link', entity_id: id, action: 'updated', title: `Star ${existing.starred ? 'added' : 'removed'}: ${existing.name || existing.url}` });
      save(next); return next;
    });
  };

  // One group per category (case-insensitive) + "Uncategorised" — see utils/linkGroups.js.
  const groups = useMemo(() => groupLinks(links), [links]);
  const allCats = useMemo(() => groups.filter(g => g.key !== UNCAT).map(g => g.label), [groups]);   // for the add/edit modal
  // A filter pointing at a group that no longer exists (its last link was deleted) means "no filter".
  const activeCat = catFilter && groups.some(g => g.key === catFilter) ? catFilter : '';
  const activeGroup = groups.find(g => g.key === activeCat) || null;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = links;
    if (q)         out = out.filter(l => l.name.toLowerCase().includes(q) || l.url.toLowerCase().includes(q) || (l.category||'').toLowerCase().includes(q));
    if (activeCat) out = out.filter(l => catKeyOf(l) === activeCat);
    // starred first
    return [...out.filter(l => l.starred), ...out.filter(l => !l.starred)];
  }, [links, query, activeCat]);

  // The tiles are the first screen; typing in the search box, or opening a group, leaves them.
  const showGroups = viewMode === 'groups' && !activeCat && query.trim() === '';

  const catCount = allCats.length;
  const n = filtered.length;
  const countLabel = `${n} link${n !== 1 ? 's' : ''}` + (catCount ? ` · ${catCount} categor${catCount !== 1 ? 'ies' : 'y'}` : '');

  const vmBtn = (mode, title, svgPath) => (
    <button onClick={() => setViewMode(mode)} aria-label={title} title={title}
      style={{ background: viewMode === mode ? 'var(--accent)' : 'var(--bg-input)', color: viewMode === mode ? '#fff' : 'var(--text-muted)', border: '1px solid var(--border)', borderRadius: 7, padding: '6px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', transition: 'all .13s' }}>
      {svgPath}
    </button>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', background: 'transparent' }}>
      <style>{`
        @media (max-width: 768px) {
          .links-toolbar .links-search { max-width: 100% !important; }
          .links-grid { grid-template-columns: 1fr !important; }
          .links-groups { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; gap: 12px !important; }
          /* Two tiles per row leaves ~130px each: stack the icon above the name (so names aren't
             cut to "Ne…") and let the favicon row wrap instead of overflowing the tile. */
          .links-tile { padding: 14px !important; gap: 12px !important; overflow: hidden; }
          .links-tile-head { flex-direction: column !important; align-items: flex-start !important; gap: 10px !important; }
          .links-tile-head > div { width: 100%; }
          .links-tile-fav { flex-wrap: wrap; }
        }
        @media (max-width: 360px) {
          .links-groups { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ── Toolbar — pinned (position:sticky, see .lk-bar) while the links scroll under it.
          The root above must not set overflow/height: either would turn it into the sticky
          bar's scroll container and stop it pinning to the tab's scroll area. ── */}
      <div className="lk-bar">
        <div className="links-toolbar" style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, width: '100%' }}>

          {/* Search */}
          <div className="links-search" style={{ position: 'relative', width: 280, flexShrink: 0 }}>
            <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
            <input type="search" aria-label="Search links" placeholder="Search links..."
              value={query} onChange={e => setQuery(e.target.value)}
              style={{ width: '100%', height: 36, padding: '0 10px 0 32px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.84rem', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }} />
          </div>

          {/* Add Link — primary action, right after search */}
          <button className="add-task-btn" style={{ flexShrink: 0 }} onClick={() => setModal('add')}>＋ Add Link</button>

          {/* View toggle — beside Add Link */}
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            {vmBtn('groups', 'Groups — a tile per category',
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
            )}
            {vmBtn('grid', 'Grid view — all links',
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
            )}
            {vmBtn('list', 'List view — all links',
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
            )}
          </div>

          {/* Category filter */}
          {allCats.length > 0 && (
            <CategoryDropdown value={activeCat} onChange={setCatFilter} options={groups.map(g => ({ value: g.key, label: g.label }))} />
          )}

          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap', flex: 1 }}>{countLabel}</span>

        </div>
      </div>

      {/* ── Content ── */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px 24px 24px', scrollbarWidth: 'thin', scrollbarColor: 'var(--border) transparent' }}>
        <div style={{ width: '100%' }}>

          {links.length === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', gap: 16, textAlign: 'center' }}>
              <div style={{ width: 68, height: 68, background: 'var(--accent-glow)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              </div>
              <div>
                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>No links saved yet</div>
                <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)', maxWidth: 300, lineHeight: 1.55 }}>Save your favourite websites, tools, and resources here for quick one-click access.</div>
              </div>
              <button onClick={() => setModal('add')}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(99,102,241,.3)' }}>
                Add First Link
              </button>
            </div>

          ) : showGroups ? (
            <div className="links-groups" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 16 }}>
              <AnimatePresence>
                {groups.map(g => <GroupTile key={g.key} group={g} onOpen={() => setCatFilter(g.key)} />)}
              </AnimatePresence>
            </div>

          ) : filtered.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>No links match your filters</div>
              <button onClick={() => { setQuery(''); setCatFilter(''); }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontWeight: 600, fontSize: '0.85rem' }}>Clear filters</button>
            </div>

          ) : (
            <>
              {/* Inside a group: a way back to the tiles */}
              {viewMode === 'groups' && activeGroup && (
                <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                  <button type="button" onClick={() => setCatFilter('')}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontWeight: 600, fontSize: '0.84rem', padding: '4px 0', fontFamily: 'inherit' }}>
                    ← All groups
                  </button>
                  <span aria-hidden="true" style={{ color: 'var(--text-muted)' }}>/</span>
                  <span style={{ fontWeight: 700, fontSize: '0.95rem', color: 'var(--text-primary)' }}>{activeGroup.label}</span>
                  <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)' }}>{n} link{n !== 1 ? 's' : ''}</span>
                </div>
              )}
              <div className="links-grid" style={viewMode === 'list'
                ? { display: 'flex', flexDirection: 'column', gap: 6 }
                : { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16 }}>
                <AnimatePresence>
                  {filtered.map(link => (
                    <LinkCard key={link.id} link={link}
                      compact={viewMode === 'list'}
                      onEdit={l => setModal(l)}
                      onDelete={deleteLink}
                      onToggleStar={toggleStar} />
                  ))}
                </AnimatePresence>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Modal */}
      <AnimatePresence>
        {modal && (
          <LinksModal
            key={modal === 'add' ? 'new' : modal.id}
            entry={modal === 'add' ? null : modal}
            existingCats={allCats}
            defaultCategory={modal === 'add' && activeGroup && activeGroup.key !== UNCAT ? activeGroup.label : ''}
            onSave={saveLink}
            onClose={() => setModal(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
});
