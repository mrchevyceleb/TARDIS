// The rail's Channels section: channel rows (click to open) plus the create
// form (a name and picked teammates). Rename, member changes and deletion
// live in the channel view's header, not here. One-on-one teammate threads
// above stay exactly as they are.

import { useId, useState } from 'react';
import { Check, ChevronRight, Hash, Plus, X } from 'lucide-react';
import { channelError, useChannelActions, useChannels } from '../hooks/useChannels';
import type { Agent } from '../../grok/agents';
import '../../grok/railGroups.css';
import './channels.css';

const CHANNELS_COLLAPSED_KEY = 'rivendell:channels-collapsed';

function readInitialCollapsed(): boolean {
  try {
    return typeof window !== 'undefined' && window.localStorage.getItem(CHANNELS_COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

export function ChannelsRail({ agents, activeChannelId, onOpenChannel }: {
  agents: Agent[];
  activeChannelId?: string;
  onOpenChannel: (id: string) => void;
}) {
  const bodyId = useId();
  const channels = useChannels();
  const actions = useChannelActions();
  const [collapsed, setCollapsed] = useState(readInitialCollapsed);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const list = channels.data?.channels ?? [];
  const busy = actions.create.isPending;

  const setCollapsedPersisted = (next: boolean) => {
    setCollapsed(next);
    try {
      window.localStorage.setItem(CHANNELS_COLLAPSED_KEY, next ? '1' : '0');
    } catch { /* ignore storage errors */ }
  };

  const toggleCollapsed = () => {
    if (!collapsed) {
      setCreating(false);
      setError(null);
      setCollapsedPersisted(true);
    } else {
      setCollapsedPersisted(false);
    }
  };

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

  const totalUnread = list.reduce((sum, c) => sum + (c.unread ?? 0), 0);
  const summary = [
    `Channels, ${list.length} ${list.length === 1 ? 'channel' : 'channels'}`,
    totalUnread ? `${totalUnread} unread` : '',
  ].filter(Boolean).join(', ');

  return (
    <section className={`bt-group ch-rail${collapsed ? ' is-collapsed' : ''}`} data-group="__channels__">
      <div className="bt-group-head ch-rail-head">
        <button
          type="button"
          className="bt-group-toggle"
          aria-expanded={!collapsed}
          aria-controls={bodyId}
          aria-label={summary}
          title={summary}
          onClick={toggleCollapsed}
        >
          <ChevronRight className="bt-group-chev" size={15} aria-hidden="true" />
          <span className="bt-group-name ch-rail-title">Channels</span>
          <span className="bt-group-count" aria-hidden="true">{list.length}</span>
          {collapsed && totalUnread > 0 ? (
            <span className="bt-group-chips" aria-hidden="true">
              <span className="bt-unread" title={`${totalUnread} waiting`}>{totalUnread > 9 ? '9+' : totalUnread}</span>
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className="bt-iconbtn ch-rail-add"
          onClick={() => { setCollapsedPersisted(false); setCreating((c) => !c); setError(null); }}
          title="New channel"
          aria-label="New channel"
          aria-expanded={creating}
        >
          <Plus size={15} />
        </button>
      </div>

      <div id={bodyId} className="bt-group-body" role="group" aria-label="Channels" inert={collapsed}>
        <div className="bt-group-body-inner">
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

          {list.map((channel) => {
            const isActive = activeChannelId === channel.id;
            const memberLabel = channel.members.length ? channel.members.join(', ') : 'No members';
            const unread = channel.unread ?? 0;
            return (
              <button
                key={channel.id}
                type="button"
                className={`bt-conv ch-row${isActive ? ' on active' : ''}`}
                onClick={() => onOpenChannel(channel.id)}
                title={`#${channel.name} · ${memberLabel}${unread ? ` · ${unread} unread` : ''}`}
              >
                <span className="bt-disc ch-row-disc" aria-hidden="true">
                  <Hash size={18} />
                </span>
                <span className="bt-conv-main">
                  <span className="bt-conv-top">
                    <span className="bt-conv-title ch-row-name">{channel.name}</span>
                    {unread > 0 && !isActive ? (
                      <span className="bt-unread" title={`${unread} waiting`} aria-label={`${unread} unread`}>
                        {unread > 9 ? '9+' : unread}
                      </span>
                    ) : null}
                    <span className="bt-group-count ch-row-count">{channel.members.length}</span>
                  </span>
                  <span className="bt-conv-sub ch-row-members">{memberLabel}</span>
                </span>
              </button>
            );
          })}
          {!list.length && !creating ? <div className="bt-group-empty ch-empty">No channels yet — add one with +.</div> : null}
        </div>
      </div>
    </section>
  );
}