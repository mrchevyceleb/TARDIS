// Desk chat: the Chief of Staff's own Hall thread, docked beside the Desk.
// Right side on desktop, a full-screen sheet on phones. "Discuss" on a card or
// Needs-you row drops a reference chip into the composer; the chip's token
// (`[desk:card-…]`) rides along with the message so the agent can look it up.
// Same thread, same transport as the Chat view: nothing forks.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, Maximize2, MessageCircle, PanelRightClose, X } from 'lucide-react';
import { GrokChat } from '../grok/GrokChat';
import type { ChatMeta } from '../grok/BotPanel';
import { agentAvatarUrl, agentColor, agentMark, DISC_INK, type Agent } from '../grok/agents';
import type { Repo } from '../chat/data/types';
import {
  DESK_DISCUSS_EVENT,
  DESK_FOCUS_EVENT,
  composeDeskMessage,
  type DeskChip,
} from '../data/desk';
import { DeskChatOpenContext } from './deskParts';

const OPEN_KEY = 'rivendell:desk-chat-open';
const MAX_CHIPS = 8;

export { DeskChatOpenContext };

/** The Desk chat's open state and pending chips. Lives in the shell so a
 *  Discuss click can open the panel even while it is closed. */
export function useDeskChat(isMobile: boolean) {
  const [open, setOpenState] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === 'true'; } catch { return false; }
  });
  const [chips, setChips] = useState<DeskChip[]>([]);
  const [focusTick, setFocusTick] = useState(0);

  const setOpen = useCallback((next: boolean) => {
    setOpenState(next);
    try { localStorage.setItem(OPEN_KEY, String(next)); } catch { /* storage unavailable */ }
  }, []);

  useEffect(() => {
    const onDiscuss = (event: Event) => {
      const chip = (event as CustomEvent<DeskChip>).detail;
      if (!chip?.id) return;
      setChips((prev) => (prev.some((c) => c.id === chip.id) ? prev : [...prev, chip].slice(-MAX_CHIPS)));
      setOpen(true);
      setFocusTick((n) => n + 1);
    };
    // On a phone the sheet covers the Desk; a pill click means "show me".
    const onFocus = () => { if (isMobile) setOpen(false); };
    window.addEventListener(DESK_DISCUSS_EVENT, onDiscuss);
    window.addEventListener(DESK_FOCUS_EVENT, onFocus);
    return () => {
      window.removeEventListener(DESK_DISCUSS_EVENT, onDiscuss);
      window.removeEventListener(DESK_FOCUS_EVENT, onFocus);
    };
  }, [isMobile, setOpen]);

  /** Open from a button: focus follows into the panel. */
  const openChat = useCallback(() => {
    setOpen(true);
    setFocusTick((n) => n + 1);
  }, [setOpen]);
  const removeChip = useCallback((id: string) => setChips((prev) => prev.filter((c) => c.id !== id)), []);
  const dropLastChip = useCallback(() => setChips((prev) => prev.slice(0, -1)), []);
  const clearChips = useCallback(() => setChips([]), []);

  return { open, setOpen, openChat, chips, removeChip, dropLastChip, clearChips, focusTick };
}

export type DeskChatState = ReturnType<typeof useDeskChat>;

type DockProps = {
  state: DeskChatState;
  agent: Agent;
  repo: Repo;
  isMobile: boolean;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onOpenStudio: () => void;
  onOpenInChat: () => void;
  onEditAgent: () => void;
  onAgentBrainSaved: () => void;
  onVoice: () => void;
  voiceActive: boolean;
};

const noopMeta = (_meta: ChatMeta) => {};
const noop = () => {};

