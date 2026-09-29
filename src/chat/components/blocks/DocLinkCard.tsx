import { Eye, ExternalLink, FileText, MonitorUp } from 'lucide-react';
import { useProxyViewer } from '../../../hooks/useProxyViewer';
import { useStudioFiles, viewerPreferred } from '../../../shell/studio/studioFiles';
import { buildLinkUrls, canOpenOnThisPc, normalizeWorkspacePath, openWorkspaceLink, opensOnThisPcByClick } from '../../utils/proxyLinks';

// Click = open the document inside TARDIS: text/code/markdown lands in the
// editor, browser-renderable files render in the in-app overlay. The side
// buttons cover the alternates: Open on PC (desktop shell only) opens the file
// in the PC's own app, Browser opens the file via Tailscale-served HTTP (any
// device), Preview forces the in-app overlay. In the desktop shell a plain
// click on a file that belongs in a real app (web pages, PDFs, images, media,
// Office files, spreadsheets) opens it on the PC too. Outside the Studio shell
// it falls back to the native rivendell:// handler.
export function DocLinkCard({ path, title }: { path: string; title?: string }) {
  const viewer = useProxyViewer();
  const studio = useStudioFiles();
  const normalizedPath = normalizeWorkspacePath(path);
  const safePath = normalizedPath ?? path;
  const { browserUrl, windowsPath } = buildLinkUrls(safePath, 'doc');
  const display = title || safePath.split('/').pop() || safePath;

  const onThisPc = normalizedPath !== null && canOpenOnThisPc(normalizedPath, 'doc');
  const clickOpensOnPc = normalizedPath !== null && opensOnThisPcByClick(normalizedPath, 'doc');

  const openPrimary = () => {
    if (normalizedPath === null) return;
    if (clickOpensOnPc) { openWorkspaceLink(normalizedPath, 'doc'); return; }
    if (studio) {
      if (viewerPreferred(normalizedPath)) { viewer.open({ source: 'doc', path: normalizedPath, title }); return; }
      studio.openFile(normalizedPath, title);
      return;
    }
    openWorkspaceLink(normalizedPath, 'doc');
  };

  return (
    <span className="chat-link-card-row">
      <button
        type="button"
        className="chat-link-card"
        onClick={openPrimary}
        title={clickOpensOnPc
          ? `Open ${display} on this PC`
          : studio ? `Open ${display} in TARDIS` : `Open ${display} natively (${windowsPath})`}
      >
        <FileText size={16} />
        <span className="chat-link-card-text">
          <span className="chat-link-card-title">{display}</span>
          <span className="chat-link-card-sub">{path}</span>
        </span>
      </button>
      <span className="chat-link-card-actions">
        {onThisPc ? (
          <button
            type="button"
            className="chat-link-card-action chat-link-card-action-pc"
            onClick={(e) => {
              e.stopPropagation();
              if (normalizedPath !== null) openWorkspaceLink(normalizedPath, 'doc');
            }}
            title="Open in your PC's app"
            aria-label={`Open ${display} on this PC`}
          >
            <MonitorUp size={13} />
            <span>Open on PC</span>
          </button>
        ) : null}
        <a
          className="chat-link-card-action"
          href={browserUrl}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in browser tab"
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={13} />
        </a>
        <button
          type="button"
          className="chat-link-card-action"
          onClick={(e) => {
            e.stopPropagation();
            if (normalizedPath !== null) viewer.open({ source: 'doc', path: normalizedPath, title });
          }}
          title="Preview in TARDIS"
        >
          <Eye size={13} />
        </button>
      </span>
    </span>
  );
}
