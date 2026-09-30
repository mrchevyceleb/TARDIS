import { FolderOpen, FolderOutput, FolderTree } from 'lucide-react';
import { useContext } from 'react';
import { ProxyViewerContext } from '../../../hooks/useProxyViewer';
import { useStudioFiles } from '../../../shell/studio/studioFiles';
import { buildLinkUrls, canOpenOnThisPc, fileManagerName, normalizeWorkspacePath, openWorkspaceLink } from '../../utils/proxyLinks';

// In the desktop shell a plain click opens the folder in the PC's own file
// manager (same as the Explorer button); when it is not synced to this PC, or
// anywhere else, it opens a closable file list. Inside the classic Studio
// shell it reveals the folder in Studio's own tree. It never navigates the app
// away.
export function FolderLinkCard({ path, title }: { path: string; title?: string }) {
  const studio = useStudioFiles();
  const viewer = useContext(ProxyViewerContext);
  const normalizedPath = normalizeWorkspacePath(path);
  const safePath = normalizedPath ?? path;
  const display = title || (safePath === '' ? 'ASSISTANT-HUB' : safePath.split('/').pop() || safePath);
  const { windowsPath } = buildLinkUrls(safePath, 'folder');
  const onThisPc = normalizedPath !== null && canOpenOnThisPc(normalizedPath, 'folder');

  const showList = () => { if (normalizedPath !== null) viewer?.open({ source: 'folder', path: normalizedPath }); };
  const openPrimary = () => {
    if (normalizedPath === null) return;
    if (onThisPc) { openWorkspaceLink(normalizedPath, 'folder', showList); return; }
    if (studio) { studio.revealFolder(normalizedPath); return; }
    if (viewer) { showList(); return; }
    openWorkspaceLink(normalizedPath, 'folder');
  };

  return (
    <span className="chat-link-card-row">
      <button
        type="button"
        className="chat-link-card"
        onClick={openPrimary}
        title={onThisPc ? `Open ${display} in ${fileManagerName()}` : `Show the files in ${display}`}
      >
        <FolderOpen size={16} />
        <span className="chat-link-card-text">
          <span className="chat-link-card-title">{display}</span>
          <span className="chat-link-card-sub">{safePath || 'workspace root'}</span>
        </span>
      </button>
      <span className="chat-link-card-actions">
        {onThisPc ? (
          <button
            type="button"
            className="chat-link-card-action chat-link-card-action-pc"
            onClick={(e) => {
              e.stopPropagation();
              if (normalizedPath !== null) openWorkspaceLink(normalizedPath, 'folder', showList);
            }}
            title={`Open in ${fileManagerName()}`}
            aria-label={`Open ${display} in ${fileManagerName()}`}
          >
            <FolderOutput size={13} />
            <span>{fileManagerName() === 'Explorer' ? 'Explorer' : 'Open folder'}</span>
          </button>
        ) : null}
        <button
          type="button"
          className="chat-link-card-action"
          onClick={(e) => {
            e.stopPropagation();
            if (normalizedPath === null) return;
            if (studio) studio.revealFolder(normalizedPath);
            else if (viewer) showList();
            else openWorkspaceLink(normalizedPath, 'folder');
          }}
          title="Show the files in this folder"
        >
          <FolderTree size={13} />
        </button>
      </span>
    </span>
  );
}
