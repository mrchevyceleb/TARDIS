import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Studio } from './shell/Studio';
import { GrokApp } from './grok/GrokApp';
import { QaSignInLanding } from './rooms/QaBoard';
import { ProxyViewerProvider } from './components/ProxyViewer';
import { JarvisProvider } from './jarvis/JarvisProvider';
import { JarvisOverlay } from './jarvis/JarvisOverlay';

const queryClient = new QueryClient();

// The Grok rebuild is the default shell. The classic Studio IDE stays one
// click away at /studio (and owns the ?path= deep link). Legacy room URLs
// (/council, /pins, …) land in the Grok shell with that room open.
const studioMatch = /^\/studio(\/|$)/.test(window.location.pathname);
// A tester sign-in link gets its own bare page, outside the shell and its
// providers: the GET must render something harmless (no credential
// consumed), and the shell's Jarvis and viewers stay out of the way until
// the tester has signed in and lands on the board.
const qaSigninMatch = /^\/qa-signin(\/|$)/.test(window.location.pathname);
const legacyRoom = window.location.pathname.replace(/^\/+/, '').replace(/\/+$/, '');

// The inline boot layer in index.html (the box materialising) fades out once
// React has committed the shell. Effects run after the first commit, so this
// is exactly "the shell exists". A short floor keeps one lamp pulse from being
// cut mid-flicker when React mounts fast; the layer never blocks input and
// the CSS cap clears it at 1.4 s even if this never runs.
function dismissBoot() {
  const el = document.getElementById('boot');
  if (!el) return;
  const wait = Math.max(0, 350 - performance.now());
  window.setTimeout(() => {
    el.classList.add('out');
    window.setTimeout(() => el.remove(), 260);
  }, wait);
}

export default function App() {
  useEffect(dismissBoot, []);
  if (qaSigninMatch) return <QaSignInLanding />;
  return (
    <QueryClientProvider client={queryClient}>
      <ProxyViewerProvider>
        <JarvisProvider>
          {studioMatch ? <Studio /> : <GrokApp initialRoom={legacyRoom || undefined} />}
          <JarvisOverlay />
        </JarvisProvider>
      </ProxyViewerProvider>
    </QueryClientProvider>
  );
}
