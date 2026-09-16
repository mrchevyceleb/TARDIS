import {
  Aperture,
  FileText,
  Hammer,
  LayoutGrid,
  MessageSquare,
  MessageSquarePlus,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Sun,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useJarvis } from '../jarvis/JarvisProvider';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useIsMobile } from '../chat/hooks/useMediaQuery';
import { Forge } from '../rooms/Forge';
import { Council } from '../rooms/Council';
import { useRepos } from '../chat/hooks/useRepos';
import { normalizeWorkspacePath } from '../chat/utils/proxyLinks';
import { useWorkspaceTree } from '../hooks/useRoomData';
import { Evenstar, StarField } from '../theme/Ornaments';
import { ROOM_NAMES } from '../data/roomNames';
import { applyTheme, readTheme } from '../theme/applyTheme';
import { FileTree } from './studio/FileTree';
import { FileTab } from './studio/FileTab';
import { ChatTab, type ChatTabApi } from './studio/ChatTab';
import { StudioFilesContext, type StudioFileActions } from './studio/studioFiles';
import { STUDIO_ACTIVE_KEY, STUDIO_TABS_KEY, STUDIO_TREE_KEY, type StudioTab } from './studio/types';
import './studio/studio.css';

// ─── Boot / persistence ──────────────────────────────────────────────────────

// Room tabs are labelled from the single source of truth even when the tab was
// persisted under an older title.
const LEGACY_CHAT_TITLE = 'Elrond';
function tabTitle(tab: StudioTab): string {
  if (tab.kind === 'council') return ROOM_NAMES.council.name;
  if (tab.kind === 'forge') return ROOM_NAMES.forge.name;
  // Only the exact legacy default is migrated; a user-renamed title survives.
  if (tab.kind === 'chat' && tab.title === LEGACY_CHAT_TITLE) return 'TARDIS';
  return tab.title;
}

function readTabs(): { tabs: StudioTab[]; active: string } {
  const fallback = (): { tabs: StudioTab[]; active: string } => {
    const tab: StudioTab = { id: 'chat:studio-main', kind: 'chat', chatId: 'studio-main', title: 'TARDIS' };
    return { tabs: [tab], active: tab.id };
  };
  try {
    const raw = localStorage.getItem(STUDIO_TABS_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.length) {
      const tabs = parsed.filter((t): t is StudioTab => t && typeof t.id === 'string' && typeof t.kind === 'string');
      if (tabs.length) {
        const storedActive = localStorage.getItem(STUDIO_ACTIVE_KEY);
        const active = tabs.some((t) => t.id === storedActive) ? storedActive! : tabs[0].id;
        return { tabs, active };
      }
    }
  } catch { /* fall through */ }
  return fallback();
}

function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path;
}

let chatSeq = 0;

