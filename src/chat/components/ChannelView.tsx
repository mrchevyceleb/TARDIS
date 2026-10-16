// The channel view: history on top, composer at the bottom, and the
// channel's management (rename, members, delete) in the header menu.
// Channel talk lives only here; it never lands in a teammate's one-on-one
// thread.
//
// Channels work exactly like the main chat (Matt, Oct 16): the same Composer
// (images, attachments, dictation, keys) and the same message rendering
// through the block renderer — Matt's posts render as user bubbles with
// image attachments from the shared attachment store, and members' posts
// render with the sender's identity like any teammate message.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Ellipsis, Hash, Pencil, Pin, PinOff, Square, Trash2, Users, X } from 'lucide-react';
import { channelError, useChannelActions, useChannelLive, useChannelMessages, useChannels, type ChannelMessage } from '../hooks/useChannels';
import type { Agent } from '../../grok/agents';
import type { ChatBlock } from '../data/types';
import { ChatThread, type ThreadPin } from './reimagine/blocks';
import { AttachButton, Composer, type SendImage } from './reimagine/Composer';
import { Plus } from './reimagine/icons';
import { DRAFT_APPEND_EVENT, type DraftAppendDetail } from '../../native/shell';
import { apiJson } from '../../data/api';
import { MESSAGE_PINS_CHANGED, scrollToPinnedMessage } from '../../grok/messagePins';
import { parsePinLinkTarget } from '../utils/proxyLinks';
import { onPresenceChange, userPresent } from '../utils/userPresence';
import { useMediaQuery } from '../hooks/useMediaQuery';
import './channels.css';

type EditMode = 'none' | 'rename' | 'members';

/** One pin row from a member's own board (message pins and team_pin notes
 *  alike — the store is the same). */
type ChannelPin = { id: string; agentId: string; member: string; blockId: string; text: string; ts: number };

/** Base message id of a pin target: link/selection pins use synthetic
 *  `<msg>::link-…` / `<msg>::sel-…` ids on top of the real message id. */
function pinBaseId(blockId: string): string {
  return blockId.includes('::') ? blockId.split('::')[0] : blockId;
}

/** Channel history through the main chat's block model: Matt's posts are
 *  user bubbles (markdown + image attachments served from the same
 *  /api/chat/attachments files the main chat uses), and members' posts
 *  render as assistant bubbles with the sender's name. */
function messageBlocks(list: ChannelMessage[]): ChatBlock[] {
  return list.map((m) => {
    const parsed = m.createdAt ? Date.parse(m.createdAt) : NaN;
    const ts = Number.isFinite(parsed) ? parsed : 0;
    if (m.from === 'Matt') {
      return {
        kind: 'user' as const,
        id: m.id,
        text: m.text,
        ts,
        ...(m.images?.length
          ? { images: m.images.map((a) => ({ mediaType: a.mediaType, dataUrl: `/api/chat/attachments/${a.id}` })) }
          : {}),
      };
    }
    return {
      kind: 'text' as const,
      id: m.id,
      from: m.from,
      text: m.text,
      ts,
      presentation: 'answer' as const,
      open: false,
    };
  });
}

