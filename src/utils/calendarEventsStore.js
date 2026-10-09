// ─── Calendar custom events data layer (Neon + localStorage fallback)
import { cloudGet, cloudSet, lsGet, lsSet } from './api';

const LS_KEY    = 'nook-calendar-events';
const CLOUD_KEY = 'calendar_events';

export async function loadCalendarEvents() {
  const cloud = await cloudGet(CLOUD_KEY);
  if (cloud != null) return cloud;
  return lsGet(LS_KEY, []);
}

export async function saveCalendarEvents(list) {
  await cloudSet(CLOUD_KEY, list);
  lsSet(LS_KEY, list);
}
