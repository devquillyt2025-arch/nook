import { memo,  useState, useEffect, useRef } from 'react';
import TimeInput from './TimeInput';
import { connectGoogleTasks, disconnectGoogleTasks } from '../utils/googleTasksSync';
import { supabase, isAuthConfigured } from '../utils/authClient';
import { isPushSupported, isCurrentlySubscribed, subscribeToPush, unsubscribeFromPush } from '../utils/pushSubscription';
import { isEmailRemindersEnabled, setEmailRemindersEnabled } from '../utils/notificationPrefs';
import { listReminders } from '../utils/reminders';
import { exportBackup } from '../utils/backup';
import { useSyncApplied } from '../utils/useSyncApplied';
import { useSyncStatus } from '../utils/useSyncStatus';
import { syncNow } from '../utils/sync';
import { connectGoogleDriveBackup, getBackupConfig, isDriveConnected, getDriveConnectionState, setBackupFrequency, getRecentRuns, runDriveBackup } from '../utils/driveBackup';
import Select from './Select';
import { askConfirm } from '../utils/confirmDialog';

const PRESETS = [
  { label: 'Standard',  sub: '25/5/15',  vals: { focusDuration: 25, shortDuration: 5,  longDuration: 15 } },
  { label: 'Short',     sub: '20/3/10',  vals: { focusDuration: 20, shortDuration: 3,  longDuration: 10 } },
  { label: 'Long',      sub: '50/10/20', vals: { focusDuration: 50, shortDuration: 10, longDuration: 20 } },
  { label: 'Deep Work', sub: '90/15/30', vals: { focusDuration: 90, shortDuration: 15, longDuration: 30 } },
];

const EMOJI_AVATARS = ['😎', '🤓', '👩‍💻', '👨‍🚀', '🦄', '👻'];

// When the user last ran a manual export. Hyphen prefix so the existing
// /^nook[-_]/ sweeps (import allowlist, Clear All, cross-tab filter) see it.
const LAST_EXPORT_KEY = 'nook-last-export';

// Build and download a rollback copy of the current data, in exactly the same
// schema-v1 zip shape a manual export produces — so recovering from a regretted
// import is just importing this file back. Uses buildBackup(), which is
// read-only, and writes nothing to Supabase.
//
// KNOWN DEBT (accepted, not a bug): these are written to the user's download
// folder and never cleaned up, so repeated imports leave a pile of
// nook-rollback-before-import-*.zip files behind. The browser gives a page no
// way to delete what it has downloaded; a real fix means keeping the last N in
// IndexedDB instead and offering restore from inside Settings. Deliberately out
// of scope for the batch that added this.
async function downloadRollbackSnapshot() {
  const [{ buildBackup }, JSZipMod] = await Promise.all([
    import('../utils/backup'),
    import('jszip'),
  ]);
  const backup = await buildBackup();
  const zip = new JSZipMod.default();
  zip.file('backup.json', JSON.stringify(backup, null, 2));
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nook-rollback-before-import-${stamp}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Backup inventory ────────────────────────────────────────────────
// Counts read from the same localStorage keys backup.js sweeps, so the panel
// can never advertise more than the archive actually carries.
function countJson(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) || 'null');
    return Array.isArray(v) ? v.length : v ? 1 : 0;
  } catch { return 0; }
}

// Only date-keyed entries are journal content — nook_journal_icons,
// _calview and _calcollapsed share the prefix but are view preferences.
function countJournalEntries() {
  let n = 0;
  for (let i = 0; i < localStorage.length; i++) {
    if (/^nook_journal_\d{4}-\d{2}-\d{2}$/.test(localStorage.key(i) || '')) n++;
  }
  return n;
}

