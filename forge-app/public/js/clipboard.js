const CLEAR_DELAY_MS = 30000;

let timer = null;

export async function copyText(text) {
  if (!navigator.clipboard) throw new Error('Copie impossible');
  clearTimeout(timer);
  timer = null;
  window.removeEventListener('focus', clearClipboard);
  await navigator.clipboard.writeText(text);
}

async function clearClipboard() {
  timer = null;
  try {
    await navigator.clipboard.writeText('');
  } catch {
    window.addEventListener('focus', clearClipboard, { once: true });
  }
}

export async function copySecret(text) {
  await copyText(text);
  timer = setTimeout(clearClipboard, CLEAR_DELAY_MS);
}

export async function flushSecret() {
  if (timer === null) return;
  clearTimeout(timer);
  await clearClipboard();
}
