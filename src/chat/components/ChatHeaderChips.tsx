import { useCallback, useEffect, useRef, useState } from 'react';
import { ComputerControl } from './ComputerControl';
import { ChatJobsChip } from './jobs/ChatJobsChip';
import { agentIdFromChatId } from '../hooks/useJobs';

/**
 * The chat header's control chips, designed once for every chat shell: the
 * background-jobs pill, then the Computer chip. Both live in the header (never
 * above the composer, where a stray click or thumb lands while someone is
 * typing) and both open their picker as a dropdown from the header.
 *
 * Jobs comes first so the Computer chip never moves when jobs come and go: the
 * header's right edge is fixed, so anything added on the left leaves the rest
 * where it was. The jobs pill hides itself when nothing runs or ran recently.
 * `compact` collapses both to an icon (plus a count or a state dot).
 */
export function ChatHeaderChips({ chatId, repo, agentId, backgroundWork, compact = false }: {
  chatId: string | undefined;
  /** The chat's workspace path, when the shell knows it; keys the per-thread device selection. */
  repo?: string;
  /** The chat's agent, when the shell knows it; else it is read from the chat id. */
  agentId?: string;
  /** Background shells and subagents the model itself is running (useChat). */
  backgroundWork?: string[];
  compact?: boolean;
}) {
  const jobsAgent = agentId ?? agentIdFromChatId(chatId);
  return (
    <>
      <ChatJobsChip key={`jobs:${chatId ?? ''}`} agentId={jobsAgent} backgroundWork={backgroundWork} compact={compact} />
      {/* Keyed on chatId + repo: two repos' same-named threads remount the
          control instead of reusing the other repo's in-flight selection. */}
      {chatId ? <ComputerControl key={`${chatId}|${repo ?? ''}`} chatId={chatId} repo={repo} compact={compact} /> : null}
    </>
  );
}

/** Below this header width (px) the chips go compact even on a wide screen: a
 *  chat column squeezed by the sidebar needs the room for the agent's name. */
const HEADER_CHIPS_FULL_MIN = 720;

/**
 * True while the header element is narrower than `HEADER_CHIPS_FULL_MIN`. Uses
 * the header's own width (like the Studio's Threshold does), not the viewport,
 * because the chat column can be narrow on a wide screen. Attach `ref` to the
 * header; a callback ref, so a header that mounts late is still measured, and
 * the first measurement lands before paint.
 */
export function useNarrowHeader(): { ref: (el: HTMLElement | null) => void; narrow: boolean } {
  const [narrow, setNarrow] = useState(false);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    // A hidden (display:none) pane reads 0: keep the last answer instead of flipping.
    const measure = () => { if (el.clientWidth > 0) setNarrow(el.clientWidth < HEADER_CHIPS_FULL_MIN); };
    measure();
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);
  return { ref, narrow };
}
