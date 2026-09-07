// Grok Bot conversation screen, anatomy from the desktop app:
//
//   header:  agent disc + name .............. settings gear, pane toggle >>
//   feed:    agent = left raised-panel bubbles · user = right brass-tinted bubbles
//            working narrative collapses into a Thoughts pod
//   dock:    pill composer  [+]  Message {agent} ............ [brass disc]
//            empty → mic (Jarvis voice) · typing → send · streaming → stop
//
// Same useChatShell brain as the Studio; presentation is pure Grok Bot.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Mic, PanelRightClose, PanelRightOpen, RotateCcw, Settings, Share2, SquarePen } from 'lucide-react';
import type { ShellViewProps } from '../chat/components/reimagine/useChatShell';
import { ChatThread } from '../chat/components/reimagine/blocks';
import { DRAFT_APPEND_EVENT, type DraftAppendDetail } from '../native/shell';
import { Composer, AttachButton } from '../chat/components/reimagine/Composer';
import { CounselPopover, ModelChip } from '../chat/components/reimagine/CounselPicker';
import { Plus } from '../chat/components/reimagine/icons';
import { BotMark } from './GrokLogo';
import { agentMark, DISC_INK, agentColor, agentAvatarUrl, type Agent } from './agents';
import { useAgentMessagePins } from './messagePins';
import { BRAND, THINKING_PHRASES, composerPlaceholders } from '../theme/voice';

export type BotConversationProps = ShellViewProps & {
  agentRecord?: Agent;
  paneOpen: boolean;
  onTogglePane: () => void;
  onVoice: () => void;
  voiceActive: boolean;
  onToggleTheme: () => void;
  theme: 'dark' | 'light';
  onOpenStudio: () => void;
  onOpenAgentEditor: () => void;
};

