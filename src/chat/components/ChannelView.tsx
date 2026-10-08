// The channel view: history on top, composer at the bottom, and the
// channel's management (rename, members, delete) in the header menu.
// Channel talk lives only here; it never lands in a teammate's one-on-one
// thread.

import { useEffect, useRef, useState } from 'react';
import { Check, Ellipsis, Hash, Pencil, Trash2, Users, X } from 'lucide-react';
import { channelError, useChannelActions, useChannelMessages, useChannels } from '../hooks/useChannels';
import type { Agent } from '../../grok/agents';
import './channels.css';

type EditMode = 'none' | 'rename' | 'members';

export function ChannelView({ channelId, agents, onDeleted }: {
  channelId: string;
  agents: Agent[];
  onDeleted: () => void;
}) {
  const channels = useChannels();
  const messages = useChannelMessages(channelId);
  const actions = useChannelActions();
  const channel = channels.data?.channels.find((c) => c.id === channelId);

  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<EditMode>('none');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const memberKey = channel?.members.join(',') ?? '';
  useEffect(() => {
    setName(channel?.name ?? '');
    setPicked(channel?.members ?? []);
  }, [channel?.name, memberKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = messages.data?.messages ?? [];
  const listKey = list.map((m) => m.id).join(',');
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeMenu = () => { setMenuOpen(false); setError(null); };

  const send = async () => {
    if (!text.trim() || actions.post.isPending) return;
    try {
      await actions.post.mutateAsync({ channelId, from: 'Matt', text });
      setText('');
    } catch (e) {
      setError(channelError(e));
    }
  };

  const saveRename = async () => {
    setError(null);
    if (!name.trim()) { setError('A channel name cannot be blank.'); return; }
    try {
      await actions.patch.mutateAsync({ id: channelId, name: name.trim() });
      setEditing('none');
    } catch (e) {
      setError(channelError(e));
    }
  };

  const saveMembers = async () => {
    setError(null);
    const current = channel?.members ?? [];
    const addMembers = picked.filter((m) => !current.includes(m));
    const removeMembers = current.filter((m) => !picked.includes(m));
    if (!addMembers.length && !removeMembers.length) { setEditing('none'); return; }
    try {
      await actions.patch.mutateAsync({ id: channelId, ...(addMembers.length ? { addMembers } : {}), ...(removeMembers.length ? { removeMembers } : {}) });
      setEditing('none');
    } catch (e) {
      setError(channelError(e));
    }
  };

  const remove = async () => {
    setError(null);
    try {
      await actions.remove.mutateAsync(channelId);
      onDeleted();
    } catch (e) {
      setError(channelError(e));
    }
  };

  if (!channel && !channels.isLoading) {
    return (
      <div className="ch-view">
        <div className="ch-missing">This channel is gone. <button type="button" className="ch-create-x" onClick={onDeleted}>Back</button></div>
      </div>
    );
  }

  return (
    <div className="ch-view">
      <header className="ch-head">
        <Hash size={15} aria-hidden="true" />
        <span className="ch-head-name">{channel?.name ?? '…'}</span>
        <span className="ch-head-members" title={channel?.members.join(', ')}>{channel?.members.length ?? 0} members</span>
        <button type="button" className="bt-iconbtn" onClick={() => setMenuOpen((o) => !o)} title="Channel menu" aria-label="Channel menu" aria-expanded={menuOpen}>
          <Ellipsis size={15} />
        </button>
      </header>

      {menuOpen ? (
        <>
          <div className="ch-menu-scrim" onClick={closeMenu} />
          <div className="ch-menu" role="menu">
            <button type="button" className="ch-menu-row" onClick={() => { setEditing('rename'); closeMenu(); }}><Pencil size={13} /> Rename</button>
            <button type="button" className="ch-menu-row" onClick={() => { setEditing('members'); closeMenu(); }}><Users size={13} /> Members</button>
            <button type="button" className="ch-menu-row danger" onClick={() => { void remove(); closeMenu(); }}><Trash2 size={13} /> Delete channel</button>
          </div>
        </>
      ) : null}

      {editing === 'rename' ? (
        <div className="ch-edit-bar">
          <input className="ch-create-name" value={name} maxLength={80} autoFocus onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setEditing('none'); if (e.key === 'Enter') { e.preventDefault(); void saveRename(); } }} />
          <button type="button" className="ch-create-go" onClick={() => void saveRename()}>Save</button>
          <button type="button" className="ch-create-x" onClick={() => setEditing('none')}><X size={11} /> Cancel</button>
        </div>
      ) : null}

      {editing === 'members' ? (
        <div className="ch-edit-bar ch-edit-members">
          <div className="ch-create-picks">
            {agents.map((a) => (
              <button key={a.id} type="button" className={`ch-pick${picked.includes(a.name) ? ' on' : ''}`}
                onClick={() => setPicked((p) => (p.includes(a.name) ? p.filter((m) => m !== a.name) : [...p, a.name]))}
                aria-pressed={picked.includes(a.name)}>
                {picked.includes(a.name) ? <Check size={11} /> : <span className="ch-pick-dot" aria-hidden="true" />}
                {a.name}
              </button>
            ))}
          </div>
          <button type="button" className="ch-create-go" onClick={() => void saveMembers()}>Save</button>
          <button type="button" className="ch-create-x" onClick={() => setEditing('none')}><X size={11} /> Cancel</button>
        </div>
      ) : null}

      <div className="ch-list" ref={listRef}>
        {list.map((m) => (
          <div key={m.id} className="ch-msg">
            <span className="ch-msg-from">{m.from}</span>
            <span className="ch-msg-text">{m.text}</span>
            <span className="ch-msg-time">{m.createdAt ? new Date(m.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''}</span>
          </div>
        ))}
        {!list.length ? <div className="ch-empty">No messages yet. Say hello.</div> : null}
      </div>

      {error && !menuOpen ? <div className="ch-error" role="alert">{error}</div> : null}

      <div className="ch-composer">
        <textarea
          className="ch-input"
          placeholder={`Message ${channel?.name ?? 'channel'}`}
          value={text}
          rows={2}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <button type="button" className="ch-send" disabled={!text.trim() || actions.post.isPending} onClick={() => void send()}>Send</button>
      </div>
    </div>
  );
}