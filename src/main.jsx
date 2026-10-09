import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import AuthGate from './components/AuthGate.jsx'
import ErrorBoundary from './components/ErrorBoundary.jsx'

// Last-resort net for exceptions/rejections that never reach a React error
// boundary (event handlers, timers, promise chains) — otherwise these vanish
// silently unless devtools happens to be open.
window.addEventListener('error', (e) => {
  console.error('[window.onerror]', e.error || e.message, e.filename ? `${e.filename}:${e.lineno}` : '');
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary title="Nook hit an unexpected error" message="Your data is safe in local storage — refreshing the page usually resolves this.">
      {/* Login wall: with VITE_SUPABASE_* set, nothing renders until someone is signed in, and
          signing out lands back on the login page. With them unset it passes straight through. */}
      <AuthGate>
        <App />
      </AuthGate>
    </ErrorBoundary>
  </StrictMode>,
)
