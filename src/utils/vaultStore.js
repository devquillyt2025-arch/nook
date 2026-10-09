// ─── Vault data layer (Neon + localStorage fallback) ──────────────
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

const LS_KEY    = 'nook_vault';
const CLOUD_KEY = 'vault';

export async function loadVault() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_KEY, []);
}

export async function saveVault(list) {
  await cloudSet(CLOUD_KEY, list);
  lsSet(LS_KEY, list);
}
