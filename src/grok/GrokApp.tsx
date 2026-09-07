// GrokApp — the Grok Bot shell. Three panes, desktop-app anatomy:
//
//   ┌─ rail ────────┬─ center chat ──────────────┬─ info pane ─────┐
//   │ mark     [+]  │  ○ Agent          ⚙  >>   │  Agent's desk   │
//   │ Search         │                            │  Routines    [+]│
//   │ agents …       │  bubbles + Thoughts pods   │  Session + meter│
//   │ Plugins  You   │  [+ Message Agent … (◉)]  │                 │
//   └────────────────┴────────────────────────────┴─────────────────┘
//
// The team is USER-CURATED (created/edited via the agent editor; seeded with
// one Chief of Staff). Every agent = one persistent forever-thread with
// auto-compaction. Rooms open in the center pane from Plugins; the classic
// Studio IDE stays at /studio.

import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { Menu } from 'lucide-react';
import { apiJson } from '../data/api';
import { useJarvis } from '../jarvis/JarvisProvider';
import { useIsMobile } from '../chat/hooks/useMediaQuery';
import { useRepos } from '../chat/hooks/useRepos';
import { useProxyViewer } from '../hooks/useProxyViewer';
import { StudioFilesContext, type StudioFileActions } from '../shell/studio/studioFiles';
import type { CompanionId } from '../chat/data/types';
import { UPLOAD_MAX_BYTES, uploadWorkspaceFile } from '../data/api';
import { appendToDraft, showToast, TOAST_EVENT } from '../native/shell';
import { BotRail } from './GrokSidebar';
import { GrokChat } from './GrokChat';
import { BotPanel, type ChatMeta } from './BotPanel';
import { AgentEditor } from './AgentEditor';
import { CallOverlay } from '../voice/CallOverlay';
import { useKonami } from '../theme/eggs';
import { applyTheme } from '../theme/applyTheme';
import { TAGLINE } from '../theme/voice';
import { useAgents, reorderAgentIds, patchAgent, sameChatId, type Agent } from './agents';
import { useChatHistory, type HistoryItem } from './history';
import { OPEN_PANE_EVENT } from './messagePins';

import { Council } from '../rooms/Council';
import { Dashboard } from '../rooms/Dashboard';
import { Tidings } from '../rooms/Tidings';
import { Calendar } from '../rooms/Calendar';
import { Hearth } from '../rooms/Hearth';
import { Library } from '../rooms/Library';
import { Pins } from '../rooms/Pins';
import { Reckoning } from '../rooms/Reckoning';
import { Forge } from '../rooms/Forge';
import { Weavings } from '../rooms/Weavings';
import { Annals } from '../rooms/Annals';
import { Scribe } from '../rooms/Scribe';

const ROOMS: Record<string, ComponentType> = {
  council: Council,
  dashboard: Dashboard,
  tidings: Tidings,
  calendar: Calendar,
  hearth: Hearth,
  library: Library,
  pins: Pins,
  reckoning: Reckoning,
  forge: Forge,
  weavings: Weavings,
  annals: Annals,
  scribe: Scribe,
};

type View =
  | { kind: 'chat'; chatId: string; cli?: CompanionId; lane?: string; repoPath?: string }
  | { kind: 'room'; key: string };

const VIEW_KEY = 'rivendell:bot-view';
const PANE_KEY = 'rivendell:bot-pane';

function readView(): View {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.kind === 'chat' && typeof parsed.chatId === 'string') return parsed;
      if (parsed?.kind === 'room' && typeof parsed.key === 'string' && ROOMS[parsed.key]) return parsed;
    }
  } catch { /* fall through */ }
  return { kind: 'chat', chatId: '' }; // resolved against the agent list below
}

