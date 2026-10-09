// ─── Pomodoro log data layer (Neon + localStorage fallback) ───────
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

const LS_KEY         = 'nook-pomo-log';
const LS_LEGACY_KEY  = 'nook-analytics';
const CLOUD_KEY      = 'pomo_log';
const MAX_POMO_LOG   = 2000;

function loadFromLocalStorage() {
  try {
    const r = localStorage.getItem(LS_KEY);
    if (r) return JSON.parse(r);
    // Legacy fallback
    const ar = localStorage.getItem(LS_LEGACY_KEY);
    if (!ar) return [];
    const analytics = JSON.parse(ar);
    const log = [];
    for (const [ds, data] of Object.entries(analytics)) {
      const c = data.pomodoros || 0;
      for (let i = 0; i < c; i++)
        log.push(`${ds}T${String(12 + Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00.000Z`);
    }
    if (log.length) lsSet(LS_KEY, log);
    return log;
  } catch { return []; }
}

export async function loadPomoLog() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  return loadFromLocalStorage();
}

export async function savePomoLog(log) {
  const capped = log.length > MAX_POMO_LOG ? log.slice(-MAX_POMO_LOG) : log;
  await cloudSet(CLOUD_KEY, capped);
  lsSet(LS_KEY, capped);
  return capped;
}
