// ─── Intentions data layer (Neon + localStorage fallback) ─────────
import { cloudGet, cloudSet, lsGet, lsSet } from './api';
import { todayStr } from './date';

const LS_KEY    = 'nook-intentions';
const CLOUD_KEY = 'intentions';

function makeItems() {
  return ['1', '2', '3'].map(id => ({ id, text: '', done: false }));
}

function freshIntentions() {
  return { date: todayStr(), items: makeItems(), history: {} };
}

function migrateIfNeeded(data) {
  const today = todayStr();
  if (!data) return freshIntentions();
  if (data.date !== today) {
    const history = { ...(data.history || {}), [data.date]: (data.items || []).some(i => i.done) };
    return { date: today, items: makeItems(), history };
  }
  return data;
}

export async function loadIntentions() {
  const cloud = await cloudGet(CLOUD_KEY);
  return migrateIfNeeded(cloud ?? lsGet(LS_KEY, null));
}

export async function saveIntentions(data) {
  await cloudSet(CLOUD_KEY, data);
  lsSet(LS_KEY, data);
}
