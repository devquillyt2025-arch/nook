// ─── Settings / preferences data layer (Neon + localStorage fallback)
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

// Cloud stores all settings-related keys under a single object.
const CLOUD_KEY = 'settings';

const LS_KEYS = {
  settings:    'nook-settings',
  theme:       'nook-theme',
  weekStart:   'nook-week-start',
  profileName:  'nook-profile-name',
  profileEmail: 'nook-profile-email',
  profileAvatar:'nook-profile-avatar',
  notifMaster:  'nook-notif-master',
  notifMorning: 'nook-notif-morning',
  notifMorningTime: 'nook-notif-morning-time',
  notifStreak:  'nook-notif-streak',
  notifPomo:    'nook-notif-pomo',
  weeklyReviews:'nook-weekly-reviews',
  customCats:   'nook_custom_categories',
  taskSort:     'nook_task_sort',
};

export async function loadSettingsBundle() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  // Assemble from localStorage keys
  const bundle = {};
  for (const [k, lsKey] of Object.entries(LS_KEYS)) {
    const raw = localStorage.getItem(lsKey);
    if (raw != null) {
      try { bundle[k] = JSON.parse(raw); } catch { bundle[k] = raw; }
    }
  }
  return bundle;
}

export async function saveSettingsBundle(bundle) {
  await cloudSet(CLOUD_KEY, bundle);
  // Mirror each key to localStorage
  for (const [k, lsKey] of Object.entries(LS_KEYS)) {
    if (bundle[k] !== undefined) {
      try { localStorage.setItem(lsKey, JSON.stringify(bundle[k])); } catch {}
    }
  }
}

export async function saveSetting(key, value) {
  const bundle = (await cloudGet(CLOUD_KEY)) || {};
  bundle[key] = value;
  await cloudSet(CLOUD_KEY, bundle);
  const lsKey = LS_KEYS[key];
  if (lsKey) { try { localStorage.setItem(lsKey, JSON.stringify(value)); } catch {} }
}
