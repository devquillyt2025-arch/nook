import { useState, useRef, useEffect, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useIsRail } from './SidebarFlyout';

const isMac = typeof window !== 'undefined' && navigator.userAgent.toLowerCase().includes('mac');

// Live full-rescan search across tasks/habits state + several localStorage-backed
// features, unchanged from the original App.jsx implementation — only the query is
// now debounced before the scan runs. Ctrl/Cmd+K still just focuses the input.
export function useNookSearch(tasks, habits) {
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const searchInputRef = useRef(null);

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(searchQuery), 180);
    return () => clearTimeout(id);
  }, [searchQuery]);

  useEffect(() => {
    const handleKeyDown = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  const searchResults = useMemo(() => {
    const q = debouncedQuery.toLowerCase().trim();
    if (q.length < 2) return [];
    const results = [];

    tasks.forEach(t => {
      if (t.name?.toLowerCase().includes(q) || t.notes?.toLowerCase().includes(q)) {
        results.push({ type: 'task', id: t.id, title: t.name, sub: t.notes?.slice(0, 60) || t.category, tab: 'tasks' });
      }
    });

    try {
      JSON.parse(localStorage.getItem('nook_notes') || '[]').forEach(n => {
        if (n.title?.toLowerCase().includes(q) || n.content?.toLowerCase().includes(q)) {
          results.push({ type: 'note', id: n.id, title: n.title || 'Untitled note', sub: n.content?.slice(0, 60), tab: 'notes' });
        }
      });
    } catch {}

    try {
      JSON.parse(localStorage.getItem('nook_countdowns') || '[]').forEach(c => {
        if (c.name?.toLowerCase().includes(q)) {
          results.push({ type: 'countdown', id: c.id, title: c.name, sub: `${c.startDate} – ${c.endDate}`, tab: 'countdowns' });
        }
      });
    } catch {}

    habits.forEach(h => {
      if (h.name?.toLowerCase().includes(q)) {
        results.push({ type: 'habit', id: h.id, title: h.name, sub: 'Habit tracker', tab: 'habits' });
      }
    });

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('nook_journal_')) continue;
      try {
        const e = JSON.parse(localStorage.getItem(key));
        const content = e?.content || '';
        if (content.toLowerCase().includes(q)) {
          const idx = content.toLowerCase().indexOf(q);
          const preview = content.slice(Math.max(0, idx - 20), idx + 60).trim();
          results.push({ type: 'journal', id: e.date, title: `Journal — ${e.date}`, sub: preview, tab: 'journal' });
        }
      } catch {}
    }

    try {
      JSON.parse(localStorage.getItem('nook_links') || '[]').forEach(l => {
        if (l.title?.toLowerCase().includes(q) || l.url?.toLowerCase().includes(q) || l.category?.toLowerCase().includes(q)) {
          results.push({ type: 'link', id: l.id, title: l.title, sub: l.url, tab: 'links' });
        }
      });
    } catch {}

    const allTabs = [
      { id: 'daily', label: 'Today' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'notes', label: 'Notes' },
      { id: 'calendar', label: 'Calendar' },
      { id: 'reminders', label: 'Reminders' },
      { id: 'links', label: 'Links' },
      { id: 'countdowns', label: 'Countdowns' },
      { id: 'habits', label: 'Habits' },
      { id: 'timer', label: 'Focus Timer' },
      { id: 'journal', label: 'Journal' },
      { id: 'reports', label: 'Reports' },
      { id: 'activity', label: 'Activity Log' },
      { id: 'settings', label: 'Settings' },
    ];
    allTabs.forEach(t => {
      if (t.label.toLowerCase().includes(q) || t.id.toLowerCase().includes(q)) {
        results.push({ type: 'tab', id: 'nav-' + t.id, title: `Go to ${t.label}`, sub: 'Navigation', tab: t.id });
      }
    });

    return results.slice(0, 8);
  }, [debouncedQuery, tasks, habits]);

  return { searchQuery, setSearchQuery, searchResults, searchInputRef };
}

function ResultIcon({ type }) {
  switch (type) {
    case 'task':      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
    case 'note':       return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>;
    case 'goal':       return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>;
    case 'habit':      return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>;
    case 'journal':    return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>;
    case 'countdown':  return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/></svg>;
    case 'link':       return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
    case 'tab':        return <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>;
    default: return null;
  }
}

