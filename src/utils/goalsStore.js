// ─── Goals data layer (Neon + localStorage fallback) ──────────────
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

const LS_KEY    = 'nook_goals';
const CLOUD_KEY = 'goals';

export async function loadGoals() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_KEY, []);
}

export async function saveGoals(list) {
  await cloudSet(CLOUD_KEY, list);
  lsSet(LS_KEY, list);
}
