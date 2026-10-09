import { memo,  useState, useMemo, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { logActivity } from '../utils/activityLog';
import { genId } from '../utils/id';
import { loadVault, saveVault } from '../utils/vaultStore';

// Deterministic colour from a string
function serviceColor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) & 0xffff;
  const hues = [210, 160, 280, 340, 25, 190, 250, 120, 310];
  return `hsl(${hues[h % hues.length]},65%,52%)`;
}
function initials(str) {
  const parts = str.trim().split(/\s+/);
  return parts.length > 1
    ? (parts[0][0] + parts[1][0]).toUpperCase()
    : str.slice(0, 2).toUpperCase();
}

// Reads an entry's custom fields, transparently upgrading the old fixed
// username/password/url shape (still present on entries saved before this
// redesign) into the generic { id, label, value, secret } shape on the fly.
// Read-only — storage isn't rewritten until the entry is next saved.
function getEntryFields(entry) {
  if (Array.isArray(entry.fields)) return entry.fields;
  const legacy = [];
  if (entry.username) legacy.push({ id: genId(), label: 'Username',    value: entry.username, secret: false });
  if (entry.password) legacy.push({ id: genId(), label: 'Password',    value: entry.password, secret: true  });
  if (entry.url)      legacy.push({ id: genId(), label: 'Website URL', value: entry.url,      secret: false });
  return legacy;
}
const blankField = () => ({ id: genId(), label: '', value: '', secret: false });

