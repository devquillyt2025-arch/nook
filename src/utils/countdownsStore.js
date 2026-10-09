// ─── Countdowns data layer (Neon + localStorage fallback) ─────────
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

const LS_KEY         = 'nook_countdowns';
const LS_PINNED_KEY  = 'nook_countdown_pinned';
const CLOUD_KEY      = 'countdowns';
const CLOUD_PIN_KEY  = 'countdown_pinned';

export async function loadCountdowns() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_KEY, []);
}

export async function saveCountdowns(list) {
  await cloudSet(CLOUD_KEY, list);
  lsSet(LS_KEY, list);
}

export async function loadCountdownPinned() {
  const cloud = await cloudGet(CLOUD_PIN_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_PINNED_KEY, []);
}

export async function saveCountdownPinned(ids) {
  await cloudSet(CLOUD_PIN_KEY, ids);
  lsSet(LS_PINNED_KEY, ids);
}