export function ChannelView({ channelId, agents, onDeleted }: {
  channelId: string;
  agents: Agent[];
  onDeleted: () => void;
}) {
  const isMobile = useMediaQuery('(max-width: 760px), (pointer: coarse) and (max-width: 1180px)');
  const channels = useChannels();
  const messages = useChannelMessages(channelId);
  const actions = useChannelActions();
  const live = useChannelLive(channelId);
  const channel = channels.data?.channels.find((c) => c.id === channelId);

  const [text, setText] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState<EditMode>('none');
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState<Record<string, boolean>>({});
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const [pins, setPins] = useState<ChannelPin[]>([]);
  const [pinsOpen, setPinsOpen] = useState(false);
  const attachRef = useRef<() => void>(() => {});
  const listRef = useRef<HTMLDivElement>(null);
  const noteTimer = useRef<number | null>(null);

  // Files dropped onto the window announce their workspace path via DRAFT_APPEND_EVENT,
  // mirroring GrokConversation so drag-and-drop works identically in channels.
  useEffect(() => {
    const onAppend = (event: Event) => {
      const detail = (event as CustomEvent<DraftAppendDetail>).detail;
      if (!detail?.text) return;
      detail.handled = true;
      setText((prev) => {
        const current = prev.replace(/\s+$/, '');
        return current ? `${current} ${detail.text} ` : `${detail.text} `;
      });
    };
    window.addEventListener(DRAFT_APPEND_EVENT, onAppend);
    return () => window.removeEventListener(DRAFT_APPEND_EVENT, onAppend);
  }, []);

  // Stop state belongs to one channel: switching channels must not carry a
  // pending Stop, a note, or its timer into the next view, and the timer
  // must never outlive this component (review 3, P2 9).
  useEffect(() => {
    setStopping({});
    setStoppedNote(null);
    if (noteTimer.current) { window.clearTimeout(noteTimer.current); noteTimer.current = null; }
  }, [channelId]);
  useEffect(() => () => { if (noteTimer.current) window.clearTimeout(noteTimer.current); }, []);

  const memberKey = channel?.members.join(',') ?? '';
  // Roster ids for the channel's members: a member's pin board is keyed by
  // its agent id, so a name without a live roster entry has no board here.
  const memberAgents = useMemo(
    () => (channel?.members ?? [])
      .map((name) => ({ name, agent: agents.find((a) => a.name === name) }))
      .filter((m): m is { name: string; agent: Agent } => Boolean(m.agent))
      .map((m) => ({ name: m.name, id: m.agent.id })),
    [memberKey, agents], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const memberAgentKey = memberAgents.map((m) => m.id).join(',');

  // Every member's board in one list, refreshed on the same events the
  // one-on-one pane uses (agents pin server-side, which raises no browser
  // event — hence the poll) so the drawer and the message rows stay true.
  // Per-agent failures keep that member's previous rows (a transient 5xx
  // must never blank a board and turn the next pin click into an unpin),
  // and a request sequence drops out-of-order responses.
  const pullSeq = useRef(0);
  useEffect(() => {
    let alive = true;
    const pull = async () => {
      // Fresh sequence per pull: the newest request wins, so an older
      // interval pull resolving last can never revert a fresh event pull.
      const seq = ++pullSeq.current;
      const ids = memberAgentKey ? memberAgentKey.split(',') : [];
      const rows = await Promise.all(ids.map(async (agentId) => {
        try {
          const r = await apiJson<{ pins: Array<{ id: string; blockId: string; text: string; ts: number }> }>(`/api/message-pins?agentId=${encodeURIComponent(agentId)}`);
          const member = memberAgents.find((m) => m.id === agentId)?.name ?? agentId;
          return { ok: true as const, pins: (r.pins ?? []).map((p) => ({ ...p, agentId, member })) };
        } catch {
          return { ok: false as const, agentId, pins: [] as ChannelPin[] };
        }
      }));
      if (!alive || seq !== pullSeq.current) return;
      setPins((prev) => {
        const next = rows.flatMap((r) => r.pins);
        // Keep the previous rows for agents whose fetch failed: a transient
        // 5xx must never blank a board and turn the next pin click into an unpin.
        const failed = new Set(rows.filter((r) => !r.ok).map((r) => r.agentId));
        const kept = prev.filter((p) => failed.has(p.agentId));
        return [...kept, ...next];
      });
    };
    void pull();
    const onChange = () => { void pull(); };
    window.addEventListener(MESSAGE_PINS_CHANGED, onChange);
    const iv = window.setInterval(pull, 20_000);
    return () => {
      alive = false;
      window.removeEventListener(MESSAGE_PINS_CHANGED, onChange);
      window.clearInterval(iv);
    };
  }, [memberAgentKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setName(channel?.name ?? '');
    setPicked(channel?.members ?? []);
  }, [channel?.name, memberKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = messages.data?.messages ?? [];
  const listKey = list.map((m) => m.id).join(',');
  const working = live.isError ? [] : live.data?.working ?? [];
  const blocks = useMemo(() => messageBlocks(list), [listKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // New messages always pin the list to the bottom; working-chip changes
  // only re-pin a reader who was already there, so chips arriving never
  // yank someone who scrolled up to read (review finding 11).
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [listKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Unread badge hygiene: while someone is actually looking at this channel,
  // keep the server's read marker at the last message RENDERED here — never
  // the server's head — so a reply nobody saw keeps its badge until it is on
  // screen. Fires when the rendered head changes or presence flips; the
  // server skips the write entirely when the marker already sits there.
  const renderedHeadId = list.length ? list[list.length - 1].id : '';
  useEffect(() => {
    if (!userPresent() || !renderedHeadId) return;
    void actions.markRead.mutateAsync({ id: channelId, upTo: renderedHeadId }).catch(() => {});
  }, [channelId, renderedHeadId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => onPresenceChange((present) => {
      if (present && renderedHeadId) void actions.markRead.mutateAsync({ id: channelId, upTo: renderedHeadId }).catch(() => {});
    }),
    [channelId, renderedHeadId], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const stoppingCount = Object.keys(stopping).length;
  useEffect(() => {
    const node = listRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [working.length, stoppingCount, stoppedNote !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  const closeMenu = () => { setMenuOpen(false); setError(null); };

  // Pin a channel message to the sender's own board (card-1327b9: each
  // member's pin board works in the channel too). The POST is a toggle
  // server-side, exactly like the one-on-one pane, and the change event
  // refreshes this view immediately — a stale list would turn the next
  // click into an accidental unpin.
  const togglePin = async (target: { blockId: string; text: string; ts: number }): Promise<boolean | 'error'> => {
    const sender = list.find((m) => m.id === pinBaseId(target.blockId))?.from ?? '';
    const agentId = memberAgents.find((m) => m.name === sender)?.id;
    if (!agentId) {
      setStoppedNote(`${sender || 'That sender'} has no board here.`);
      if (noteTimer.current) window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => setStoppedNote(null), 4000);
      return 'error';
    }
    try {
      const r = await apiJson<{ pinned: boolean }>('/api/message-pins', {
        method: 'POST',
        body: JSON.stringify({ agentId, ...target }),
      });
      return Boolean(r.pinned);
    } catch {
      return 'error';
    } finally {
      window.dispatchEvent(new Event(MESSAGE_PINS_CHANGED));
    }
  };

  const unpin = async (id: string) => {
    try {
      await apiJson(`/api/message-pins/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {
      /* the next poll restores the row if the delete missed */
    }
    window.dispatchEvent(new Event(MESSAGE_PINS_CHANGED));
  };

  const pin: ThreadPin = {
    pinnedBlockIds: pins.map((p) => p.blockId),
    onToggle: togglePin,
  };

  const send = async (sendText: string, images?: SendImage[]): Promise<boolean> => {
    if ((!sendText.trim() && !images?.length) || actions.post.isPending) return false;
    try {
      const clean = images?.map(({ mediaType, base64 }) => ({ mediaType, base64 }));
      await actions.post.mutateAsync({
        channelId,
        from: 'Matt',
        person: true,
        text: sendText,
        ...(clean?.length ? { images: clean } : {}),
      });
      setText('');
      return true;
    } catch (e) {
      setError(channelError(e));
      return false;
    }
  };

  const stopMember = async (member: string) => {
    setStopping((s) => ({ ...s, [member]: true }));
    try {
      const { stopped, dropped } = await actions.stopMember.mutateAsync({ channelId, member });
      if (!stopped.length) {
        const note = dropped > 0
          ? `Cleared ${dropped} queued ping${dropped === 1 ? '' : 's'} for ${member}.`
          : `${member} had nothing from this channel running.`;
        setStoppedNote(note);
        if (noteTimer.current) window.clearTimeout(noteTimer.current);
        noteTimer.current = window.setTimeout(() => setStoppedNote(null), 4000);
      }
    } catch (e) {
      setError(channelError(e));
    } finally {
      setStopping((s) => { const next = { ...s }; delete next[member]; return next; });
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
    if (!window.confirm(`Delete #${channel?.name ?? 'channel'}? Its history is removed with it.`)) return;
    try {
      await actions.remove.mutateAsync(channelId);
      onDeleted();
    } catch (e) {
      setError(channelError(e));
    }
  };

  if (channels.isError) {
    return (
      <div className="ch-view">
        <div className="ch-missing">Could not load channels. <button type="button" className="ch-create-x" onClick={() => void channels.refetch()}>Retry</button></div>
      </div>
    );
  }
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
        <button type="button" className="bt-iconbtn" onClick={() => { setPinsOpen((o) => !o); }}
          title="Pinned from members" aria-label="Pinned from members" aria-expanded={pinsOpen}>
          <Pin size={15} />
        </button>
        <button type="button" className="bt-iconbtn" onClick={() => setMenuOpen((o) => !o)} title="Channel menu" aria-label="Channel menu" aria-expanded={menuOpen}>
          <Ellipsis size={15} />
        </button>

        {pinsOpen ? (
          <div className="ch-pins" role="dialog" aria-label="Members' pin boards">
            <div className="ch-pins-head">Members’ boards in #{channel?.name ?? 'channel'}</div>
            {!pins.length ? (
              <div className="ch-pins-empty">Nothing pinned yet. Hover or tap a teammate’s message and pin it to their board.</div>
            ) : (() => {
              const inChannel = new Set(list.map((m) => m.id));
              const order = [...(channel?.members ?? []).filter((m) => pins.some((p) => p.member === m)),
                ...[...new Set(pins.map((p) => p.member))].filter((m) => !(channel?.members ?? []).includes(m))];
              return order.map((member) => (
                <div key={member} className="ch-pins-sec">
                  <div className="ch-pins-title">{`Pinned from ${member}`}</div>
                  {pins.filter((p) => p.member === member).map((p) => {
                    const target = parsePinLinkTarget(p.text);
                    const note = (p.text ?? '').trim() || 'Empty note';
                    const jumpable = !target && !p.blockId.startsWith('note-') && inChannel.has(pinBaseId(p.blockId));
                    const body = target?.kind === 'web' ? (
                      <button type="button" className="ch-pins-text" title={`Open ${target.url}`}
                        onClick={() => window.open(target.url, '_blank', 'noopener,noreferrer')}>{note} ↗</button>
                    ) : target ? (
                      <span className="ch-pins-text" title="Workspace link — open it from the one-on-one pane">{note}</span>
                    ) : p.blockId.startsWith('note-') ? (
                      <span className="ch-pins-text" title="Pinned by the agent">{note}</span>
                    ) : jumpable ? (
                      <button type="button" className="ch-pins-text" title="Jump to this message"
                        onClick={() => { setPinsOpen(false); scrollToPinnedMessage(p.blockId); }}>{note}</button>
                    ) : (
                      <span className="ch-pins-text" title="Pinned in another conversation">{note}</span>
                    );
                    return (
                      <div key={p.id} className="ch-pins-row">
                        {body}
                        <button type="button" className="bt-iconbtn ch-pins-unpin" title={`Unpin from ${member}`}
                          aria-label={`Unpin from ${member}`} onClick={() => { void unpin(p.id); }}>
                          <PinOff size={12} />
                        </button>
                      </div>
                    );
                  })}
                </div>
              ));
            })()}
          </div>
        ) : null}

        {menuOpen ? (
          <div className="ch-menu" role="menu">
            <button type="button" className="ch-menu-row" onClick={() => { setEditing('rename'); closeMenu(); }}><Pencil size={13} /> Rename</button>
            <button type="button" className="ch-menu-row" onClick={() => { setEditing('members'); closeMenu(); }}><Users size={13} /> Members</button>
            <button type="button" className="ch-menu-row danger" onClick={() => { void remove(); closeMenu(); }}><Trash2 size={13} /> Delete channel</button>
          </div>
        ) : null}
      </header>

      {pinsOpen ? <div className="ch-menu-scrim" onClick={() => setPinsOpen(false)} /> : null}
      {menuOpen ? <div className="ch-menu-scrim" onClick={closeMenu} /> : null}

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
            {picked.filter((m) => !agents.some((a) => a.name === m)).map((m) => (
              <button key={`gone-${m}`} type="button" className="ch-pick on" title="Former teammate — click to remove"
                onClick={() => setPicked((p) => p.filter((x) => x !== m))} aria-pressed={true}>
                <Check size={11} />
                {m} (gone)
              </button>
            ))}
          </div>
          <button type="button" className="ch-create-go" onClick={() => void saveMembers()}>Save</button>
          <button type="button" className="ch-create-x" onClick={() => setEditing('none')}><X size={11} /> Cancel</button>
        </div>
      ) : null}

      {(working.length || Object.keys(stopping).length || stoppedNote) ? (
        <div className="ch-working">
          {working.map((w) => (
            <span key={w.member} className="ch-working-chip">
              <span className="ch-working-dot" aria-hidden="true" />
              {w.fromChannel
                ? <>{w.member} working{w.lane === 'main' ? '' : ' (background)'}…</>
                : <>{w.member} busy elsewhere…</>}
              {w.fromChannel ? (
                <button type="button" className="ch-working-stop" title={`Stop ${w.member}'s turn in this channel`}
                  aria-label={`Stop ${w.member}'s turn in this channel`} disabled={stopping[w.member] === true}
                  onClick={() => { void stopMember(w.member); }}>
                  <Square size={9} aria-hidden="true" /> Stop
                </button>
              ) : null}
            </span>
          ))}
          {Object.keys(stopping).filter((m) => !working.some((w) => w.member === m && w.fromChannel)).map((m) => (
            <span key={`stopping-${m}`} className="ch-working-chip">Stopping {m}…</span>
          ))}
          {stoppedNote ? <span className="ch-working-chip">{stoppedNote}</span> : null}
        </div>
      ) : null}

      <div className={`ch-body rc ${isMobile ? 'rc-mobile' : 'rc-desktop'}`}>
        <div className="ch-list" ref={listRef}>
          <div className="ch-thread">
            <ChatThread mobile={isMobile} blocks={blocks} status="idle" suppressTyping pin={pin} />
          </div>
          {messages.isError ? <div className="ch-empty">Could not load messages. <button type="button" className="ch-create-x" onClick={() => void messages.refetch()}>Retry</button></div> : null}
          {!list.length && !messages.isError ? <div className="ch-empty">No messages yet. Say hello.</div> : null}
        </div>

        {error && !menuOpen ? <div className="ch-error" role="alert">{error}</div> : null}

        <div className="bt-dock">
          <div className="bt-dock-inner">
            <Composer
              chatId={`channel:${channelId}`}
              robotControl={false}
              value={text}
              onChange={setText}
              onSend={(sendText, images) => send(sendText, images)}
              busy={actions.post.isPending}
              placeholder={`Message ${channel?.name ?? 'channel'}`}
              mentionMembers={memberAgents.map((a) => a.name)}
              leadingSlot={
                <button
                  type="button"
                  className="grok-attach"
                  aria-label="Attach a file"
                  title="Attach a file"
                  onClick={() => attachRef.current()}
                >
                  <Plus />
                </button>
              }
              attachButton={<AttachButton onClick={() => attachRef.current()} />}
              openFileInputRef={attachRef}
              hint={
                <span className="hint">
                  <b>@</b> mention · <b>shift+enter</b> new line
                </span>
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
