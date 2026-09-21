import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { memo, useCallback, useContext, type MouseEvent, type ReactNode } from 'react';
import {
  annotateWorkspaceMentions,
  openExternalHttpLink,
  openWorkspaceLink,
  parseProxyHref,
  parseWorkspaceMentionText,
} from '../../utils/proxyLinks';
import { ProxyViewerContext } from '../../../hooks/useProxyViewer';
import { useStudioFiles, viewerPreferred } from '../../../shell/studio/studioFiles';

// Literary-styled wrapper around react-markdown. Agent replies arrive as
// markdown; this renderer leans on the gold/silver theme tokens so emphasis
// (bold, code, headings, lists, quotes) reads at a glance instead of dissolving
// into a wall of ivory text.
//
// CRITICAL: the `components` map and `remarkPlugins` array MUST live at module
// scope. ReactMarkdown converts markdown to React elements whose component
// types are the entries in `components` — if those function references churn
// on every render, React sees a brand-new component type per child, unmounts
// and remounts the entire rendered subtree, and any in-flight text selection
// inside the chat transcript dies on every parent re-render. Hall re-renders
// constantly (WebSocket events, status pills, scribe events), so an inline
// components map = the user cannot copy chat content.

// react-markdown v10 strips unknown URL schemes via its default urlTransform.
// Whitelist our internal proxy schemes so the `a` override below sees them
// and can render in-app cards instead of empty external links.
function proxyUrlTransform(url: string): string {
  if (url.startsWith('rivendell-doc:') || url.startsWith('rivendell-folder:')) return url;
  return defaultUrlTransform(url);
}

const REMARK_PLUGINS = [[remarkGfm, { singleTilde: false }]] as const;

/** CommonMark treats "33607. Hello" as an ordered list starting at 33607.
 *  Chat then used to drop `start` and show "1. Hello", eating zip codes,
 *  years, and ticket numbers. Escape 4+ digit markers outside fences. */
export function protectChatMarkdownLists(input: string): string {
  return input.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~)/).map((part, i) => {
    if (i % 2 === 1) return part;
    return part.replace(/(^|\r?\n)(\d{4,})([.)])(?=\s|$)/g, '$1$2\\$3');
  }).join('');
}

type WorkspaceTarget = { kind: 'doc' | 'folder'; path: string };

const INLINE_CODE_STYLE = {
  fontFamily: 'var(--r-mono)',
  fontSize: '0.92em',
  color: 'var(--r-gold)',
  background: 'rgba(212, 175, 99, 0.10)',
  border: '1px solid var(--r-line-gold)',
  borderRadius: 4,
  padding: '0 5px',
  wordBreak: 'break-all' as const,
};

function textFromReactNode(value: ReactNode): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(textFromReactNode).join('');
  return '';
}

function useWorkspaceTargetOpener(target: WorkspaceTarget | null): () => void {
  const studio = useStudioFiles();
  const viewer = useContext(ProxyViewerContext);
  const kind = target?.kind;
  const path = target?.path;

  return useCallback(() => {
    if (!kind || path === undefined) return;

    // Inside the Studio shell, keep it in-app: folders reveal in the file tree,
    // renderable docs (html/pdf/images/media) open in the overlay, and text,
    // code, markdown, config, and data files open in the editor.
    if (studio) {
      if (kind === 'folder') { studio.revealFolder(path); return; }
      if (viewer && viewerPreferred(path)) { viewer.open({ source: 'doc', path }); return; }
      studio.openFile(path);
      return;
    }

    openWorkspaceLink(path, kind);
  }, [kind, path, studio, viewer]);
}

function MarkdownCode(props: any) {
  const { inline, children, className } = props;
  const isInline = inline ?? !className;
  const inlineTarget = isInline ? parseWorkspaceMentionText(textFromReactNode(children)) : null;
  const openTarget = useWorkspaceTargetOpener(inlineTarget);

  if (isInline) {
    if (inlineTarget) {
      const href = `rivendell-${inlineTarget.kind}:${encodeURIComponent(inlineTarget.path)}`;
      const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        openTarget();
      };

      return (
        <a
          href={href}
          onClick={onClick}
          className="sw-md-proxy-link sw-md-proxy-code-link"
          data-proxy-kind={inlineTarget.kind}
          title={inlineTarget.kind === 'folder' ? 'Reveal in TARDIS' : 'Open in TARDIS'}
        >
          <code style={INLINE_CODE_STYLE}>{inlineTarget.display}</code>
        </a>
      );
    }

    return <code style={INLINE_CODE_STYLE}>{children}</code>;
  }

  return (
    <pre style={{
      background: 'var(--r-bg-deep)',
      border: '1px solid var(--r-line)',
      borderLeft: '2px solid var(--r-gold-soft)',
      borderRadius: 6,
      padding: '10px 12px',
      margin: '10px 0',
      overflowX: 'auto',
      maxWidth: '100%',
      fontFamily: 'var(--r-mono)',
      fontSize: 12.5,
      lineHeight: 1.55,
      color: 'var(--r-ink)',
      whiteSpace: 'pre',
    }}><code>{children}</code></pre>
  );
}