// ── Add / Edit Modal ──────────────────────────────────────────────
function VaultModal({ entry, defaultService, services, onSave, onClose }) {
  const [service, setService] = useState(entry?.title || defaultService || '');
  const [fields,  setFields]  = useState(() => {
    const initial = entry ? getEntryFields(entry) : [];
    return initial.length ? initial.map(f => ({ ...f, id: f.id || genId() })) : [blankField()];
  });
  const firstRef = useRef(null);
  const submittingRef = useRef(false); // guards a same-frame double-submit (double-Enter)
  useEffect(() => { firstRef.current?.focus(); }, []);

  const updateField = (id, patch) => setFields(prev => prev.map(f => f.id === id ? { ...f, ...patch } : f));
  const removeField = (id) => setFields(prev => prev.filter(f => f.id !== id));
  const addField     = () => setFields(prev => [...prev, blankField()]);

  const submit = (e) => {
    e.preventDefault();
    if (!service.trim() || submittingRef.current) return;
    submittingRef.current = true;
    const cleanFields = fields
      .map(f => ({ ...f, label: f.label.trim(), value: f.secret ? f.value : f.value.trim() }))
      .filter(f => f.label || f.value);
    onSave({
      id:        entry?.id || genId(),
      title:     service.trim(),
      fields:    cleanFields,
      createdAt: entry?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    onClose();
  };

  const field = (extra = {}) => ({
    style: { width: '100%', padding: '11px 14px', border: '1px solid var(--border)', borderRadius: 8, background: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: '0.88rem', outline: 'none', boxSizing: 'border-box', fontFamily: 'inherit', transition: 'border-color .13s' },
    onFocus: e => (e.target.style.borderColor = 'var(--accent)'),
    onBlur:  e => (e.target.style.borderColor = 'var(--border)'),
    ...extra,
  });
  const smallLabel = { display: 'block', fontSize: '0.7rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' };

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 400, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
      onClick={onClose}>
      <motion.div initial={{ opacity: 0, y: 20, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 20 }}
        transition={{ duration: .2, ease: 'easeOut' }}
        onClick={e => e.stopPropagation()}
        style={{ background: 'var(--bg-elevated)', borderRadius: 16, boxShadow: '0 20px 60px rgba(0,0,0,.35)', width: '100%', maxWidth: 480 }}>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '20px 24px 0' }}>
          <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)' }}>{entry ? 'Edit Account' : 'Add Account'}</h2>
          <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 4, display: 'flex', borderRadius: 6 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <form onSubmit={submit} style={{ padding: '18px 24px 24px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Service name */}
          <div>
            <label style={{ display: 'block', fontSize: '0.75rem', fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 5, textTransform: 'uppercase', letterSpacing: '.05em' }}>Service / App Name *</label>
            <input ref={firstRef} list="vault-services" value={service} onChange={e => setService(e.target.value)} placeholder="e.g. Gmail, GitHub, Netflix" required {...field()} />
            <datalist id="vault-services">
              {services.map(s => <option key={s} value={s} />)}
            </datalist>
          </div>
          {/* Custom fields — two inputs (label + value) per row, add as many rows as needed */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {fields.map((f, i) => (
              <div key={f.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg-input)' }}>
                <div style={{ display: 'flex', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <label style={smallLabel}>Field label</label>
                    <input value={f.label} onChange={e => updateField(f.id, { label: e.target.value })}
                      placeholder="e.g. Username, PIN" {...field()} style={{ ...field().style, background: 'var(--bg-elevated)' }} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <label style={smallLabel}>Field value</label>
                    <div style={{ position: 'relative' }}>
                      <input value={f.value} onChange={e => updateField(f.id, { value: e.target.value })}
                        type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder="Value"
                        {...field({ style: { ...field().style, background: 'var(--bg-elevated)', paddingRight: 38 } })} />
                      <button type="button" onClick={() => updateField(f.id, { secret: !f.secret })}
                        aria-label={f.secret ? 'Marked sensitive — value hidden' : 'Mark as sensitive value'} title={f.secret ? 'Sensitive value (click to unmask while typing)' : 'Mark as sensitive value'}
                        style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: f.secret ? 'var(--accent)' : 'var(--text-muted)', display: 'flex', padding: 4 }}>
                        <EyeIcon open={!f.secret} size={16} />
                      </button>
                    </div>
                  </div>
                </div>
                {fields.length > 1 && (
                  <button type="button" onClick={() => removeField(f.id)}
                    style={{ alignSelf: 'flex-end', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 600, padding: '2px 4px', display: 'flex', alignItems: 'center', gap: 3 }}>
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    Remove row
                  </button>
                )}
              </div>
            ))}
            <button type="button" onClick={addField}
              style={{ alignSelf: 'flex-start', background: 'none', border: '1px dashed var(--border)', borderRadius: 8, color: 'var(--accent)', fontSize: '0.8rem', fontWeight: 600, padding: '7px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              Add row
            </button>
          </div>
          <div style={{ display: 'flex', gap: 10, marginTop: 2 }}>
            <button type="submit" style={{ flex: 1, background: 'var(--accent)', color: '#fff', border: 'none', borderRadius: 8, padding: '11px 0', fontSize: '0.88rem', fontWeight: 600, cursor: 'pointer', transition: 'background .13s' }}
              onMouseEnter={e => (e.currentTarget.style.background = 'var(--accent-dark)')}
              onMouseLeave={e => (e.currentTarget.style.background = 'var(--accent)')}>
              {entry ? 'Save Changes' : 'Add Account'}
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

// ── Shared micro icons ────────────────────────────────────────────
function EyeIcon({ open, size = 15 }) {
  return open
    ? <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
    : <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>;
}

function CopyBtn({ text, label }) {
  const [ok, setOk] = useState(false);
  const copy = () => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1800); });
  return (
    <button onClick={copy} aria-label={label} title={label}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color: ok ? 'var(--color-green)' : 'var(--text-muted)', padding: 5, display: 'flex', borderRadius: 5, flexShrink: 0, transition: 'color .15s' }}>
      {ok
        ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
      }
    </button>
  );
}

