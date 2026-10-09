// AUDIT LOG - 2026-06-04
// Bug 1: ReportsView — React.useRef used without React default imported → Fixed: useRef named import
// Bug 2: ReportsView — upsertLog/toggleMilestone not imported → Fixed: added to trackerUtils import block
// Bug 3: ReportsView ProjectDetail — milestones/targetDate destructured from computeProjectStats return (not returned) → Fixed: pull from tracker.config
// Bug 4: computeGlobalStats — project trackers inflated scheduledCount but isLoggedToday always false for incomplete projects → Fixed: exclude type==='project' from daily counts
// Bug 5: App midnight reset fired at local midnight but todayStr() uses UTC date → Fixed: use UTC midnight for timeout
// Bug 6: insightsEngine — explicit skips (val===false) counted as misses in "missed 3 days" insight → Fixed: only count val==null
// Bug 7: WeeklyReviewModal — backdrop click didn't close modal (no onClick handler on overlay) → Fixed: added onClick={onClose} + stopPropagation
// Bug 8: computeHabitStreaks — first loop (lines ~111-130) wrote into `current` which was immediately reset to 0, dead code → Fixed: removed dead loop
// Bug 9: Timer setInterval-only countdown drifts in throttled background tabs → Fixed: record timerEndAt on start/resume, derive remaining from Date.now() delta

import { useState, useEffect, useRef, useCallback, useMemo, lazy, Suspense } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

import { CAT_META } from './utils/categoryMeta';
import Timer from './components/Timer';
import Stats from './components/Stats';
import AddTaskModal from './components/AddTaskModal';
import ShortcutsModal from './components/ShortcutsModal';
import WeeklyReviewModal from './components/WeeklyReviewModal';
import DailyGoalsView from './components/DailyGoalsView';
import AddTrackerModal from './components/AddTrackerModal';
import {
  loadHabits, saveHabits, migrateFromTrackers, toggleCompletion,
} from './habitsStore';
import {
  loadTrackers, saveTrackers,
  isScheduledToday, isLoggedToday, computeHabitStreaks, getConfig
} from './trackers/trackerUtils';
import { handleAuthCallback, syncTasks, pushSyncQueue, directGoogleTaskUpdate, directGoogleTaskDelete } from './utils/googleTasksSync';
import { pushTask, pushTasks, softDeleteTask, softDeleteTasks, fetchTasks, reconcileTasks, migrateLocalTasks, isTasksSyncConfigured, getUserId, subscribeToTasks, reconcileRemoteChange, restoreTasks } from './utils/tasksService';
import { pushHabit, softDeleteHabit, fetchHabits, reconcileHabits, migrateLocalHabits, isHabitsSyncConfigured, subscribeToHabits, reconcileRemoteHabitChange, pushHabits, restoreHabits } from './utils/habitsService';
import { handleCalendarAuthCallback, isGCalConnected, connectGoogleCalendar, disconnectGoogleCalendar } from './utils/googleCalendarSync';
import { handleDriveBackupCallback } from './utils/driveBackup';
import { maybeRunAutoBackup } from './utils/autoBackup';
import { sendNotification } from './utils/notificationUtils';
import { getSecsForMode } from './utils/timerUtils';
import { setTickSeconds, getTickSeconds } from './utils/timerTickStore';
import { logActivity, diffObjects } from './utils/activityLog';
import { startSync, isForeignSyncApply, runAdditiveSync, runUntrackedSync, clearLocalSyncState, settleSync } from './utils/sync';
import { useSyncApplied } from './utils/useSyncApplied';
import { clearReminder, renameReminder, restoreReminders } from './utils/reminders';
import { localDateStr, todayStr } from './utils/date';
import { genId } from './utils/id';
import FocusCompanion from './components/FocusCompanion';
import SidebarSearch, { useNookSearch, ResultsList } from './components/SidebarSearch';
import VoiceCommandButton from './components/VoiceCommandButton';
import nookLogo from './nook-favicon.png';
import AssistantChat from './components/AssistantChat';

// ── Code-split route-level views (each tab's chunk loads only when that tab is opened) ──
const ReportsView     = lazy(() => import('./components/ReportsView'));
const CalendarView    = lazy(() => import('./components/CalendarView'));
const TaskList        = lazy(() => import('./components/TaskList'));
const SettingsView    = lazy(() => import('./components/SettingsView'));
const JournalView     = lazy(() => import('./components/JournalView'));
const CountdownsView  = lazy(() => import('./components/CountdownsView'));
const HabitsView      = lazy(() => import('./components/HabitsView'));
const NotesView       = lazy(() => import('./components/NotesView'));
const NoteModal       = lazy(() => import('./components/NotesView').then(m => ({ default: m.NoteModal })));
const ActivityLogView = lazy(() => import('./components/ActivityLogView'));
const VaultView       = lazy(() => import('./components/VaultView'));
const LinksView       = lazy(() => import('./components/LinksView'));
const RemindersView   = lazy(() => import('./components/RemindersView'));
const ChatView        = lazy(() => import('./components/ChatView'));

// ─── Constants ───────────────────────────────────────────────────
const LONG_BREAK_AFTER = 4;
// Same retention pattern as utils/activityLog.js's MAX_ENTRIES — pomodoroLog
// grows one entry per completed focus session forever with no cap otherwise.
// Every consumer (Stats, DailyGoalsView, AnalyticsDashboard) only ever looks
// at the last 7/30 days, so 2000 entries is a large multiple of what's ever
// actually read, not a lookback window being narrowed.
const MAX_POMO_LOG = 2000;
const DEFAULT_SETTINGS = {
  focusDuration: 25, shortDuration: 5, longDuration: 15, customDuration: 25,
  autoSwitch: false, sound: true,
};

// ─── Audio ───────────────────────────────────────────────────────
let _audioCtx = null;
function initAudio() {
  if (!_audioCtx) { const C = window.AudioContext || window.webkitAudioContext; if (C) _audioCtx = new C(); }
  if (_audioCtx?.state === 'suspended') _audioCtx.resume().catch(() => {});
}
function playAlarm() {
  const ctx = _audioCtx; if (!ctx) return;
  try {
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, ctx.currentTime + 0.4);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.6);
    osc.connect(gain); gain.connect(ctx.destination);
    osc.start(); osc.stop(ctx.currentTime + 0.6);
  } catch {}
}

// ─── Storage keys ────────────────────────────────────────────────
const SK = {
  tasks: 'nook-tasks', settings: 'nook-settings',
  theme: 'nook-theme', pomoLog: 'nook-pomo-log',
  intentions: 'nook-intentions',
};

function persist(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} }

// ─── Active tab persistence ──────────────────────────────────────
// Nav state only — which view is showing, nothing about its contents. Kept in
// its own key so it never rides along with a content slice.
//
// Hyphen prefix (not `nook:active-tab`) on purpose: every path that sweeps
// Nook's storage — import's ALLOWED_PREFIX, "Clear all data", the cross-tab
// filter — matches /^nook[-_]/. A `nook:` key would be invisible to all three
// and survive a "clear everything". Matches the `nook-sidebar-open` precedent.
const ACTIVE_TAB_KEY = 'nook-active-tab';

// The 14 real tab ids. Anything else — a renamed/removed tab, a hand-edited
// value, the dead 'goals' id DailyGoalsView still links to — falls back to
// 'daily' rather than rendering a blank content area.
const TAB_IDS = new Set([
  'daily', 'tasks', 'calendar', 'habits', 'journal', 'reminders', 'notes',
  'timer', 'links', 'countdowns', 'reports', 'activity', 'vault', 'settings',
]);

// Read synchronously as a useState initializer — NOT in a mount effect, which
// would paint Today first and then visibly swap to the real tab.
function loadActiveTab() {
  try {
    const saved = localStorage.getItem(ACTIVE_TAB_KEY);
    return TAB_IDS.has(saved) ? saved : 'daily';
  } catch { return 'daily'; }
}

// Sync-engine-internal keys that shouldn't trigger the cross-tab reload banner —
// these are plumbing (tokens, queue, tombstones, one-time migration flags), not
// content the user actually authored, so a change here isn't "your data changed
// in another tab" in any way a reload would help with.
const CROSS_TAB_IGNORE_KEYS = new Set([
  'nook_google_tokens', 'nook_pkce_verifier', 'nook_sync_queue', 'nook_deleted_tasks',
  'nook_last_pull_sync', 'nook_sync_enabled',
  'nook-notif-state', 'nook-visits', 'nook-install-dismissed', 'nook-analytics',
  'nook_cleaned_w_duplicates', 'nook_habits_migrated', 'nook_tasks_migrated', 'nook_habits_sync_migrated',
  // UI-only preferences — not user content, so changing these in another tab
  // should not trigger the "data changed" reload banner:
  'nook-sidebar-open',
  // Bookkeeping for "Last exported" in Settings — running an export in another
  // tab is not a content change and must not raise the reload banner.
  'nook-last-export',
  // Each window keeps its own in-memory activeTab; this key is only the seed
  // for the NEXT cold load (last switch wins). Ignoring it here is what stops
  // two open windows from fighting: switching tabs in one must not raise the
  // "data changed elsewhere" reload banner in the other, and must not yank the
  // other window's view out from under whatever it's showing.
  ACTIVE_TAB_KEY,
]);

// ─── Helpers ─────────────────────────────────────────────────────
function makeItems() { return ['1','2','3'].map(id => ({ id, text: '', done: false })); }

// ─── Loaders ─────────────────────────────────────────────────────
const VALID_CATS = new Set(['learning','fitness','mental','work','growth']);
const CAT_KW = [
  ['learning',['learn','study','read','course','book','educat']],
  ['fitness', ['fit','gym','exercise','workout','run','sport','health']],
  ['mental',  ['mental','meditat','mind','journal','stress','relax']],
  ['growth',  ['grow','personal','habit','skill','creat','hobby']],
];
function toCategory(raw) {
  if (!raw) return 'work';
  const lo = raw.toLowerCase().trim();
  if (VALID_CATS.has(lo)) return lo;
  for (const [cat,kws] of CAT_KW) if (kws.some(kw => lo.includes(kw))) return cat;
  return 'work';
}
function migrateTask(t) {
  if (t.name !== undefined) return t;
  return {
    id: t.id || String(Date.now()+Math.random()), name: t.text||'Untitled',
    category: toCategory(t.category),
    priority: ['none','low','medium','high'].includes(t.priority)?t.priority:'none',
    timeEstimate:(t.estPomodoros||1)*25, notes:t.notes||'', dueDate:'',
    completed:Boolean(t.completed), timeLogged:(t.actPomodoros||0)*25*60,
    pomodorosCompleted:t.actPomodoros||0,
    createdAt:t.createdAt?new Date(t.createdAt).toISOString():new Date().toISOString(),
    completedAt:t.completed?new Date().toISOString():null,
  };
}
function loadTasks() {
  try { const r=localStorage.getItem(SK.tasks); return r?JSON.parse(r).map(migrateTask):[]; } catch { return []; }
}
function loadSettings() {
  try {
    const r=localStorage.getItem(SK.settings); if(!r) return {...DEFAULT_SETTINGS};
    const p=JSON.parse(r);
    return {
      focusDuration: p.focusDuration||p.pomodoroDuration||DEFAULT_SETTINGS.focusDuration,
      shortDuration: p.shortDuration||p.shortBreakDuration||DEFAULT_SETTINGS.shortDuration,
      longDuration:  p.longDuration||p.longBreakDuration||DEFAULT_SETTINGS.longDuration,
      customDuration:p.customDuration||DEFAULT_SETTINGS.customDuration,
      autoSwitch:    p.autoSwitch??DEFAULT_SETTINGS.autoSwitch,
      sound:         p.sound??p.soundEnabled??DEFAULT_SETTINGS.sound,
    };
  } catch { return {...DEFAULT_SETTINGS}; }
}
function loadPomoLog() {
  try {
    const r=localStorage.getItem(SK.pomoLog); if(r) return JSON.parse(r);
    const ar=localStorage.getItem('nook-analytics'); if(!ar) return [];
    const analytics=JSON.parse(ar); const log=[];
    for(const [ds,data] of Object.entries(analytics)) {
      const c=data.pomodoros||0;
      for(let i=0;i<c;i++) log.push(`${ds}T${String(12+Math.floor(i/60)).padStart(2,'0')}:${String(i%60).padStart(2,'0')}:00.000Z`);
    }
    if(log.length) persist(SK.pomoLog,log); return log;
  } catch { return []; }
}
function loadIntentions() {
  try {
    const r=localStorage.getItem(SK.intentions); const today=todayStr();
    if(!r) return {date:today,items:makeItems(),history:{}};
    const d=JSON.parse(r);
    if(d.date!==today) {
      const history={...(d.history||{}),[d.date]:(d.items||[]).some(i=>i.done)};
      return {date:today,items:makeItems(),history};
    }
    return d;
  } catch { return {date:todayStr(),items:makeItems(),history:{}}; }
}



