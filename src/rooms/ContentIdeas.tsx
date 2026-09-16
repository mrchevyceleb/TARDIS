import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Sparkles, LoaderCircle } from 'lucide-react';
import { contentRequest } from '../data/api';
import type { ContentBrand, ContentIdea } from '../data/content';

type Scanner = { connected: boolean; error?: string; schedule?: string; timezone?: string; runs: Array<{ id: string; status: string; started_at: string; ideas_written: number; error?: string }> };
const link = (value: string) => { try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };

export function ContentIdeas({ brand, onCreate }: { brand: ContentBrand; onCreate: (idea: ContentIdea) => void }) {
  const cache = useQueryClient();
  const [notice, setNotice] = useState('');
  const [requesting, setRequesting] = useState(false);
  const ideas = useQuery({ queryKey: ['content', 'ideas', brand], queryFn: ({ signal }) => contentRequest<{ ideas: ContentIdea[] }>(`/ideas?brand=${brand}`, 'GET', undefined, signal), refetchInterval: 10000, retry: false });
  const scanner = useQuery({ queryKey: ['content', 'scanner', brand], queryFn: ({ signal }) => contentRequest<Scanner>(`/scanner?brand=${brand}`, 'GET', undefined, signal), refetchInterval: 15000, retry: false });
  const latest = scanner.data?.runs[0];
  const scan = async () => {
    setRequesting(true); setNotice('');
    try { await contentRequest('/scan', 'POST', { brand }); setNotice('Scan requested. New ideas will appear here as research finishes.'); void cache.invalidateQueries({ queryKey: ['content', 'scanner'] }); }
    catch (e) { setNotice(e instanceof Error ? e.message : 'Could not start research.'); }
    finally { setRequesting(false); }
  };
  return <div>
    <div className="content-connection-actions"><p>Fresh research for your next draft. Your Coordinator can use these same ideas in routines.</p><button className="content-button" disabled={requesting || !scanner.data?.connected || latest?.status === 'running'} onClick={() => void scan()}><Search size={16}/> {requesting || latest?.status === 'running' ? 'Researching…' : 'Find fresh ideas'}</button></div>
    <p className="content-hint">{scanner.data?.connected ? `Scanner connected · ${scanner.data.schedule === '0 0 * * *' ? 'Nightly at midnight' : `Schedule: ${scanner.data.schedule}`} (${scanner.data.timezone})` : scanner.data?.error || 'Checking scanner…'}{latest && ` · Last run: ${new Date(latest.started_at).toLocaleString()} · ${latest.status} · ${latest.ideas_written} ideas`}</p>
    {(notice || ideas.error || scanner.error || latest?.error) && <p className="content-notice" role="status">{notice || ideas.error?.message || scanner.error?.message || latest?.error}</p>}
    {ideas.isPending ? <div className="content-empty"><LoaderCircle className="content-spin"/> Loading ideas…</div> : ideas.data?.ideas.length ? <div className="content-grid">{ideas.data.ideas.map((idea) => <article className="content-card" key={idea.id}>
      <div className="content-card-top"><span className="content-kind">{idea.source === 'cron' ? 'Researched idea' : 'Your idea'}</span><span>{idea.score === null ? '' : `${idea.score}/100`}</span></div>
      <h2>{idea.headline}</h2><p>{idea.description}</p>{idea.recommended_angle && <p><strong>Angle:</strong> {idea.recommended_angle}</p>}
      <div>{idea.signals.filter(s => link(s.url)).map((s, i) => <a key={`${s.url}-${i}`} href={link(s.url)} target="_blank" rel="noopener noreferrer" className="content-button quiet">Source {i + 1}</a>)}</div>
      {idea.generation_jobs.length > 0 && <p className="content-hint">{idea.generation_jobs.map(j => `${j.kind}: ${j.status}`).join(' · ')}</p>}
      <button className="content-button primary" onClick={() => onCreate(idea)}><Sparkles size={16}/> Create drafts</button>
    </article>)}</div> : <div className="content-empty"><Search size={30}/><h2>No ideas yet</h2><p>Start a scan, or let the nightly research bring ideas here.</p></div>}
  </div>;
}
