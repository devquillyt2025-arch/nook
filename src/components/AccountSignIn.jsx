import { useState } from 'react';
import { supabase, friendlyAuthError } from '../utils/authClient';

// Optional sign-in, shown in Settings → Connections while signed out. Nook is
// local-first and fully usable without an account; signing in is what switches
// on cross-device sync, reminders, push and Drive backup. (AuthGate/AuthPage —
// the full-screen gate — are deliberately not mounted; see main.jsx.)
//
// A successful sign-in RELOADS the page. Several cloud features (task/habit
// hydrate + Realtime, push, reminders) initialise once on mount and look for a
// session then; reloading puts the app in exactly the state it was in when it
// was only ever mounted behind the gate, instead of a half-initialised one.
export default function AccountSignIn() {
  const [mode, setMode] = useState('signin');           // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const switchMode = (m) => { setMode(m); setError(''); setNotice(''); };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setError(''); setNotice('');
    if (!email.trim() || !password) { setError('Enter your email and password.'); return; }
    if (mode === 'signup' && password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    setBusy(true);
    try {
      if (mode === 'signin') {
        const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (err) throw err;
        window.location.reload();
        return;                                          // stay "busy" until the reload lands
      }
      const { data, error: err } = await supabase.auth.signUp({ email: email.trim(), password });
      if (err) throw err;
      if (data?.session) { window.location.reload(); return; }
      setNotice('Account created — check your inbox to confirm it, then sign in.');
      setMode('signin');
      setPassword('');
    } catch (err) {
      setError(friendlyAuthError(err?.message));
    }
    setBusy(false);
  };

  const signInWithGoogle = async () => {
    if (busy) return;
    setError(''); setNotice(''); setBusy(true);
    try {
      const { data, error: err } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + '/', skipBrowserRedirect: true },
      });
      if (err) throw err;
      if (data?.url) { window.location.assign(data.url); return; }
      throw new Error('Google sign-in is not available right now.');
    } catch (err) {
      setError(friendlyAuthError(err?.message));
      setBusy(false);
    }
  };

  const signup = mode === 'signup';
  const inputStyle = { width: '100%', padding: '9px 12px', fontSize: '0.88rem', borderRadius: 10, boxSizing: 'border-box' };
  const linkBtn = { background: 'none', border: 'none', padding: '8px 2px', minHeight: 32, cursor: 'pointer', color: 'var(--accent)', fontSize: '0.78rem', fontWeight: 600 };

  return (
    <form onSubmit={submit} noValidate aria-label={signup ? 'Create account' : 'Sign in'}
      style={{ padding: '12px 0 4px', borderTop: '1px solid var(--border)' }}>
      <p style={{ color: 'var(--text-secondary)', fontSize: '0.78rem', lineHeight: 1.5, margin: '0 0 10px' }}>
        {signup ? 'Create an account' : 'Sign in'} to sync your tasks, notes, journal and settings across devices.
        {' '}Nook works fully without one — what is on this device is merged with your account, never replaced.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label className="set-field-lbl" htmlFor="nk-acct-email">Email</label>
          <input id="nk-acct-email" type="email" className="form-inp" style={inputStyle}
            value={email} onChange={e => setEmail(e.target.value)} autoComplete="email"
            placeholder="you@example.com" disabled={busy} />
        </div>
        <div>
          <label className="set-field-lbl" htmlFor="nk-acct-password">Password</label>
          <input id="nk-acct-password" type="password" className="form-inp" style={inputStyle}
            value={password} onChange={e => setPassword(e.target.value)}
            autoComplete={signup ? 'new-password' : 'current-password'}
            placeholder={signup ? 'At least 6 characters' : 'Your password'} disabled={busy} />
        </div>
      </div>

      <div role="status" aria-live="polite" style={{ minHeight: 0 }}>
        {error && <div style={{ marginTop: 10, fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-red)' }}>{error}</div>}
        {notice && <div style={{ marginTop: 10, fontSize: '0.78rem', fontWeight: 600, color: 'var(--color-green)' }}>{notice}</div>}
      </div>

      <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button type="submit" className="secondary-btn" disabled={busy}
          style={{ padding: '9px 18px', borderRadius: 10, border: '1px solid var(--accent)', background: 'var(--surface-nested)', color: 'var(--text-primary)', fontWeight: 700, fontSize: '0.82rem', cursor: 'pointer' }}>
          {busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
        </button>
        <button type="button" className="secondary-btn" disabled={busy} onClick={signInWithGoogle}
          style={{ padding: '9px 16px', borderRadius: 10, border: '1px solid var(--border)', background: 'var(--surface-nested)', color: 'var(--text-primary)', fontWeight: 600, fontSize: '0.82rem', cursor: 'pointer' }}>
          Continue with Google
        </button>
        <button type="button" style={{ ...linkBtn, marginLeft: 'auto' }} disabled={busy}
          onClick={() => switchMode(signup ? 'signin' : 'signup')}>
          {signup ? 'Have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>
    </form>
  );
}