export function GrokConversation(props: BotConversationProps) {
  const { s, picker } = props;
  const [counselOpen, setCounselOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const attachRef = useRef<() => void>(() => {});
  const settingsRef = useRef<HTMLDivElement | null>(null);

  const agent = props.agentRecord;
  const agentName = agent?.name ?? props.agent ?? BRAND;
  const messagePins = useAgentMessagePins(agent?.id);
  // Fresh array each name change only — the Composer's rotation keys on identity.
  const placeholders = useMemo(() => composerPlaceholders(agentName), [agentName]);

  const empty = s.blocks.length === 0 && !s.busy;

  // Files sent to the ship (drag and drop) announce their workspace path here.
  useEffect(() => {
    const onAppend = (event: Event) => {
      const detail = (event as CustomEvent<DraftAppendDetail>).detail;
      if (!detail?.text) return;
      detail.handled = true;
      const current = s.value.replace(/\s+$/, '');
      s.setValue(current ? `${current} ${detail.text} ` : `${detail.text} `);
    };
    window.addEventListener(DRAFT_APPEND_EVENT, onAppend);
    return () => window.removeEventListener(DRAFT_APPEND_EVENT, onAppend);
  }, [s.value, s.setValue]);

  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (settingsRef.current && !settingsRef.current.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSettingsOpen(false); };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [settingsOpen]);

  const flash = (msg: string) => {
    setToast(msg);
    window.setTimeout(() => setToast(null), 1800);
  };

  const copyTranscript = async () => {
    const text = s.blocks
      .map((b) => {
        if (b.kind === 'user') return `You: ${b.text}`;
        if (b.kind === 'text') return `${agentName}: ${b.text}`;
        return null;
      })
      .filter(Boolean)
      .join('\n\n');
    if (!navigator.clipboard?.writeText) { flash('Copy unavailable'); return; }
    try {
      await navigator.clipboard.writeText(text);
      flash('Conversation copied');
    } catch {
      flash('Copy failed');
    }
  };

  const micDisc = (
    <button
      type="button"
      className={`bt-mic${props.voiceActive ? ' listening' : ''}`}
      aria-label={props.voiceActive ? 'Jarvis is listening' : `Talk to ${agentName}`}
      title={props.voiceActive ? 'Jarvis is listening' : `Talk to ${agentName}`}
      onClick={props.onVoice}
    >
      <Mic size={17} />
    </button>
  );

  const composer = (
    <Composer
      chatId={s.chatId}
      value={s.value}
      onChange={s.setValue}
      onSend={s.send}
      onStop={s.stop}
      onSteer={s.steer}
      busy={s.busy}
      commands={s.commands}
      placeholders={placeholders}
      leadingSlot={
        <button
          type="button"
          className="grok-attach"
          aria-label="Attach images"
          title="Attach images"
          onClick={() => attachRef.current()}
        >
          <Plus />
        </button>
      }
      attachButton={<AttachButton onClick={() => attachRef.current()} />}
      openFileInputRef={attachRef}
      idleAction={micDisc}
      modelChip={<ModelChip picker={picker} onClick={() => setCounselOpen((o) => !o)} />}
      onMellon={(rect) => s.sparks.burst(rect.left + rect.width / 2, rect.top + rect.height / 2)}
    />
  );

  return (
    <div className="rc rc-desktop bt-conv-wrap bt-fade">
      <div className="bt-head">
        <div className="bt-head-agent" title={agent ? `${agent.name} — ${agent.role}` : agentName}>
          <span className="bt-disc" style={agent ? { color: DISC_INK, background: agentColor(agent.name) } : undefined}>{agent && agentAvatarUrl(agent) ? <img className="bt-disc-img" src={agentAvatarUrl(agent) ?? undefined} alt={agent.name} /> : agentMark(agent, agentName.slice(0, 1))}</span>
          <span className="bt-head-name">{agentName}</span>
        </div>
        <div className="bt-head-actions">
          <button className="bt-iconbtn" onClick={props.onOpenAgentEditor} title={agent ? `Edit ${agent.name}` : 'Companion settings'} aria-label={agent ? `Edit ${agent.name}` : 'Companion settings'}>
            <SquarePen size={15} />
          </button>
          <div style={{ position: 'relative' }} ref={settingsRef}>
            <button
              className="bt-iconbtn"
              onClick={() => setSettingsOpen((o) => !o)}
              title="Settings"
              aria-label="Settings"
              aria-haspopup="menu"
              aria-expanded={settingsOpen}
            >
              <Settings size={15} />
            </button>
            {settingsOpen ? (
              <div className="bt-plugins-pop" style={{ left: 'auto', right: 0, top: 38, bottom: 'auto' }} role="menu">
                <button className="bt-plug-row" onClick={() => { void copyTranscript(); setSettingsOpen(false); }}>
                  <Share2 size={16} /> Copy conversation
                </button>
                <button className="bt-plug-row" onClick={() => { s.fresh(); setSettingsOpen(false); }}>
                  <RotateCcw size={16} /> Fresh thread
                </button>
                {agent ? (
                  <button className="bt-plug-row" onClick={() => { props.onOpenAgentEditor(); setSettingsOpen(false); }}>
                    <Settings size={16} /> Edit {agent.name}
                  </button>
                ) : null}
                <button className="bt-plug-row" onClick={() => { props.onToggleTheme(); setSettingsOpen(false); }}>
                  {props.theme === 'dark' ? 'Light mode' : 'Dark mode'}
                </button>
                <button className="bt-plug-row" onClick={() => { props.onOpenStudio(); setSettingsOpen(false); }}>
                  Studio IDE
                </button>
              </div>
            ) : null}
          </div>
          <button
            className="bt-iconbtn bt-pane-toggle"
            onClick={props.onTogglePane}
            title={props.paneOpen ? 'Hide panel' : 'Show panel'}
            aria-label={props.paneOpen ? 'Hide panel' : 'Show panel'}
          >
            {props.paneOpen ? <PanelRightClose size={15} /> : <PanelRightOpen size={15} />}
          </button>
        </div>
      </div>

      {empty ? (
        <div className="bt-empty">
          <BotMark size={64} />
          <div className="bt-empty-title">Give {agentName} a mission.</div>
          {s.error ? <div className="chip" style={{ color: 'var(--r-rose)' }}>{s.error}</div> : null}
        </div>
      ) : (
        <main className="bt-feed" ref={s.sticky.scrollRef} onScroll={s.sticky.onScroll}>
          <div className="bt-feed-inner">
            <ChatThread
              blocks={s.blocks}
              status={s.status}
              contentRef={s.sticky.contentRef}
              bottomRef={s.sticky.bottomRef}
              phrases={THINKING_PHRASES}
              collapseSteps
              suppressTyping={s.automationBusy}
              workingSince={s.workingSince}
              pin={agent ? {
                pinnedBlockIds: messagePins.pins.map((p) => p.blockId),
                onToggle: messagePins.toggle,
              } : undefined}
            />
            {s.error ? (
              <div className="chip" style={{ color: 'var(--r-rose)', borderColor: 'var(--r-line)', background: 'var(--r-bg-card)' }}>
                {s.error}
              </div>
            ) : null}
          </div>
        </main>
      )}

      <button
        type="button"
        className={`jump${s.sticky.unread > 0 || (!s.sticky.pinned && s.busy) ? ' show' : ''}`}
        onClick={s.sticky.jumpToBottom}
      >
        Latest
        {s.sticky.unread > 0 ? <span className="cnt">{s.sticky.unread}</span> : null}
      </button>

      <div className="bt-dock">
        <div className="bt-dock-inner">
          <CounselPopover picker={picker} open={counselOpen} onClose={() => setCounselOpen(false)} />
          {composer}
        </div>
      </div>

      {toast ? <div className="bt-toast" role="status">{toast}</div> : null}
      {s.sparks.sparks}
    </div>
  );
}
