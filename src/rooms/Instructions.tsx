// Instructions — every word each agent is given, layer by layer, editable in
// place (Matt, Nov 3 2026: "i want to be able to easily directly manage ALL
// CONTEXT and instructions ALL agents in tardis get").

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, Copy, Eye, Pencil, ScrollText, Search, Sparkles, Users, X } from 'lucide-react';
import { apiJson } from '../data/api';
import { agentAvatarUrl, useAgents, type Agent } from '../grok/agents';
import './instructions.css';

type Layer = { key: string; title: string; note: string; path: string; text: string; bytes: number; mtime: number; sharedWith: string[] };
type AgentInstructions = { agent: { id: string; name: string; engine: string }; layers: Layer[]; assembled: string };

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
/** Rough tokens: about four characters each. Only for a sense of weight. */
const tokens = (bytes: number) => `~${Math.round(bytes / 4).toLocaleString()} tokens`;
const shortPath = (path: string) => path.replace(/^\/home\/[^/]+\//, '~/');

export function Instructions() {
  const { agents } = useAgents();
  const [picked, setPicked] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [exact, setExact] = useState(false);
  // Layer keys with unsaved edits, so switching agent or view never drops work.
  const [dirty, setDirty] = useState<Set<string>>(() => new Set());
  const markDirty = useCallback((key: string, on: boolean) => setDirty(prev => {
    if (prev.has(key) === on) return prev;
    const next = new Set(prev);
    if (on) next.add(key); else next.delete(key);
    return next;
  }), []);
  const leave = (go: () => void) => {
    if (dirty.size && !window.confirm('You have unsaved changes. Leave them and switch anyway?')) return;
    setDirty(new Set());
    go();
  };
  useEffect(() => {
    if (!dirty.size) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty.size]);
  const agentId = picked ?? agents[0]?.id ?? null;
  const query = useQuery({
    queryKey: ['instructions', agentId],
    queryFn: () => apiJson<AgentInstructions>(`/api/instructions/${encodeURIComponent(agentId!)}`, { cache: 'no-store' }),
    enabled: Boolean(agentId),
  });
  const names = useMemo(() => new Map(agents.map(a => [a.id, a.name])), [agents]);
  const shown = agents.filter(a => `${a.name} ${a.role}`.toLowerCase().includes(filter.toLowerCase()));
  const data = query.data;
  const total = data?.layers.reduce((sum, l) => sum + l.bytes, 0) ?? 0;
  const biggest = Math.max(1, ...(data?.layers.map(l => l.bytes) ?? [1]));

  return (
    <div className="ins-room">
      <div className="ins-glow" aria-hidden />
      <header className="ins-header">
        <span className="ins-eyebrow"><ScrollText size={13} /> INSTRUCTIONS</span>
        <h1>Everything your agents are told</h1>
        <p>Pick an agent to see every layer of its instructions in the order it reads them. Edit any layer right here. Shared layers change for every agent that uses them, and agents pick changes up the next time their session starts.</p>
      </header>

      <div className="ins-body">
        <aside className="ins-agents">
          <label className="ins-search"><Search size={14} /><input value={filter} onChange={e => setFilter(e.target.value)} placeholder="Find an agent" /></label>
          <div className="ins-agent-list">
            {shown.map(a => <AgentChip key={a.id} agent={a} active={a.id === agentId} onPick={() => { if (a.id !== agentId) leave(() => { setPicked(a.id); setExact(false); }); }} />)}
          </div>
        </aside>

        <section className="ins-main">
          {query.isLoading || !data ? (
            <div className="ins-empty">{query.error ? (query.error as Error).message : 'Loading instructions…'}</div>
          ) : (
            <>
              <div className="ins-summary">
                <div><strong>{data.layers.length}</strong><span>layers</span></div>
                <div><strong>{kb(total)}</strong><span>{tokens(total)}</span></div>
                <div><strong>{data.agent.engine}</strong><span>engine</span></div>
                <button className="ins-toggle" aria-pressed={exact} onClick={() => leave(() => setExact(v => !v))}>
                  <Eye size={14} /> {exact ? 'Back to layers' : 'Exact text TARDIS adds'}
                </button>
              </div>
              {exact ? <ExactText text={data.assembled} /> : (
                <div className="ins-layers">
                  {data.layers.map((layer, i) => (
                    <LayerCard key={`${data.agent.id}:${layer.key}`} layer={layer} index={i} agentId={data.agent.id}
                      weight={layer.bytes / biggest} names={names} onDirty={markDirty} />
                  ))}
                </div>
              )}
              <p className="ins-foot">The engine's own built-in system prompt and each skill's one-line description also load, and those are not editable here.</p>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function AgentChip({ agent, active, onPick }: { agent: Agent; active: boolean; onPick: () => void }) {
  const avatar = agentAvatarUrl(agent);
  return (
    <button className={`ins-agent${active ? ' active' : ''}`} onClick={onPick} aria-current={active ? 'true' : undefined}>
      <span className="ins-avatar">{avatar ? <img src={avatar} alt="" /> : agent.name.slice(0, 1)}</span>
      <span className="ins-agent-text"><b>{agent.name}</b><small>{agent.role}</small></span>
    </button>
  );
}

function LayerCard({ layer, index, agentId, weight, names, onDirty }: { layer: Layer; index: number; agentId: string; weight: number; names: Map<string, string>; onDirty: (key: string, on: boolean) => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  // The file's mtime when editing began travels with the draft, so a refetch
  // mid-edit can never quietly turn a stale save into an overwrite.
  const [draft, setDraft] = useState<{ text: string; mtime: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { if (!saved) return; const t = window.setTimeout(() => setSaved(false), 1600); return () => window.clearTimeout(t); }, [saved]);
  const others = layer.sharedWith.filter(id => id !== agentId);
  const editing = draft !== null;
  const changed = draft !== null && draft.text !== layer.text;
  useEffect(() => { onDirty(layer.key, changed); }, [changed, layer.key, onDirty]);
  useEffect(() => () => onDirty(layer.key, false), [layer.key, onDirty]);

  async function save() {
    if (draft === null) return;
    setSaving(true); setError('');
    try {
      await apiJson('/api/instructions', { method: 'PUT', body: JSON.stringify({ path: layer.path, text: draft.text, mtime: draft.mtime }) });
      setDraft(null); setSaved(true);
      await client.invalidateQueries({ queryKey: ['instructions'] });
    } catch (e) {
      const raw = (e as Error).message;
      let message = raw;
      try { message = (JSON.parse(raw) as { error?: string }).error ?? raw; } catch { /* plain text */ }
      setError(message || 'Could not save.');
    } finally { setSaving(false); }
  }

  return (
    <article className={`ins-layer${open ? ' open' : ''}${saved ? ' saved' : ''}`} style={{ animationDelay: `${index * 40}ms` }}>
      <button className="ins-layer-head" onClick={() => setOpen(v => !v)} aria-expanded={open}>
        <span className="ins-step">{index + 1}</span>
        <span className="ins-layer-title"><b>{layer.title}</b><small>{layer.note}</small></span>
        {others.length ? <span className="ins-shared" title={others.map(id => names.get(id) ?? id).join(', ')}><Users size={12} /> {layer.sharedWith.length}</span> : null}
        <span className="ins-size"><i style={{ width: `${Math.max(6, weight * 100)}%` }} />{kb(layer.bytes)}</span>
        <ChevronDown size={16} className="ins-chev" />
      </button>
      {open ? (
        <div className="ins-layer-body">
          <div className="ins-path">
            <code>{shortPath(layer.path)}</code>
            {others.length ? <span>Also used by {others.map(id => names.get(id) ?? id).join(', ')}</span> : <span>Only this agent</span>}
          </div>
          {editing ? (
            <textarea className="ins-editor" value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} spellCheck autoFocus />
          ) : (
            <pre className="ins-text">{layer.text}</pre>
          )}
          {error ? <p className="ins-error">{error}</p> : null}
          <div className="ins-actions">
            {editing ? (
              <>
                {others.length ? <span className="ins-warn">Saving changes this for {layer.sharedWith.length} agents.</span> : null}
                <button onClick={() => { setDraft(null); setError(''); }} disabled={saving}><X size={14} /> Cancel</button>
                <button className="primary" onClick={save} disabled={saving || !changed}><Check size={14} /> {saving ? 'Saving…' : 'Save'}</button>
              </>
            ) : (
              <button className="primary" onClick={() => setDraft({ text: layer.text, mtime: layer.mtime })}><Pencil size={14} /> Edit</button>
            )}
          </div>
        </div>
      ) : null}
      {saved ? <span className="ins-confetti" aria-hidden><Sparkles size={16} /></span> : null}
    </article>
  );
}

function ExactText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ins-exact">
      <div className="ins-path">
        <span>This is the exact text TARDIS puts in front of the model, after the engine's own files (global and project rules) above.</span>
        <button onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1400); }); }}>
          {copied ? <Check size={14} /> : <Copy size={14} />} {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="ins-text">{text}</pre>
    </div>
  );
}