// Compute next due date string (YYYY-MM-DD) for a recurring task
function nextDueDate(dueDateStr, recurrence, recurrenceDays) {
  const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
  const toISO   = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  const base    = dueDateStr ? new Date(dueDateStr + 'T00:00:00') : new Date();
  if (recurrence === 'daily')    return toISO(addDays(base, 1));
  if (recurrence === 'weekly')   return toISO(addDays(base, 7));
  if (recurrence === 'monthly')  { const r = new Date(base); r.setMonth(r.getMonth() + 1); return toISO(r); }
  if (recurrence === 'weekdays') {
    let next = addDays(base, 1);
    while (next.getDay() === 0 || next.getDay() === 6) next = addDays(next, 1);
    return toISO(next);
  }
  if (recurrence === 'custom' && recurrenceDays?.length) {
    let next = addDays(base, 1);
    for (let i = 0; i < 7; i++, next = addDays(next, 1))
      if (recurrenceDays.includes(next.getDay())) return toISO(next);
  }
  return '';
}

// ─── App ─────────────────────────────────────────────────────────
export default function App() {
  const initSettings = useMemo(loadSettings, []); // eslint-disable-line

  // ── Existing state ──
  const [tasks,       setTasks]       = useState(loadTasks);
  const [syncStatus,  setSyncStatus]  = useState(() => localStorage.getItem('nook_sync_enabled') === 'true' ? 'Synced' : 'Not connected');

  const [theme,       setTheme]       = useState(() => { try { const t = localStorage.getItem(SK.theme); return t ? JSON.parse(t) : 'dark'; } catch { return 'dark'; } });
  const [settings,    setSettings]    = useState(initSettings);
  const [pomodoroLog, setPomodoroLog] = useState(loadPomoLog);

  // ── OAuth Callback & Initial Sync ──
  useEffect(() => {
    // Callbacks are distinguished by OAuth `state`: Drive backup (state=
    // drivebackup) and Calendar (state=gcal) each no-op unless their state
    // matches, so order is safe; Tasks matches a bare `code` and runs last.
    handleDriveBackupCallback().then(driveSuccess => {
      if (driveSuccess) {
        showToast('Google Drive connected for backups!', 'success');
        return;
      }
      handleCalendarAuthCallback().then(calSuccess => {
        if (calSuccess) {
          showToast('Connected to Google Calendar!', 'success');
          return;
        }
        handleAuthCallback().then(success => {
          if (success) {
            showToast('Connected to Google Tasks!', 'success');
            setSyncStatus('Syncing...');
            syncTasks(tasks, setTasks, setSyncStatus);
          } else if (localStorage.getItem('nook_sync_enabled') === 'true') {
            syncTasks(tasks, setTasks, setSyncStatus);
          }
        });
      });
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Automated Drive backup: check on load (and window focus) whether a
  // backup is due for the user's chosen frequency. No-op unless opted in and
  // Drive is connected; failures are logged to backup_runs, not thrown here.
  useEffect(() => {
    maybeRunAutoBackup();
    const onFocus = () => maybeRunAutoBackup();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);

  // ── One-Time Cleanup for Keystroke Bug Duplicates ──
  useEffect(() => {
    if (localStorage.getItem('nook_cleaned_w_duplicates') !== 'true') {
      const badNames = ["W", "Wo", "Wor", "Work", "Work ", "Work O", "Work On", "Work On.", "Work On..", "Work On..."];
      setTasks(prev => {
        const toDelete = prev.filter(t => badNames.includes(t.name) && t.completed === false);
        if (toDelete.length === 0) return prev;
        
        let next = [...prev];
        toDelete.forEach(dup => {
          next = next.filter(t => t.id !== dup.id);
          pushSyncQueue({ type: 'DELETE', taskId: dup.id, googleTaskId: dup.googleTaskId });
        });
        setTimeout(() => syncTasks(next, setTasks, setSyncStatus), 1000);
        return next;
      });
      localStorage.setItem('nook_cleaned_w_duplicates', 'true');
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Window Focus Sync Trigger ──
  // Uses tasksRef (not tasks) so the listener is never re-registered on each
  // task mutation, and always reads the live list — not a stale closure snapshot
  // that would let pullTasksFromGoogle clobber concurrent local edits.
  useEffect(() => {
    const handleFocus = () => {
      if (localStorage.getItem('nook_sync_enabled') === 'true') {
        syncTasks(tasksRef.current, setTasks, setSyncStatus, true);
      }
    };
    window.addEventListener('focus', handleFocus);
    return () => window.removeEventListener('focus', handleFocus);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [timerMode,       setTimerMode]       = useState('focus');
  const [activeTimerMode, setActiveTimerMode] = useState('focus'); // mode actually running
  const [timerState,   setTimerState]   = useState('idle');
  const [timerSeconds, setTimerSeconds] = useState(() => getSecsForMode('focus',initSettings));
  const [totalSeconds, setTotalSeconds] = useState(() => getSecsForMode('focus',initSettings));
  // Seed the external tick store so Timer/FocusCompanion/DailyGoalsView show the
  // right value on first render, before any tick/start/switch has run.
  useEffect(() => { setTickSeconds(timerSeconds); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const [activeTaskId, setActiveTaskId] = useState(null);
  const [openModal,    setOpenModal]    = useState(null);
  const [toast,        setToast]        = useState(null);
  const [crossTabChanged, setCrossTabChanged] = useState(false);

  // ── New state ──
  const [activeTab,      setActiveTab]      = useState(loadActiveTab);
  const [isAssistantOpen, setIsAssistantOpen] = useState(false);
  // Persist nav state so a reload lands where you left off. Write-through on
  // every switch, same shape as the sidebar-collapse pref below.
  useEffect(() => {
    try { localStorage.setItem(ACTIVE_TAB_KEY, activeTab); } catch {}
  }, [activeTab]);
  const [pendingOpenTaskId, setPendingOpenTaskId] = useState(null); // deep-link from Reminders tab
  const [trackers,       setTrackers]       = useState(loadTrackers);
  const [intentions,     setIntentions]     = useState(loadIntentions);
  const [editingTracker, setEditingTracker] = useState(null);
  const [showAddTracker, setShowAddTracker] = useState(false);
  const [editingTask,    setEditingTask]    = useState(null);
  const [noteEditorCtx,  setNoteEditorCtx]  = useState(null); // { note, onSave, onDelete }
  const [habits,         setHabits]         = useState(() => loadHabits() ?? []);

  // ── PWA Install State ──
  const [deferredPrompt, setDeferredPrompt] = useState(null);
  const [showInstallBanner, setShowInstallBanner] = useState(false);


  const handleImportData = useCallback(async (data) => {
    // Support schema-v1 ZIP exports (the current exportBackup format)
    // as well as legacy flat {key: string} imports.
    const isSchemaV1 = data?.schemaVersion === 1 && data?.data?.local;
    const localMap = isSchemaV1 ? data.data.local : data;

    const ALLOWED_PREFIX = /^nook[-_]/;
    const BLOCKED_KEYS = new Set(['nook_google_tokens','nook_pkce_verifier','nook_sync_queue','nook_deleted_tasks']);

    const keyCount = Object.keys(localMap).filter(k => ALLOWED_PREFIX.test(k) && !BLOCKED_KEYS.has(k)).length;
    if (!confirm(`This will replace ${keyCount} data set(s) with the backup. Continue?`)) return;

    // Cross-device sync is merged, never destructive: while the backup is being
    // written, nothing it removes counts as a deletion (see runAdditive). Without
    // this, importing an older backup would delete everything newer from every
    // signed-in device.
    await runAdditiveSync(async () => {
      for (const [key, value] of Object.entries(localMap)) {
        if (!ALLOWED_PREFIX.test(key)) continue;      // reject non-nook keys
        if (BLOCKED_KEYS.has(key)) continue;           // never restore tokens/queues
        try {
          // value is already parsed; re-stringify for localStorage
          localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value));
        } catch (err) {
          console.error(`[Import] failed to write ${key}:`, err);
        }
      }
    });
    
    // ── Cloud-backed slices ────────────────────────────────────────────
    // Reminders, tasks and habits do NOT live in localStorage alone, so the
    // writes above don't restore them. Each needs its own Supabase write, and
    // all of them have to finish BEFORE the reload below — a reload mid-request
    // abandons it silently.
    //
    // Tasks and habits additionally need the *tombstone* cleared, not just the
    // row rewritten: Supabase is the cross-device source of truth, so anything
    // deleted after the backup was taken still had a soft-delete whose
    // updatedAt was newer than the restored copy's. Without restore_tasks /
    // restore_habits (migration 0011, backup-wins + deleted_at cleared), the
    // very next hydrate re-applied that tombstone and the task disappeared
    // again seconds after the import claimed success.
    const notes = [];

    // Whether tasks/habits have a cloud copy at all. When they don't, the
    // localStorage writes above ARE the whole restore and there is nothing
    // further to do — reporting "could not be restored to your account" to a
    // local-only user would be alarming and false.
    const cloudSync = isTasksSyncConfigured();

    // Each restore is independent: one failing must not stop the others, and
    // the local data is already written either way, so a failure here is
    // partial, never total. Say which part failed rather than implying the
    // whole import did.
    const runRestore = async (label, rows, fn) => {
      if (!rows.length) return;
      const plural = rows.length === 1 ? '' : 's';
      try {
        const { restored, skipped } = await fn(rows);
        if (skipped) {
          notes.push(
            `• ${rows.length} ${label}${plural} could NOT be restored to your account — ` +
            (skipped === 'signed_out'
              ? 'you are not signed in. Sign in and import again.'
              : 'this Nook has no account sync configured.')
          );
        } else {
          notes.push(`• ${restored} ${label}${plural} restored`);
        }
      } catch (err) {
        console.error(`[Import] ${label} restore failed:`, err);
        notes.push(`• ${label}s could NOT be restored: ${err?.message || 'unknown error'}`);
      }
    };

    // Reminders are Supabase-only with no local mirror, so this runs (and
    // reports) regardless of whether task sync is on.
    await runRestore('reminder', data?.data?.remote?.reminders || [], restoreReminders);

    if (cloudSync) {
      // Read back from localMap, not from state — these are the arrays just
      // written above, in the backup's own shape.
      await runRestore('task',  Array.isArray(localMap['nook-tasks'])  ? localMap['nook-tasks']  : [], restoreTasks);
      await runRestore('habit', Array.isArray(localMap['nook_habits']) ? localMap['nook_habits'] : [], restoreHabits);
    }
    // Everything the import wrote must be diffed and pushed BEFORE the reload
    // below — a reload abandons in-flight requests (same reason as the restores).
    await settleSync();


    // Copy is deliberately specific, because the two behaviours genuinely
    // differ and the previous single sentence ("a restore brings back
    // everything in the file") was false for tasks and habits — the exact
    // thing people run a restore for.
    alert(
      `Backup imported.\n\n` +
      (notes.length ? `${notes.join('\n')}\n\n` : '') +
      (cloudSync
        ? `Everything in the backup is back, including items you deleted since, and items created since were kept.\n\n` +
          `Tasks, habits, reminders, notes, journal, links and your other synced data were MERGED with your account, so this applies on your other devices too.`
        : `Your data was REPLACED with the backup's copy — anything created since the backup was taken is gone.`)
    );

    window.location.reload();
  }, []);

  const handleClearData = useCallback(() => {
    // Copy is precise about scope on purpose: this clears localStorage only.
    // Tasks and habits also live in Supabase and are NOT deleted here — they
    // sync back down on the next load. Promising "ALL data" was misleading.
    if (confirm(
      "Clear all data stored in this browser?\n\n" +
      "This deletes everything Nook keeps on this device — tasks, habits, journal, notes, links and countdowns — and cannot be undone.\n\n" +
      "It does NOT delete your synced copies in the cloud: if you are signed in, your tasks, habits, notes, journal and other synced data will sync back down on the next load. Reminders are also kept."
    )) {
      // Nook keys use BOTH prefixes: 'nook-' (tasks, settings, calendar…) and
      // 'nook_' (notes, links, countdowns, journal, goals, Google tokens/sync).
      // Match both so "Clear all data" actually clears everything — leaving the
      // underscore keys behind previously kept content and live OAuth tokens.
      const keys = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && (k.startsWith('nook-') || k.startsWith('nook_'))) keys.push(k);
      }
      // Wiping THIS device must not be read as the user deleting everything in
      // their account: the removals are not observed, and the sync bookkeeping
      // goes with them so the next load pulls the cloud copy back down.
      runUntrackedSync(() => { keys.forEach(k => localStorage.removeItem(k)); clearLocalSyncState(); })
        .finally(() => window.location.reload());
    }
  }, []);

  const handleSettingsSyncToggle = useCallback((enabled) => {
    if (enabled) {
      localStorage.setItem('nook_sync_enabled', 'true');
      setSyncStatus('Syncing...');
      syncTasks(tasks, setTasks, setSyncStatus);
    } else {
      localStorage.setItem('nook_sync_enabled', 'false');
      setSyncStatus('Not connected');
    }
  }, [tasks, setTasks, setSyncStatus]);

  const handleSettingsDisconnect = useCallback(() => {
    setSyncStatus('Not connected');
  }, [setSyncStatus]);

  const handleSettingsSyncNow = useCallback(() => {
    syncTasks(tasks, setTasks, setSyncStatus);
  }, [tasks, setTasks, setSyncStatus]);

  const handleUpdateProfile = useCallback((name, email, av) => {
    // Profile name/email/avatar are stored in localStorage by SettingsView directly.
    // Nothing to sync into App state here.
  }, []);

  const handleConnectGCal = useCallback(() => connectGoogleCalendar(), []);
  const handleDisconnectGCal = useCallback(() => disconnectGoogleCalendar(), []);

  // ── Handlers ──
  const intervalRef        = useRef(null);
  const toastTimerRef      = useRef(null);
  const activeTaskRef      = useRef(activeTaskId);
  const timerModeRef       = useRef(timerMode);
  const activeTimerModeRef = useRef('focus');
  const timerStateRef      = useRef('idle');
  const timerSecsRef       = useRef(timerSeconds);
  const timerEndAtRef      = useRef(null); // wall-clock ms when current session should complete
  const settingsRef        = useRef(settings);
  const pomoLogRef         = useRef(pomodoroLog);
  const switchModeRef      = useRef(null);
  const onCompleteRef      = useRef(null);
  // Stable ref so focus/sync callbacks always see the current tasks list without
  // closing over a stale snapshot or depending on `tasks` in their effect deps.
  const tasksRef           = useRef(tasks);
  const habitsRef          = useRef(habits);

  useEffect(() => { activeTaskRef.current      = activeTaskId;    }, [activeTaskId]);
  useEffect(() => { timerModeRef.current       = timerMode;       }, [timerMode]);
  useEffect(() => { activeTimerModeRef.current = activeTimerMode; }, [activeTimerMode]);
  useEffect(() => { timerStateRef.current      = timerState;      }, [timerState]);
  useEffect(() => { timerSecsRef.current       = timerSeconds;    }, [timerSeconds]);
  useEffect(() => { settingsRef.current        = settings;        }, [settings]);
  useEffect(() => { pomoLogRef.current         = pomodoroLog;     }, [pomodoroLog]);
  useEffect(() => { tasksRef.current           = tasks;           }, [tasks]);
  useEffect(() => { habitsRef.current          = habits;          }, [habits]);

  // Fetch the remote task snapshot and reconcile it into state (LWW on
  // updatedAt), then push anything the server is missing (local-only or
  // local-newer) back up. Shared by the mount hydrate and the focus refresh.
  // No-op when offline / signed out (fetchTasks returns null → keep cache).
  const hydrateTasksFromSupabase = useCallback(async () => {
    const snapshot = await fetchTasks();
    if (!snapshot) return;
    // Push decision is made against the pre-merge local list (what the server
    // hasn't got yet); the merge itself runs against the freshest prev.
    const { toPush } = reconcileTasks(tasksRef.current, snapshot.live, snapshot.tombstones);
    setTasks(prev => reconcileTasks(prev, snapshot.live, snapshot.tombstones).merged);
    if (toPush.length) pushTasks(toPush);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supabase tasks: one-time migration, then hydrate on mount ──
  // Supabase is the cross-device source of truth; localStorage is a write-
  // through cache. Sequenced as a single async flow so migration and hydrate
  // never race each other. No-ops cleanly when auth is unconfigured / signed
  // out / offline (each step bails and the local cache is kept untouched).
  // Runs beside googleTasksSync — both merge into the same array via setTasks.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isTasksSyncConfigured()) return;
      const uid = await getUserId();
      if (cancelled || !uid) return;

      // Phase 4 — one-time seed of localStorage tasks into Supabase.
      // SEQUENCING (timing, not guaranteed): we read the local list from
      // tasksRef.current here, after the awaits above. The one-time duplicate-
      // cleanup effect (nook_cleaned_w_duplicates) runs earlier and removes junk
      // via setTasks. The awaited getUserId()+count round-trips are almost always
      // longer than React's re-render + passive ref-sync, so we almost always
      // read the CLEANED list — but React makes no ordering promise between a
      // passive effect and an unrelated await resolving. On a very fast/cached
      // auth path there is a narrow window where a junk task cleanup would have
      // removed could still be uploaded. Accepted: the failure mode is minor
      // (an extra row, no data loss) and reconcile self-heals nothing worse.
      // If a stray post-migration duplicate ever appears, THIS is where to look.
      const result = await migrateLocalTasks(tasksRef.current);
      if (result.status === 'migrated') showToast(`Synced ${result.count} task${result.count === 1 ? '' : 's'} to your account`, 'success');
      if (cancelled) return;

      // Phase 3 — hydrate + reconcile (LWW on updatedAt).
      await hydrateTasksFromSupabase();
    })();
    return () => { cancelled = true; };
  }, [hydrateTasksFromSupabase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supabase tasks: refresh on window focus (Phase 5) ──
  // A cheaper, always-on counterpart to Realtime: when the user returns to the
  // tab, re-fetch and reconcile so changes made elsewhere land even if the
  // Realtime socket was asleep/dropped. Separate from the Google focus-sync
  // handler above (that one is gated by nook_sync_enabled).
  useEffect(() => {
    if (!isTasksSyncConfigured()) return;
    const onFocus = () => { hydrateTasksFromSupabase(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [hydrateTasksFromSupabase]);

  // ── Supabase tasks: live Realtime subscription (Phase 5) ──
  // Applies each incoming insert/update/delete to state, LWW-guarded, so a task
  // created/edited/deleted on another device appears here without a reload. The
  // reconcile no-ops on the echo of our own writes (equal updatedAt).
  useEffect(() => {
    const unsubscribe = subscribeToTasks((payload) => {
      setTasks(prev => reconcileRemoteChange(prev, payload));
    });
    return unsubscribe;
  }, []);

  // ── Supabase habits: hydrate + reconcile (shared by mount & focus) ──
  const hydrateHabitsFromSupabase = useCallback(async () => {
    const snapshot = await fetchHabits();
    if (!snapshot) return;
    const { toPush } = reconcileHabits(habitsRef.current, snapshot.live, snapshot.tombstones);
    setHabits(prev => reconcileHabits(prev, snapshot.live, snapshot.tombstones).merged);
    if (toPush.length) pushHabits(toPush);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supabase habits: one-time migration, then hydrate on mount ──
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!isHabitsSyncConfigured()) return;
      const uid = await getUserId();
      if (cancelled || !uid) return;

      // Phase 4 — one-time seed of localStorage habits into Supabase.
      // SEQUENCING vs migrateFromTrackers (timing, not guaranteed — same care as
      // the tasks cleanup effect): migrateFromTrackers runs in its own mount
      // effect and, on a first-ever run, setHabits() the trackers-derived list.
      // We read habitsRef.current only AFTER the awaits above, whose network
      // round-trips are almost always longer than React's re-render + passive
      // ref-sync, so we migrate the POST-trackers list rather than an empty one.
      // React makes no ordering promise here; worst case on a very fast/cached
      // path is that a just-migrated-from-trackers habit lands via the later
      // focus/realtime reconcile instead of this first pass. No data loss.
      const result = await migrateLocalHabits(habitsRef.current);
      if (result.status === 'migrated') showToast(`Synced ${result.count} habit${result.count === 1 ? '' : 's'} to your account`, 'success');
      if (cancelled) return;

      await hydrateHabitsFromSupabase();
    })();
    return () => { cancelled = true; };
  }, [hydrateHabitsFromSupabase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Supabase habits: refresh on window focus ──
  useEffect(() => {
    if (!isHabitsSyncConfigured()) return;
    const onFocus = () => { hydrateHabitsFromSupabase(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [hydrateHabitsFromSupabase]);

  // ── Supabase habits: live Realtime subscription ──
  useEffect(() => {
    const unsubscribe = subscribeToHabits((payload) => {
      setHabits(prev => reconcileRemoteHabitChange(prev, payload));
    });
    return unsubscribe;
  }, []);

  // ── Persistence ──
  useEffect(() => { persist(SK.tasks,      tasks);      }, [tasks]);
  useEffect(() => { persist(SK.settings,   settings);   }, [settings]);
  useEffect(() => { persist(SK.pomoLog,    pomodoroLog); }, [pomodoroLog]);
  useEffect(() => { persist(SK.intentions, intentions); }, [intentions]);
  useEffect(() => { saveTrackers(trackers);              }, [trackers]);
  useEffect(() => { saveHabits(habits);                  }, [habits]);
  useEffect(() => {
    // One-time migration: copy type='habit' trackers into the habits store
    const migrated = migrateFromTrackers(trackers);
    if (migrated !== null) setHabits(migrated);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    persist(SK.theme, theme);
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // ── Midnight reset ──
  // Rolls intentions over to the new day in place (no reload) so an open note/journal/task
  // editor isn't discarded. Re-arms itself after each fire so it keeps working across
  // multiple midnights in a long-lived tab, not just the first one after page load.
  useEffect(() => {
    let t;
    const armNext = () => {
      const now = new Date();
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      t = setTimeout(() => {
        setIntentions(prev => {
          const today = todayStr();
          if (prev.date === today) return prev;
          const history = {...(prev.history||{}), [prev.date]: prev.items.some(i=>i.done)};
          return { date: today, items: makeItems(), history };
        });
        armNext();
      }, midnight - now);
    };
    armNext();
    return () => clearTimeout(t);
  }, []);

  // ── PWA Install tracking ──
  useEffect(() => {
    let visits = parseInt(localStorage.getItem('nook-visits') || '0', 10);
    if (!sessionStorage.getItem('nook-session-visited')) {
      visits += 1;
      localStorage.setItem('nook-visits', visits.toString());
      sessionStorage.setItem('nook-session-visited', 'true');
    }
    
    const handleBeforeInstallPrompt = (e) => {
      e.preventDefault();
      setDeferredPrompt(e);
      if (visits >= 3 && localStorage.getItem('nook-install-dismissed') !== 'true') {
        setShowInstallBanner(true);
      }
    };
    
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    return () => window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
  }, []);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === 'accepted') {
      setShowInstallBanner(false);
      localStorage.setItem('nook-install-dismissed', 'true');
    }
    setDeferredPrompt(null);
  };

  const dismissInstallBanner = () => {
    setShowInstallBanner(false);
    localStorage.setItem('nook-install-dismissed', 'true');
  };

  // ── Scheduled Notifications Engine ──
  useEffect(() => {
    const checkNotifications = () => {
      const masterEnabled = localStorage.getItem('nook-notif-master') !== 'false';
      if (!masterEnabled) return;

      const now = new Date();
      const today = localDateStr(now);
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

      let notifState = { date: today, triggered: {} };
      try {
        const savedState = JSON.parse(localStorage.getItem('nook-notif-state'));
        if (savedState && savedState.date === today) {
          notifState = savedState;
        }
      } catch (e) {}

      let updated = false;

      // 1. Morning Briefing
      const briefingEnabled = localStorage.getItem('nook-notif-morning') !== 'false';
      const briefingTime = localStorage.getItem('nook-notif-morning-time') || '08:00';
      if (briefingEnabled && currentTime === briefingTime && !notifState.triggered.briefing) {
        const scheduled = trackers.filter(t => isScheduledToday(t) && !isLoggedToday(t));
        if (scheduled.length > 0) {
          const profileName = localStorage.getItem('nook-profile-name') || 'there';
          sendNotification(`Good morning, ${profileName}!`, {
            body: `You have ${scheduled.length} tracker${scheduled.length > 1 ? 's' : ''} to log today. Let's get started!`
          });
          notifState.triggered.briefing = true;
          updated = true;
        }
      }

      // 2. Habit Reminders
      trackers.forEach(t => {
        if (t.type === 'habit' && t.config?.reminderTime === currentTime && !notifState.triggered[`habit_${t.id}`]) {
          if (isScheduledToday(t) && !isLoggedToday(t)) {
            const { current: streak } = computeHabitStreaks(t);
            sendNotification(`Time to log: ${t.name}`, {
              body: streak > 0 ? `Current streak: ${streak} days. Keep it going!` : 'Log it now to start your streak!'
            });
            notifState.triggered[`habit_${t.id}`] = true;
            updated = true;
          }
        }
      });

      // 3. Streak At-Risk Alerts
      const streakAlertsEnabled = localStorage.getItem('nook-notif-streak') !== 'false';
      if (streakAlertsEnabled && currentTime === '20:00' && !notifState.triggered.streak_alerts) {
        trackers.forEach(t => {
          if (t.type === 'habit' && isScheduledToday(t) && !isLoggedToday(t)) {
            const { current: streak } = computeHabitStreaks(t);
            if (streak >= 3) {
              sendNotification('Streak at risk! 🔥', {
                body: `Don't break your ${streak}-day streak for "${t.name}".`
              });
            }
          }
        });
        notifState.triggered.streak_alerts = true;
        updated = true;
      }

      if (updated) {
        localStorage.setItem('nook-notif-state', JSON.stringify(notifState));
      }
    };

    // Check immediately, then every minute
    checkNotifications();
    const timerId = setInterval(checkNotifications, 60000);
    return () => clearInterval(timerId);
  }, [trackers]);

  // ── Toast ──
  const showToast = useCallback((msg, type='info') => {
    setToast({ msg, type, key: Date.now() });
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToast(null), 3200);
  }, []);

  useEffect(() => {
    const handleAppToast = (e) => {
      if (e.detail && e.detail.msg) {
        showToast(e.detail.msg, e.detail.type || 'info');
      }
    };
    window.addEventListener('app-toast', handleAppToast);
    return () => window.removeEventListener('app-toast', handleAppToast);
  }, [showToast]);

  // ── Cross-tab change detection ──
  // Redesign decision (robustness audit, cross-tab item): Nook has no merge
  // logic for concurrent tabs — this is deliberately just detect-and-warn,
  // not an attempt at a real merge. The `storage` event only fires in OTHER
  // tabs of the same origin (never the tab that made the write), which is
  // exactly the signal needed here. Excludes sync-engine-internal keys
  // (tokens, queue, tombstones, migration/bookkeeping flags) since those
  // changing doesn't mean the user's own content changed elsewhere — only
  // user-facing data keys should prompt a reload.
  useEffect(() => {
    const onStorage = (e) => {
      // Another tab's sync engine merged a remote change into this shared
      // localStorage. That's not a competing edit, and sync.js already told this
      // tab's views to refresh — a "reload" prompt would be wrong and noisy.
      if (isForeignSyncApply()) return;
      if (!e.key || !/^nook[-_]/.test(e.key) || CROSS_TAB_IGNORE_KEYS.has(e.key)) return;
      setCrossTabChanged(true);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // ── Timer ──
  // Batched focus-time accrual: the ticking interval no longer calls setTasks (and
  // therefore doesn't persist to localStorage) every single second. Elapsed seconds
  // accumulate in a ref and get flushed in one write every FLUSH_EVERY_N_SECS ticks,
  // plus immediately on pause/reset/completion/task-switch so nothing is lost.
  const FLUSH_EVERY_N_SECS = 10;
  const pendingFocusSecondsRef = useRef(0);
  const pendingFocusTaskIdRef  = useRef(null);
  const focusTickCountRef      = useRef(0);

  const flushFocusTime = useCallback(() => {
    const taskId = pendingFocusTaskIdRef.current;
    const secs   = pendingFocusSecondsRef.current;
    pendingFocusSecondsRef.current = 0;
    focusTickCountRef.current = 0;
    if (taskId && secs > 0) {
      setTasks(ts => ts.map(t => t.id === taskId ? { ...t, timeLogged: t.timeLogged + secs } : t));
    }
  }, []);

  const accrueFocusSecond = useCallback(() => {
    const currentTaskId = activeTaskRef.current;
    if (pendingFocusTaskIdRef.current !== currentTaskId) {
      flushFocusTime(); // commit whatever was pending for the previous task first
      pendingFocusTaskIdRef.current = currentTaskId;
    }
    if (!currentTaskId) return;
    pendingFocusSecondsRef.current += 1;
    focusTickCountRef.current += 1;
    if (focusTickCountRef.current >= FLUSH_EVERY_N_SECS) flushFocusTime();
  }, [flushFocusTime]);

  const switchMode = useCallback((mode) => {
    setTimerMode(mode);
    // Only update seconds/totalSeconds when no timer is actively running/paused
    if (timerStateRef.current === 'idle') {
      const secs = getSecsForMode(mode, settingsRef.current);
      setTimerSeconds(secs); setTotalSeconds(secs);
      setTickSeconds(secs);
      setActiveTimerMode(mode);
    }
  }, []);
  useEffect(() => { switchModeRef.current = switchMode; }, [switchMode]);

  onCompleteRef.current = () => {
    const mode=activeTimerModeRef.current, sett=settingsRef.current;
    if (sett.sound) playAlarm();
    
    // Push notification if enabled
    const pomoAlertsEnabled = localStorage.getItem('nook-notif-pomo') !== 'false';
    if (pomoAlertsEnabled) {
      if (mode === 'focus') {
        sendNotification('Focus session complete!', { body: 'Time for a break.' });
      } else {
        sendNotification('Break over.', { body: 'Ready for the next session?' });
      }
    }

    if (mode==='focus') {
      logActivity({ module: 'focus', entity_type: 'focus_session', entity_id: new Date().getTime().toString(), action: 'completed', title: 'Focus Session Completed' });
      setPomodoroLog(prev=>{
        const next=[...prev, new Date().toISOString()];
        return next.length>MAX_POMO_LOG ? next.slice(-MAX_POMO_LOG) : next;
      });
      flushFocusTime();
      if (activeTaskRef.current) {
        setTasks(ts=>ts.map(t=>t.id===activeTaskRef.current?{...t,pomodorosCompleted:(t.pomodorosCompleted||0)+1}:t));
      }
      const nextPos=(pomoLogRef.current.length+1)%LONG_BREAK_AFTER;
      const isLong=nextPos===0;
      showToast(isLong?`${LONG_BREAK_AFTER} sessions done! Long break 🎉`:'Focus done! Short break 🌿','success');
      setTimeout(()=>switchModeRef.current(isLong?'long':'short'), sett.autoSwitch?800:300);
    } else {
      showToast('Break over! Ready to focus? 💪','info');
      setTimeout(()=>switchModeRef.current('focus'), sett.autoSwitch?800:300);
    }
  };

  useEffect(() => {
    if (timerState!=='running') { clearInterval(intervalRef.current); return; }
    intervalRef.current = setInterval(() => {
      // Use wall-clock delta so the timer stays accurate in throttled background tabs.
      const remaining = Math.ceil((timerEndAtRef.current - Date.now()) / 1000);
      if (activeTimerModeRef.current==='focus') accrueFocusSecond();
      // Per-second display goes through an external store, not React state, so this
      // tick never re-renders App (or the sidebar/header/other tabs) — only the
      // few components that actually show the countdown subscribe to it.
      setTickSeconds(Math.max(0, remaining));
      if (remaining <= 0) {
        clearInterval(intervalRef.current);
        setTimerSeconds(0);
        setTimerState('idle');
        setTimeout(() => onCompleteRef.current(), 0);
      }
    }, 1000);
    return () => clearInterval(intervalRef.current);
  }, [timerState, accrueFocusSecond]);

  const adjustDuration = useCallback((secs) => {
    const clamped = Math.max(60, secs);
    setTimerSeconds(clamped);
    setTotalSeconds(clamped);
    setTickSeconds(clamped);
  }, []);

  const startTimer  = useCallback(() => {
    initAudio();
    const viewedMode = timerModeRef.current;
    const isResume = timerStateRef.current === 'paused' && viewedMode === activeTimerModeRef.current;
    if (isResume) {
      // Resume with remaining seconds
      timerEndAtRef.current = Date.now() + timerSecsRef.current * 1000;
      setTickSeconds(timerSecsRef.current);
    } else {
      // Fresh start — use timerSecsRef (respects user edits; switchMode already set the default)
      clearInterval(intervalRef.current);
      const secs = timerSecsRef.current;
      setTimerSeconds(secs); setTotalSeconds(secs);
      setTickSeconds(secs);
      timerSecsRef.current = secs;
      setActiveTimerMode(viewedMode);
      activeTimerModeRef.current = viewedMode;
      timerEndAtRef.current = Date.now() + secs * 1000;
    }
    pendingFocusTaskIdRef.current = activeTaskRef.current;
    pendingFocusSecondsRef.current = 0;
    focusTickCountRef.current = 0;
    setTimerState('running');
  }, []);
  const pauseTimer  = useCallback(() => {
    const remaining = getTickSeconds();
    setTimerSeconds(remaining);
    flushFocusTime();
    setTimerState('paused');
  }, [flushFocusTime]);
  const resetTimer  = useCallback(() => {
    clearInterval(intervalRef.current); setTimerState('idle');
    flushFocusTime();
    const s=getSecsForMode(timerMode,settings); setTimerSeconds(s); setTotalSeconds(s); setTickSeconds(s);
    setActiveTimerMode(timerMode);
  }, [timerMode, settings, flushFocusTime]);

  // ── Task operations ──
  const selectTask = useCallback((id) => {
    if (timerState==='running') { showToast('Pause the timer first','warn'); return; }
    setActiveTaskId(prev=>prev===id?null:id);
  }, [timerState, showToast]);

  const addTask = useCallback((data) => {
    const t = {
      id:genId(), name:data.name.trim(), category:data.category, priority:data.priority,
      timeEstimate:Math.max(1,Math.min(480,Number(data.timeEstimate)||25)),
      notes:data.notes.trim(), dueDate:data.dueDate, completed:false, status: 'needsAction',
      timeLogged:0, pomodorosCompleted:0, createdAt:new Date().toISOString(), completedAt:null,
      recurrence: data.recurrence || null,
      recurrenceDays: data.recurrenceDays || [],
      googleTaskId: null,
      lastSyncedAt: null,
      updatedAt: new Date().toISOString(),
      syncConflict: null
    };
    logActivity({ module: 'tasks', entity_type: 'task', entity_id: t.id, action: 'created', title: t.name });
    setTasks(prev => {
      const next = [t, ...prev];
      pushSyncQueue({ type: 'CREATE', taskId: t.id });
      setTimeout(() => syncTasks(next, setTasks, setSyncStatus), 500);
      return next;
    });
    pushTask(t); // Supabase cross-device sync (full row; fire-and-forget)
    setOpenModal(null);
    showToast(`"${t.name}" added ✓`,'success');
  }, [showToast]);

  // A reminder row carries a snapshot of the task's title, because the Edge
  // Function that sends the email/push can't read localStorage. Renaming a task
  // therefore has to reach that row, or the notification keeps the old text.
  //
  // Compared against tasksRef and called BEFORE setTasks rather than inside the
  // updater: React re-invokes updaters (StrictMode, and on a retried render),
  // and the existing clearReminder calls in there get away with it only because
  // DELETE is idempotent. Firing a network write once, outside, is the honest
  // version. No-ops when the name is unchanged, blank, or the task is unknown —
  // quickUpdateTask takes partial patches that may carry no name at all.
  const syncReminderTitle = useCallback((taskId, nextName) => {
    if (!nextName) return;
    const prevName = tasksRef.current.find(t => t.id === taskId)?.name;
    if (!prevName || prevName === nextName) return;
    renameReminder('task', taskId, nextName).catch(() => {});
  }, []);

  const updateTaskData = useCallback((updated) => {
    const nextUpdated = { ...updated, name: updated.name.trim(), notes: (updated.notes||'').trim(), updatedAt: new Date().toISOString() };
    syncReminderTitle(updated.id, nextUpdated.name);
    setTasks(prev => {
      const old = prev.find(t => t.id === updated.id);
      const changes = old ? diffObjects(old, nextUpdated, ['name', 'notes', 'priority', 'category', 'dueDate', 'timeEstimate']) : null;
      logActivity({ module: 'tasks', entity_type: 'task', entity_id: updated.id, action: 'updated', title: nextUpdated.name, field_changes: changes });
      if (nextUpdated.completed && !old?.completed) clearReminder('task', updated.id).catch(() => {});
      const next = prev.map(t => t.id === updated.id ? { ...t, ...nextUpdated } : t);
      pushSyncQueue({ type: 'UPDATE', taskId: updated.id });
      setTimeout(() => syncTasks(next, setTasks, setSyncStatus), 500);
      if (old) pushTask({ ...old, ...nextUpdated }); // Supabase: full merged row, not the partial
      return next;
    });
    setEditingTask(null);
    showToast(`"${updated.name.trim()}" updated ✓`, 'success');
  }, [showToast, syncReminderTitle]);

  // Silent update for detail-panel auto-saves (no toast, no modal side-effects).
  // Still logs to the Activity Log so edits via the detail panel appear in the
  // audit trail — they just don't interrupt the user with a toast or close a modal.
  const quickUpdateTask = useCallback((updated) => {
    const nextUpdated = { ...updated, name: (updated.name||'').trim(), notes: (updated.notes||'').trim(), updatedAt: new Date().toISOString() };
    syncReminderTitle(updated.id, nextUpdated.name);
    setTasks(prev => {
      const old = prev.find(t => t.id === updated.id);
      const changes = old ? diffObjects(old, nextUpdated, ['name', 'notes', 'priority', 'category', 'dueDate', 'timeEstimate']) : null;
      if (changes) {
        logActivity({ module: 'tasks', entity_type: 'task', entity_id: updated.id, action: 'updated', title: nextUpdated.name, field_changes: changes });
      }
      if (nextUpdated.completed && !old?.completed) clearReminder('task', updated.id).catch(() => {});
      const next = prev.map(t => t.id === updated.id ? { ...t, ...nextUpdated } : t);
      pushSyncQueue({ type: 'UPDATE', taskId: updated.id });
      setTimeout(() => syncTasks(next, setTasks, setSyncStatus), 500);
      // Supabase: send the FULL merged row. quickUpdateTask receives a partial
      // patch, so pushing nextUpdated alone would null every omitted column.
      if (old) pushTask({ ...old, ...nextUpdated });
      return next;
    });
  }, [syncReminderTitle]);

  // Stable handlers passed to the memoized TaskList (keep its props referentially stable)
  const openAddTaskModal = useCallback(() => setOpenModal('add'), []);
  const openEditTask     = useCallback((task) => setEditingTask(task), []);
  // tasksRef keeps this callback stable while still syncing the live list.
  const handleSyncNow    = useCallback(() => syncTasks(tasksRef.current, setTasks, setSyncStatus), []); // eslint-disable-line react-hooks/exhaustive-deps

  // Reminders tab → jump to the task that owns a reminder, opened straight to its Scheduling tab.
  const navigateToReminderSource = useCallback((sourceType, sourceId) => {
    if (sourceType === 'task') {
      setActiveTab('tasks');
      setPendingOpenTaskId(sourceId);
    }
  }, []);
  const clearPendingOpenTaskId = useCallback(() => setPendingOpenTaskId(null), []);

  // Deep link from a reminder push notification's notificationclick handler
  // (see public/sw.js), e.g. /?reminder=task:abc123 — opens once on load,
  // then cleans the URL so a refresh doesn't re-trigger it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const reminder = params.get('reminder');
    if (!reminder) return;
    const [sourceType, sourceId] = reminder.split(':');
    if (sourceType && sourceId) navigateToReminderSource(sourceType, sourceId);
    params.delete('reminder');
    const next = params.toString();
    window.history.replaceState(null, '', window.location.pathname + (next ? `?${next}` : ''));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Habit callbacks ──
  const addHabit = useCallback((h) => {
    // Stamp updatedAt (habits had no such field originally) so the Supabase
    // LWW guard has a comparable timestamp; store + push the full row.
    const habit = { ...h, updatedAt: new Date().toISOString() };
    logActivity({ module: 'habits', entity_type: 'habit', entity_id: habit.id, action: 'created', title: habit.name });
    setHabits(prev => [habit, ...prev]);
    pushHabit(habit); // Supabase cross-device sync (full row; fire-and-forget)
  }, []);
  const updateHabit = useCallback((h) => {
    const updated = { ...h, updatedAt: new Date().toISOString() };
    setHabits(prev => {
      const old = prev.find(x => x.id === h.id);
      const changes = old ? diffObjects(old, updated, ['name', 'frequency', 'category', 'color', 'reminderEnabled', 'reminderTime', 'archived']) : null;
      // Distinguish archive/restore from a plain edit
      const action = old?.archived === false && updated.archived === true ? 'archived'
                   : old?.archived === true  && updated.archived === false ? 'restored'
                   : 'updated';
      logActivity({ module: 'habits', entity_type: 'habit', entity_id: updated.id, action, title: updated.name, field_changes: changes });
      pushHabit(updated); // Supabase: full row (HabitsView already sends complete objects)
      return prev.map(x => x.id === updated.id ? updated : x);
    });
  }, []);
  const deleteHabit = useCallback((id) => {
    setHabits(prev => {
      const h = prev.find(x => x.id === id);
      if (h) {
        logActivity({ module: 'habits', entity_type: 'habit', entity_id: id, action: 'deleted', title: h.name });
        softDeleteHabit(h); // Supabase: tombstone so the delete propagates across devices
      }
      return prev.filter(x => x.id !== id);
    });
  }, []);
  const markHabitDone = useCallback((id) => {
    setHabits(prev => {
      const h = prev.find(x => x.id === id);
      if (!h) return prev;
      const wasCompleted = h.completions?.includes(localDateStr());
      logActivity({ module: 'habits', entity_type: 'habit', entity_id: id, action: wasCompleted ? 'updated' : 'completed', title: h.name, field_changes: wasCompleted ? [{ field: 'completed_today', from: 'true', to: 'false' }] : null });
      const toggled = { ...toggleCompletion(h), updatedAt: new Date().toISOString() };
      pushHabit(toggled); // Supabase: full row with the updated completions array
      return prev.map(x => x.id === id ? toggled : x);
    });
  }, []);

  const toggleComplete = useCallback(async (id) => {
    const isSyncEnabled = localStorage.getItem('nook_sync_enabled') === 'true';
    const currentTask = tasks.find(t => t.id === id);
    if (!currentTask) return;

    const done = !currentTask.completed;
    logActivity({ module: 'tasks', entity_type: 'task', entity_id: id, action: done ? 'completed' : 'updated', title: currentTask.name, field_changes: done ? null : [{ field: 'completed', from: 'true', to: 'false' }] });
    // A completed task shouldn't still fire a reminder — clear it server-side.
    // Fire-and-forget: a Supabase hiccup here shouldn't block completing the task.
    if (done) clearReminder('task', id).catch(() => {});

    const performLocalUpdate = (forceSync = false) => {
      setTasks(prev => {
        const task = prev.find(t => t.id === id);
        const toggled = task && { ...task, completed: done, status: done ? 'completed' : 'needsAction', completedAt: done ? new Date().toISOString() : null, updatedAt: new Date().toISOString() };
        const mapped = prev.map(t => t.id === id ? toggled : t);
        let finalTasks = mapped;
        let newOccurrence = null;
        // Auto-create next occurrence when completing a recurring task
        if (done && task?.recurrence) {
          const due  = nextDueDate(task.dueDate, task.recurrence, task.recurrenceDays);
          newOccurrence = {
            ...task,
            id: genId(), completed: false, status: 'needsAction', completedAt: null,
            dueDate: due, timeLogged: 0, pomodorosCompleted: 0,
            createdAt: new Date().toISOString(),
            googleTaskId: null, lastSyncedAt: null, updatedAt: new Date().toISOString(), syncConflict: null
          };
          finalTasks = [...mapped, newOccurrence];
          pushSyncQueue({ type: 'CREATE', taskId: newOccurrence.id });
        }
        pushSyncQueue({ type: 'UPDATE', taskId: id });
        setTimeout(() => syncTasks(finalTasks, setTasks, setSyncStatus), forceSync ? 10 : 500);
        // Supabase: push the toggled task (full row) + any new recurrence occurrence.
        if (toggled) pushTasks(newOccurrence ? [toggled, newOccurrence] : [toggled]);
        return finalTasks;
      });
      if (id===activeTaskId && timerState==='running') pauseTimer();
    };

    if (isSyncEnabled && currentTask.googleTaskId) {
      setSyncStatus('Updating Task Status...');

      const success = await directGoogleTaskUpdate(currentTask.googleTaskId, {
        status: done ? 'completed' : 'needsAction'
      });
      
      if (success) {

        // Apply the completion locally straight away so the checkbox reflects the
        // change immediately, instead of depending on the follow-up pull to bring
        // the status back (clock skew / timing could otherwise revert it).
        const completedIso = new Date().toISOString();
        const applyDone = t => t.id === id
          ? { ...t, completed: done, status: done ? 'completed' : 'needsAction', completedAt: done ? completedIso : null, updatedAt: completedIso }
          : t;
        // Flush any partial focus-time accumulation so the sync carries the
        // correct timeLogged — without this, up to FLUSH_EVERY_N_SECS of timer
        // work could be overwritten by pullTasksFromGoogle's setTasks.
        flushFocusTime();
        // Track the freshly-built list so the sync below runs on an array that
        // INCLUDES both the completion and any new occurrence — passing the stale
        // `tasks` closure dropped them (pull rebuilds state from whatever array
        // it's given, erasing just-applied local changes).
        let nextTasks = tasksRef.current.map(applyDone);
        setTasks(prev => prev.map(applyDone));
        // Supabase: push the toggled task (full row). Sourced from nextTasks so
        // it carries the just-flushed timeLogged, not a stale snapshot.
        const toggledRow = nextTasks.find(t => t.id === id);
        if (toggledRow) pushTask(toggledRow);

        if (done && currentTask.recurrence) {
           const due = nextDueDate(currentTask.dueDate, currentTask.recurrence, currentTask.recurrenceDays);
           const next = {
             ...currentTask,
             id: genId(), completed: false, status: 'needsAction', completedAt: null,
             dueDate: due, timeLogged: 0, pomodorosCompleted: 0,
             createdAt: new Date().toISOString(),
             googleTaskId: null, lastSyncedAt: null, updatedAt: new Date().toISOString(), syncConflict: null
           };
           nextTasks = [...nextTasks, next];
           setTasks(prev => [...prev, next]);
           pushSyncQueue({ type: 'CREATE', taskId: next.id });
           pushTask(next); // Supabase: new recurrence occurrence (full row)
        }

        // Force a fresh sync to pull the status update from Google. Pass the list
        // that includes the completion and any new occurrence so the pull's
        // setTasks doesn't erase them.
        await syncTasks(nextTasks, setTasks, setSyncStatus);
        if (id===activeTaskId && timerState==='running') pauseTimer();
      } else {
        setSyncStatus('Sync failed');
        performLocalUpdate(); // Fallback to offline queue behavior
      }
    } else {
      performLocalUpdate();
    }
  }, [tasks, activeTaskId, timerState, pauseTimer, setTasks]);

  const deleteTask = useCallback((id) => {
    clearReminder('task', id).catch(() => {});
    setTasks(prev => {
      const task = prev.find(t => t.id === id);
      if (task) logActivity({ module: 'tasks', entity_type: 'task', entity_id: id, action: 'deleted', title: task.name });
      if (task && task.googleTaskId) {
        pushSyncQueue({ type: 'DELETE', googleTaskId: task.googleTaskId, taskId: id });
      }
      const next = prev.filter(t => t.id !== id);
      setTimeout(() => syncTasks(next, setTasks, setSyncStatus), 500);
      if (task) softDeleteTask(task); // Supabase: tombstone so the delete propagates across devices
      return next;
    });
    if (activeTaskId===id) { setActiveTaskId(null); if(timerState==='running') pauseTimer(); }
  }, [activeTaskId, timerState, pauseTimer]);

  const clearCompleted = useCallback(async () => {
    const isSyncEnabled = localStorage.getItem('nook_sync_enabled') === 'true';
    const completedTasks = tasks.filter(t => t.completed || t.status === 'completed');
    if (!completedTasks.length) return;

    logActivity({ module: 'tasks', entity_type: 'task', entity_id: '', action: 'deleted', title: `Cleared ${completedTasks.length} completed task${completedTasks.length > 1 ? 's' : ''}` });

    softDeleteTasks(completedTasks); // Supabase: tombstone the whole batch (both branches remove them locally)

    if (isSyncEnabled) {
      setSyncStatus('Deleting Completed Tasks...');
      const withGid = completedTasks.filter(t => t.googleTaskId);
      // Delete on Google in bounded-concurrency batches instead of one sequential
      // await per task (N round-trips) — much faster when clearing many at once.
      const LIMIT = 5;
      for (let i = 0; i < withGid.length; i += LIMIT) {
        await Promise.all(withGid.slice(i, i + LIMIT).map(t => directGoogleTaskDelete(t.googleTaskId)));
      }
      // Record all deletions once (was re-parsing/writing localStorage per task) so
      // the next pull doesn't re-create them.
      if (withGid.length) {
        const delStr = localStorage.getItem('nook_deleted_tasks');
        let deletedIds = [];
        try { deletedIds = delStr ? JSON.parse(delStr) : []; } catch {}
        for (const t of withGid) if (!deletedIds.includes(t.googleTaskId)) deletedIds.push(t.googleTaskId);
        localStorage.setItem('nook_deleted_tasks', JSON.stringify(deletedIds));
      }
      const filtered = tasks.filter(t => !t.completed && t.status !== 'completed');
      setTasks(filtered);
      await syncTasks(filtered, setTasks, setSyncStatus);
    } else {
      setTasks(prev => prev.filter(t => !t.completed && t.status !== 'completed'));
    }
    showToast(`Cleared ${completedTasks.length} completed task${completedTasks.length > 1 ? 's' : ''}`, 'info');
  }, [tasks, showToast]);

  const saveSettings = useCallback((next) => {
    setSettings(next);
    if (timerState==='idle') { const s=getSecsForMode(timerMode,next); setTimerSeconds(s); setTotalSeconds(s); setTickSeconds(s); }
    setOpenModal(null); showToast('Settings saved','success');
  }, [timerState, timerMode, showToast]);

  // ── Intention callbacks ──
  const updateIntention = useCallback((id, text) => {
    setIntentions(prev => {
      const existing = prev.items.find(i => i.id === id);
      const isNew = !existing?.text && text;
      if (isNew || (existing && existing.text !== text)) {
        logActivity({ module: 'intentions', entity_type: 'intention', entity_id: id, action: isNew ? 'created' : 'updated', title: text });
      }
      return {...prev, items:prev.items.map(i=>i.id===id?{...i,text}:i)};
    });
  }, []);
  const toggleIntention = useCallback((id) => {
    setIntentions(prev => {
      const intention = prev.items.find(i => i.id === id);
      if (intention && intention.text) {
        logActivity({ module: 'intentions', entity_type: 'intention', entity_id: id, action: intention.done ? 'updated' : 'completed', title: intention.text, field_changes: intention.done ? [{ field: 'done', from: 'true', to: 'false' }] : null });
      }
      return {...prev, items:prev.items.map(i=>i.id===id?{...i,done:!i.done}:i)};
    });
  }, []);

  // ── Tracker callbacks ──
  const addTracker = useCallback((t) => {
    logActivity({ module: 'trackers', entity_type: 'tracker', entity_id: t.id, action: 'created', title: t.name });
    setTrackers(prev=>[t,...prev]);
    showToast(`"${t.name}" tracker created ✓`,'success');
  }, [showToast]);
  const updateTracker = useCallback((newTracker) => {
    setTrackers(prev => {
      const oldTracker = prev.find(t => t.id === newTracker.id);
      if (oldTracker) {
        const today = localDateStr();
        const oldLog = (oldTracker.logs || []).find(l => l.date === today);
        const newLog = (newTracker.logs || []).find(l => l.date === today);
        
        // Log any structural edit (name, target, category, config).
        // Log-only mutations (newLog !== oldLog) are caught by the 'completed'
        // branch below, so we only fire 'updated' when something else changed.
        const isStructuralEdit = oldTracker.name !== newTracker.name
          || oldTracker.target !== newTracker.target
          || oldTracker.category !== newTracker.category
          || JSON.stringify(oldTracker.config) !== JSON.stringify(newTracker.config);
        const isLogOnlyMutation = !oldLog && newLog; // caught separately below
        if (isStructuralEdit && !isLogOnlyMutation) {
          logActivity({ module: 'trackers', entity_type: 'tracker', entity_id: newTracker.id, action: 'updated', title: newTracker.name });
        }

        // Habit logged or Target/Average updated
        if (!oldLog && newLog) {
          logActivity({ module: 'trackers', entity_type: 'tracker', entity_id: newTracker.id, action: 'completed', title: newTracker.name });
          if (navigator.vibrate) navigator.vibrate(50);
          showToast(`Logged "${newTracker.name}"`, 'success');
          
          if (newTracker.type === 'habit') {
            const { current: streak } = computeHabitStreaks(newTracker);
            if ([7, 14, 30, 60, 100].includes(streak)) {
              import('canvas-confetti').then(({ default: confetti }) => confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } }));
              showToast(`🔥 ${streak} day streak on ${newTracker.name}!`, 'success');
            }
          }
        }
        
        // Project Goal completed
        if (newTracker.type === 'project') {
          const oldDone = (getConfig(oldTracker).milestones || []).filter(m => m.done).length;
          const newDone = (getConfig(newTracker).milestones || []).filter(m => m.done).length;
          const total = (getConfig(newTracker).milestones || []).length;
          if (oldDone < total && newDone === total && total > 0) {
            if (navigator.vibrate) navigator.vibrate([50, 100, 50]);
            import('canvas-confetti').then(({ default: confetti }) => confetti({ particleCount: 200, spread: 100, origin: { y: 0.5 } }));
            showToast(`🎉 Project completed: ${newTracker.name}!`, 'success');
          } else if (newDone > oldDone) {
            if (navigator.vibrate) navigator.vibrate(50);
          }
        }
      }
      return prev.map(x => x.id === newTracker.id ? newTracker : x);
    });
  }, [showToast]);
  const deleteTracker = useCallback((id) => {
    setTrackers(prev => {
      const t = prev.find(x => x.id === id);
      if (t) logActivity({ module: 'trackers', entity_type: 'tracker', entity_id: id, action: 'deleted', title: t.name });
      return prev.filter(x => x.id !== id);
    });
    showToast('Tracker deleted','info');
  }, [showToast]);

  const handleTrackerSave = useCallback((tracker) => {
    if (editingTracker) updateTracker(tracker);
    else addTracker(tracker);
    setShowAddTracker(false);
    setEditingTracker(null);
  }, [editingTracker, addTracker, updateTracker]);

  const openAddTracker = useCallback(() => {
    setEditingTracker(null); setShowAddTracker(true);
  }, []);
  const openEditTracker = useCallback((tracker) => {
    setEditingTracker(tracker); setShowAddTracker(true);
  }, []);

  // ── Escape closes open modals/drawers ──
  useEffect(() => {
    const handler = e => {
      if (e.key === 'Escape' && (openModal || showAddTracker)) {
        setOpenModal(null); setShowAddTracker(false); setEditingTracker(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [openModal, showAddTracker]);

  const activeTask    = tasks.find(t=>t.id===activeTaskId)??null;
  const pomodoroCount = pomodoroLog.length%LONG_BREAK_AFTER;

  // Tab badge counts
  const scheduledToday = trackers.filter(t=>isScheduledToday(t));
  const unloggedToday  = scheduledToday.filter(t=>!isLoggedToday(t));

  const [sidebarOpen, setSidebarOpen] = useState(
    () => localStorage.getItem('nook-sidebar-open') !== 'false'
  );
  // Persist collapse state so it survives reloads (matches app's local-first convention)
  useEffect(() => {
    localStorage.setItem('nook-sidebar-open', sidebarOpen ? 'true' : 'false');
  }, [sidebarOpen]);
  // Mirrors whichever SidebarSearch/MobileMoreModal instance is currently live —
  // NotesView falls back to this as `globalSearchQuery` to live-filter its own
  // list when the sidebar search box is used while on the Notes tab.
  const [searchQuery, setSearchQuery] = useState('');
  const [profileName, setProfileName] = useState(() => localStorage.getItem('nook-profile-name') || 'Productivity User');
  const [profileEmail, setProfileEmail] = useState(() => {
    const saved = localStorage.getItem('nook-profile-email');
    if (saved) return saved;
    const name = localStorage.getItem('nook-profile-name') || 'user';
    return `${name.toLowerCase().replace(/\s+/g, '')}@gmail.com`;
  });
  const [profileAvatar, setProfileAvatar] = useState(() => localStorage.getItem('nook-profile-avatar') || '😎');
  // ── Cross-device sync (everything except tasks/habits/reminders) ──
  // utils/sync.js watches localStorage writes and mirrors them to Supabase
  // (synced_items), and merges other devices' changes back INTO localStorage.
  // This component only has to (1) start it and (2) re-read the slices it holds
  // in React state when a remote change lands — each tab's view does the same
  // for its own slice via useSyncApplied. No-op without a signed-in session.
  useEffect(() => { startSync(); }, []);
  useSyncApplied(
    ['pomo_settings', 'pomo_log', 'intentions', 'trackers', 'theme', 'profile_name', 'profile_email', 'profile_avatar'],
    (names) => {
      if (names.includes('pomo_settings')) setSettings(loadSettings());
      if (names.includes('pomo_log'))      setPomodoroLog(loadPomoLog());
      if (names.includes('intentions'))    setIntentions(loadIntentions());   // also rolls a stale day over
      if (names.includes('trackers'))      setTrackers(loadTrackers());
      if (names.includes('theme')) {
        try { const t = JSON.parse(localStorage.getItem(SK.theme)); if (t === 'dark' || t === 'light') setTheme(t); } catch {}
      }
      if (names.includes('profile_name'))   setProfileName(localStorage.getItem('nook-profile-name') || 'Productivity User');
      if (names.includes('profile_email'))  { const e = localStorage.getItem('nook-profile-email'); if (e) setProfileEmail(e); }
      if (names.includes('profile_avatar')) setProfileAvatar(localStorage.getItem('nook-profile-avatar') || '😎');
    },
  );


  // Nav badge counts (derived — no effect needed, no notification side-effect).
  // Previously this block contained a per-edit "Daily Summary" notification that
  // fired 5 s after every task count change — removed (BUG-08) because it spammed
  // on every add/complete and bypassed the proper morning-briefing system.
  const pendingTasksCount = tasks.filter(t => !t.completed).length;
  const activeHabitsCount = habits.filter(h => !h.archived).length;

  return (
    <div className={`app${sidebarOpen ? ' sidebar-open' : ' sidebar-rail'}`}>
      {/* ── Body: sidebar nav + content ── */}
      <div className="app-body">

      {/* Sidebar — always mounted; collapses to icon rail rather than hiding.
          desktop-only hides it on mobile where the bottom nav takes over. */}
      <nav
        className={`main-nav desktop-only${sidebarOpen ? '' : ' main-nav--rail'}`}
        role="navigation"
        aria-label="Main navigation"
      >
        {/* Brand row — logo + name + toggle button */}
        <div className="sidebar-brand">
          <img 
            src={nookLogo} 
            className="sidebar-brand-logo" 
            alt="Nook Logo" 
            onClick={() => {
              if (!sidebarOpen) setSidebarOpen(true);
            }}
            style={{ cursor: !sidebarOpen ? 'pointer' : 'default' }}
            title={!sidebarOpen ? 'Expand sidebar' : ''}
          />
          <span className="sidebar-brand-name">Nook</span>
          {sidebarOpen && (
            <button
              className="hdr-btn sidebar-close-btn"
              onClick={() => setSidebarOpen(false)}
              title="Collapse sidebar"
              aria-label="Collapse sidebar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
            </button>
          )}
        </div>

        {/* Search — full widget when expanded, icon-only trigger when railed —
            plus the voice-command mic beside it, so both are reachable from
            any tab the same way. */}
        <div className="sb-search-row">
          <SidebarSearch tasks={tasks} habits={habits} setActiveTab={setActiveTab} onQueryChange={setSearchQuery} />
          {/* <VoiceCommandButton tasks={tasks} addTask={addTask} toggleComplete={toggleComplete} showToast={showToast} /> */}
        </div>

        {/* ── Section: Main ── */}
        <span className="nav-section-label">Main</span>
        {[
          { id:'daily',      label:'Today',        Icon: NavIcoSun,         badge: unloggedToday.length || 0 },
          { id:'tasks',      label:'Tasks',        Icon: NavIcoCheckSquare, badge: tasks.filter(t=>!t.completed).length || 0 },
          { id:'calendar',   label:'Calendar',     Icon: NavIcoCalendar },
          { id:'habits',     label:'Habits',       Icon: NavIcoRepeat },
          { id:'journal',    label:'Journal',      Icon: NavIcoBookOpen },
          { id:'reminders',  label:'Reminders',    Icon: NavIcoBell },
          { id:'notes',      label:'Notes',        Icon: NavIcoNotes },
        ].map(tab => (
          <button key={tab.id}
            className={`main-nav-btn${activeTab===tab.id?' nav-active':''}`}
            onClick={() => setActiveTab(tab.id)}
            title={!sidebarOpen ? tab.label : undefined}
          >
            <span className="nav-icon-wrap">
              <span className="nav-icon"><tab.Icon /></span>
              {tab.badge > 0 && <span className="nav-badge-rail">{tab.badge > 99 ? '99+' : tab.badge}</span>}
            </span>
            <span className="nav-label">{tab.label}</span>
            {tab.badge > 0 && <span className="nav-badge">{tab.badge}</span>}
          </button>
        ))}

        {/* ── Section: More — shown flat in rail, labelled when expanded ── */}
        <div className="nav-divider" />
        <span className="nav-section-label">More</span>
        {[
          { id:'timer',      label:'Focus',        Icon: NavIcoTimerIcon },
          { id:'links',      label:'Links',        Icon: NavIcoLinks },
          { id:'countdowns', label:'Countdowns',   Icon: NavIcoHourglass },
          // { id:'chat',       label:'AI Assistant', Icon: NavIcoChat }, // Hidden for now per user request
        ].map(tab => (
          <button key={tab.id}
            className={`main-nav-btn${(activeTab===tab.id && tab.id !== 'chat') || (tab.id === 'chat' && isAssistantOpen) ? ' nav-active':''}`}
            onClick={() => {
              if (tab.id === 'chat') {
                setIsAssistantOpen(!isAssistantOpen);
              } else {
                setActiveTab(tab.id);
              }
            }}
            title={!sidebarOpen ? tab.label : undefined}
          >
            <span className="nav-icon-wrap">
              <span className="nav-icon"><tab.Icon /></span>
            </span>
            <span className="nav-label">{tab.label}</span>
          </button>
        ))}

        {/* ── Section: Utility — reports, audit, credentials ── */}
        <div className="nav-divider" />
        <span className="nav-section-label">Utility</span>
        {[
          { id:'reports',  label:'Reports',       Icon: NavIcoBarChart },
          { id:'activity', label:'Activity Log',  Icon: NavIcoHistory },
          { id:'vault',    label:'Saved Logins',  Icon: NavIcoVault },
        ].map(tab => (
          <button key={tab.id}
            className={`main-nav-btn${activeTab===tab.id?' nav-active':''}`}
            onClick={() => setActiveTab(tab.id)}
            title={!sidebarOpen ? tab.label : undefined}
          >
            <span className="nav-icon-wrap">
              <span className="nav-icon"><tab.Icon /></span>
            </span>
            <span className="nav-label">{tab.label}</span>
          </button>
        ))}

        <div className="nav-spacer" />
        <div className="nav-settings-separator" />
        <button
          className={`main-nav-btn${activeTab==='settings'?' nav-active':''}`}
          onClick={() => setActiveTab('settings')}
          title={!sidebarOpen ? "Settings" : undefined}
        >
          <span className="nav-icon-wrap">
            <span className="nav-icon"><NavIcoSettings /></span>
          </span>
          <span className="nav-label">Settings</span>
        </button>
      </nav>

      {/* ── Mobile Bottom Nav ── */}
      <nav className="mobile-bottom-nav">
        {[
          { id:'daily',    label:'Today',    Icon: NavIcoSun,         badge: unloggedToday.length || 0 },
          { id:'tasks',    label:'Tasks',    Icon: NavIcoCheckSquare, badge: tasks.filter(t=>!t.completed).length || 0 },
          { id:'journal',  label:'Journal',  Icon: NavIcoBookOpen },
          { id:'habits',   label:'Habits',   Icon: NavIcoRepeat },
        ].map(tab => (
          <button key={tab.id}
            className={`main-nav-btn${activeTab===tab.id?' nav-active':''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span className="nav-icon"><tab.Icon /></span>
            <span className="nav-label">{tab.label}</span>
            {tab.badge > 0 && <span className="nav-badge">{tab.badge}</span>}
          </button>
        ))}
        <button className={`main-nav-btn${openModal === 'mobile-more' ? ' nav-active' : ''}`} onClick={() => setOpenModal('mobile-more')}>
          <span className="nav-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/><circle cx="5" cy="12" r="1.5"/></svg>
          </span>
          <span className="nav-label">More</span>
        </button>
      </nav>

      {/* ── Tab content ── */}
      <div className={`tab-content${activeTab === 'journal' ? ' tab-content-journal' : ''}`}>
        <AnimatePresence mode="wait">
        <motion.div
          key={activeTab}
          className={`sunsama-tab-transition${activeTab === 'daily' ? ' yartu-tab-active' : ''}${activeTab === 'calendar' ? ' calendar-tab-active' : ''}${activeTab === 'activity' ? ' activity-tab-active' : ''}${activeTab === 'habits' ? ' habits-tab-active' : ''}${activeTab === 'journal' ? ' journal-tab-active' : ''}${activeTab === 'tasks' ? ' tasks-tab-active' : ''}`}
          // Opacity-only transition: animating y leaves an inline transform on this
          // wrapper even at rest, which makes it the containing block for any
          // position:sticky descendant (e.g. the Activity Log toolbar) and breaks
          // sticky-to-scroll-container, causing the toolbar to drift while scrolling.
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.13, ease: 'easeOut' }}
        >
          <Suspense fallback={<TabFallback />}>
          {activeTab === 'daily' && (
            <DailyGoalsView
              trackers={trackers}
              onUpdateTracker={updateTracker}
              onAddTracker={openAddTracker}
              intentions={intentions}
              onIntentionUpdate={updateIntention}
              onIntentionToggle={toggleIntention}
              pomodoroLog={pomodoroLog}
              tasks={tasks}
              onTriggerWeeklyReview={() => setOpenModal('weekly-review')}
              habits={habits}
              onMarkHabitDone={markHabitDone}
              activeTaskId={activeTaskId}
              timerRunning={timerState==='running'}
              selectTask={selectTask}
              toggleComplete={toggleComplete}
              deleteTask={deleteTask}
              clearCompleted={clearCompleted}
              setOpenModal={setOpenModal}
              addTask={addTask}
              setEditingTask={setEditingTask}
              updateTaskData={updateTaskData}
              quickUpdateTask={quickUpdateTask}
              syncStatus={syncStatus}
              syncTasks={() => syncTasks(tasks, setTasks, setSyncStatus)}
              startTimer={startTimer}
              pauseTimer={pauseTimer}
              resetTimer={resetTimer}
              timerState={timerState}
              timerMode={timerMode}
              totalSeconds={totalSeconds}
              setActiveTab={setActiveTab}
            />
          )}

          {activeTab === 'reports' && (
            <ReportsView
              habits={habits}
              tasks={tasks}
              pomodoroLog={pomodoroLog}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsView
              settings={settings}
              onSaveSettings={saveSettings}
              theme={theme}
              onSetTheme={setTheme}
              onClearData={handleClearData}
              onImportData={handleImportData}
              syncStatus={syncStatus}
              onSyncToggle={handleSettingsSyncToggle}
              onDisconnect={handleSettingsDisconnect}
              onSyncNow={handleSettingsSyncNow}
              initialProfileName={profileName}
              initialProfileEmail={profileEmail}
              initialProfileAvatar={profileAvatar}
              onUpdateProfile={handleUpdateProfile}
              gcalConnected={isGCalConnected()}
              onConnectGCal={handleConnectGCal}
              onDisconnectGCal={handleDisconnectGCal}
            />
          )}

          {activeTab === 'calendar' && (
            <CalendarView
              tasks={tasks}
              onAddTask={addTask}
              onUpdateTask={updateTaskData}
              trackers={trackers}
              habits={habits}
            />
          )}

          {activeTab === 'timer' && (
            <div className="timer-tab-wrap">
            <div className="timer-tab">
              <div className="timer-left-col">
                <Timer
                  task={activeTask}
                  timerMode={timerMode}
                  activeTimerMode={activeTimerMode}
                  timerState={timerState}
                  totalSeconds={totalSeconds}
                  pomodoroCount={pomodoroCount}
                  onSwitchMode={switchMode}
                  onStart={startTimer}
                  onPause={pauseTimer}
                  onReset={resetTimer}
                  onAdjustDuration={adjustDuration}
                />
              </div>
              <div className="timer-right-col">
                <FocusCompanion
                  tasks={tasks}
                  activeTaskId={activeTaskId}
                  onSelectTask={selectTask}
                  onToggle={toggleComplete}
                  pomodoroLog={pomodoroLog}
                  timerState={timerState}
                  timerMode={timerMode}
                />
                <TodayBreakdown tasks={tasks} />
                <Stats tasks={tasks} pomodoroLog={pomodoroLog} settings={settings} />
              </div>
            </div>
            </div>
          )}

          {activeTab === 'habits'  && (
            <HabitsView
              habits={habits}
              onAddHabit={addHabit}
              onUpdateHabit={updateHabit}
              onDeleteHabit={deleteHabit}
            />
          )}
          {activeTab === 'journal'  && <JournalView sidebarOpen={sidebarOpen} />}
          {activeTab === 'countdowns' && <CountdownsView />}
          {activeTab === 'notes'    && <NotesView onOpenNoteEditor={setNoteEditorCtx} globalSearchQuery={searchQuery} />}
          {activeTab === 'vault'    && <VaultView />}
          {activeTab === 'links'   && <LinksView />}
          {activeTab === 'reminders' && <RemindersView onNavigateToSource={navigateToReminderSource} tasks={tasks} />}
          {activeTab === 'chat'      && <ChatView />}
          {activeTab === 'activity' && <ActivityLogView setActiveTab={setActiveTab} />}

          {activeTab === 'tasks' && (
            <div className="tasks-tab">
              <TaskList
                tasks={tasks}
                activeTaskId={activeTaskId}
                timerRunning={timerState==='running'}
                onSelect={selectTask}
                onToggle={toggleComplete}
                onDelete={deleteTask}
                onClearCompleted={clearCompleted}
                onAdd={openAddTaskModal}
                onAddTask={addTask}
                onEdit={openEditTask}
                onUpdate={updateTaskData}
                onQuickUpdate={quickUpdateTask}
                syncStatus={syncStatus}
                onSyncNow={handleSyncNow}
                openTaskId={pendingOpenTaskId}
                onOpenTaskIdHandled={clearPendingOpenTaskId}
              />
            </div>
          )}
          </Suspense>
        </motion.div>
        </AnimatePresence>

        {/* PWA Install Banner */}
        {showInstallBanner && (
          <div className="install-banner" style={{
            position: 'fixed', bottom: 20, left: 20, right: 20, zIndex: 999,
            background: 'var(--bg-card)', padding: '16px 20px', borderRadius: 16,
            boxShadow: 'var(--shadow-lg)', display: 'flex', alignItems: 'center', gap: 16,
            border: '1px solid var(--border-strong)'
          }}>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <svg width="24" height="24" viewBox="0 0 192 192" fill="none"><circle cx="96" cy="96" r="50" stroke="#fff" strokeWidth="12"/><circle cx="96" cy="96" r="24" fill="#fff"/></svg>
              </div>
              <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Install Nook for quick access</div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleInstallClick} style={{ background: 'var(--accent)', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 8, fontWeight: 600, cursor: 'pointer' }}>Install</button>
              <button onClick={dismissInstallBanner} style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: 'none', padding: '8px 12px', borderRadius: 8, cursor: 'pointer' }}>×</button>
            </div>
          </div>
        )}
      </div>
      </div>{/* end app-body */}

      {/* ── Cross-tab change banner ── */}
      {/* Detect-and-warn, not a merge: tells the user their data may have
          changed in another tab and lets them choose to reload, rather than
          silently doing anything on their behalf.
          No dismiss-without-reload — verified (two real tabs, Playwright)
          that dismissing left this tab's in-memory state stale, and its next
          save silently overwrote the other tab's write with no further
          warning. A banner you can wave away into a worse state than the one
          it warned about is worse than no banner, so Reload is the only exit. */}
      {crossTabChanged && (
        <div role="status" aria-live="polite" style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 500,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 14,
          padding: '10px 16px', background: 'var(--color-amber, #f59e0b)', color: '#1a1200',
          fontSize: '0.85rem', fontWeight: 600, boxShadow: '0 2px 10px rgba(0,0,0,0.25)',
        }}>
          <span>Your data changed in another tab. Reload to see the latest and avoid overwriting it.</span>
          <button onClick={() => window.location.reload()} style={{
            background: '#1a1200', color: '#fff', border: 'none', borderRadius: 7,
            padding: '5px 14px', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', flexShrink: 0,
          }}>Reload</button>
        </div>
      )}

      {/* ── Toast ── */}
      {toast && <div key={toast.key} role="status" aria-live="polite" aria-atomic="true" className={`app-toast toast-${toast.type}`}>{toast.msg}</div>}

      {/* ── Modals ── */}
      <AnimatePresence>
        {noteEditorCtx && (
          <Suspense fallback={null}>
            <NoteModal
              key={noteEditorCtx.note.id}
              note={noteEditorCtx.note}
              onSave={(savedNote) => noteEditorCtx.onSave(savedNote)}
              onClose={() => setNoteEditorCtx(null)}
              onDelete={(id) => noteEditorCtx.onDelete(id)}
              onColorChange={noteEditorCtx.onColorChange}
            />
          </Suspense>
        )}
        {openModal==='add'       && <AddTaskModal  key="add-task" onAdd={addTask}     onClose={()=>setOpenModal(null)} existingTasks={tasks} />}
        {openModal==='mobile-more' && (
          <MobileMoreModal
            key="mobile-more"
            onClose={() => setOpenModal(null)}
            onSelect={(id) => { 
              if (id === 'chat') {
                setIsAssistantOpen(true);
              } else {
                setActiveTab(id); 
              }
              setOpenModal(null); 
            }}
            tasks={tasks} habits={habits}
            onQueryChange={setSearchQuery}
          />
        )}
        {editingTask             && <AddTaskModal  key="edit-task" onEdit={updateTaskData} onClose={()=>setEditingTask(null)} editTask={editingTask} />}
        {openModal==='shortcuts' && <ShortcutsModal key="shortcuts" onClose={()=>setOpenModal(null)} />}
        {openModal==='weekly-review' && (
          <WeeklyReviewModal
            key="weekly-review"
            trackers={trackers} tasks={tasks} pomodoroLog={pomodoroLog}
            onClose={() => setOpenModal(null)}
            onSave={(reviewData) => {
              let currentReviews = [];
              try { currentReviews = JSON.parse(localStorage.getItem('nook-weekly-reviews') || '[]'); }
              catch { console.warn('[WeeklyReview] nook-weekly-reviews was corrupted, resetting.'); }
              localStorage.setItem('nook-weekly-reviews', JSON.stringify([reviewData, ...currentReviews]));
              showToast('Weekly review saved!', 'success');
              setOpenModal(null);
            }}
          />
        )}
        {showAddTracker && (
          <AddTrackerModal
            key="add-tracker"
            onSave={handleTrackerSave}
            onClose={() => { setShowAddTracker(false); setEditingTracker(null); }}
            editTracker={editingTracker}
            existingTrackers={trackers}
          />
        )}
      </AnimatePresence>
      <AssistantChat isOpen={isAssistantOpen} onClose={() => setIsAssistantOpen(false)} />
    </div>
  );
}

// ─── Lazy-view loading fallback ───────────────────────────────────
function TabFallback() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240, color: 'var(--text-muted)' }}>
      <span className="tab-fallback-spinner" aria-label="Loading" />
    </div>
  );
}

// ─── Mobile More Drawer: nav grid + Search/Avatar (mobile has no
// sidebar to host them — folded in here per the sidebar-only-layout redesign) ──
function MobileMoreModal(props) {
  const { onClose, onSelect, tasks, habits, onQueryChange } = props;
  const tabs = [
    { id: 'notes', label: 'Notes', Icon: NavIcoNotes },
    { id: 'calendar', label: 'Calendar', Icon: NavIcoCalendar },
    { id: 'reminders', label: 'Reminders', Icon: NavIcoBell },
    { id: 'links', label: 'Links', Icon: NavIcoLinks },
    { id: 'countdowns', label: 'Countdowns', Icon: NavIcoHourglass },
    { id: 'timer', label: 'Focus', Icon: NavIcoTimerIcon },
    { id: 'vault', label: 'Saved Logins', Icon: NavIcoVault },
    // { id: 'chat', label: 'AI Assistant', Icon: NavIcoChat }, // Hidden for now per user request
    { id: 'reports', label: 'Reports', Icon: NavIcoBarChart },
    { id: 'activity', label: 'Activity Log', Icon: NavIcoHistory },
    { id: 'settings', label: 'Settings', Icon: NavIcoSettings },
  ];

  const { searchQuery, setSearchQuery, searchResults, searchInputRef } = useNookSearch(tasks, habits);

  // Notes' own list view falls back to this as `globalSearchQuery` — see App.jsx.
  useEffect(() => { onQueryChange?.(searchQuery); }, [searchQuery, onQueryChange]);

  const select = (tab) => { setSearchQuery(''); onSelect(tab); };

  return (
    <div className="mobile-more-overlay" onClick={onClose}>
      <motion.div
        className="mobile-more-drawer"
        onClick={e => e.stopPropagation()}
        initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={{ type: 'spring', damping: 25, stiffness: 200 }}
      >
        <div className="mobile-more-header">
          <h3>More</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="mm-search" role="search" aria-label="Search Nook">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="search-icon"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input
            ref={searchInputRef}
            type="text"
            aria-label="Search Nook"
            placeholder="Search for anything..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
        </div>
        {searchQuery.length >= 2 && (
          <div className="mm-search-results">
            <ResultsList searchQuery={searchQuery} searchResults={searchResults} onSelect={select} />
          </div>
        )}

        <div className="nav-divider" style={{ margin: '4px 14px 10px' }} />

        <div className="mobile-more-grid">
          {tabs.map(t => (
            <button key={t.id} className="mobile-more-item" onClick={() => onSelect(t.id)}>
              <span className="mobile-more-icon"><t.Icon /></span>
              <span className="mobile-more-label">{t.label}</span>
            </button>
          ))}
        </div>
      </motion.div>
    </div>
  );
}

// ─── Today's task breakdown ───────────────────────────────────────
function TodayBreakdown({ tasks }) {
  const today = todayStr();
  const done  = tasks.filter(t=>t.completed && t.completedAt?.startsWith(today));
  const byCat = {};
  for (const t of done) byCat[t.category]=(byCat[t.category]||0)+1;
  const entries = Object.entries(byCat);
  if (!entries.length) return null;
  return (
    <div className="today-breakdown">
      <span className="today-breakdown-lbl">Today's completions</span>
      <div className="today-breakdown-chips">
        {entries.map(([cat,n]) => {
          const m=CAT_META[cat]??{label:cat,color:'#6366f1'};
          return (
            <span key={cat} className="today-cat-chip"
              style={{background:m.color+'22',color:m.color,border:`1px solid ${m.color}44`}}>
              {m.label} {n}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ─── Inline SVG icons ─────────────────────────────────────────────
const S = { fill:'none', stroke:'currentColor', strokeWidth:'1.75', strokeLinecap:'round', strokeLinejoin:'round' };

// App logo — crosshair/focus mark
// Header action icons (16px)

// ─── Sidebar nav icons (18px) ─────────────────────────────────────
// Section 1 — Daily
function NavIcoSun() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="4"/><line x1="12" y1="20" x2="12" y2="22"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="2" y1="12" x2="4" y2="12"/><line x1="20" y1="12" x2="22" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>;
}
function NavIcoRepeat() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>;
}
function NavIcoCheckSquare() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>;
}
function NavIcoTimerIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 16"/><line x1="9" y1="2" x2="15" y2="2"/><line x1="12" y1="2" x2="12" y2="5"/></svg>;
}
function NavIcoBookOpen() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>;
}
// Section 2 — Planning
function NavIcoHourglass() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M5 2h14"/><path d="M5 22h14"/><path d="M5 2c0 6 6 6 6 10s-6 4-6 10"/><path d="M19 2c0 6-6 6-6 10s6 4 6 10"/></svg>;
}
function NavIcoChat() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>;
}
function NavIcoBarChart() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/><line x1="2" y1="20" x2="22" y2="20"/></svg>;
}
function NavIcoCalendar() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>;
}
function NavIcoNotes() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>;
}
function NavIcoHistory() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>;
}
function NavIcoVault() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>;
}
function NavIcoLinks() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>;
}
function NavIcoBell() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>;
}
// Bottom
function NavIcoSettings() {
  return <svg width="18" height="18" viewBox="0 0 24 24" {...S}><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>;
}