// One field's value cell — owns its own reveal state so multiple secret
// fields on the same row don't share a single show/hide toggle.
function FieldValue({ f }) {
  const [show, setShow] = useState(false);
  if (!f.value) return <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>—</span>;
  if (!f.secret) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <span style={{ fontSize: '0.84rem', color: 'var(--text-primary)', wordBreak: 'break-word' }}>{f.value}</span>
        <CopyBtn text={f.value} label={`Copy ${f.label || 'value'}`} />
      </span>
    );
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
      <span style={{ fontSize: '0.82rem', color: 'var(--text-secondary)', fontFamily: show ? 'inherit' : 'monospace', letterSpacing: show ? 'normal' : '.1em' }}>
        {show ? f.value : '••••••••'}
      </span>
      <button onClick={() => setShow(s => !s)} aria-label={show ? 'Hide value' : 'Reveal value'}
        style={{ background: 'none', border: 'none', cursor: 'pointer', color: show ? 'var(--accent)' : 'var(--text-muted)', padding: 5, display: 'flex', borderRadius: 5, flexShrink: 0 }}>
        <EyeIcon open={show} />
      </button>
      <CopyBtn text={f.value} label={`Copy ${f.label || 'value'}`} />
    </span>
  );
}

// ── Account Row (inside expanded group) ──────────────────────────
function AccountRow({ entry, onEdit, onDelete }) {
  const [confirmDel, setConfirmDel] = useState(false);
  const fields = getEntryFields(entry).filter(f => f.label || f.value);

  const iconBtn = (label, color, hoverBg, hoverColor, children, onClick) => (
    <button onClick={onClick} aria-label={label} title={label}
      style={{ background: 'none', border: 'none', cursor: 'pointer', color, padding: 5, display: 'flex', borderRadius: 6, flexShrink: 0, transition: 'all .12s' }}
      onMouseEnter={e => { e.currentTarget.style.background = hoverBg; e.currentTarget.style.color = hoverColor; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'none'; e.currentTarget.style.color = color; }}>
      {children}
    </button>
  );

  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '10px 12px', borderRadius: 10, background: 'var(--bg-elevated)', border: '1px solid var(--border)', minWidth: 0 }}>

      {/* Fields */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 5 }}>
        {fields.length === 0 ? (
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', fontStyle: 'italic' }}>No fields added</span>
        ) : fields.map(f => (
          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: '0.68rem', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '.04em', minWidth: 72 }}>
              {f.label || 'Field'}
            </span>
            <FieldValue f={f} />
          </div>
        ))}
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 1, flexShrink: 0 }}>
        {iconBtn('Edit account', 'var(--text-muted)', 'var(--bg-hover)', 'var(--accent)', (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        ), () => onEdit(entry))}
        {confirmDel ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, background: 'var(--color-red-bg)', borderRadius: 6, padding: '2px 6px' }}>
            <span style={{ fontSize: '0.7rem', color: 'var(--color-red)', fontWeight: 600 }}>Delete?</span>
            <button onClick={() => onDelete(entry.id)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-red)', fontWeight: 700, fontSize: '0.7rem', padding: '2px 3px' }}>Yes</button>
            <button onClick={() => setConfirmDel(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: '0.7rem', padding: '2px 3px' }}>No</button>
          </div>
        ) : (
          iconBtn('Delete account', 'var(--text-muted)', 'var(--color-red-bg)', 'var(--color-red)', (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
          ), () => setConfirmDel(true))
        )}
      </div>
    </div>
  );
}