export function GrokApp({ initialRoom }: { initialRoom?: string }) {
  const jarvis = useJarvis();
  const viewer = useProxyViewer();
  const isMobile = useIsMobile();
  const { repos } = useRepos();
  const history = useChatHistory();
  const { agents, reload: reloadAgents } = useAgents();

  const [view, setView] = useState<View>(() => {
    if (initialRoom && ROOMS[initialRoom]) return { kind: 'room', key: initialRoom };
    return readView();
  });
  const [paneOpen, setPaneOpen] = useState(() => localStorage.getItem(PANE_KEY) !== 'false');
  const [railCollapsed, setRailCollapsed] = useState(() => localStorage.getItem('rivendell:rail-collapsed') === 'true');
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [meta, setMeta] = useState<ChatMeta | null>(null);
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('rivendell:theme') === 'light' ? 'light' : 'dark',
  );
  const [editorOpen, setEditorOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<Agent | undefined>(undefined);
  const [callAgent, setCallAgent] = useState<Agent | null>(null);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { localStorage.setItem(VIEW_KEY, JSON.stringify(view)); }, [view]);
  useEffect(() => { localStorage.setItem(PANE_KEY, String(paneOpen)); }, [paneOpen]);
  useEffect(() => {
    const open = () => setPaneOpen(true);
    window.addEventListener(OPEN_PANE_EVENT, open);
    return () => window.removeEventListener(OPEN_PANE_EVENT, open);
  }, []);
  useEffect(() => { localStorage.setItem('rivendell:rail-collapsed', String(railCollapsed)); }, [railCollapsed]);
  // Esc also collapses the desktop rail (quick focus-the-chat shortcut).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editorOpen && !callAgent) {
        // The drawer's own Escape handler owns mobile navigation. Letting this
        // desktop shortcut run too persists railCollapsed=true underneath it.
        if (isMobile || drawerOpen) return;
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
        setRailCollapsed(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editorOpen, callAgent, isMobile, drawerOpen]);
  useEffect(() => { if (!isMobile) setDrawerOpen(false); }, [isMobile]);

  // Easter eggs — presentation only. Konami regenerates every disc for a
  // beat; an unknown room path gets a BAD WOLF toast. Neither touches a turn.
  const [regen, setRegen] = useState(false);
  const [eggToast, setEggToast] = useState<string | null>(null);
  const eggTimers = useRef({ toast: 0, regen: 0 });
  const toastEgg = useCallback((msg: string) => {
    window.clearTimeout(eggTimers.current.toast);
    setEggToast(msg);
    eggTimers.current.toast = window.setTimeout(() => setEggToast(null), 2400);
  }, []);
  useKonami(useCallback(() => {
    window.clearTimeout(eggTimers.current.regen);
    setRegen(true);
    eggTimers.current.regen = window.setTimeout(() => setRegen(false), 1400);
    toastEgg(`Type 40 TT Capsule · ${TAGLINE}`);
  }, [toastEgg]));
  useEffect(() => {
    const timers = eggTimers.current;
    return () => { window.clearTimeout(timers.toast); window.clearTimeout(timers.regen); };
  }, []);
  const badWolf = useRef(Boolean(initialRoom && !ROOMS[initialRoom]));
  useEffect(() => {
    if (badWolf.current) { badWolf.current = false; toastEgg('BAD WOLF'); }
  }, [toastEgg]);

  // Short notices from utilities that have no UI of their own.
  useEffect(() => {
    const onToast = (event: Event) => {
      const text = (event as CustomEvent<{ text: string }>).detail?.text;
      if (text) toastEgg(text);
    };
    window.addEventListener(TOAST_EVENT, onToast);
    return () => window.removeEventListener(TOAST_EVENT, onToast);
  }, [toastEgg]);

  // Drop any file onto the console and it lands in the ship's inbox/, with
  // its workspace path appended to the draft so the companion can be told.
  // The composer keeps first claim on image drops (they become attachments).
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const onDragOver = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const onDrop = (e: DragEvent) => {
      if (e.defaultPrevented || !hasFiles(e)) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (!files.length) return;
      void (async () => {
        for (const file of files) {
          if (file.size > UPLOAD_MAX_BYTES) {
            toastEgg(`${file.name} is over 200 MB; sync it to the workspace instead.`);
            continue;
          }
          toastEgg(`Sending ${file.name} to the ship…`);
          try {
            const saved = await uploadWorkspaceFile(`inbox/${file.name}`, file);
            const mention = `ASSISTANT-HUB/${saved.path}`;
            if (appendToDraft(mention)) {
              toastEgg(`Sent to the ship · ${saved.path}`);
            } else {
              // No composer on screen (a room is open): keep the path handy.
              const copied = await navigator.clipboard?.writeText(mention).then(() => true, () => false);
              toastEgg(copied ? `Sent to the ship · ${saved.path} · path copied` : `Sent to the ship · ${saved.path}`);
            }
          } catch (error) {
            toastEgg(`Could not send ${file.name}: ${(error as Error).message}`);
          }
        }
      })();
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
    };
  }, [toastEgg]);

  // Land on the first agent (Chief of Staff) once the list loads, if the
  // persisted view points at a thread that no longer exists.
  useEffect(() => {
    if (view.kind !== 'chat' || view.chatId || !agents.length) return;
    setView({ kind: 'chat', chatId: agents[0].home, lane: agents[0].engine });
  }, [view, agents]);

  // Esc closes the mobile drawer. Never focus its search input automatically:
  // on phones that summons the keyboard over the agent list. Blur the composer
  // and move accessibility focus to the non-text close button instead; do not
  // restore textarea focus on close (that would reopen the keyboard).
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setDrawerOpen(false); };
    window.addEventListener('keydown', onKey);
    (document.activeElement as HTMLElement | null)?.blur?.();
    const raf = window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>('.bt-rail [aria-label="Close sidebar"]')?.focus({ preventScroll: true });
    });
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
      // The close button is removed with the drawer. On the next frame, put
      // keyboard/AT focus on the newly rendered non-text hamburger — never the
      // composer textarea, so the soft keyboard stays closed.
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLElement>('.bt-menubtn[aria-label="Open sidebar"]')?.focus({ preventScroll: true });
      });
    };
  }, [drawerOpen]);

  const hubRepo = repos.find((r) => r.isAssistantHub) ?? repos[0];

  const openAgent = useCallback((a: Agent) => {
    setView({ kind: 'chat', chatId: a.home, lane: a.engine });
    setDrawerOpen(false);
  }, []);

  const openChat = useCallback((item: HistoryItem) => {
    // Reopen on the engine that wrote the log. Strip any legacy account suffix;
    // public defaults use the CLI's normal profile or an explicit server map.
    const baseChatId = item.chatId.replace(/__acct__[a-z0-9-]+$/i, '');
    const cli = item.cli as CompanionId;
    const lane = item.cli;
    setView({ kind: 'chat', chatId: baseChatId, cli, lane, repoPath: item.repo });
    setDrawerOpen(false);
  }, []);

  const openRoom = useCallback((key: string) => {
    setView({ kind: 'room', key });
    setDrawerOpen(false);
  }, []);

  const goHome = useCallback(() => {
    if (agents.length) setView({ kind: 'chat', chatId: agents[0].home, lane: agents[0].engine });
    setDrawerOpen(false);
  }, [agents]);

  const openStudio = useCallback(() => { window.location.assign('/studio'); }, []);
  const onMeta = useCallback((m: ChatMeta) => setMeta(m), []);

  // Ctrl/Cmd+Shift+O opens the agent list's first thread (quick home).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'O' || e.key === 'o')) {
        e.preventDefault();
        goHome();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goHome]);

  const fileActions = useMemo<StudioFileActions>(() => ({
    openFile: (path, name) => viewer.open({ source: 'doc', path, title: name }),
    revealFolder: () => window.location.assign('/studio'),
  }), [viewer]);

  const activeChat = view.kind === 'chat' ? view : undefined;
  const activeRoom = view.kind === 'room' ? view.key : undefined;
  const RoomView = view.kind === 'room' ? ROOMS[view.key] : undefined;
  const agent = activeChat ? agents.find((a) => sameChatId(activeChat.chatId, a.home)) : undefined;

  const chatRepo = activeChat?.repoPath
    ? (repos.find((r) => r.path === activeChat.repoPath) ?? hubRepo)
    : hubRepo;

  return (
    <StudioFilesContext.Provider value={fileActions}>
      <div className={`bot-app${railCollapsed ? ' rail-collapsed' : ''}${regen ? ' regen' : ''}`} data-theme={theme}>
        <BotRail
          collapsed={railCollapsed}
          onToggleCollapse={() => setRailCollapsed((c) => !c)}
          drawerOpen={drawerOpen}
          onCloseDrawer={() => setDrawerOpen(false)}
          agents={agents}
          items={history.items}
          hubRepo={hubRepo?.path}
          activeChat={activeChat ? { chatId: activeChat.chatId, cli: activeChat.cli, repo: activeChat.repoPath } : undefined}
          onOpenChat={openChat}
          onOpenAgent={openAgent}
          onEditAgent={(a) => { setEditTarget(a); setEditorOpen(true); }}
          onPatchAgent={(a, patch) => {
            const previous = { muted: Boolean(a.muted), pinned: Boolean(a.pinned), unread: a.unread };
            void patchAgent(a.id, patch, previous).then(() => reloadAgents()).catch(() => {
              const action = patch.muted !== undefined
                ? (patch.muted ? 'mute' : 'unmute')
                : (patch.pinned ? 'pin' : 'unpin');
              showToast(`Could not ${action} ${a.name}`);
            });
          }}
          onReorder={(ids) => { void reorderAgentIds(ids).then(() => reloadAgents()); }}
          onNewAgent={() => { setEditTarget(undefined); setEditorOpen(true); }}
          activeRoom={activeRoom}
          onOpenRoom={openRoom}
          theme={theme}
          onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          onOpenStudio={openStudio}
          onHome={goHome}
        />

        <div className={`bt-scrim${drawerOpen ? ' show' : ''}`} onClick={() => setDrawerOpen(false)} />

        <main className="bt-main">
          {(isMobile || railCollapsed) && !drawerOpen ? (
            <button
              className="bt-menubtn"
              style={{ position: 'absolute', top: 10, left: 10, zIndex: 26 }}
              onClick={() => {
                (document.activeElement as HTMLElement | null)?.blur?.();
                if (isMobile) setDrawerOpen(true);
                else setRailCollapsed(false);
              }}
              aria-label="Open sidebar"
              title="Open sidebar"
            >
              <Menu size={17} />
            </button>
          ) : null}

          {view.kind === 'chat' ? (
            <GrokChat
              key={`${view.chatId}:${chatRepo?.path ?? ''}`}
              chatId={view.chatId}
              cli={view.cli}
              lane={view.lane}
              agent={agent}
              repo={chatRepo}
              paneOpen={paneOpen}
              onTogglePane={() => setPaneOpen((o) => !o)}
              onOpenAgentEditor={() => { setEditTarget(agent); setEditorOpen(true); }}
              onAgentBrainSaved={reloadAgents}
              onVoice={() => (agent ? setCallAgent(agent) : jarvis.summon())}
              voiceActive={jarvis.wakeActive}
              theme={theme}
              onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
              onOpenStudio={openStudio}
              onMeta={onMeta}
            />
          ) : RoomView ? (
            <div className="bt-room r-scroll" key={activeRoom}>
              <div className="bt-room-wrap bt-fade">
                <RoomView />
              </div>
            </div>
          ) : null}
        </main>

        {view.kind === 'chat' ? (
          <BotPanel
            className={`bt-pane-mount${paneOpen ? ' open' : ''}`}
            agent={agent ?? null}
            meta={meta}
            onOpenForge={() => openRoom('forge')}
            onClose={() => setPaneOpen(false)}
          />
        ) : null}

        {callAgent ? (
          <CallOverlay
            agent={callAgent}
            initialVoice={callAgent.voice ?? 'ara'}
            onClose={() => setCallAgent(null)}
          />
        ) : null}

        <AgentEditor
          open={editorOpen}
          agent={editTarget}
          onClose={() => setEditorOpen(false)}
          onSaved={(saved) => {
            reloadAgents();
            // New companion (or engine change) → open its home thread.
            if (!editTarget || editTarget.engine !== saved.engine) {
              setView({ kind: 'chat', chatId: saved.home, lane: saved.engine });
            }
          }}
          onDeleted={async (deleted) => {
            reloadAgents();
            // Never stay inside — and land on an agent we KNOW still exists
            // (the stale pre-reload list must not resurrect the deleted one).
            if (view.kind === 'chat' && sameChatId(view.chatId, deleted.home)) {
              try {
                const r = await apiJson<{ agents: Agent[] }>('/api/agents');
                const first = (r.agents ?? []).find((a) => a.id !== deleted.id);
                setView(first
                  ? { kind: 'chat', chatId: first.home, lane: first.engine }
                  : { kind: 'chat', chatId: '' });
              } catch {
                setView({ kind: 'chat', chatId: '' });
              }
            }
          }}
        />
        {eggToast ? <div className="bt-toast" role="status">{eggToast}</div> : null}
      </div>
    </StudioFilesContext.Provider>
  );
}

export default GrokApp;
