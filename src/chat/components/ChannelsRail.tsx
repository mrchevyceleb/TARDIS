// The rail's Channels section: channel rows (click to open) plus the create
// form (a name and picked teammates). Rename, member changes and deletion
// live in the channel view's header, not here. One-on-one teammate threads
// above stay exactly as they are.

import { useState } from 'react';
import { Check, Hash, Plus, X } from 'lucide-react';
import { channelError, useChannelActions, useChannels } from '../hooks/useChannels';
import type { Agent } from '../../grok/agents';
import './channels.css';

export function ChannelsRail({ agents, activeChannelId, onOpenChannel }: {
  agents: Agent[];
  activeChannelId?: string;
  onOpenChannel: (id: string) => void;
}) {
  const channels = useChannels();
  const actions = useChannelActions();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const list = channels.data?.channels ?? [];
  const busy = actions.create.isPending;

  const togglePick = (member: string) => {
    setPicked((p) => (p.includes(member) ? p.filter((m) => m !== member) : [...p, member]));
  };

  const submit = async () => {
    setError(null);
    if (!name.trim() || !picked.length) {
      setError('A channel needs a name and at least one teammate.');
      return;
    }
    try {
      const result = await actions.create.mutateAsync({ name: name.trim(), members: picked });
      setName('');
      setPicked([]);
      setCreating(false);
      onOpenChannel(result.channel.id);
    } catch (e) {
      setError(channelError(e));
    }
  };

  return (
    <div className="ch-rail">
      <div className="ch-rail-head">
        <span className="ch-rail-title">Channels</span>
        <button
          type="button"
          className="bt-iconbtn"
          onClick={() => { setCreating((c) => !c); setError(null); }}
          title="New channel"
          aria-label="New channel"
          aria-expanded={creating}
        >
          <Plus size={14} />
        </button>
      </div>

      {creating ? (
        <div className="ch-create">
          <input
            className="ch-create-name"
            placeholder="Channel name"
            value={name}
            maxLength={80}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') { setCreating(false); setError(null); }
              if (e.key === 'Enter') { e.preventDefault(); void submit(); }
            }}
          />
          <div className="ch-create-picks">
            {agents.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`ch-pick${picked.includes(a.name) ? ' on' : ''}`}
                onClick={() => togglePick(a.name)}
                aria-pressed={picked.includes(a.name)}
              >
                {picked.includes(a.name) ? <Check size={11} /> : <span className="ch-pick-dot" aria-hidden="true" />}
                {a.name}
              </button>
            ))}
          </div>
          {error ? <div className="ch-error" role="alert">{error}</div> : null}
          <div className="ch-create-actions">
            <button type="button" className="ch-create-go" disabled={busy} onClick={() => void submit()}>
              {busy ? 'Creating…' : `Create (${picked.length})`}
            </button>
            <button type="button" className="ch-create-x" onClick={() => { setCreating(false); setError(null); }}>
              <X size={11} /> Cancel
            </button>
          </div>
        </div>
      ) : null}

      {list.map((channel) => (
        <button
          key={channel.id}
          type="button"
          className={`ch-row${activeChannelId === channel.id ? ' active' : ''}`}
          onClick={() => onOpenChannel(channel.id)}
          title={channel.members.join(', ')}
        >
          <Hash size={13} aria-hidden="true" />
          <span className="ch-row-name">{channel.name}</span>
          <span className="ch-row-count">{channel.members.length}</span>
        </button>
      ))}
      {!list.length && !creating ? <div className="ch-empty">No channels yet.</div> : null}
    </div>
  );
}