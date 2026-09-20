import { useState, useEffect } from 'react';
import { supabase, isAuthConfigured } from '../utils/authClient';
import AuthPage from './AuthPage';

/* 
 * NOTE: AuthGate and AuthPage are purposefully bypassed in main.jsx 
 * for local-only use right now. We are keeping the code here because 
 * we will use it in the future when we add cloud sync/accounts.
 */

// Gates the app behind email/password auth — but ONLY when Supabase env vars
// are present. Without them, the app renders exactly as before (no login),
// so adding this can't break the existing experience.
export default function AuthGate({ children }) {
  // undefined = still checking the session; null = signed out; object = signed in
  const [session, setSession] = useState(isAuthConfigured ? undefined : null);
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
      if (active) setSession(data.session ?? null);
    })();

    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
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
