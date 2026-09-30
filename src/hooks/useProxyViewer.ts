import { createContext, useContext } from 'react';

export type ProxyViewerRequest =
  | { source: 'doc'; path: string; title?: string; /** Set when opened from a folder list: the header then offers a way back to it. */ fromFolder?: string }
  | { source: 'artifact'; id: string; title?: string }
  | { source: 'folder'; path: string; title?: string }
  | {
      source: 'inline';
      title: string;
      kind: 'html' | 'markdown' | 'text';
      content: string;
    };

export type ProxyViewerContextValue = {
  open: (request: ProxyViewerRequest) => void;
  close: () => void;
};

export const ProxyViewerContext = createContext<ProxyViewerContextValue | null>(null);

export function useProxyViewer(): ProxyViewerContextValue {
  const value = useContext(ProxyViewerContext);
  if (!value) throw new Error('useProxyViewer must be called inside <ProxyViewerProvider>');
  return value;
}
