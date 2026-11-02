import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './tokens.css';
import './index.css';
import './chat/chat-theme.css';
import './chat/chat-reimagine.css';
import './grok/grok.css';
import './theme/eggs.css';
import './theme/fonts.css';
import App from './App';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// TARDIS ships no service worker. The old PWA-only one registered a no-op
// `fetch` handler, which browsers flag as dead weight on every navigation, and
// it bought nothing: it cached neither the shell nor any API response. Retire
// whatever is still installed on clients that picked it up.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister())))
      .catch(() => { /* best effort - nothing to retire */ });
  });
}

// A long-lived TARDIS tab used to stay on its already-loaded JavaScript
// forever after a local deploy. That made fixes appear broken even though the
// server was serving a new hashed bundle. Revalidate the shell on wake/focus
// and periodically; reload only when its entry asset actually changed. Defer
// while the user has an unsent draft so an update can never eat their words.
const bootEntryAsset = Array.from(document.scripts)
  .map((script) => script.getAttribute('src') ?? '')
  .find((src) => /\/assets\/index-[^/]+\.js(?:\?|$)/.test(src));

if (bootEntryAsset) {
  let checkingBuild = false;
  const checkForBuildUpdate = async () => {
    if (checkingBuild || document.visibilityState !== 'visible') return;
    checkingBuild = true;
    try {
      const response = await fetch(window.location.pathname, {
        cache: 'no-store',
        headers: { 'x-rivendell-version-check': '1' },
      });
      if (!response.ok) return;
      const html = await response.text();
      const match = html.match(/(?:src=["'])([^"']*\/assets\/index-[^"'?]+\.js(?:\?[^"']*)?)["']/i);
      if (!match || match[1] === bootEntryAsset) return;
      const draftSelector = [
        'textarea',
        '[contenteditable="true"]',
        'input:not([type])',
        'input[type="text"]',
        'input[type="email"]',
        'input[type="url"]',
        'input[type="tel"]',
        'input[type="number"]',
        'input[type="date"]',
        'input[type="datetime-local"]',
        'input[type="time"]',
        'input[type="password"]',
      ].join(',');
      const hasDraft = Array.from(document.querySelectorAll(draftSelector)).some((node) => {
        if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
          return !node.disabled && !node.readOnly && Boolean(node.value.trim());
        }
        return Boolean(node.textContent?.trim());
      });
      if (hasDraft) return;
      window.location.reload();
    } catch {
      // Offline/restarting is handled by chat reconnect state; retry later.
    } finally {
      checkingBuild = false;
    }
  };
  window.addEventListener('focus', () => { void checkForBuildUpdate(); });
  window.addEventListener('pageshow', () => { void checkForBuildUpdate(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForBuildUpdate();
  });
  window.setInterval(() => { void checkForBuildUpdate(); }, 30_000);
}
