// Promise-based confirmation popup — the one way Nook asks "are you sure?" before a delete.
// `askConfirm()` resolves true (confirmed) or false (cancelled / dismissed); <ConfirmHost/>
// (mounted once in App.jsx) draws it. Replaces the native confirm() and the old in-row
// "Delete? Yes / No" strips, so every delete asks in the same themed popup.
//
//   if (!(await askConfirm({ title: 'Delete this note?', message: 'It will be gone for good.' }))) return;

let current = null;               // { id, opts, resolve } while a popup is open
const listeners = new Set();
let nextId = 1;

const emit = () => listeners.forEach(l => l());

export function askConfirm(opts = {}) {
  // A second ask while one is open (e.g. a double-click) replaces it; the first counts as cancelled.
  if (current) current.resolve(false);
  return new Promise(resolve => {
    current = { id: nextId++, opts, resolve };
    emit();
  });
}

export function settleConfirm(id, answer) {
  if (!current || current.id !== id) return;
  const { resolve } = current;
  current = null;
  emit();
  resolve(answer);
}

export const subscribeConfirm = (l) => { listeners.add(l); return () => listeners.delete(l); };
export const getConfirm = () => current;
