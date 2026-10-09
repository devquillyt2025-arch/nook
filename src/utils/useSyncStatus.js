import { useState, useEffect } from 'react';
import { getSyncStatus, onSyncStatus, isSyncActive } from './sync';

// Live view of the sync engine's state for UI (Settings → Connections).
// { active, state: 'idle'|'syncing'|'error'|'off', pending, lastSyncAt, error }
export function useSyncStatus() {
  const read = () => ({ ...getSyncStatus(), active: isSyncActive() });
  const [status, setStatus] = useState(read);
  useEffect(() => {
    setStatus(read());
    const off = onSyncStatus(() => setStatus(read()));
    // `active` flips when the session is established, which is not a status event.
    const t = setInterval(() => setStatus(prev => {
      const next = read();
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    }), 3000);
    return () => { off(); clearInterval(t); };
  }, []);
  return status;
}
