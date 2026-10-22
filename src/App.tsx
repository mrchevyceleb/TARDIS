import { useEffect, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { getResourceGuardHealth } from './data/api';
import { showToast } from './native/shell';
import { Studio } from './shell/Studio';
import { GrokApp } from './grok/GrokApp';
import { ProxyViewerProvider } from './components/ProxyViewer';
import { JarvisProvider } from './jarvis/JarvisProvider';
import { JarvisOverlay } from './jarvis/JarvisOverlay';

const queryClient = new QueryClient();

// The Grok rebuild is the default shell. The classic Studio IDE stays one
// click away at /studio (and owns the ?path= deep link). Legacy room URLs
// (/council, /pins, …) land in the Grok shell with that room open.
const studioMatch = /^\/studio(\/|$)/.test(window.location.pathname);
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

function ResourceNotices() {
  const seen = useRef<string[] | null>(null);
  const [notice, setNotice] = useState('');
  const { data } = useQuery({ queryKey: ['resource-guard'], queryFn: getResourceGuardHealth, refetchInterval: 15_000, retry: false });
  useEffect(() => {
    if (!data || data.mode === 'off') return;
    const known = seen.current;
    seen.current = [...new Set([...data.incidents.map((item) => item.id), ...(known ?? [])])].slice(0, 200);
    if (known === null) return; // seed old receipts silently; no client clock assumptions
    const fresh = data.incidents.filter((item) => item.kind !== 'hold' && !known.includes(item.id));
    if (!fresh.length) return;
    const latest = fresh[0];
    const text = `${latest.owner}: ${latest.message}${fresh.length > 1 ? ` (${fresh.length} new notices.)` : ''} Details are on the Desk.`;
    setNotice(text);
    showToast(text);
  }, [data]);
  return <span className="sr-only" role="status" aria-live="polite">{notice}</span>;
}

export default function App() {
  useEffect(dismissBoot, []);
  return (
    <QueryClientProvider client={queryClient}>
      <ProxyViewerProvider>
        <JarvisProvider>
          <ResourceNotices />
          {studioMatch ? <Studio /> : <GrokApp initialRoom={legacyRoom || undefined} />}
          <JarvisOverlay />
        </JarvisProvider>
      </ProxyViewerProvider>
    </QueryClientProvider>
  );
}
