// ─── Links data layer (Neon + localStorage fallback) ──────────────
import { cloudGet, cloudSet, lsGet, lsSet } from './api';
import { logActivity } from './activityLog';

const LS_KEY    = 'nook_links';
const CLOUD_KEY = 'links';

export async function loadLinks() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_KEY, []);
}

export async function saveLinks(list) {
  await cloudSet(CLOUD_KEY, list);
  lsSet(LS_KEY, list);
}
