import { ArrowUp, Copy, ExternalLink, File as FileIcon, FileText, Folder, X } from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Markdown } from '../chat/components/primitives/Markdown';
import { apiJson } from '../data/api';
import type { FileTreeNode, WorkspaceChildrenResponse, WorkspaceFileResponse } from '../data/types';
import { ProxyViewerContext, type ProxyViewerRequest } from '../hooks/useProxyViewer';
import { Button, Chip } from './Primitives';

type ArtifactRecord = {
  id: string;
  kind: 'html' | 'markdown' | 'text';
  title: string;
  byteSize: number;
  createdAt: string;
};

type LoadedDoc = {
  source: 'doc';
  request: { path: string; title?: string };
  file: WorkspaceFileResponse;
};

type LoadedArtifact = {
  source: 'artifact';
  request: { id: string; title?: string };
  record: ArtifactRecord;
  content: string;
};

type LoadedInline = {
  source: 'inline';
  request: { title: string; kind: 'html' | 'markdown' | 'text'; content: string };
};

type LoadedFolder = {
  source: 'folder';
  request: { path: string; title?: string };
  listing: WorkspaceChildrenResponse;
};

type Loaded = LoadedDoc | LoadedArtifact | LoadedInline | LoadedFolder;

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico']);
const VIDEO_EXTS = new Set(['mp4', 'mov', 'webm']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg']);

export function ProxyViewerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ProxyViewerRequest | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const close = useCallback(() => {
    setRequest(null);
    setLoaded(null);
    setError(null);
  }, []);

  const open = useCallback((next: ProxyViewerRequest) => {
    setRequest(next);
  }, []);

  useEffect(() => {
    if (!request) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setLoaded(null);

    (async () => {
      try {
        if (request.source === 'doc') {
          const file = await apiJson<WorkspaceFileResponse>(`/api/docs/file?path=${encodeURIComponent(request.path)}`);
          if (cancelled) return;
          setLoaded({ source: 'doc', request, file });
        } else if (request.source === 'folder') {
          const listing = await apiJson<WorkspaceChildrenResponse>(`/api/docs/children?path=${encodeURIComponent(request.path)}`);
          if (cancelled) return;
          setLoaded({ source: 'folder', request, listing });
        } else if (request.source === 'artifact') {
          const record = await apiJson<ArtifactRecord>(`/api/artifacts/${encodeURIComponent(request.id)}`);
          const contentRes = await fetch(`/api/artifacts/${encodeURIComponent(request.id)}/content`);
          if (!contentRes.ok) throw new Error(`HTTP ${contentRes.status}`);
          const content = await contentRes.text();
          if (cancelled) return;
          setLoaded({ source: 'artifact', request, record, content });
        } else {
          if (cancelled) return;
          setLoaded({ source: 'inline', request });
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, close]);

  const value = useMemo(() => ({ open, close }), [open, close]);

  return (
    <ProxyViewerContext.Provider value={value}>
      {children}
      {request ? (
        <ProxyViewerOverlay
          request={request}
          loaded={loaded}
          loading={loading}
          error={error}
          onClose={close}
        />
      ) : null}
    </ProxyViewerContext.Provider>
  );
}

function ProxyViewerOverlay({
  request,
  loaded,
  loading,
  error,
  onClose,
}: {
  request: ProxyViewerRequest;
  loaded: Loaded | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}) {
  const title = useMemo(() => {
    if (request.source === 'inline') return request.title;
    if (request.title) return request.title;
    if (loaded?.source === 'doc') return loaded.file.name;
    if (loaded?.source === 'artifact') return loaded.record.title;
    if (request.source === 'doc' || request.source === 'folder') return request.path.split('/').pop() || 'Workspace';
    return 'Loading';
  }, [request, loaded]);

  return (
    <div className="proxy-viewer-overlay" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="proxy-viewer" onClick={(event) => event.stopPropagation()}>
        <header className="proxy-viewer-head">
          <div className="proxy-viewer-title">
            <FileText size={18} />
            <div>
              <p className="r-eyebrow-gold">{loaded ? labelFor(loaded) : 'Loading'}</p>
              <h2>{title}</h2>
              <span>{subtitleFor(request, loaded)}</span>
            </div>
          </div>
          <div className="proxy-viewer-actions">
            {loaded ? <CopyPathButton loaded={loaded} /> : null}
            {loaded?.source === 'artifact' ? <OpenRawButton loaded={loaded} /> : null}
            <button className="rail-icon-button" type="button" onClick={onClose} aria-label="Close viewer" title="Close">
              <X size={17} />
            </button>
          </div>
        </header>

        <div className="proxy-viewer-body r-scroll">
          {loading ? <p className="proxy-viewer-status">Reading...</p> : null}
          {error ? <p className="proxy-viewer-status proxy-viewer-error">Could not open: {error}</p> : null}
          {!loading && !error && loaded ? <ProxyViewerContent loaded={loaded} /> : null}
        </div>
      </div>
    </div>
  );
}

/** A simple, closable file list for a workspace folder. Never leaves the app. */
function FolderListing({ loaded }: { loaded: LoadedFolder }) {
  const viewer = useContext(ProxyViewerContext);
  const here = loaded.listing.path ?? loaded.request.path;
  const parent = here.includes('/') ? here.slice(0, here.lastIndexOf('/')) : '';
  const rows: FileTreeNode[] = [...(loaded.listing.children ?? [])].sort((a, b) => (
    (a.type === b.type ? 0 : a.type === 'directory' ? -1 : 1) || a.name.localeCompare(b.name)
  ));
  const openNode = (node: FileTreeNode) => viewer?.open(node.type === 'directory'
    ? { source: 'folder', path: node.path }
    : { source: 'doc', path: node.path, title: node.name });
  return (
    <div className="proxy-folder">
      {here ? (
        <button type="button" className="proxy-folder-row proxy-folder-up" onClick={() => viewer?.open({ source: 'folder', path: parent })}>
          <ArrowUp size={15} />
          <span>Up</span>
        </button>
      ) : null}
      {rows.length === 0 ? <p className="proxy-viewer-status">This folder is empty.</p> : null}
      {rows.map((node) => (
        <button key={node.path} type="button" className="proxy-folder-row" onClick={() => openNode(node)}>
          {node.type === 'directory' ? <Folder size={15} /> : <FileIcon size={15} />}
          <span className="proxy-folder-name">{node.name}</span>
          {node.type === 'file' && typeof node.size === 'number' ? <span className="proxy-folder-size">{formatBytes(node.size)}</span> : null}
        </button>
      ))}
    </div>
  );
}

function ProxyViewerContent({ loaded }: { loaded: Loaded }) {
  if (loaded.source === 'folder') return <FolderListing loaded={loaded} />;
  if (loaded.source === 'inline') {
    if (loaded.request.kind === 'html') {
      return (
        <iframe
          className="proxy-viewer-frame"
          title={loaded.request.title}
          sandbox=""
          srcDoc={loaded.request.content}
        />
      );
    }
    if (loaded.request.kind === 'markdown') {
      return <div className="proxy-viewer-md"><Markdown>{loaded.request.content}</Markdown></div>;
    }
    return <pre className="proxy-viewer-pre">{loaded.request.content}</pre>;
  }

  if (loaded.source === 'artifact') {
    if (loaded.record.kind === 'html') {
      return (
        <iframe
          className="proxy-viewer-frame"
          title={loaded.record.title}
          sandbox=""
          srcDoc={loaded.content}
        />
      );
    }
    if (loaded.record.kind === 'markdown') {
      return <div className="proxy-viewer-md"><Markdown>{loaded.content}</Markdown></div>;
    }
    return <pre className="proxy-viewer-pre">{loaded.content}</pre>;
  }

  const file = loaded.file;
  const ext = file.language || extensionFromName(file.name);
  const rawUrl = `/api/files/raw?path=${encodeURIComponent(file.path)}`;

  if (ext === 'pdf') {
    return (
      <iframe
        className="proxy-viewer-frame"
        title={file.name}
        src={rawUrl}
      />
    );
  }

  if (IMAGE_EXTS.has(ext)) {
    return (
      <div className="proxy-viewer-media">
        <img className="proxy-viewer-image" src={rawUrl} alt={file.name} />
      </div>
    );
  }

  if (VIDEO_EXTS.has(ext)) {
    return <video className="proxy-viewer-video" src={rawUrl} controls />;
  }

  if (AUDIO_EXTS.has(ext)) {
    return <audio className="proxy-viewer-audio" src={rawUrl} controls />;
  }

  if (file.tooLarge) {
    return <p className="proxy-viewer-status">{file.content}</p>;
  }

  if (ext === 'md' || ext === 'markdown' || /\.md$/i.test(file.name)) {
    return <div className="proxy-viewer-md"><Markdown>{file.content}</Markdown></div>;
  }

  if (ext === 'html' || ext === 'htm') {
    return (
      <iframe
        className="proxy-viewer-frame"
        title={file.name}
        sandbox=""
        srcDoc={file.content}
      />
    );
  }

  if (isBinaryNotice(file.content)) {
    return (
      <div className="proxy-viewer-binary">
        <p>{file.content}</p>
        <CopyOneDrivePathBlock path={file.path} />
      </div>
    );
  }

  return <pre className="proxy-viewer-pre">{file.content}</pre>;
}

function CopyOneDrivePathBlock({ path }: { path: string }) {
  return (
    <div className="proxy-viewer-binary-actions">
      <p className="proxy-viewer-binary-hint">
        OneDrive syncs this folder to every device. Paste the path below into Finder (Mac) or Explorer (Windows) to open it natively.
      </p>
      <code className="proxy-viewer-binary-path">{path}</code>
      <Button tone="gold" onClick={() => navigator.clipboard?.writeText(path)}>
        <Copy size={14} />
        Copy OneDrive path
      </Button>
    </div>
  );
}

function CopyPathButton({ loaded }: { loaded: Loaded }) {
  if (loaded.source !== 'doc') return null;
  return (
    <Button tone="ghost" onClick={() => navigator.clipboard?.writeText(loaded.file.path)} title="Copy workspace-relative path">
      <Copy size={14} />
      Copy path
    </Button>
  );
}

function OpenRawButton({ loaded }: { loaded: LoadedArtifact }) {
  return (
    <Button
      tone="ghost"
      onClick={() => window.open(`/api/artifacts/${encodeURIComponent(loaded.record.id)}/content`, '_blank', 'noopener')}
      title="Open raw content in a new tab"
    >
      <ExternalLink size={14} />
      Open raw
    </Button>
  );
}

function labelFor(loaded: Loaded): string {
  if (loaded.source === 'folder') return 'folder';
  if (loaded.source === 'doc') return loaded.file.language || 'document';
  if (loaded.source === 'artifact') return loaded.record.kind;
  return loaded.request.kind;
}

function subtitleFor(request: ProxyViewerRequest, loaded: Loaded | null): string {
  if (loaded?.source === 'doc') return loaded.file.path;
  if (loaded?.source === 'folder') return `/${loaded.listing.path ?? loaded.request.path}`;
  if (loaded?.source === 'artifact') return `${formatBytes(loaded.record.byteSize)} · ${new Date(loaded.record.createdAt).toLocaleString()}`;
  if (loaded?.source === 'inline') return `${loaded.request.kind} preview`;
  if (request.source === 'doc' || request.source === 'folder') return request.path;
  if (request.source === 'inline') return `${request.kind} preview`;
  return 'artifact';
}

function extensionFromName(name: string): string {
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function isBinaryNotice(content: string): boolean {
  return content.startsWith('Binary or unsupported file type');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
