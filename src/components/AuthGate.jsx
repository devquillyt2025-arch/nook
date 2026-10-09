import { useState, useEffect } from 'react';
import { supabase, isAuthConfigured } from '../utils/authClient';
import AuthPage from './AuthPage';

// Gates the app behind email/password auth — but ONLY when Supabase env vars
// are present. Without them, the app renders exactly as before (no login),
// so adding this can't break the existing experience.

// A stored supabase-js session (the `sb-<ref>-auth-token` record, not its `-code-verifier`
// / `-user` siblings), whatever its token state.
function hasStoredSession() {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !/^sb-.+-auth-token$/.test(k)) continue;
      const v = JSON.parse(localStorage.getItem(k) || 'null');
      if (v && v.refresh_token) return true;
    }
  } catch { /* unreadable storage ⇒ treat as none */ }
  return false;
}

// Offline-safe: getSession() — and the INITIAL_SESSION event — report "no session" when the
// access token (1 h) has expired AND the refresh request can't reach the server. That is not
// "signed out": supabase-js clears the stored session when a refresh is refused for good
// and keeps it when the network is merely down. So a session that is still in storage means
// "could not verify", and the user is let in — their data is local, and a login wall that
// blocks it offline would be worse than useless. If the session later proves revoked,
// supabase-js emits SIGNED_OUT and the gate closes again.
const UNVERIFIED_SESSION = { unverified: true };
const sessionOrUnverified = (event, s) =>
  s ?? (event !== 'SIGNED_OUT' && hasStoredSession() ? UNVERIFIED_SESSION : null);

export default function AuthGate({ children }) {
  // undefined = still checking the session; null = signed out; object = signed in.
  // A session already in storage is trusted at once (no spinner, and no ~25 s wait while
  // supabase-js retries a refresh that can't reach the server); the check below confirms it
  // in the background and closes the gate if it turns out to be revoked.
  const [session, setSession] = useState(() => !isAuthConfigured ? null : hasStoredSession() ? UNVERIFIED_SESSION : undefined);
  const [ssoError, setSsoError] = useState('');

  useEffect(() => {
    if (!isAuthConfigured) return;
    let active = true;

    (async () => {
      // Cross-app SSO handoff: the marketing/landing login page (a separate
      // origin) signs the user in with its own Supabase client and hands off
      // the resulting session via a URL hash using custom key names
      // (`sb_access_token`/`sb_refresh_token`) so it never collides with
      // Supabase's own OAuth/magic-link hash format, which this app's
      // `detectSessionInUrl` already handles natively for its own Google
      // sign-in and password-reset flows. Consume it once, then scrub the
      // hash so the tokens never linger in the URL or browser history.
      const hash = window.location.hash;
      if (hash.includes('sb_access_token=')) {
        const params = new URLSearchParams(hash.slice(1));
        const access_token = params.get('sb_access_token');
        const refresh_token = params.get('sb_refresh_token');
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
        if (access_token && refresh_token) {
          // The handoff tokens are single-shot — once consumed (by this call,
          // successful or not) they're gone from the URL, so a failure here
          // must be surfaced now or it's lost. Previously the return value
          // was discarded entirely, so a failed handoff fell straight through
          // to getSession() below and landed on a plain "signed out" screen —
          // indistinguishable from having never signed in at all.
          //
          // Deliberately NOT gated on `active`, unlike the setSession call
          // below. Verified (Phase 5 sandbox, real revoked-session handoff)
          // that gating this on `active` silently swallowed a genuine error:
          // React StrictMode double-invokes this effect in dev, and the
          // *first* instance — the one that actually owns the hash, since
          // replaceState already stripped it by the time the second runs —
          // can have its `active` flipped false by the second mount's
          // cleanup before this await resolves. The hash is consumed exactly
          // once, ever; whichever effect instance processes it is the only
          // chance to ever report the result, so there's no "staler, about
          // to be superseded" run to guard against here the way there is for
          // the session-setting call below.
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          if (error) {
            setSsoError('Your sign-in link expired or was already used. Please sign in again below.');
          }
        }
      }
      const { data } = await supabase.auth.getSession();
      if (active) setSession(sessionOrUnverified('GET_SESSION', data.session));
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => setSession(sessionOrUnverified(event, s)));
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  if (!isAuthConfigured) return children;

  if (session === undefined) {
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'grid', placeItems: 'center', background: 'var(--bg-base)' }}>
        <span className="tab-fallback-spinner" aria-label="Loading" />
      </div>
    );
  }

  if (!session) return <AuthPage ssoError={ssoError} />;

  return children;
}