// Unpositioned — the caller decides how to place it (inside SearchOverlay's
// already-positioned .sbsrch-panel here, or nothing when it's already sitting
// inside the mobile More sheet).
export function ResultsList({ searchQuery, searchResults, onSelect }) {
  return (
    <div className="search-results-list" onMouseDown={e => e.stopPropagation()}>
      {searchResults.length === 0 ? (
        <div className="search-empty">No results for "{searchQuery}"</div>
      ) : (
        searchResults.map(r => (
          <button key={r.type + r.id} className="search-result-item" onMouseDown={e => e.preventDefault()} onClick={() => onSelect(r.tab)}>
            <span className="search-result-icon" data-type={r.type}><ResultIcon type={r.type} /></span>
            <div className="search-result-text">
              <span className="search-result-title">{r.title}</span>
              {r.sub && <span className="search-result-sub">{r.sub}</span>}
            </div>
            <span className="search-result-badge">{r.type}</span>
          </button>
        ))
      )}
    </div>
  );
}

// Renders inline (full 240px sidebar) or as a 40px icon on the 64px rail —
// both are just triggers now. Typing/results live in a single portaled
// overlay (SearchOverlay) shared by both, closing on Escape/backdrop/✕.
export default function SidebarSearch({ tasks, habits, setActiveTab, onQueryChange }) {
  const isRail = useIsRail();
  const { searchQuery, setSearchQuery, searchResults, searchInputRef } = useNookSearch(tasks, habits);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef(null);

  // Notes' own list view falls back to this as `globalSearchQuery` — see App.jsx.
  useEffect(() => { onQueryChange?.(searchQuery); }, [searchQuery, onQueryChange]);

  // Global Ctrl/Cmd+K opens the overlay outright (previously it only focused
  // an input that, on the rail, wasn't even mounted unless already open).
  // Guarded by offsetParent so it's a no-op while this trigger sits under the
  // <768px `.desktop-only` rule — MobileMoreModal owns search on mobile, and
  // this component stays mounted-but-hidden there (CSS display:none, not
  // unmounted), so an unguarded listener would pop this overlay over it.
  useEffect(() => {
    const handler = e => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return;
      if (!triggerRef.current || triggerRef.current.offsetParent === null) return;
      e.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const close = () => setOpen(false);
  const select = (tab) => { setActiveTab(tab); setOpen(false); setSearchQuery(''); };

  const trigger = isRail ? (
    <button ref={triggerRef} type="button" className="hdr-btn sb-rail-trigger" title="Search (Ctrl K)" onClick={() => setOpen(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </button>
  ) : (
    <button ref={triggerRef} type="button" className="sb-search-full" aria-label="Search Nook" onClick={() => setOpen(true)}>
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
      <span className="sb-search-full-placeholder">Search for anything...</span>
      <span className="search-shortcut-badge">{isMac ? '⌘K' : 'Ctrl K'}</span>
    </button>
  );

  return (
    <div className={isRail ? 'sb-search-rail' : 'sb-search-full-wrap'}>
      {trigger}
      {open && (
        <SearchOverlay
          searchQuery={searchQuery}
          setSearchQuery={setSearchQuery}
          searchResults={searchResults}
          searchInputRef={searchInputRef}
          onClose={close}
          onSelect={select}
        />
      )}
    </div>
  );
}

// Fixed, centered, backdropped overlay — portaled to <body> so it escapes
// .main-nav's overflow clipping (same reason SidebarFlyout portals) and sits
// above all app content. Mirrors the app's existing command-palette pattern
// (JournalView's jnx-palette-overlay) rather than inventing a new one.
function SearchOverlay({ searchQuery, setSearchQuery, searchResults, searchInputRef, onClose, onSelect }) {
  // Focus the input once the overlay (and portal) has actually mounted.
  // Timeout is cleared on close/unmount so a stray focus() can never fire
  // after the panel is gone (no setState involved here — nothing async to
  // race — but the ref access itself is guarded the same way).
  useEffect(() => {
    const id = setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => clearTimeout(id);
  }, [searchInputRef]);

  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <div className="sbsrch-overlay" onMouseDown={onClose}>
      <div className="sbsrch-panel" role="dialog" aria-modal="true" aria-label="Search Nook" onMouseDown={e => e.stopPropagation()}>
        <div className="sbsrch-input-row">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          {/* Clear (×) lives INSIDE the field so it reads as "clear this input",
              distinct from the panel-close (✕) at the row's edge — otherwise the
              two adjacent X glyphs looked like two close buttons. */}
          <div className="sbsrch-field">
            <input
              ref={searchInputRef}
              type="text"
              role="searchbox"
              aria-label="Search Nook"
              placeholder="Search for anything..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button type="button" className="search-clear-btn" onClick={() => { setSearchQuery(''); searchInputRef.current?.focus(); }} title="Clear search" aria-label="Clear search">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            )}
          </div>

        </div>
        {searchQuery.length >= 2 && <ResultsList searchQuery={searchQuery} searchResults={searchResults} onSelect={onSelect} />}
      </div>
    </div>,
    document.body
  );
}