export function DeskChatDock(props: DockProps) {
  const { state, agent, isMobile } = props;
  const panelRef = useRef<HTMLElement>(null);
  const openerRef = useRef<HTMLButtonElement>(null);

  // Opening (or a Discuss click) moves focus into the panel: the composer on
  // desktop, ready for the question; the Back button on phones, so the soft
  // keyboard does not cover the chip before it is seen.
  useEffect(() => {
    if (!state.focusTick || !state.open) return;
    const raf = window.requestAnimationFrame(() => {
      const panel = panelRef.current;
      const target = isMobile
        ? panel?.querySelector<HTMLElement>('.desk-chat-close')
        : panel?.querySelector<HTMLElement>('textarea');
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(raf);
  }, [state.focusTick, state.open, isMobile]);

  const close = () => {
    state.setOpen(false);
    window.requestAnimationFrame(() => openerRef.current?.focus({ preventScroll: true }));
  };

  if (!state.open) {
    return (
      <button
        ref={openerRef}
        type="button"
        className="desk-chat-fab"
        onClick={state.openChat}
        aria-label={`Chat with ${agent.name} here`}
        title={`Chat with ${agent.name} without leaving the Desk`}
      >
        <MessageCircle size={17} aria-hidden="true" />
        <span>Ask {agent.name}</span>
        {state.chips.length ? <span className="desk-chat-fab-count" aria-hidden="true">{state.chips.length}</span> : null}
      </button>
    );
  }

  const avatar = agentAvatarUrl(agent);
  const header = ({ chips }: { chips: ReactNode }) => (
    <div className="desk-chat-head">
      <span className="bt-disc" style={{ color: DISC_INK, background: agentColor(agent.name) }}>
        {avatar ? <img className="bt-disc-img" src={avatar} alt="" /> : agentMark(agent, agent.name.slice(0, 1))}
      </span>
      <div className="desk-chat-name">
        <strong>{agent.name}</strong>
        <span>Same thread as Chat</span>
      </div>
      {chips}
      <button type="button" className="bt-iconbtn" onClick={props.onOpenInChat} title="Open in Chat" aria-label={`Open ${agent.name} in Chat`}>
        <Maximize2 size={15} />
      </button>
      <button type="button" className="bt-iconbtn desk-chat-close" onClick={close} title={isMobile ? 'Back to the Desk' : 'Hide chat'} aria-label={isMobile ? 'Back to the Desk' : 'Hide chat'}>
        {isMobile ? <ChevronDown size={18} /> : <PanelRightClose size={15} />}
      </button>
    </div>
  );

  const chips = state.chips.map((chip) => (
    <span key={chip.id} className="desk-chip" data-kind={chip.kind} title={chip.title}>
      <span aria-hidden="true">📌</span>
      <span className="desk-chip-title">{chip.title}</span>
      <button type="button" className="desk-chip-x" aria-label={`Remove ${chip.title}`} onClick={() => state.removeChip(chip.id)}>
        <X size={12} />
      </button>
    </span>
  ));

  return (
    <aside
      ref={panelRef}
      className={`desk-chat${isMobile ? ' is-sheet' : ''}`}
      aria-label={`Chat with ${agent.name}`}
      // On phones the sheet covers the Desk: a modal dialog, Escape goes back.
      role={isMobile ? 'dialog' : undefined}
      aria-modal={isMobile || undefined}
      onKeyDown={isMobile ? (event) => {
        if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.stopPropagation(); close(); }
      } : undefined}
    >
      <GrokChat
        key={`${agent.home}:${props.repo.path}`}
        chatId={agent.home}
        lane={agent.engine}
        agent={agent}
        repo={props.repo}
        paneOpen={false}
        onTogglePane={noop}
        onVoice={props.onVoice}
        voiceActive={props.voiceActive}
        theme={props.theme}
        onToggleTheme={props.onToggleTheme}
        onOpenStudio={props.onOpenStudio}
        onOpenAgentEditor={props.onEditAgent}
        onAgentBrainSaved={props.onAgentBrainSaved}
        onMeta={noopMeta}
        dock={{
          header,
          chips,
          chipCount: state.chips.length,
          onBackspaceEmpty: state.dropLastChip,
          placeholder: state.chips.length > 1 ? 'Ask about these' : 'Ask about this',
          takeOutgoing: (text) => {
            const out = composeDeskMessage(state.chips, text);
            state.clearChips();
            return out;
          },
        }}
      />
    </aside>
  );
}