function MarkdownAnchor({ href, children }: { href?: string; children?: ReactNode }) {
  const proxyTarget = parseProxyHref(href);
  const openTarget = useWorkspaceTargetOpener(proxyTarget);

  if (proxyTarget) {
    const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
      openTarget();
    };

    return (
      <a
        href={href}
        onClick={onClick}
        className="sw-md-proxy-link"
        data-proxy-kind={proxyTarget.kind}
      >
        {children}
      </a>
    );
  }

  const onExternalClick = (event: MouseEvent<HTMLAnchorElement>) => {
    // Preserve modifier/middle-click semantics. A normal primary tap in an
    // installed PWA escapes through the OS default-browser bridge when the
    // platform supports it.
    if (!href || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (openExternalHttpLink(href)) event.preventDefault();
  };

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={onExternalClick}
      style={{
        color: 'var(--r-elf-glow)',
        textDecoration: 'underline',
        textUnderlineOffset: 2,
        textDecorationColor: 'rgba(106, 163, 255, 0.5)',
      }}
    >
      {children}
    </a>
  );
}

const MD_COMPONENTS: Components = {
  p: ({ children }) => (
    <p style={{ margin: '0 0 8px', lineHeight: 1.6 }}>{children}</p>
  ),
  strong: ({ children }) => (
    <strong style={{ fontWeight: 600, color: 'var(--r-gold)' }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ fontStyle: 'italic', color: 'var(--r-ink)' }}>{children}</em>
  ),
  ul: ({ children }) => (
    <ul style={{ margin: '4px 0 8px', paddingLeft: 22, listStyle: 'disc' }}>{children}</ul>
  ),
  ol: ({ children, start }) => (
    <ol
      start={typeof start === 'number' && start > 1 ? start : undefined}
      style={{ margin: '4px 0 8px', paddingLeft: 22, listStyle: 'decimal' }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ margin: '2px 0', lineHeight: 1.55 }}>{children}</li>
  ),
  h1: ({ children }) => (
    <h3 style={{
      margin: '14px 0 6px',
      fontFamily: 'var(--r-display)',
      fontSize: 20,
      fontWeight: 500,
      color: 'var(--r-gold)',
      fontStyle: 'italic',
    }}>{children}</h3>
  ),
  h2: ({ children }) => (
    <h4 style={{
      margin: '12px 0 4px',
      fontFamily: 'var(--r-display)',
      fontSize: 17,
      fontWeight: 500,
      color: 'var(--r-gold)',
      fontStyle: 'italic',
    }}>{children}</h4>
  ),
  h3: ({ children }) => (
    <h5 style={{
      margin: '10px 0 2px',
      fontFamily: 'var(--r-display)',
      fontSize: 15,
      fontWeight: 500,
      color: 'var(--r-gold-soft)',
      fontStyle: 'italic',
    }}>{children}</h5>
  ),
  code: MarkdownCode,
  a: MarkdownAnchor,
  blockquote: ({ children }) => (
    <blockquote style={{
      borderLeft: '2px solid var(--r-gold-soft)',
      margin: '8px 0',
      padding: '2px 0 2px 12px',
      color: 'var(--r-ink-soft)',
      fontStyle: 'italic',
      background: 'rgba(212, 175, 99, 0.04)',
    }}>{children}</blockquote>
  ),
  hr: () => (
    <hr style={{
      border: 0,
      height: 1,
      margin: '14px 0',
      background: 'linear-gradient(90deg, transparent, var(--r-line-gold), transparent)',
    }} />
  ),
  table: ({ children }) => (
    <div style={{ overflowX: 'auto', margin: '8px 0' }}>
      <table style={{
        borderCollapse: 'collapse',
        fontSize: 13,
        lineHeight: 1.45,
      }}>{children}</table>
    </div>
  ),
  thead: ({ children }) => (
    <thead style={{ borderBottom: '1px solid var(--r-line-gold)' }}>{children}</thead>
  ),
  th: ({ children }) => (
    <th style={{
      textAlign: 'left',
      padding: '6px 12px 6px 0',
      fontWeight: 500,
      color: 'var(--r-gold)',
      fontFamily: 'var(--r-display)',
      fontStyle: 'italic',
    }}>{children}</th>
  ),
  td: ({ children }) => (
    <td style={{
      padding: '4px 12px 4px 0',
      borderTop: '1px solid var(--r-line)',
      verticalAlign: 'top',
      color: 'var(--r-ink)',
    }}>{children}</td>
  ),
  del: ({ children }) => (
    <del style={{ color: 'var(--r-ink-faint)' }}>{children}</del>
  ),
  input: (props: any) => {
    // GFM task list checkboxes — render as read-only visual markers.
    if (props.type === 'checkbox') {
      return (
        <input
          type="checkbox"
          checked={!!props.checked}
          readOnly
          style={{ marginRight: 6, verticalAlign: 'middle', accentColor: 'var(--r-gold)' }}
        />
      );
    }
    return <input {...props} />;
  },
};

function MarkdownInner({ children }: { children: string }) {
  const annotated = annotateWorkspaceMentions(protectChatMarkdownLists(children));
  return (
    <div className="sw-md">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS as any}
        urlTransform={proxyUrlTransform}
        components={MD_COMPONENTS}
      >
        {annotated}
      </ReactMarkdown>
    </div>
  );
}

// Memoize on the `children` string so unrelated parent re-renders (Hall ticks
// constantly on WebSocket events) don't churn the rendered DOM. Without this,
// every chat block's subtree re-mounts on every event and the user's text
// selection collapses on every render.
export const Markdown = memo(MarkdownInner);