// ── Service Group (accordion) ─────────────────────────────────────
function ServiceGroup({ serviceName, accounts, defaultOpen, onEdit, onDelete, onAddToService }) {
  const [open, setOpen] = useState(defaultOpen);
  const color = serviceColor(serviceName);
  const inits = initials(serviceName);

  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>

      {/* Header */}
      <button
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        style={{ width: '100%', padding: '14px 18px', borderRadius: 10, display: 'flex', alignItems: 'center', gap: 14, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', transition: 'background .12s' }}
        onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
      >
        {/* Avatar */}
        <div style={{ width: 40, height: 40, borderRadius: 10, background: color, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0, fontWeight: 800, fontSize: '0.82rem', color: '#fff', letterSpacing: '.02em' }}>
          {inits}
        </div>

        {/* Name + count */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: '0.95rem', fontWeight: 700, color: 'var(--text-primary)' }}>{serviceName}</span>
          <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginLeft: 8 }}>
            {accounts.length} account{accounts.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Add to group */}
        <div onClick={e => { e.stopPropagation(); onAddToService(serviceName); }}
          role="button" tabIndex={0}
          onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onAddToService(serviceName); } }}
          aria-label={`Add account to ${serviceName}`}
          title={`Add account to ${serviceName}`}
          style={{ padding: '4px 8px', borderRadius: 7, border: '1px solid var(--border)', color: 'var(--text-muted)', fontSize: '0.75rem', fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0, background: 'var(--bg-input)', transition: 'all .12s' }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--accent)'; e.currentTarget.style.color = 'var(--accent)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; e.currentTarget.style.color = 'var(--text-muted)'; }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
          Add
        </div>

        {/* Chevron */}
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          style={{ flexShrink: 0, transition: 'transform .2s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}>
          <polyline points="6 9 12 15 18 9"/>
        </svg>
      </button>

      {/* Expanded body */}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: .2, ease: 'easeInOut' }}
            style={{ overflow: 'hidden' }}
          >
            <div style={{ padding: '0 16px 16px', display: 'flex', flexDirection: 'column', gap: 8, borderTop: '1px solid var(--border)' }}>
              <div style={{ height: 8 }} />
              {accounts.map(entry => (
                <AccountRow key={entry.id} entry={entry} onEdit={onEdit} onDelete={onDelete} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ── Main VaultView ────────────────────────────────────────────────
export default memo(function VaultView() {
  const [entries,  setEntries]  = useState([]);
  const [vaultLoading, setVaultLoading] = useState(true);
  const [query,    setQuery]    = useState('');
  const [modal,    setModal]    = useState(null); // null | { mode:'add', service? } | { mode:'edit', entry }

  useEffect(() => {
    loadVault().then(data => { setEntries(data); setVaultLoading(false); });
  }, []);

  const persist = (next) => { setEntries(next); saveVault(next); };

  const saveEntry = (entry) => {
    setEntries(prev => {
      const exists = prev.find(e => e.id === entry.id);
      const next = exists ? prev.map(e => e.id === entry.id ? entry : e) : [entry, ...prev];
      logActivity({ module: 'vault', entity_type: 'vault_item', entity_id: entry.id, action: exists ? 'updated' : 'created', title: entry.title });
      save(next); return next;
    });
  };

  const deleteEntry = (id) => {
    setEntries(prev => { 
      const existing = prev.find(e => e.id === id);
      if (existing) logActivity({ module: 'vault', entity_type: 'vault_item', entity_id: id, action: 'deleted', title: existing.title });
      const next = prev.filter(e => e.id !== id); 
      save(next); 
      return next; 
    });
  };

  // All unique service names (for datalist autocomplete)
  const serviceNames = useMemo(() => [...new Set(entries.map(e => e.title))].sort(), [entries]);

  // Group entries by service name, with search filtering
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? entries.filter(e =>
          e.title.toLowerCase().includes(q) ||
          getEntryFields(e).some(f =>
            f.label.toLowerCase().includes(q) || (!f.secret && f.value.toLowerCase().includes(q))
          )
        )
      : entries;

    const map = new Map();
    filtered.forEach(e => {
      if (!map.has(e.title)) map.set(e.title, []);
      map.get(e.title).push(e);
    });
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries, query]);

  const totalAccounts = entries.length;

  return (
    <div style={{ width: '100%', maxWidth: 900, margin: '0 auto', boxSizing: 'border-box', padding: '32px', display: 'flex', flexDirection: 'column', gap: 20, background: 'transparent' }}>

      <div style={{
        padding: '10px 14px', borderRadius: 8,
        background: 'rgba(234,179,8,0.12)', border: '1px solid rgba(234,179,8,0.4)',
        fontSize: '0.8rem', color: '#ca8a04', display: 'flex', gap: 8, alignItems: 'center'
      }}>
        ⚠️ Passwords are stored unencrypted on this device. Do not use this for highly sensitive credentials.
      </div>

      {/* ── Toolbar ── */}
      <div style={{ paddingBottom: 14, borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 12 }}>
        <div style={{ position: 'relative', flex: 1, maxWidth: 340 }}>
          <svg style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input type="search" aria-label="Search saved logins" placeholder="Search accounts..."
            value={query} onChange={e => setQuery(e.target.value)}
            style={{ width: '100%', height: 36, padding: '0 10px 0 32px', background: 'var(--bg-input)', border: '1px solid var(--border)', borderRadius: 8, fontSize: '0.84rem', color: 'var(--text-primary)', outline: 'none', boxSizing: 'border-box' }} />
        </div>

        <span style={{ fontSize: '0.78rem', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
          {query.trim()
            ? `${groups.reduce((n, [, a]) => n + a.length, 0)} of ${totalAccounts} accounts`
            : `${totalAccounts} account${totalAccounts !== 1 ? 's' : ''} · ${groups.length} service${groups.length !== 1 ? 's' : ''}`}
        </span>

        {/* Add Account — primary action, moved here from the removed page header */}
        <button className="add-task-btn" style={{ marginLeft: 'auto', flexShrink: 0 }} onClick={() => setModal({ mode: 'add' })}>＋ Add Account</button>
      </div>

      {/* ── Grouped List ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

          {totalAccounts === 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '50vh', gap: 16, textAlign: 'center' }}>
              <div style={{ width: 68, height: 68, background: 'var(--accent-glow)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
              </div>
              <div>
                <div style={{ fontSize: '1.05rem', fontWeight: 700, color: 'var(--text-primary)', marginBottom: 6 }}>No saved logins yet</div>
                <div style={{ fontSize: '0.84rem', color: 'var(--text-muted)', maxWidth: 300, lineHeight: 1.55 }}>Add accounts to get started. Stored in plain text in your browser's local storage — not encrypted, so avoid your most sensitive passwords here.</div>
              </div>
              <button onClick={() => setModal({ mode: 'add' })}
                style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '10px 24px', borderRadius: 10, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', boxShadow: '0 4px 12px rgba(99,102,241,.3)' }}>
                Add First Account
              </button>
            </div>

          ) : groups.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)' }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>No accounts match "{query}"</div>
              <button onClick={() => setQuery('')} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontWeight: 600, fontSize: '0.85rem' }}>Clear search</button>
            </div>

          ) : (
            <AnimatePresence>
              {groups.map(([svc, accs], i) => (
                <motion.div key={svc} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .15, delay: i * .03 }}>
                  <ServiceGroup
                    serviceName={svc}
                    accounts={accs}
                    defaultOpen={groups.length === 1 || !!query.trim()}
                    onEdit={entry => setModal({ mode: 'edit', entry })}
                    onDelete={deleteEntry}
                    onAddToService={svcName => setModal({ mode: 'add', service: svcName })}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          )}
      </div>

      {/* Footer notice */}
      <div style={{ paddingTop: 8, borderTop: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 7, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Stored locally in this browser only, in plain text (not encrypted) — never uploaded to a server. Not recommended for highly sensitive passwords.
      </div>

      {/* Modal */}
      <AnimatePresence>
        {modal && (
          <VaultModal
            key={modal.mode === 'edit' ? modal.entry.id : 'new'}
            entry={modal.mode === 'edit' ? modal.entry : null}
            defaultService={modal.mode === 'add' ? (modal.service || '') : ''}
            services={serviceNames}
            onSave={saveEntry}
            onClose={() => setModal(null)}
          />
        )}
      </AnimatePresence>
    </div>
  );
});