export function Studio() {
  const jarvis = useJarvis();
  const isMobile = useIsMobile();
  const boot = useMemo(readTabs, []);
  const [tabs, setTabs] = useState<StudioTab[]>(boot.tabs);
  const [active, setActive] = useState<string>(boot.active);
  // Mobile-only "⋯ More" menu (Jarvis / Missions / Engine Room / theme live here so the
  // narrow top bar stays uncluttered and every control keeps a real tap target).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState(() => {
    const stored = localStorage.getItem(STUDIO_TREE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    // No saved preference: collapse by default on phones so the tree doesn't
    // cover the content on first load.
    return typeof window !== 'undefined' && window.innerWidth <= 760;
  });
  const [theme, setTheme] = useState(readTheme);
  const [zoom, setZoom] = useState<number>(() => {
    const v = Number(localStorage.getItem('rivendell:zoom'));
    return v >= 0.7 && v <= 2 ? v : 1;
  });
  const [dirtyById, setDirtyById] = useState<Record<string, boolean>>({});
  const [reveal, setReveal] = useState<{ path: string; n: number } | null>(null);
  const revealSeq = useRef(0);
  // Inline rename for chat tabs (right-click or double-click a chat tab).
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [treeWidth, setTreeWidth] = useState<number>(() => {
    const v = Number(localStorage.getItem('rivendell:studio-tree-w'));
    return v >= 180 && v <= 640 ? v : 300;
  });
  const stepZoom = (d: number) => setZoom((z) => Math.min(2, Math.max(0.7, Math.round((z + d) * 100) / 100)));

  // Drag the divider between the file tree and the content to resize.
  const startTreeResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = treeWidth;
    const z = zoom || 1;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(640, Math.max(180, startW + (ev.clientX - startX) / z));
      setTreeWidth(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const { repos } = useRepos();
  const assistantHubRepo = repos.find((r) => r.isAssistantHub) ?? repos[0];
  const { data: treeData } = useWorkspaceTree();

  // Registry of live chat send() fns, keyed by chatId, plus pending "Ask TARDIS" sends.
  const chatApis = useRef<Map<string, ChatTabApi>>(new Map());
  const pendingAsk = useRef<Map<string, string>>(new Map());

  // ── persistence ──
  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { localStorage.setItem('rivendell:zoom', String(zoom)); }, [zoom]);
  useEffect(() => { localStorage.setItem('rivendell:studio-tree-w', String(Math.round(treeWidth))); }, [treeWidth]);
  useEffect(() => { localStorage.setItem(STUDIO_TABS_KEY, JSON.stringify(tabs)); }, [tabs]);
  useEffect(() => { localStorage.setItem(STUDIO_ACTIVE_KEY, active); }, [active]);
  useEffect(() => { localStorage.setItem(STUDIO_TREE_KEY, String(treeCollapsed)); }, [treeCollapsed]);

  // Close the mobile "More" menu on outside pointer / Escape. Escape also returns
  // focus to the trigger so keyboard users aren't dropped onto <body>.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (moreRef.current && !moreRef.current.contains(e.target as Node)) setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setMoreOpen(false); moreBtnRef.current?.focus(); }
    };
    document.addEventListener('pointerdown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [moreOpen]);
  // On open, move focus into the popover (first item) for keyboard users.
  useEffect(() => {
    if (moreOpen) moreMenuRef.current?.querySelector('button')?.focus();
  }, [moreOpen]);
  // Leaving mobile width tears the menu down so it can't linger as a stray popover.
  useEffect(() => { if (!isMobile) setMoreOpen(false); }, [isMobile]);

  // ── deep link: ?path=foo opens that file ──
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const path = params.get('path')?.replace(/^\//, '');
    if (path) {
      openFileTab(path, fileName(path));
      params.delete('path');
      const search = params.toString();
      window.history.replaceState({}, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
      return;
    }
    // First visit with only chat tabs: open Notion-style home.md once.
    const seen = localStorage.getItem('rivendell:opened-hub-home');
    if (!seen) {
      localStorage.setItem('rivendell:opened-hub-home', '1');
      openFileTab('home.md', 'home.md');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── tab ops ──
  const activate = useCallback((id: string) => setActive(id), []);

  const openFileTab = useCallback((path: string, name: string) => {
    const id = `file:${path}`;
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, kind: 'file', path, title: name }]));
    setActive(id);
    // On phones the tree overlays the content — close it so the file is visible.
    if (typeof window !== 'undefined' && window.innerWidth <= 760) setTreeCollapsed(true);
  }, []);

  // Reveal a folder in the tree: open the tree if collapsed, then ask FileTree
  // to expand the ancestor chain and scroll the target into view.
  const revealFolder = useCallback((path: string) => {
    const normalizedPath = normalizeWorkspacePath(path);
    if (normalizedPath === null) return;
    setTreeCollapsed(false);
    setReveal({ path: normalizedPath, n: ++revealSeq.current });
  }, []);

  // Actions chat (and link cards) call to open workspace links inside TARDIS.
  const fileActions = useMemo<StudioFileActions>(() => ({
    openFile: (path: string, name?: string) => {
      const normalizedPath = normalizeWorkspacePath(path);
      if (normalizedPath === null) return;
      openFileTab(normalizedPath, name ?? fileName(normalizedPath));
    },
    revealFolder,
  }), [openFileTab, revealFolder]);

  const openChatTab = useCallback(() => {
    const chatId = `studio-${Date.now()}-${chatSeq++}`;
    const id = `chat:${chatId}`;
    setTabs((prev) => [...prev, { id, kind: 'chat', chatId, title: 'TARDIS' }]);
    setActive(id);
    return chatId;
  }, []);

  const openForgeTab = useCallback(() => {
    const id = 'forge';
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, kind: 'forge', title: ROOM_NAMES.forge.name }]));
    setActive(id);
  }, []);

  const openCouncilTab = useCallback(() => {
    const id = 'council';
    setTabs((prev) => (prev.some((t) => t.id === id) ? prev : [...prev, { id, kind: 'council', title: ROOM_NAMES.council.name }]));
    setActive(id);
  }, []);

  // Retarget open file tabs after a tree drag-move (path prefix rewrite).
  const handlePathsMoved = useCallback((from: string, to: string) => {
    setTabs((prev) => prev.map((tab) => {
      if (tab.kind !== 'file' || !tab.path) return tab;
      if (tab.path === from || tab.path.startsWith(`${from}/`)) {
        const nextPath = tab.path === from ? to : `${to}${tab.path.slice(from.length)}`;
        return { ...tab, id: `file:${nextPath}`, path: nextPath, title: fileName(nextPath) };
      }
      return tab;
    }));
    setActive((cur) => {
      if (!cur.startsWith('file:')) return cur;
      const path = cur.slice('file:'.length);
      if (path === from || path.startsWith(`${from}/`)) {
        const nextPath = path === from ? to : `${to}${path.slice(from.length)}`;
        return `file:${nextPath}`;
      }
      return cur;
    });
    setDirtyById((prev) => {
      const next: Record<string, boolean> = {};
      for (const [id, dirty] of Object.entries(prev)) {
        if (!id.startsWith('file:')) { next[id] = dirty; continue; }
        const path = id.slice('file:'.length);
        if (path === from || path.startsWith(`${from}/`)) {
          const nextPath = path === from ? to : `${to}${path.slice(from.length)}`;
          next[`file:${nextPath}`] = dirty;
        } else {
          next[id] = dirty;
        }
      }
      return next;
    });
  }, []);


  const closeTab = useCallback((id: string) => {
    setTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== id);
      if (next.length === 0) {
        const tab: StudioTab = { id: 'chat:studio-main', kind: 'chat', chatId: 'studio-main', title: 'TARDIS' };
        setActive(tab.id);
        return [tab];
      }
      setActive((cur) => (cur !== id ? cur : (next[Math.max(0, idx - 1)] ?? next[0]).id));
      return next;
    });
  }, []);

  // Persist a new tab title (trims; an empty title is ignored so a tab can never
  // lose its label). setTabs auto-saves to localStorage, so renames survive reload.
  const renameTab = useCallback((id: string, title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title: trimmed } : t)));
  }, []);

  const startRename = useCallback((tab: StudioTab) => {
    setDraftTitle(tab.title);
    setEditingTabId(tab.id);
  }, []);

  const registerChatApi = useCallback((chatId: string, api: ChatTabApi | null) => {
    if (api) {
      chatApis.current.set(chatId, api);
      const pending = pendingAsk.current.get(chatId);
      if (pending) { pendingAsk.current.delete(chatId); api.send(pending); }
    } else {
      chatApis.current.delete(chatId);
    }
  }, []);

  const onDirtyChange = useCallback((id: string, dirty: boolean) => {
    setDirtyById((prev) => (prev[id] === dirty ? prev : { ...prev, [id]: dirty }));
  }, []);

  // ── Ask TARDIS about a file: route to an existing chat tab, or open one ──
  const askElrond = useCallback((path: string) => {
    const message = `Please open and review \`ASSISTANT-HUB/${path}\`.`;
    setTabs((prev) => {
      const activeTab = prev.find((t) => t.id === active);
      const target = (activeTab?.kind === 'chat' ? activeTab : prev.find((t) => t.kind === 'chat')) ?? null;
      if (target?.chatId) {
        setActive(target.id);
        const api = chatApis.current.get(target.chatId);
        if (api) api.send(message);
        else pendingAsk.current.set(target.chatId, message);
        return prev;
      }
      // no chat tab open — create one and queue the message
      const chatId = `studio-${Date.now()}-${chatSeq++}`;
      const id = `chat:${chatId}`;
      pendingAsk.current.set(chatId, message);
      setActive(id);
      return [...prev, { id, kind: 'chat', chatId, title: 'TARDIS' }];
    });
  }, [active]);

  const dirtyPaths = useMemo(() => {
    const set = new Set<string>();
    for (const t of tabs) if (t.kind === 'file' && t.path && dirtyById[t.id]) set.add(t.path);
    return set;
  }, [tabs, dirtyById]);

  const activeTab = tabs.find((t) => t.id === active);
  const activeFileDirty = activeTab?.kind === 'file' ? Boolean(dirtyById[activeTab.id]) : false;

  const tabIcon = (kind: StudioTab['kind']) =>
    kind === 'file' ? <FileText size={13} /> : kind === 'council' ? <LayoutGrid size={13} /> : kind === 'forge' ? <Hammer size={13} /> : <MessageSquare size={13} />;

  const rootStyle: React.CSSProperties | undefined =
    zoom !== 1 ? { zoom, width: `calc(100vw / ${zoom})`, height: `calc(100dvh / ${zoom})` } : undefined;

  return (
    <StudioFilesContext.Provider value={fileActions}>
      <div className="studio" data-theme={theme} style={rootStyle}>
        <StarField />

        {/* ── Top bar ── */}
        <header className="studio-topbar">
          <div className="studio-brand">
            <Evenstar size={22} color="var(--r-tardis-lit)" glow />
            <strong>TARDIS</strong>
          </div>

          <button
            className="studio-tree-toggle"
            onClick={() => setTreeCollapsed((c) => !c)}
            title={treeCollapsed ? 'Show files' : 'Hide files'}
          >
            {treeCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </button>

          <nav className="studio-tabs r-scroll" role="tablist">
            {tabs.map((tab) => {
              const isActive = tab.id === active;
              const dirty = tab.kind === 'file' && dirtyById[tab.id];
              const isChat = tab.kind === 'chat';
              const isEditing = editingTabId === tab.id;
              const commit = () => { renameTab(tab.id, draftTitle); setEditingTabId(null); };
              return (
                <div
                  key={tab.id}
                  className={`studio-tab ${isActive ? 'active' : ''} ${isEditing ? 'editing' : ''}`}
                  role="tab"
                  aria-selected={isActive}
                  onContextMenu={isChat ? (e) => { e.preventDefault(); startRename(tab); } : undefined}
                >
                  {isEditing ? (
                    <span className="studio-tab-main is-editing">
                      {tabIcon(tab.kind)}
                      <input
                        className="studio-tab-rename"
                        value={draftTitle}
                        autoFocus
                        aria-label="Rename tab"
                        onFocus={(e) => e.currentTarget.select()}
                        onChange={(e) => setDraftTitle(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); commit(); }
                          else if (e.key === 'Escape') { e.preventDefault(); setEditingTabId(null); }
                        }}
                        onBlur={commit}
                      />
                    </span>
                  ) : (
                    <button
                      className="studio-tab-main"
                      onClick={() => activate(tab.id)}
                      onDoubleClick={isChat ? () => startRename(tab) : undefined}
                      title={isChat ? `${tabTitle(tab)} · right-click to rename` : (tab.path ?? tab.title)}
                    >
                      {tabIcon(tab.kind)}
                      <span className="tab-title">{tabTitle(tab)}</span>
                      {dirty ? <span className="tab-dirty">●</span> : null}
                    </button>
                  )}
                  <button className="studio-tab-close" onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }} title="Close" aria-label={`Close ${tabTitle(tab)}`}>
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </nav>

          {isMobile ? (
            /* Mobile: keep the primary "new chat" in reach, fold the rest into ⋯ */
            <div className="studio-topbar-actions studio-actions-mobile">
              <button
                className="studio-newchat-btn"
                onClick={openChatTab}
                title="New chat with TARDIS"
                aria-label="New chat with TARDIS"
              >
                <MessageSquarePlus size={18} />
              </button>
              <div
                className="studio-more"
                ref={moreRef}
                onBlur={(e) => { if (!moreRef.current?.contains(e.relatedTarget as Node)) setMoreOpen(false); }}
              >
                <button
                  ref={moreBtnRef}
                  className="studio-more-btn"
                  onClick={() => setMoreOpen((o) => !o)}
                  aria-haspopup="true"
                  aria-expanded={moreOpen}
                  title="More"
                  aria-label={jarvis.wakeActive ? 'More actions · Jarvis listening for wake word' : 'More actions'}
                >
                  <MoreHorizontal size={18} />
                  {jarvis.wakeActive && <span className="jarvis-summon-dot" aria-hidden="true" />}
                </button>
                {moreOpen ? (
                  <div className="studio-more-menu" ref={moreMenuRef}>
                    <button
                      type="button"
                      onClick={() => { jarvis.summon(); setMoreOpen(false); }}
                      aria-label={jarvis.wakeActive ? 'Summon Jarvis · listening for wake word' : 'Summon Jarvis'}
                    >
                      <Aperture size={17} /> Summon Jarvis
                      {jarvis.wakeActive ? <span className="studio-more-dot" aria-hidden="true" /> : null}
                    </button>
                    <button type="button" onClick={() => { openCouncilTab(); setMoreOpen(false); }}>
                      <LayoutGrid size={17} /> {ROOM_NAMES.council.name}
                    </button>
                    <button type="button" onClick={() => { openForgeTab(); setMoreOpen(false); }}>
                      <Hammer size={17} /> {ROOM_NAMES.forge.name}
                    </button>
                    <button type="button" onClick={() => { setTheme((t) => (t === 'dark' ? 'light' : 'dark')); setMoreOpen(false); }}>
                      {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />} {theme === 'dark' ? 'Light theme' : 'Dark theme'}
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="studio-topbar-actions">
              <button
                className="jarvis-summon-btn"
                onClick={jarvis.summon}
                title={jarvis.wakeActive ? 'Jarvis (listening for wake word · Ctrl+J)' : 'Summon Jarvis (Ctrl+J)'}
              >
                <Aperture size={16} />
                {jarvis.wakeActive && <span className="jarvis-summon-dot" />}
              </button>
              <button onClick={openChatTab} title="New chat with TARDIS"><MessageSquarePlus size={16} /></button>
              <button onClick={openCouncilTab} title={`Open ${ROOM_NAMES.council.name} (task kanban)`}><LayoutGrid size={16} /></button>
              <button onClick={openForgeTab} title={`Open ${ROOM_NAMES.forge.name} (cron & deploy)`}><Hammer size={16} /></button>
              <span className="studio-zoom">
                <button onClick={() => stepZoom(-0.1)} title="Smaller"><ZoomOut size={16} /></button>
                <button className="studio-zoom-pct" onClick={() => setZoom(1)} title="Reset size">{Math.round(zoom * 100)}%</button>
                <button onClick={() => stepZoom(0.1)} title="Bigger"><ZoomIn size={16} /></button>
              </span>
              <button onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))} title="Toggle theme">
                {theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}
              </button>
            </div>
          )}
        </header>

        {/* ── Body: tree | divider | content ── */}
        <div
          className={`studio-body ${treeCollapsed ? 'tree-collapsed' : ''}`}
          style={{ ['--studio-tree-w' as string]: `${Math.round(treeWidth)}px` } as React.CSSProperties}
        >
          <aside className="studio-tree">
            {!treeCollapsed && (
              <FileTree
                selectedPath={activeTab?.kind === 'file' ? activeTab.path : undefined}
                dirtyPaths={dirtyPaths}
                onOpenFile={openFileTab}
                onAskElrond={askElrond}
                onPathsMoved={handlePathsMoved}
                revealPath={reveal?.path}
                revealNonce={reveal?.n}
              />
            )}
          </aside>

          {!treeCollapsed && (
            <div className="studio-divider" onMouseDown={startTreeResize} title="Drag to resize" />
          )}

          <main className="studio-content">
            {tabs.map((tab) => (
              <div key={tab.id} className="studio-pane" hidden={tab.id !== active}>
                {tab.kind === 'file' && tab.path ? (
                  <FileTab id={tab.id} path={tab.path} onDirtyChange={onDirtyChange} onAskElrond={askElrond} />
                ) : tab.kind === 'chat' && tab.chatId ? (
                  <ChatTab chatId={tab.chatId} repo={assistantHubRepo} registerApi={registerChatApi} />
                ) : tab.kind === 'council' ? (
                  <div className="studio-room-pane r-scroll"><Council /></div>
                ) : tab.kind === 'forge' ? (
                  <div className="studio-room-pane r-scroll"><Forge /></div>
                ) : null}
              </div>
            ))}
          </main>
        </div>

        {/* ── Status bar ── */}
        <footer className="studio-statusbar">
          <span className="studio-status-left">
            <span className="r-pulse-dot green" />
            TARDIS online
            <span className="studio-status-sep">·</span>
            {treeData?.displayPath ?? '~/ASSISTANT-HUB'}
          </span>
          <span className="studio-status-right">
            {treeData ? <>{treeData.fileCount ?? 0} files · {treeData.dirCount ?? 0} folders</> : null}
            {activeTab?.kind === 'file' ? (
              <>
                <span className="studio-status-sep">·</span>
                {activeFileDirty ? <span className="studio-status-dirty">unsaved</span> : 'saved'}
              </>
            ) : null}
          </span>
        </footer>
      </div>
    </StudioFilesContext.Provider>
  );
}