export default memo(function SettingsView({ settings, onSaveSettings, theme, onSetTheme, onClearData, onImportData, syncStatus, onSyncToggle, onDisconnect, onSyncNow, onUpdateProfile, initialProfileName, initialProfileEmail, initialProfileAvatar, gcalConnected, onConnectGCal, onDisconnectGCal }) {
  // Profile state — seed from App.jsx's already-resolved state (same values the header shows)
  const [profileName, setProfileName] = useState(
    () => initialProfileName || localStorage.getItem('nook-profile-name') || 'Productivity User'
  );
  const [profileEmail, setProfileEmail] = useState(
    () => initialProfileEmail || localStorage.getItem('nook-profile-email') || ''
  );
  const [avatar, setAvatar] = useState(
    () => initialProfileAvatar || localStorage.getItem('nook-profile-avatar') || '😎'
  );

  // Keep a stable ref to onUpdateProfile so the save effect doesn't re-fire when the parent re-renders
  const onUpdateProfileRef = useRef(onUpdateProfile);
  useEffect(() => { onUpdateProfileRef.current = onUpdateProfile; });

  // Notifications state
  const [notifMaster, setNotifMaster] = useState(() => localStorage.getItem('nook-notif-master') !== 'false');
  const [notifMorning, setNotifMorning] = useState(() => localStorage.getItem('nook-notif-morning') !== 'false');
  const [morningTime, setMorningTime] = useState(() => localStorage.getItem('nook-notif-morning-time') || '08:00');
  const [notifStreak, setNotifStreak] = useState(() => localStorage.getItem('nook-notif-streak') !== 'false');
  const [notifPomo, setNotifPomo] = useState(() => localStorage.getItem('nook-notif-pomo') !== 'false');

  // Push reminders (Web Push — works even when Nook is closed; distinct
  // from the in-app Notification toggles above, which only fire while a
  // tab is open).
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  useEffect(() => {
    let active = true;
    isCurrentlySubscribed().then(v => { if (active) setPushEnabled(v); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Email reminders — independent channel from push; same reminders,
  // delivered by the same send-task-reminders Edge Function, just via
  // email instead of (or alongside) a device push.
  const [emailEnabled, setEmailEnabledState] = useState(false);
  const [emailBusy, setEmailBusy] = useState(false);
  useEffect(() => {
    let active = true;
    isEmailRemindersEnabled().then(v => { if (active) setEmailEnabledState(v); }).catch(() => {});
    return () => { active = false; };
  }, []);

  // Preferences state
  const [form, setForm] = useState(settings);
  const [weekStart, setWeekStart] = useState(() => localStorage.getItem('nook-week-start') || 'monday');
  const sync = useSyncStatus();
  // Profile / week-start edited on another device: re-read what the sync engine merged into storage.
  useSyncApplied(['profile_name', 'profile_email', 'profile_avatar', 'week_start'], (names) => {
    if (names.includes('profile_name'))   setProfileName(localStorage.getItem('nook-profile-name') || 'Productivity User');
    if (names.includes('profile_email'))  setProfileEmail(localStorage.getItem('nook-profile-email') || '');
    if (names.includes('profile_avatar')) setAvatar(localStorage.getItem('nook-profile-avatar') || '😎');
    if (names.includes('week_start'))     setWeekStart(localStorage.getItem('nook-week-start') || 'monday');
  });
  const [backupBusy, setBackupBusy] = useState(false);
  const [aiApiKey, setAiApiKey] = useState(() => localStorage.getItem('nook_ai_api_key') || '');

  // Origin storage quota (Chrome/Edge/Firefox support the Storage API; Safari
  // and older browsers don't — quotaPct stays null there and the KB-only
  // figure below is all we show, same as before this existed).
  const [quotaPct, setQuotaPct] = useState(null);
  useEffect(() => {
    if (!navigator.storage?.estimate) return;
    navigator.storage.estimate().then(({ usage, quota }) => {
      if (quota > 0) setQuotaPct(Math.round((usage / quota) * 100));
    }).catch(() => {});
  }, []);

  // ── Auto backup to Google Drive ──
  const [driveConfig, setDriveConfig] = useState(null);
  const [driveFreq, setDriveFreq] = useState('off');
  const [driveRuns, setDriveRuns] = useState([]);
  useEffect(() => {
    if (!isAuthConfigured) return;
    let active = true;
    (async () => {
      const cfg = await getBackupConfig();
      if (!active) return;
      setDriveConfig(cfg);
      setDriveFreq(cfg?.frequency || 'off');
      setDriveRuns(await getRecentRuns());
    })().catch(() => {});
    return () => { active = false; };
  }, []);

  const changeDriveFreq = async (freq) => {
    const prev = driveFreq;
    setDriveFreq(freq); // optimistic
    try {
      await setBackupFrequency(freq);
      setDriveConfig(c => ({ ...(c || {}), frequency: freq }));
    } catch (err) {
      setDriveFreq(prev);
      alert(`Couldn't save backup frequency: ${err?.message || 'unknown error'}`);
    }
  };

  // Approximate size of what a backup will upload — mirrors backup.js's key
  // filter (nook- / nook_ keys, minus secrets/transient). bytes ≈ chars for the
  // JSON payload that lands in Drive.
  const backupSizeLabel = () => {
    let bytes = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !(k.startsWith('nook-') || k.startsWith('nook_'))) continue;
      if (['nook_google_tokens', 'nook_pkce_verifier', 'nook_sync_queue', 'nook_deleted_tasks'].includes(k)) continue;
      const low = k.toLowerCase();
      if (low.includes('token') || low.includes('pkce')) continue;
      bytes += (localStorage.getItem(k) || '').length + k.length;
    }
    return bytes >= 1024 * 1024 ? `${(bytes / 1048576).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
  };

  // Sign-in identity for the Connections overview. Distinct from the editable
  // profile email above, which is a local display name and proves nothing about
  // whether cloud features (reminders, sync, backup) can actually work.
  const [accountEmail, setAccountEmail] = useState(null);
  const [accountChecked, setAccountChecked] = useState(!isAuthConfigured);   // don't flash the sign-in form at a signed-in user
  useEffect(() => {
    if (!isAuthConfigured) return;
    let alive = true;
    supabase.auth.getUser()
      .then(({ data }) => { if (alive) { setAccountEmail(data?.user?.email ?? null); setAccountChecked(true); } })
      .catch(() => { if (alive) setAccountChecked(true); });
    // Follow sign-in / sign-out too (e.g. from the sign-in form below, or another tab).
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => { if (alive) { setAccountEmail(s?.user?.email ?? null); setAccountChecked(true); } });
    return () => { alive = false; sub?.subscription?.unsubscribe(); };
  }, []);

  const driveState = getDriveConnectionState(driveConfig);

  // What an export would contain, right now. Local counts are synchronous;
  // the reminder count is a Supabase read (SELECT only) and lands after.
  const [lastExport, setLastExport] = useState(() => localStorage.getItem(LAST_EXPORT_KEY));
  const [inventory, setInventory] = useState(null);
  useEffect(() => {
    setInventory({
      tasks: countJson('nook-tasks'),
      habits: countJson('nook_habits'),
      journal: countJournalEntries(),
      notes: countJson('nook_notes'),
      links: countJson('nook_links'),
      countdowns: countJson('nook_countdowns'),
      vault: countJson('nook_vault'),
      reminders: null,            // pending
    });
    let alive = true;
    listReminders()
      .then(rs => { if (alive) setInventory(inv => inv && { ...inv, reminders: rs.length }); })
      .catch(() => { if (alive) setInventory(inv => inv && { ...inv, reminders: 0 }); });
    return () => { alive = false; };
  }, []);

  const [runBusy, setRunBusy] = useState(false);
  const handleBackupNow = async () => {
    if (runBusy) return;
    setRunBusy(true);
    try {
      const res = await runDriveBackup();
      setDriveConfig(await getBackupConfig());       // refresh "Last backed up"
      setDriveRuns(await getRecentRuns());           // refresh recent list
      const c = res?.counts || {};
      alert(
        `Backed up to Google Drive ✓\n\n` +
        `File: ${res?.file || 'nook-backup.json'}\n` +
        `Size: ${backupSizeLabel()}\n` +
        `${c.local ?? '?'} local data set${c.local === 1 ? '' : 's'} · ${c.reminders ?? 0} reminder${c.reminders === 1 ? '' : 's'}`
      );
    } catch (err) {
      setDriveRuns(await getRecentRuns().catch(() => driveRuns)); // surface the failure row
      alert(`Backup failed: ${err?.message || 'unknown error'}`);
    } finally {
      setRunBusy(false);
    }
  };

  // Save effects — try/catch matches the app-wide persist() convention: a
  // QuotaExceededError here would otherwise throw during React's commit phase
  // and propagate to the nearest error boundary, which used to mean the whole
  // app (there was none above Settings), not just this toggle.
  useEffect(() => {
    try {
      localStorage.setItem('nook-profile-name', profileName);
      localStorage.setItem('nook-profile-email', profileEmail);
      localStorage.setItem('nook-profile-avatar', avatar);
    } catch {}
    if (onUpdateProfileRef.current) onUpdateProfileRef.current(profileName, profileEmail, avatar);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileName, profileEmail, avatar]);
  useEffect(() => { try { localStorage.setItem('nook-notif-master', notifMaster); } catch {} }, [notifMaster]);
  useEffect(() => { try { localStorage.setItem('nook-notif-morning', notifMorning); } catch {} }, [notifMorning]);
  useEffect(() => { try { localStorage.setItem('nook-notif-morning-time', morningTime); } catch {} }, [morningTime]);
  useEffect(() => { try { localStorage.setItem('nook-notif-streak', notifStreak); } catch {} }, [notifStreak]);
  useEffect(() => { try { localStorage.setItem('nook-notif-pomo', notifPomo); } catch {} }, [notifPomo]);
  useEffect(() => { try { localStorage.setItem('nook-week-start', weekStart); } catch {} }, [weekStart]);
  useEffect(() => { try { localStorage.setItem('nook_ai_api_key', aiApiKey); } catch {} }, [aiApiKey]);

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const applyPreset = preset => setForm(f => ({ ...f, ...preset.vals }));

  const submitSettings = () => {
    onSaveSettings({
      ...form,
      focusDuration:  Math.max(1, Math.min(480, Number(form.focusDuration)  || 25)),
      shortDuration:  Math.max(1, Math.min(60,  Number(form.shortDuration)  || 5)),
      longDuration:   Math.max(1, Math.min(120, Number(form.longDuration)   || 15)),
      customDuration: Math.max(1, Math.min(480, Number(form.customDuration) || 25)),
    });
    alert('Settings saved!');
  };

  // Full unified backup — all localStorage content + the user's Supabase
  // reminders/prefs, zipped and downloaded. Read-only. (Restore is a separate,
  // still-in-review feature.)
  const handleFullBackup = async () => {
    if (backupBusy) return;
    setBackupBusy(true);
    try {
      const counts = await exportBackup();
      // Record when an export last happened — nothing tracked this before, so
      // "have I backed up recently?" was unanswerable. Written here in the
      // caller rather than inside exportBackup(), which stays read-only.
      const stamp = new Date().toISOString();
      try { localStorage.setItem(LAST_EXPORT_KEY, stamp); } catch {}
      setLastExport(stamp);
      // "Download started", not "downloaded ✓" — a browser can silently block,
      // cancel, or redirect a triggered download with no JS-visible signal
      // either way, so we can only confirm the file was built, not saved.
      // The Saved Logins tab is gone, but a browser that used it still holds
      // those passwords in plaintext and the backup sweeps every nook_ key — so
      // say so, but only when it is actually true.
      const leftoverLogins = countJson('nook_vault');
      alert(
        `Backup download started\n\n` +
        `• ${counts.local} local data set${counts.local === 1 ? '' : 's'} (tasks, notes, journal, etc.)\n` +
        `• ${counts.reminders} reminder${counts.reminders === 1 ? '' : 's'}\n` +
        `• ${counts.notification_prefs} preference row${counts.notification_prefs === 1 ? '' : 's'}` +
        (leftoverLogins > 0 ? `\n\nIncludes ${leftoverLogins} old saved login${leftoverLogins === 1 ? '' : 's'} (passwords in plaintext) — keep this .zip somewhere safe.` : '')
      );
    } catch (err) {
      console.error('[Backup] export failed:', err);
      alert(`Backup failed: ${err?.message || 'unknown error'}`);
    } finally {
      setBackupBusy(false);
    }
  };

  const handleImport = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const doImport = async () => {
      try {
        let data;
        if (file.name.endsWith('.zip')) {
          const JSZip = (await import('jszip')).default;
          const zip = await JSZip.loadAsync(file);
          const jsonFile = zip.file('backup.json');
          if (!jsonFile) throw new Error('backup.json not found inside ZIP.');
          data = JSON.parse(await jsonFile.async('string'));
        } else {
          data = JSON.parse(await file.text());
        }
        // Stash a rollback of the CURRENT state before handing over to the
        // importer, which overwrites localStorage behind a single confirm and
        // then reloads. Downloaded rather than held in memory precisely because
        // of that reload — anything in memory or in a React ref is gone, and a
        // base64 zip in localStorage would compete for the quota we're about to
        // overwrite. Silent by design: no extra prompt, it's insurance.
        //
        // If the rollback can't be produced we abort instead of continuing —
        // losing data because the safety net failed is the worse outcome.
        try {
          await downloadRollbackSnapshot();
        } catch (rollbackErr) {
          console.error('[Import] rollback snapshot failed:', rollbackErr);
          alert(
            `Import cancelled — couldn't save a rollback copy of your current data first.\n\n` +
            `${rollbackErr?.message || 'unknown error'}\n\n` +
            `Nothing was changed. Export manually, then import again.`
          );
          return;
        }

        // Awaited: the importer now restores reminders to Supabase before it
        // reloads, so a fire-and-forget call here would drop the rejection.
        await onImportData(data);
      } catch (err) {
        alert(`Import failed: ${err.message}`);
      }
    };
    doImport();
  };

  const handleAvatarUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      setAvatar(event.target.result);
    };
    reader.readAsDataURL(file);
  };

  const requestNotificationPermission = async () => {
    if (!('Notification' in window)) {
      alert("This browser does not support desktop notification");
      return;
    }
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        alert('Enable notifications in browser settings to get reminders');
        setNotifMaster(false);
      } else {
        setNotifMaster(true);
      }
    } catch {
      setNotifMaster(false);
    }
  };

  const handleMasterNotifToggle = () => {
    if (!notifMaster) {
      requestNotificationPermission();
    } else {
      setNotifMaster(false);
    }
  };

  const handlePushRemindersToggle = async () => {
    if (pushBusy) return;
    setPushBusy(true);
    try {
      if (!pushEnabled) {
        await subscribeToPush();
        setPushEnabled(true);
      } else {
        await unsubscribeFromPush();
        setPushEnabled(false);
      }
    } catch (err) {
      alert(err.message || 'Could not update reminder settings.');
    } finally {
      setPushBusy(false);
    }
  };

  const handleEmailRemindersToggle = async () => {
    if (emailBusy) return;
    setEmailBusy(true);
    try {
      const next = !emailEnabled;
      await setEmailRemindersEnabled(next);
      setEmailEnabledState(next);
    } catch (err) {
      alert(err.message || 'Could not update reminder settings.');
    } finally {
      setEmailBusy(false);
    }
  };

  const handleLogout = async () => {
    if (!window.confirm('Log out of Nook?\n\nYou\'ll be signed out (and any Google connections disconnected). Your local data stays saved on this device.')) return;
    try { disconnectGoogleTasks(); } catch {}
    try { if (gcalConnected) onDisconnectGCal(); } catch {}
    localStorage.setItem('nook_sync_enabled', 'false');
    if (isAuthConfigured) {
      // 'global' also revokes the session on the server; if that request fails the device must
      // still be signed out, so fall back to dropping the local session.
      try {
        const { error } = await supabase.auth.signOut();
        if (error) await supabase.auth.signOut({ scope: 'local' });
      } catch { try { await supabase.auth.signOut({ scope: 'local' }); } catch {} }
    }
    window.location.reload();                  // AuthGate then finds no session and shows the login page
  };

  const calculateStorage = () => {
    let total = 0;
    for (const key in localStorage) {
      if (localStorage.hasOwnProperty(key)) {
        total += ((localStorage[key].length + key.length) * 2);
      }
    }
    return (total / 1024).toFixed(2);
  };

  return (
    <div className="settings-view">

      <div className="settings-grid">

      {/* ── Account — first card on purpose: who is signed in, and Sign out ──
          Sign-in itself is the login page (AuthGate), which signing out returns to. */}
      {isAuthConfigured && (
        <section className="settings-card" aria-label="Account">
          <h3 className="settings-card-title">Account</h3>
          {!accountChecked ? (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: 0 }}>Checking…</p>
          ) : accountEmail ? (
            <>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase' }}>Signed in as</div>
                  <div style={{ color: 'var(--text-primary)', fontSize: '0.92rem', fontWeight: 600, overflowWrap: 'anywhere' }}>{accountEmail}</div>
                </div>
                <button type="button" onClick={handleLogout}
                  style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid rgba(248,113,113,0.5)', background: 'var(--color-red-bg)', color: 'var(--color-red)', fontWeight: 700, fontSize: '0.84rem', cursor: 'pointer' }}>
                  Sign out
                </button>
              </div>
              <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.5, margin: '10px 0 0' }}>
                Your data syncs across every device signed in to this account. Signing out keeps your data on this device.
              </p>
            </>
          ) : (
            <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', margin: 0 }}>Not signed in.</p>
          )}
        </section>
      )}

      {/* Profile Section */}
      <section className="settings-card">
        <h3 className="settings-card-title">Profile</h3>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="avatar-picker" style={{ textAlign: 'center', flexShrink: 0 }}>
            <div style={{ width: 62, height: 62, borderRadius: '50%', background: 'var(--surface-nested)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '2.1rem', overflow: 'hidden', border: '2px solid var(--accent)', boxShadow: '0 4px 12px var(--accent-glow)' }}>
              {avatar.startsWith('data:image') ? <img src={avatar} alt="avatar" style={{width: '100%', height: '100%', objectFit: 'cover'}} /> : avatar}
            </div>
            <label className="upload-link" style={{ display: 'block', marginTop: 7, fontSize: '0.75rem', fontWeight: 600, color: 'var(--accent-light)', cursor: 'pointer' }}>
              Upload
              <input type="file" accept="image/*" style={{ display: 'none' }} onChange={handleAvatarUpload} />
            </label>
          </div>
          <div style={{ flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <label className="set-field-lbl">Name</label>
              <div style={{ position: 'relative' }}>
                <input type="text" maxLength={20} className="form-inp profile-input" style={{ width: '100%', boxSizing: 'border-box', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', padding: '9px 44px 9px 12px', fontSize: '0.88rem', borderRadius: 10 }} value={profileName} onChange={e => setProfileName(e.target.value.slice(0, 20))} placeholder="What should we call you?" />
                <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.7rem', color: profileName.length >= 20 ? 'var(--color-red)' : 'var(--text-muted)', pointerEvents: 'none', fontWeight: 600 }}>{profileName.length}/20</div>
              </div>
            </div>
            <div>
              <label className="set-field-lbl">Email</label>
              <div style={{ position: 'relative' }}>
                <input type="email" maxLength={50} className="form-inp profile-input" style={{ width: '100%', boxSizing: 'border-box', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', padding: '9px 44px 9px 12px', fontSize: '0.88rem', borderRadius: 10 }} value={profileEmail} onChange={e => setProfileEmail(e.target.value.slice(0, 50))} placeholder="yourname@example.com" />
                <div style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: '0.7rem', color: profileEmail.length >= 50 ? 'var(--color-red)' : 'var(--text-muted)', pointerEvents: 'none', fontWeight: 600 }}>{profileEmail.length}/50</div>
              </div>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <label className="set-field-lbl" style={{ marginBottom: 10 }}>Choose Emoji</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {EMOJI_AVATARS.map(em => (
              <button key={em} onClick={() => setAvatar(em)} style={{ background: avatar === em ? 'var(--accent-glow)' : 'var(--surface-nested)', border: avatar === em ? '2px solid var(--accent)' : '2px solid transparent', borderRadius: 12, width: 42, height: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '1.3rem', cursor: 'pointer', transition: 'all 0.18s var(--ease-spring)', boxShadow: avatar === em ? '0 4px 12px var(--accent-glow)' : 'none' }}>
                {em}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Notifications Section */}
      {/* ── Connections overview ──
          Every integration's live state in one place. Each row is derived from
          the same source the section below it uses, so this can't drift out of
          step with the controls themselves. */}
      <section className="settings-card">
        <h3 className="settings-card-title">Connections</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: 10 }}>
          Where Nook is currently connected. Anything amber needs attention.
        </p>

        <ConnRow
          label="Account"
          tone={!isAuthConfigured || !accountChecked ? 'off' : accountEmail ? 'ok' : 'warn'}
          detail={!isAuthConfigured
            ? 'Local only — no cloud features'
            : accountEmail
              ? <span style={{ overflowWrap: 'anywhere' }}>{accountEmail}</span>
              : (accountChecked ? 'Signed out' : 'Checking…')}
        />
        {isAuthConfigured && (
          <ConnRow
            label="Cross-device sync"
            tone={!sync.active ? 'off' : sync.state === 'error' || (sync.pending > 0 && sync.state !== 'syncing') ? 'warn' : 'ok'}
            detail={
              <>
                {!sync.active ? 'Waiting for sign-in'
                  : sync.state === 'syncing' ? 'Syncing…'
                  : sync.state === 'error' ? `Couldn’t reach the server — ${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting`
                  : sync.pending > 0 ? `${sync.pending} change${sync.pending === 1 ? '' : 's'} waiting to upload`
                  : sync.lastSyncAt ? `Up to date · ${new Date(sync.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                  : 'Connected'}
                {sync.active && sync.state !== 'syncing' && (
                  <button type="button" onClick={() => syncNow()}
                    style={{ marginLeft: 10, background: 'none', border: 'none', cursor: 'pointer', color: 'var(--accent)', fontSize: '0.78rem', fontWeight: 600, padding: 0 }}>
                    Sync now
                  </button>
                )}
              </>
            }
          />
        )}
        <ConnRow
          label="Google Tasks"
          tone={syncStatus === 'Not connected' ? 'off' : 'ok'}
          detail={syncStatus === 'Not connected' ? 'Not connected' : syncStatus}
        />
        <ConnRow
          label="Google Calendar"
          tone={gcalConnected ? 'ok' : 'off'}
          detail={gcalConnected ? 'Connected' : 'Not connected'}
        />
        <ConnRow
          label="Google Drive backup"
          tone={driveState === 'connected' ? 'ok' : driveState === 'needs_reconnect' ? 'warn' : 'off'}
          detail={
            driveState === 'needs_reconnect' ? 'Access expired — reconnect'
            : driveState === 'not_connected' ? 'Not connected'
            : driveConfig?.last_backup_at
              ? `Last backup ${new Date(driveConfig.last_backup_at).toLocaleDateString()}`
              : 'Connected — no backup yet'
          }
        />
        <ConnRow
          label="Push reminders"
          tone={!isPushSupported() ? 'off' : pushEnabled ? 'ok' : 'off'}
          detail={!isPushSupported() ? 'Not supported here' : pushEnabled ? 'On, this device' : 'Off'}
        />
        <ConnRow
          label="Email reminders"
          tone={emailEnabled ? 'ok' : 'off'}
          detail={emailEnabled ? 'On' : 'Off'}
        />
      </section>

      <section className="settings-card">
        <h3 className="settings-card-title">Notifications</h3>

        <label className="set-row master-toggle" onClick={handleMasterNotifToggle} style={{ background: 'var(--accent-glow)', borderColor: 'var(--border-accent)' }}>
          <div>
            <div className="set-row-lbl">Enable Notifications</div>
            <div className="set-row-sub">Master switch for all push notifications</div>
          </div>
          <div className="toggle-track" data-on={notifMaster ? 'true' : 'false'} style={{ flexShrink: 0 }}>
            <div className="toggle-thumb" />
          </div>
        </label>

        <div style={{ opacity: notifMaster ? 1 : 0.5, pointerEvents: notifMaster ? 'auto' : 'none', display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          <div className="set-row" style={{ cursor: 'default' }}>
            <div>
              <div className="set-row-lbl">Morning Briefing</div>
              <div className="set-row-sub">Daily summary of pending trackers</div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginLeft: 'auto' }}>
              <TimeInput className="form-inp" value={morningTime} onChange={e => setMorningTime(e.target.value)} style={{ padding: '6px 10px', borderRadius: 8, fontSize: '0.8rem', fontWeight: 600, background: 'var(--bg-surface)', width: 118 }} />
              <div className="toggle-track" onClick={() => setNotifMorning(!notifMorning)} data-on={notifMorning ? 'true' : 'false'} style={{ cursor: 'pointer', flexShrink: 0 }}><div className="toggle-thumb" /></div>
            </div>
          </div>

          <label className="set-row" onClick={() => setNotifStreak(!notifStreak)}>
            <div>
              <div className="set-row-lbl">Streak at-risk alerts (8 PM)</div>
              <div className="set-row-sub">Alert if you're about to lose a 3+ day streak</div>
            </div>
            <div className="toggle-track" data-on={notifStreak ? 'true' : 'false'} style={{ flexShrink: 0 }}><div className="toggle-thumb" /></div>
          </label>

          <label className="set-row" onClick={() => setNotifPomo(!notifPomo)}>
            <div>
              <div className="set-row-lbl">Pomodoro timer alerts</div>
              <div className="set-row-sub">Notify when focus/break sessions end</div>
            </div>
            <div className="toggle-track" data-on={notifPomo ? 'true' : 'false'} style={{ flexShrink: 0 }}><div className="toggle-thumb" /></div>
          </label>
        </div>

        <div style={{ height: 1, background: 'var(--border)', margin: '14px 0' }} />

        {isPushSupported() ? (
          <label className="set-row" onClick={handlePushRemindersToggle} style={{ opacity: pushBusy ? 0.6 : 1, pointerEvents: pushBusy ? 'none' : 'auto' }}>
            <div>
              <div className="set-row-lbl">Push reminders</div>
              <div className="set-row-sub">Task &amp; event reminders — delivered even when Nook is closed</div>
            </div>
            <div className="toggle-track" data-on={pushEnabled ? 'true' : 'false'} style={{ flexShrink: 0 }}><div className="toggle-thumb" /></div>
          </label>
        ) : (
          <div className="set-row" style={{ cursor: 'default', opacity: 0.6 }}>
            <div>
              <div className="set-row-lbl">Push reminders</div>
              <div className="set-row-sub">Not supported in this browser</div>
            </div>
          </div>
        )}

        <label className="set-row" onClick={handleEmailRemindersToggle} style={{ opacity: emailBusy ? 0.6 : 1, pointerEvents: emailBusy ? 'none' : 'auto', marginTop: 8 }}>
          <div>
            <div className="set-row-lbl">Email reminders</div>
            <div className="set-row-sub">Sent to your account's sign-in email — independent of push, works on any device</div>
          </div>
          <div className="toggle-track" data-on={emailEnabled ? 'true' : 'false'} style={{ flexShrink: 0 }}><div className="toggle-thumb" /></div>
        </label>
      </section>

      {/* Google Tasks Sync Section */}
      <section className="settings-card">
        <h3 className="settings-card-title">Google Tasks Sync</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: 14 }}>
          Sync tasks with Google Tasks. Works on this device only (state lives in localStorage).
        </p>

        {syncStatus === 'Not connected' ? (
          <button
            type="button"
            className="primary-btn"
            style={{ background: '#4285F4', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 11, fontWeight: 600, fontSize: '0.86rem', border: 'none', cursor: 'pointer', boxShadow: '0 4px 12px rgba(66,133,244,0.25)' }}
            onClick={connectGoogleTasks}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#fff"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#fff"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#fff"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#fff"/>
            </svg>
            Connect Google Tasks
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <style>{`@keyframes customSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
            <label className="set-row" onClick={() => onSyncToggle(localStorage.getItem('nook_sync_enabled') !== 'true')}>
              <div>
                <div className="set-row-lbl">Sync tasks with Google Tasks</div>
                <div className="set-row-sub" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {syncStatus === 'Syncing...' && (
                    <svg style={{ animation: 'customSpin 1s linear infinite', width: 12, height: 12, color: 'var(--accent)' }} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" strokeOpacity="0.25"></circle>
                      <path fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                  )}
                  <span>Status: {syncStatus}</span>
                </div>
              </div>
              <div className="toggle-track" data-on={localStorage.getItem('nook_sync_enabled') === 'true' ? 'true' : 'false'} style={{ flexShrink: 0 }}><div className="toggle-thumb" /></div>
            </label>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="primary-btn"
                style={{ background: 'var(--accent)', color: '#fff', display: 'inline-flex', alignItems: 'center', gap: 8, padding: '9px 18px', borderRadius: 10, fontWeight: 600, fontSize: '0.84rem', border: 'none', cursor: 'pointer' }}
                disabled={syncStatus === 'Syncing...'}
                onClick={onSyncNow}
              >
                {syncStatus === 'Syncing...' ? 'Syncing...' : 'Sync Now'}
              </button>
              <button
                type="button"
                className="secondary-btn"
                style={{ color: 'var(--color-red)', border: '1px solid #ef4444', background: 'rgba(239,68,68,0.06)', padding: '9px 18px', borderRadius: 10, fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer' }}
                onClick={() => { disconnectGoogleTasks(); onDisconnect(); }}
              >
                Disconnect
              </button>
            </div>
          </div>
        )}
      </section>

      {/* Google Calendar Sync Section */}
      <section className="settings-card">
        <h3 className="settings-card-title">Google Calendar Sync</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: 14 }}>
          Connect to see events on the Nook calendar. Manage them from the <strong style={{ color: 'var(--text-primary)' }}>Calendar</strong> tab.
        </p>

        {!gcalConnected ? (
          <button
            type="button"
            className="primary-btn"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 11, fontWeight: 600, fontSize: '0.86rem', border: 'none', cursor: 'pointer', background: '#4285F4', color: '#fff', boxShadow: '0 4px 12px rgba(66,133,244,0.25)' }}
            onClick={onConnectGCal}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <rect x="3" y="4" width="18" height="17" rx="2" stroke="#fff" strokeWidth="1.5"/>
              <path d="M16 2v4M8 2v4M3 9h18" stroke="#fff" strokeWidth="1.5" strokeLinecap="round"/>
              <text x="12" y="18" textAnchor="middle" fontSize="8" fontWeight="700" fill="#fff">G</text>
            </svg>
            Connect Google Calendar
          </button>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="set-row" style={{ cursor: 'default', background: 'rgba(66,133,244,0.08)', borderColor: 'rgba(66,133,244,0.24)', justifyContent: 'flex-start', gap: 11 }}>
              <div style={{ width: 9, height: 9, borderRadius: '50%', background: 'var(--color-green)', boxShadow: '0 0 6px rgba(34,197,94,0.5)', flexShrink: 0 }} />
              <div>
                <div className="set-row-lbl">Google Calendar connected</div>
                <div className="set-row-sub">Events sync when you open the Calendar tab.</div>
              </div>
            </div>
            <button
              type="button"
              className="secondary-btn"
              style={{ alignSelf: 'flex-start', color: 'var(--color-red)', border: '1px solid #ef4444', background: 'rgba(239,68,68,0.06)', padding: '9px 18px', borderRadius: 10, fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer' }}
              onClick={() => {
                if (window.confirm('Disconnect Google Calendar?\n\nThis will hide all Google Calendar events from Nook. You can reconnect at any time.')) {
                  onDisconnectGCal();
                }
              }}
            >
              Disconnect
            </button>
          </div>
        )}
      </section>

      {/* AI Assistant Integration */}
      <section className="settings-card">
        <h3 className="settings-card-title">AI Assistant Integration</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: 14 }}>
          Connect your free Google Gemini API key to chat with your local data. Your data never leaves your browser except when sending questions to the AI.
        </p>
        <div className="form-grp">
          <label className="set-field-lbl">Gemini API Key</label>
          <input 
            type="password" 
            className="form-inp" 
            style={{ width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10, boxSizing: 'border-box' }} 
            value={aiApiKey} 
            onChange={e => setAiApiKey(e.target.value)} 
            placeholder="AIzaSy..." 
          />
        </div>
      </section>

      {/* App Preferences */}
      <section className="settings-card">
        <h3 className="settings-card-title">App Preferences</h3>

        <div style={{ display: 'flex', gap: 14, marginBottom: 18, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="set-field-lbl">Theme</label>
            <Select
              className="form-inp"
              style={{ width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10 }}
              value={theme}
              onChange={e => onSetTheme(e.target.value)}
              options={[
                { value: 'dark', label: 'Dark Mode' },
                { value: 'light', label: 'Light Mode' },
              ]}
            />
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label className="set-field-lbl">Week starts on</label>
            <Select
              className="form-inp"
              style={{ width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10 }}
              value={weekStart}
              onChange={e => setWeekStart(e.target.value)}
              options={[
                { value: 'monday', label: 'Monday' },
                { value: 'sunday', label: 'Sunday' },
              ]}
            />
          </div>
        </div>

        <div className="form-grp" style={{ marginBottom: 18 }}>
          <label className="set-field-lbl">Timer Presets</label>
          <div className="preset-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
            {PRESETS.map(p => (
              <button key={p.label} type="button" className="preset-btn" onClick={() => applyPreset(p)} style={{ padding: '10px 12px', borderRadius: 11, border: '1px solid var(--border)', background: 'var(--surface-nested)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, cursor: 'pointer', transition: 'all 0.18s var(--ease-spring)' }}>
                <span style={{ fontWeight: 700, fontSize: '0.86rem', color: 'var(--text-primary)' }}>{p.label}</span>
                <small style={{ color: 'var(--accent-light)', fontWeight: 600, fontSize: '0.72rem' }}>{p.sub}</small>
              </button>
            ))}
          </div>
        </div>

        <div className="form-grp" style={{ marginBottom: 18 }}>
          <label className="set-field-lbl">Timer Durations (minutes)</label>
          <div className="form-row" style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <div className="form-grp">
              <label className="sub-label" style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginBottom: 5, display: 'block', fontWeight: 600 }}>Focus</label>
              <input type="number" className="form-inp" style={{ width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10, boxSizing: 'border-box' }} value={form.focusDuration} onChange={e => set('focusDuration', e.target.value)} min="1" max="480" />
            </div>
            <div className="form-grp">
              <label className="sub-label" style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginBottom: 5, display: 'block', fontWeight: 600 }}>Short</label>
              <input type="number" className="form-inp" style={{ width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10, boxSizing: 'border-box' }} value={form.shortDuration} onChange={e => set('shortDuration', e.target.value)} min="1" max="60" />
            </div>
            <div className="form-grp">
              <label className="sub-label" style={{ fontSize: '0.74rem', color: 'var(--text-secondary)', marginBottom: 5, display: 'block', fontWeight: 600 }}>Long</label>
              <input type="number" className="form-inp" style={{ width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10, boxSizing: 'border-box' }} value={form.longDuration} onChange={e => set('longDuration', e.target.value)} min="1" max="120" />
            </div>
          </div>
        </div>

        <button className="primary-btn" style={{ padding: '10px 20px', borderRadius: 11, fontWeight: 700, fontSize: '0.86rem', background: 'var(--accent)', color: '#fff', border: 'none', cursor: 'pointer' }} onClick={submitSettings}>Save Timer Preferences</button>
      </section>

      {/* Data Management */}
      <section className="settings-card">
        <h3 className="settings-card-title">Data Management</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: 14 }}>
          Your content is stored locally in your browser ({calculateStorage()} KB used
          {quotaPct !== null && <span style={{ color: quotaPct >= 80 ? 'var(--color-red)' : 'inherit', fontWeight: quotaPct >= 80 ? 700 : 400 }}> — {quotaPct}% of your browser's storage limit for this site</span>}).
          A full backup also bundles your reminders and notification preferences.
          {inventory?.vault > 0 && ` It also still contains ${inventory.vault} old saved login${inventory.vault === 1 ? '' : 's'} (passwords in plaintext) from the removed Saved Logins tab — store the file somewhere you'd store a password export.`}
        </p>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.8rem', lineHeight: 1.5, marginBottom: 14 }}>
          <strong style={{ color: 'var(--text-primary)' }}>Clear Local Data</strong> only erases this
          browser's copy. Everything synced to your account — tasks, habits, notes, journal and
          the rest — stays in the cloud and comes back on the next load, and reminders are kept.
          Importing replaces this browser's data when you're signed out; when you're signed in it
          is merged with your account instead, so nothing on your other devices is deleted. A
          rollback copy of your current data is downloaded automatically first.
        </p>
        {quotaPct !== null && quotaPct >= 80 && (
          <p style={{ color: 'var(--color-red)', fontSize: '0.78rem', lineHeight: 1.5, marginTop: -6, marginBottom: 14 }}>
            You're close to this browser's storage limit for Nook. Export a backup soon —
            writes can start silently failing once the limit is reached.
          </p>
        )}

        {/* What's included — live counts, so the export's scope is visible
            before you rely on it rather than only in the post-hoc alert. */}
        {inventory && (
          <div style={{ marginBottom: 14, padding: '11px 13px', borderRadius: 10, background: 'var(--surface-nested)', border: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
              <span style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', fontWeight: 700 }}>
                What's included
              </span>
              <span style={{ fontSize: '0.75rem', color: lastExport ? 'var(--text-secondary)' : 'var(--color-amber, #f59e0b)', fontWeight: lastExport ? 500 : 700 }}>
                {lastExport
                  ? `Last exported ${new Date(lastExport).toLocaleString()}`
                  : 'Never exported'}
              </span>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px' }}>
              {[
                ['Tasks', inventory.tasks],
                ['Habits', inventory.habits],
                ['Journal entries', inventory.journal],
                ['Notes', inventory.notes],
                ['Links', inventory.links],
                ['Countdowns', inventory.countdowns],
                ...(inventory.vault > 0 ? [['Old saved logins (tab removed)', inventory.vault]] : []),
                ['Reminders', inventory.reminders],
              ].map(([label, n]) => (
                <span key={label} style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {label}{' '}
                  <span style={{ color: 'var(--text-primary)', fontWeight: 700 }}>
                    {n === null ? '…' : n}
                  </span>
                </span>
              ))}
            </div>
            {inventory.vault > 0 && (
              <div style={{ marginTop: 10 }}>
                <button type="button"
                  style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--color-red)', fontSize: '0.78rem', fontWeight: 700 }}
                  onClick={async () => {
                    if (!(await askConfirm({
                      title: `Delete ${inventory.vault} old saved login${inventory.vault === 1 ? '' : 's'}?`,
                      message: `The usernames and passwords will be permanently deleted from this browser.\n\nThe Saved Logins tab no longer exists, so this is the only way to remove them other than Clear Local Data. This cannot be undone.`,
                    }))) return;
                    try { localStorage.removeItem('nook_vault'); } catch {}
                    setInventory(inv => inv && { ...inv, vault: 0 });
                  }}>
                  Delete old saved logins
                </button>
              </div>
            )}
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="secondary-btn" style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--surface-nested)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.84rem', cursor: backupBusy ? 'default' : 'pointer', opacity: backupBusy ? 0.65 : 1, display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={handleFullBackup} disabled={backupBusy}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            {backupBusy ? 'Preparing…' : 'Export My Data (.zip)'}
          </button>

          <label className="secondary-btn" style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-nested)', color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer', margin: 0, display: 'inline-flex', alignItems: 'center', gap: 7 }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Import
            <input type="file" accept=".json,.zip" style={{ display: 'none' }} onChange={handleImport} />
          </label>

          <button className="secondary-btn" style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid #ef4444', background: 'rgba(239,68,68,0.06)', color: 'var(--color-red)', fontWeight: 600, fontSize: '0.84rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={onClearData}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
            Clear Local Data
          </button>
        </div>

        {/* ── Auto Backup to Google Drive ── */}
        {isAuthConfigured && (
          <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.9rem', color: 'var(--text-primary)' }}>Auto Backup to Google Drive</div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', marginTop: 3 }}>
                  Backs up automatically in the background while Nook is open · about <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{backupSizeLabel()}</span> per backup.
                </div>
              </div>
              <div style={{ width: 150, flexShrink: 0 }}>
                <Select
                  value={driveFreq}
                  onChange={e => changeDriveFreq(e.target.value)}
                  options={[
                    { value: 'off',    label: 'Off' },
                    { value: 'daily',  label: 'Daily' },
                    { value: 'weekly', label: 'Weekly' },
                  ]}
                  style={{ background: 'var(--surface-nested)', border: '1px solid var(--border)', borderRadius: 10, height: 38, padding: '0 12px', fontSize: '0.84rem' }}
                />
              </div>
            </div>

            {/* Connect prompt — shown when Drive was never connected AND when a
                stored token has been revoked. The second case is the important
                one: it used to render as a healthy connection with this button
                hidden, leaving no way to re-consent. */}
            {driveState !== 'connected' && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <button className="secondary-btn" style={{ padding: '9px 16px', borderRadius: 10, border: `1px solid ${driveState === 'needs_reconnect' ? 'var(--color-amber, #f59e0b)' : 'var(--accent)'}`, background: 'var(--surface-nested)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 7 }} onClick={connectGoogleDriveBackup}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
                  {driveState === 'needs_reconnect' ? 'Reconnect Google Drive' : 'Connect Google Drive'}
                </button>
                <span style={{ fontSize: '0.76rem', color: driveState === 'needs_reconnect' ? 'var(--color-amber, #f59e0b)' : 'var(--text-secondary)', fontWeight: driveState === 'needs_reconnect' ? 600 : 400 }}>
                  {driveState === 'needs_reconnect'
                    ? 'Google revoked access — backups are failing until you reconnect.'
                    : 'Needed once to allow background uploads to a private “Nook Backups” folder.'}
                </span>
              </div>
            )}

            {/* Last-backup status + manual trigger */}
            {isDriveConnected(driveConfig) && (
              <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
                  {driveConfig?.last_backup_at
                    ? <>Last backed up: <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{new Date(driveConfig.last_backup_at).toLocaleString()}</span>
                        {driveRuns[0]?.counts?.local != null && <> · {driveRuns[0].counts.local} data sets, {driveRuns[0].counts.reminders ?? 0} reminders ({backupSizeLabel()})</>}
                        {driveConfig.last_status === 'error' && (
                          <span style={{ color: driveState === 'needs_reconnect' ? 'var(--color-amber, #f59e0b)' : 'var(--color-red)' }}>
                            {driveState === 'needs_reconnect' ? ' · access expired' : ' · last run failed'}
                          </span>
                        )}</>
                    : <>Connected — no backup has run yet{driveFreq === 'off' ? ' (choose Daily or Weekly to enable).' : '. It’ll run on next load, or click “Back up now”.'}</>}
                </div>
                <button className="secondary-btn" style={{ padding: '8px 14px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--surface-nested)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.8rem', cursor: runBusy ? 'default' : 'pointer', opacity: runBusy ? 0.65 : 1, flexShrink: 0, whiteSpace: 'nowrap' }} onClick={handleBackupNow} disabled={runBusy}>
                  {runBusy ? 'Backing up…' : 'Back up now'}
                </button>
              </div>
            )}

            {/* Recent runs */}
            {driveRuns.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-muted)', marginBottom: 6, fontWeight: 700 }}>Recent backups</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                  {driveRuns.map((r, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.76rem' }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: r.status === 'success' ? 'var(--color-green)' : 'var(--color-red)' }} />
                      <span style={{ color: 'var(--text-secondary)' }}>{new Date(r.ran_at).toLocaleString()}</span>
                      <span style={{ color: r.status === 'success' ? 'var(--text-primary)' : 'var(--color-red)', fontWeight: 600 }}>
                        {r.status === 'success' ? (r.file_name || 'backed up') : `failed: ${r.error || 'error'}`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* About */}
      <section className="settings-card" style={{ textAlign: 'center', padding: '22px 20px', background: 'transparent', boxShadow: 'none' }}>
        <div style={{ fontSize: '1.8rem', marginBottom: 8 }}>🌱</div>
        <div style={{ fontWeight: 800, fontSize: '1.05rem', color: 'var(--text-primary)' }}>Nook v3.0</div>
        <p style={{ color: 'var(--text-secondary)', fontSize: '0.82rem', marginTop: 6 }}>A beautiful Pomodoro timer and task manager.</p>
        <a href="mailto:bugs@nook.app" style={{ color: 'var(--accent-light)', fontSize: '0.8rem', fontWeight: 600, textDecoration: 'none', display: 'inline-block', marginTop: 12 }}>Report a bug</a>
      </section>

      </div>{/* end settings-grid */}

      {/* ── Log out — only while there is an account to log out of ── */}
      {isAuthConfigured && accountEmail && (
        <button type="button" className="settings-logout-btn" onClick={handleLogout}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>
          </svg>
          Log Out
        </button>
      )}
    </div>
  );
});

// ─── Connections overview row ────────────────────────────────────────
// tone: 'ok'   — live and working
//       'warn' — set up but broken, needs the user to do something
//       'off'  — not connected / switched off, which is not a problem
// 'warn' is deliberately distinct from 'off': a revoked Drive token is not the
// same as never having connected, and reading them the same way is what let a
// two-week backup outage go unnoticed.
function ConnRow({ label, tone, detail }) {
  const color = tone === 'ok'   ? 'var(--color-green)'
              : tone === 'warn' ? 'var(--color-amber, #f59e0b)'
              :                   'var(--text-muted)';
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', borderTop: '1px solid var(--border)' }}>
      <span
        aria-hidden="true"
        style={{
          width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0,
          boxShadow: tone === 'ok' ? '0 0 6px rgba(34,197,94,0.5)' : 'none',
        }}
      />
      <span style={{ fontSize: '0.83rem', fontWeight: 600, color: 'var(--text-primary)' }}>{label}</span>
      <span style={{
        marginLeft: 'auto', textAlign: 'right', fontSize: '0.78rem',
        color: tone === 'warn' ? color : 'var(--text-secondary)',
        fontWeight: tone === 'warn' ? 700 : 500,
      }}>
        {detail}
      </span>
    </div>
  );
}
