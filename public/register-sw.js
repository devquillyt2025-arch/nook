// Registers the service worker (offline shell + Web Push). Kept as a same-origin file rather
// than an inline <script> in index.html so the Content-Security-Policy can forbid inline scripts.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
