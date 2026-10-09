const STORAGE_KEY = 'nook-activity-log';
const MAX_ENTRIES = 2000;

function genId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function logActivity({
  module,
  entity_type,
  entity_id,
  action,
  title,
  field_changes = null,
  status = 'success',
}) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const log = raw ? JSON.parse(raw) : [];
    const entry = {
      id: genId(),
      module,
      entity_type,
      entity_id: String(entity_id || ''),
      action,
      title: title || '',
      field_changes,
      status,
      created_at: new Date().toISOString(),
    };
    log.unshift(entry);
    if (log.length > MAX_ENTRIES) log.length = MAX_ENTRIES;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(log));
    // Notify ActivityLogView (if mounted) so it can refresh without polling.
    // Fire-and-forget; never throws.
    try { window.dispatchEvent(new Event('nook-activity-updated')); } catch {}
    return entry;
  } catch (err) {
    console.warn('[ActivityLog] write failed:', err);
  }
}

export function loadActivityLog() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function clearActivityLog() {
  localStorage.removeItem(STORAGE_KEY);
}

// Returns [{field, from, to}] for changed fields, or null if nothing changed.
export function diffObjects(oldObj, newObj, fields) {
  const changes = [];
  for (const field of fields) {
    const from = oldObj?.[field] ?? null;
    const to   = newObj?.[field] ?? null;
    const fromStr = typeof from === 'object' ? JSON.stringify(from) : String(from ?? '');
    const toStr   = typeof to   === 'object' ? JSON.stringify(to)   : String(to   ?? '');
    if (fromStr !== toStr) changes.push({ field, from: fromStr, to: toStr });
  }
  return changes.length > 0 ? changes : null;
}
