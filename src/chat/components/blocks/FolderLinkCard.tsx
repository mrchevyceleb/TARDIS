import { FolderOpen, FolderOutput, FolderTree } from 'lucide-react';
import { useStudioFiles } from '../../../shell/studio/studioFiles';
import { buildLinkUrls, canOpenOnThisPc, fileManagerName, normalizeWorkspacePath, openWorkspaceLink } from '../../utils/proxyLinks';

// Click reveals the folder in TARDIS's own file tree. The side button does
// the same explicitly. In the desktop shell a second button opens the folder in
// the PC's own file manager. Outside the Studio shell it falls back to opening
// the folder in Windows Explorer via the rivendell:// handler.
export function FolderLinkCard({ path, title }: { path: string; title?: string }) {
  const studio = useStudioFiles();
  const normalizedPath = normalizeWorkspacePath(path);
  const safePath = normalizedPath ?? path;
  const display = title || (safePath === '' ? 'ASSISTANT-HUB' : safePath.split('/').pop() || safePath);
  const { windowsPath } = buildLinkUrls(safePath, 'folder');
  const onThisPc = normalizedPath !== null && canOpenOnThisPc(normalizedPath, 'folder');

  const openPrimary = () => {
    if (normalizedPath === null) return;
    if (studio) { studio.revealFolder(normalizedPath); return; }
    openWorkspaceLink(normalizedPath, 'folder');
  };

  return (
    <span className="chat-link-card-row">
      <button
        type="button"
        className="chat-link-card"
        onClick={openPrimary}
        title={studio ? `Reveal ${display} in the file tree` : `Open ${display} in File Explorer (${windowsPath})`}
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
              if (normalizedPath !== null) openWorkspaceLink(normalizedPath, 'folder');
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
            else openWorkspaceLink(normalizedPath, 'folder');
          }}
          title={studio ? 'Reveal in file tree' : `Open ${display} in File Explorer (${windowsPath})`}
        >
          <FolderTree size={13} />
        </button>
      </span>
    </span>
  );
}
