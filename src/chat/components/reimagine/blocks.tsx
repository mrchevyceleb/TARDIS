// Shared building blocks for the reimagined chat thread, used by BOTH the
// desktop (Conversation) and mobile (Mobile) screens. These render the real
// ChatBlock stream from useChat into the "ship speaks on the page" anatomy
// defined in the approved prototypes (§3.3 – §3.8).

import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatBlock } from '../../data/types';
import { REACTION_EMOJIS } from '../../data/reactions';
import { Markdown } from '../primitives/Markdown';
import { DeskRefText } from '../primitives/DeskRef';
import { ArtifactCard } from '../blocks/ArtifactCard';
import { DocLinkCard } from '../blocks/DocLinkCard';
import { FolderLinkCard } from '../blocks/FolderLinkCard';
import { ChevronDown, StarSigil } from './icons';
import { isAutomationPeer, isNoopToken, shouldHideAutomationTurn } from '../../utils/routineNoise';
import { JobResultCard } from '../jobs/JobResultCard';
import { isJobResultPeer } from '../jobs/format';
import { BRAND, REGEN_QUOTES, THINKING_PHRASES, TIMEY_WIMEY } from '../../../theme/voice';

export function timeLabel(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hourCycle: 'h12' });
}

function dayLabel(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'Today';
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── day mark (centered italic serif between gold hairlines) ───────────────
export function DayMark({ label }: { label: string }) {
  return (
    <div className="daymark" title={label === 'Today' || label === 'Yesterday' ? TIMEY_WIMEY : undefined}>
      <span>{label}</span>
    </div>
  );
}

function stepClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** What the agent is doing right now, in plain words: the running tool, or
 *  thinking, or what it is waiting on. `activityKey` changes whenever output
 *  lands, which restarts the quiet-for timer; a running tool times itself. */
function ActiveTurnIndicator({ since, phrases, activity, toolSince, writing = false, waiting, activityKey }: { since?: number; phrases: string[]; activity?: string; toolSince?: number; writing?: boolean; waiting?: string; activityKey?: string }) {
  const changedAtRef = useRef({ key: activityKey, at: Date.now() });
  if (changedAtRef.current.key !== activityKey) changedAtRef.current = { key: activityKey, at: Date.now() };
  const startedAtRef = useRef(since && since > 0 ? since : 0);
  if (since && since > 0 && (startedAtRef.current === 0 || since < startedAtRef.current)) {
    startedAtRef.current = since;
  }
  const hasKnownStart = startedAtRef.current > 0;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const elapsed = hasKnownStart ? Math.max(0, now - startedAtRef.current) : 0;
  const seconds = Math.floor(elapsed / 1000);
  const quietMs = Math.max(0, now - changedAtRef.current.at);
  // Each state says only what is true of it: a running tool times itself, prose
  // being written has no timer, and "quiet" is time since anything last landed.
  // What it is waiting on (a background job) is named only once the agent has gone quiet.
  let stepText: string | null = null;
  let spoken = '';
  if (activity) {
    if (toolSince) { stepText = `${activity} · ${stepClock(now - toolSince)}`; spoken = activity; }
    else if (writing) { stepText = activity; spoken = activity; }
    else {
      // The wait comes before the quiet clock: on a phone the label ellipsizes at the end, and what
      // it is waiting on matters more than how long it has been quiet.
      stepText = waiting && quietMs >= 8000 ? `${activity} · waiting on ${waiting} · quiet ${stepClock(quietMs)}` : `${activity} · quiet ${stepClock(quietMs)}`;
      spoken = waiting && quietMs >= 8000 ? `${activity}, waiting on ${waiting}` : activity;
    }
  }
  const label = stepText ?? phrases[Math.floor(elapsed / 2800) % phrases.length] ?? 'Working';
  const clock = hasKnownStart
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : 'live';
  return (
    <div className="active-turn" role="status" aria-label={spoken ? `Agent is still working: ${spoken}` : 'Agent is still working'}>
      <span className="vortex active-turn-star" aria-hidden="true" />
      <span key={stepText ? 'step' : label} className={`active-turn-label bt-fade${stepText ? ' active-turn-step' : ''}`} title={stepText ?? undefined} aria-hidden="true">{label}</span>
      <span className="active-turn-dots" aria-hidden="true"><i /><i /><i /></span>
      <span className="active-turn-time" aria-hidden="true">{clock}</span>
    </div>
  );
}

function TurnCompleteIndicator() {
  return (
    <div className="turn-complete" role="status" aria-label="Turn complete">
      <span aria-hidden="true">✓</span>
      <span>Turn complete</span>
    </div>
  );
}

function ConnectionStateIndicator({ reconnecting }: { reconnecting: boolean }) {
  return (
    <div className="connection-state" role="status">
      <span className="vortex connection-state-star" aria-hidden="true" />
      <span>{reconnecting ? 'Re-materialising…' : 'Connection lost — dematerialised'}</span>
    </div>
  );
}

export type ThreadPin = {
  pinnedBlockIds: string[];
  onToggle: (target: { blockId: string; text: string; ts: number }) => void | Promise<void>;
};

// ── actions row (copy / pin) — §3.8 ───────────────────────────────────────
export function ActionsRow({
  getText,
  pinned,
  onTogglePin,
  onReact,
  mine,
}: {
  getText: () => string;
  pinned?: boolean;
  onTogglePin?: () => void | Promise<void>;
  onReact?: (emoji: string) => void;
  mine?: string[];
}) {
  const [copied, setCopied] = useState(false);
  const [localPinned, setLocalPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const isPinned = onTogglePin ? Boolean(pinned) : localPinned;
  const mineSet = new Set(mine ?? []);
  return (
    <div className={`acts${pickerOpen ? ' react-open' : ''}`}>
      <button
        type="button"
        className={`act${copied ? ' copied' : ''}`}
        onClick={async (e) => {
          e.stopPropagation();
          try {
            await navigator.clipboard?.writeText(getText());
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1400);
          } catch {
            /* clipboard unavailable / denied */
          }
        }}
      >
        {copied ? 'copied ✓' : 'copy'}
      </button>
      {onReact ? (
        <span className={`react-wrap${pickerOpen ? ' open' : ''}`}>
          <button
            type="button"
            className="act"
            aria-expanded={pickerOpen}
            title="React"
            onClick={(e) => {
              e.stopPropagation();
              setPickerOpen((open) => !open);
            }}
          >
            react
          </button>
          {pickerOpen ? (
            <span className="react-picker" role="listbox" aria-label="React with emoji">
              {REACTION_EMOJIS.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  className={`react-pick${mineSet.has(emoji) ? ' mine' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onReact(emoji);
                    setPickerOpen(false);
                  }}
                >
                  {emoji}
                </button>
              ))}
            </span>
          ) : null}
        </span>
      ) : null}
      <button
        type="button"
        className={`act${isPinned ? ' copied' : ''}`}
        aria-pressed={isPinned}
        title={isPinned ? 'Unpin from the sidebar' : 'Pin to the sidebar'}
        onClick={async (e) => {
          e.stopPropagation();
          if (onTogglePin) {
            if (busy) return;
            setBusy(true);
            try { await onTogglePin(); } finally { setBusy(false); }
            return;
          }
          setLocalPinned((p) => !p);
        }}
      >
        {isPinned ? 'pinned ✓' : 'pin'}
      </button>
    </div>
  );
}

// ── streaming text — §3.3 (raw tail fades via .tok + caret; full markdown
//    re-renders once the block closes) ─────────────────────────────────────
function StreamText({ text, open }: { text: string; open: boolean }) {
  // Track the length seen on the previous render so only the freshly appended
  // chunk gets the .tok fade (mirrors the prototype's per-word shimmer without
  // re-rendering the whole markdown tree every token).
  const prevLenRef = useRef(0);
  useEffect(() => {
    prevLenRef.current = text.length;
  }, [text]);

  if (!open) {
    return (
      <div className="prose">
        <Markdown>{text}</Markdown>
      </div>
    );
  }
  const prev = Math.min(prevLenRef.current, text.length);
  const head = text.slice(0, prev);
  const tail = text.slice(prev);
  return (
    <div className="prose">
      <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>
        {head}
        {tail && <span className="tok">{tail}</span>}
        <span className="caret" />
      </p>
    </div>
  );
}

// ── tool card (collapsible working card) — §3.5 ───────────────────────────
function toolLines(b: Extract<ChatBlock, { kind: 'tool' }>): { html: string; count: number } {
  const lines: string[] = [];
  if (b.args) {
    try {
      const parsed = JSON.parse(b.args);
      const top = Array.isArray(parsed)
        ? parsed
        : typeof parsed === 'object' && parsed
          ? Object.keys(parsed).slice(0, 3)
          : null;
      if (top) lines.push(`<b>${escapeHtml(b.tool)}</b> · ${escapeHtml(JSON.stringify(top))}`);
      else lines.push(`<b>${escapeHtml(b.tool)}</b>`);
    } catch {
      lines.push(`<b>${escapeHtml(b.tool)}</b> · ${escapeHtml(b.args)}`);
    }
  } else {
    lines.push(`<b>${escapeHtml(b.tool)}</b>`);
  }
  if (b.result) lines.push(escapeHtml(b.result));
  return { html: lines.map((l) => `<span class="ln">${l}</span>`).join(''), count: lines.length };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function ToolCard({ block }: { block: Extract<ChatBlock, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(block.running);
  const wasRunningRef = useRef(block.running);
  // Auto-collapse with a beat when the tool finishes, mirroring the prototype.
  useEffect(() => {
    if (wasRunningRef.current && !block.running) {
      const t = window.setTimeout(() => setOpen(false), 260);
      wasRunningRef.current = block.running;
      return () => window.clearTimeout(t);
    }
    wasRunningRef.current = block.running;
    return undefined;
  }, [block.running]);

  const { html, count } = toolLines(block);
  const meta = block.running ? <RunningMeta since={block.ts} /> : `${count} step${count === 1 ? '' : 's'} · done`;
  return (
    <div className={`tool ${block.running ? 'running' : 'done'}${open ? ' open' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        {block.running ? <span className="vortex tstar" aria-hidden="true" /> : <StarSigil className="tstar" />}
        <span className="tool-title">{block.tool}</span>
        <span className="tool-meta">{meta}</span>
        <ChevronDown className="tool-chev" />
      </button>
      <div className="tool-body">
        <pre dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  );
}

// ── teammate message (collapsed by default so long handoffs stay available
//    without taking over the conversation feed) ───────────────────────────
const PEER_PREVIEW_CHARS = 180;

export function cleanPeerMessageText(raw: string): string {
  return raw
    .replace(/^\[message from teammate[^\]]*\]\n?/, '')
    // Older events stored the model-only reply instruction in the visible
    // peer payload. New deliveries use peerText and never persist it, but keep
    // replay of existing forever-threads clean too.
    .replace(/\n\n\(Reply inline (?:in this turn|for the thread)[\s\S]*\)\s*$/, '')
    .trim();
}

function peerPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= PEER_PREVIEW_CHARS) return oneLine;
  return `${oneLine.slice(0, PEER_PREVIEW_CHARS).trimEnd()}…`;
}

/** What a person can actually see under a teammate message. A settled NO_UPDATE
 *  or empty reply, and tool cards, are not a reply. */
function publicPeerResponse(responseBlocks: AssistantBlock[], streaming: boolean): AssistantBlock[] {
  return responseBlocks.filter((item) => (
    item.kind !== 'tool'
    && !(item.kind === 'text' && !showTextCaret(item, streaming) && (!item.text.trim() || isProtocolNoopText(item.text)))
  ));
}

/** The peer boundary, not individual content-block open flags, owns progress.
 *  Providers can briefly close one block before opening the next; the exchange
 *  must not flicker to "done" while its turn is still running. */
function peerResponseBusy(responseBlocks: AssistantBlock[], responseActive: boolean): boolean {
  return responseActive || responseBlocks.some(
    (item) => (item.kind === 'text' && item.open) || (item.kind === 'tool' && item.running),
  );
}

function PeerMessageBubble({
  block,
  responseBlocks,
  responseActive,
  streaming,
  mobile,
  collapseSteps,
  pin,
  onReact,
}: {
  block: Extract<ChatBlock, { kind: 'peer' }>;
  responseBlocks: AssistantBlock[];
  responseActive: boolean;
  streaming: boolean;
  mobile: boolean;
  collapseSteps: boolean;
  pin?: ThreadPin;
  onReact?: (targetSeq: number, emoji: string) => void;
}) {
  const initial = (block.from || '?').trim().slice(0, 1).toUpperCase();
  const routineResult = block.fromRole === 'automation-result';
  // Quiet routines stay hidden. Deliverable ones (dashboards, briefs) are
  // something Matt has to read, so they start open in the thread.
  const [open, setOpen] = useState(routineResult);
  const text = cleanPeerMessageText(block.text);
  const bodyId = `peer-message-${block.id}`;
  const hasResponse = responseBlocks.length > 0;
  // A settled NO_UPDATE / empty reply renders nothing, so it must not leave an
  // empty timestamped bubble under the peer card.
  const publicResponseBlocks = publicPeerResponse(responseBlocks, streaming);
  const responseToolCount = responseBlocks.filter((item) => item.kind === 'tool').length;
  const responseBusy = peerResponseBusy(responseBlocks, responseActive);
  const role = routineResult
    ? 'routine update'
    : block.fromRole
      ? `${block.fromRole} · to you`
      : 'to you';
  const subject = hasResponse ? 'exchange' : 'message';

  return (
    <>
    <div className={`bt-peer${routineResult ? ' routine-result' : ''}${open ? ' open' : ''}`}>
      <button
        type="button"
        className="bt-peer-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="bt-peer-head">
          <span className="bt-peer-disc">{initial}</span>
          <span className="bt-peer-name">{block.from}</span>
          <span className="bt-peer-role">{role}</span>
          {!block.tsApprox && timeLabel(block.ts) ? <span className="bt-peer-when">{timeLabel(block.ts)}</span> : null}
          {hasResponse || responseBusy ? (
            <span className={`bt-peer-status${responseBusy ? ' working' : ''}`} role="status" aria-live="polite">
              <i aria-hidden="true" /> {responseBusy
                ? 'working'
                : responseToolCount > 0
                  ? `done · ${responseToolCount} tool${responseToolCount === 1 ? '' : 's'}`
                  : 'done'}
            </span>
          ) : null}
          <span className="bt-peer-action">{open ? 'hide' : 'show'} {subject}</span>
          <ChevronDown className="bt-peer-chev" />
        </span>
        {!open ? <span className="bt-peer-preview">{peerPreview(text)}</span> : null}
      </button>
      {open ? (
        <div className="bt-peer-body" id={bodyId}>
          <section className="bt-peer-turn">
            <span className="bt-peer-turn-label">{block.from}</span>
            {routineResult
              ? <div className="bt-peer-turn-text prose"><Markdown>{text}</Markdown></div>
              : <div className="bt-peer-turn-text"><DeskRefText text={text} /></div>}
          </section>
          {hasResponse ? (
            <section className="bt-peer-turn bt-peer-response">
              <span className="bt-peer-turn-label">Reply</span>
              <ElrondGroup
                blocks={responseBlocks}
                streaming={streaming}
                mobile={mobile}
                collapseSteps={collapseSteps}
                pin={pin}
                onReact={onReact}
              />
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
    {!open && publicResponseBlocks.length > 0 ? (
      <div className="bt-peer-public-response" aria-label="Agent response to teammate message">
        <ElrondGroup
          blocks={publicResponseBlocks}
          streaming={streaming}
          mobile={mobile}
          collapseSteps={collapseSteps}
          pin={pin}
          onReact={onReact}
        />
      </div>
    ) : null}
    </>
  );
}

/** A background job's result arrives as an automation peer message. It gets a
 *  compact status card, never a person's message bubble. */
function PeerBubble(props: React.ComponentProps<typeof PeerMessageBubble>) {
  if (isJobResultPeer(props.block.fromRole, props.block.text)) return <JobResultCard block={props.block} />;
  return <PeerMessageBubble {...props} />;
}

// ── folded teammate updates ──────────────────────────────────────────────
// Runs of settled, silent teammate handoffs (the agent answered with nothing
// for the person: NO_UPDATE, or tool work only) collapse into one dim line so a
// busy lane's thread is not a wall of handoff cards. Expanding shows each card
// exactly as it renders on its own. Anything still working, anything with a real
// reply, routine results and job results are never folded.
const FOLD_MIN_RUN = 2;

type FoldItem = { fold: true; key: string; from: string; ts: number; tsApprox?: boolean; node: ReactNode };

function isFoldItem(node: unknown): node is FoldItem {
  return typeof node === 'object' && node !== null && (node as { fold?: unknown }).fold === true;
}

function foldNames(items: FoldItem[]): string {
  const names: string[] = [];
  for (const item of items) {
    const name = (item.from || 'Teammate').trim();
    if (!names.includes(name)) names.push(name);
  }
  return names.length > 3 ? `${names.slice(0, 3).join(', ')} +${names.length - 3}` : names.join(', ');
}

function FoldedHandoffs({ items }: { items: FoldItem[] }) {
  const [open, setOpen] = useState(false);
  const bodyId = `peer-fold-${items[0].key}`;
  const latest = items[items.length - 1];
  const when = !latest.tsApprox ? timeLabel(latest.ts) : '';
  return (
    <div className={`bt-peer-fold${open ? ' open' : ''}`}>
      <button
        type="button"
        className="bt-peer-fold-toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-controls={bodyId}
      >
        <span className="bt-peer-fold-count">{items.length} teammate updates</span>
        <span className="bt-peer-fold-names">{foldNames(items)}</span>
        {when ? <span className="bt-peer-fold-when">{when}</span> : null}
        <span className="bt-peer-fold-action">{open ? 'hide' : 'show'}</span>
        <ChevronDown className="bt-peer-fold-chev" />
      </button>
      {open ? (
        <div className="bt-peer-fold-body" id={bodyId}>
          {items.map((item) => <Fragment key={item.key}>{item.node}</Fragment>)}
        </div>
      ) : null}
    </div>
  );
}

// Regeneration: same agent, new face. Rolling compaction and a mid-turn
// service restart both rotate the model context while the thread survives.
// The quote is seeded per block so replays never reshuffle it.
const regenQuote = (seed: number) => REGEN_QUOTES[Math.abs(Math.floor(seed)) % REGEN_QUOTES.length];

function CompactDivider({ block }: { block: Extract<ChatBlock, { kind: 'compact' }> }) {
  const words = block.words >= 1000 ? `${(block.words / 1000).toFixed(1)}k` : block.words;
  return (
    <div className="compact-mark regen-mark" title={`Regeneration #${block.count}: durable memory document (${block.words} words) generated from ${block.turns} turns${block.savedToRag ? ' and saved to the RAG vault' : ''}. Same agent, same thread — only the model context rotated.`}>
      <span className="compact-line" />
      <span className="compact-label">
        Regeneration · {words} words banked{block.savedToRag === false ? '' : ' · saved to RAG'}
        <em className="regen-quote">“{regenQuote(block.count)}”</em>
      </span>
      <span className="compact-line" />
    </div>
  );
}

function RestartDivider({ block }: { block: Extract<ChatBlock, { kind: 'restart' }> }) {
  return (
    <div className="compact-mark regen-mark restart-mark" title={`${BRAND} restarted while a turn was running — the in-flight tool call's output was lost with the process. Ask the companion to re-check the work.`}>
      <span className="compact-line" />
      <span className="compact-label">
        Regeneration · service restarted mid-turn
        <em className="regen-quote">“{regenQuote(block.ts)}”</em>
      </span>
      <span className="compact-line" />
    </div>
  );
}

function TerminalErrorCard({ block }: { block: Extract<ChatBlock, { kind: 'terminal-error' }> }) {
  return (
    <div className="terminal-error" role={block.continuing ? 'status' : 'alert'}>
      <span className="terminal-error-mark" aria-hidden="true">!</span>
      <span>
        <strong>{block.continuing ? 'Switched model provider' : 'Couldn’t answer this turn'}</strong>
        <span className="terminal-error-copy">{block.message}</span>
      </span>
    </div>
  );
}

const ENGINE_LABEL: Record<string, string> = {
  xai: 'Grok',
  zai: 'GLM',
  claude: 'Claude',
  assistant: 'Claude',
  codex: 'Codex',
  banana: 'OpenRouter',
  'banana-local': 'Local',
  'banana-fireworks': 'Fireworks',
};

function engineLabel(id: string): string {
  return ENGINE_LABEL[id] ?? id;
}

function SwitchDivider({ block }: { block: Extract<ChatBlock, { kind: 'switch' }> }) {
  const from = engineLabel(block.from);
  const to = engineLabel(block.to);
  const model = block.model ? ` · ${block.model}` : '';
  return (
    <div className="compact-mark switch-mark" title={`This thread stayed put. ${to} will answer from here on${block.model ? ` (${block.model})` : ''}.`}>
      <span className="compact-line" />
      <span className="compact-label">Switched {from} → {to}{model}</span>
      <span className="compact-line" />
    </div>
  );
}

function BackgroundNote({ block }: { block: Extract<ChatBlock, { kind: 'background' }> }) {
  const title = block.state === 'kept'
    ? 'Background work runs inside this session, so switching models now would end it. The switch waits for it to finish, or for your next message after 15 minutes.'
    : 'This background work ended without reporting back. The agent is told on its next turn.';
  return (
    <div className="compact-mark background-mark" title={title}>
      <span className="compact-line" />
      <span className="compact-label">{block.text}</span>
      <span className="compact-line" />
    </div>
  );
}

// ── user bubble ───────────────────────────────────────────────────────────
function UserBubble({ block, agentName, onRetry }: { block: Extract<ChatBlock, { kind: 'user' }>; agentName?: string; onRetry?: (clientMsgId: string) => void }) {
  const images = block.images ?? [];
  const missing = Math.max(0, (block.imageCount ?? images.length) - images.length);
  // data: URLs can't be top-level navigated to in Chrome — clone via blob.
  // Open the tab synchronously (popup blockers kill async window.open once
  // the click's transient activation expires), then navigate when ready.
  const openImage = (e: React.MouseEvent, src: string) => {
    if (!src.startsWith('data:')) return;
    e.preventDefault();
    const win = window.open('', '_blank');
    if (!win) return;
    void fetch(src)
      .then((r) => r.blob())
      .then((b) => {
        const url = URL.createObjectURL(b);
        win.location.href = url;
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      })
      .catch(() => win.close());
  };
  return (
    <div className="msg m-user">
      {images.length ? (
        <div className="uimg-row">
          {images.map((img, i) => (
            <a key={i} href={img.dataUrl} target="_blank" rel="noreferrer" className="uimg-link" onClick={(e) => openImage(e, img.dataUrl)}>
              <img className="uimg" src={img.dataUrl} alt={`attachment ${i + 1}`} loading="lazy" />
            </a>
          ))}
        </div>
      ) : null}
      {missing > 0 ? (
        <span className="uimg-missing">
          📎 {block.attachmentsLost || images.length
            ? `${missing} image${missing === 1 ? '' : 's'} not kept`
            : `${missing} image${missing === 1 ? '' : 's'} attached`}
        </span>
      ) : null}
      <div className="bubble"><DeskRefText text={block.text} /></div>
      {block.deliveryState ? (
        <span className={`delivery-state ${block.deliveryState}`} role={block.deliveryState === 'failed' ? 'alert' : 'status'}>
          {block.deliveryState === 'queued'
            ? `Queued · ${agentName ? `${agentName} is` : 'the agent is'} mid-step, it will land at the next safe moment`
            : 'Not delivered'}
          {block.deliveryState === 'failed' && onRetry && block.clientMsgId && !block.noRetry && !block.imageCount && !images.length ? (
            <button type="button" className="delivery-retry" onClick={() => onRetry(block.clientMsgId!)}>Retry</button>
          ) : null}
        </span>
      ) : (
        <span className="when">{timeLabel(block.ts)}</span>
      )}
    </div>
  );
}

type AssistantBlock = Extract<ChatBlock, { kind: 'text' } | { kind: 'tool' } | { kind: 'doc-link' } | { kind: 'folder-link' } | { kind: 'artifact' }>;
type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>;

/** Live "working · m:ss" heartbeat for running tool calls. Long subprocess
 *  waits (codex reviews, big bashes) used to render a static "working…" for
 *  minutes and read as a dead agent — a ticking counter proves it's alive. */
function RunningMeta({ since }: { since: number }) {
  // Wall clock for the initial elapsed (block.ts is Date.now-based), then
  // advance monotonically — a system-clock adjustment must not jump or zero
  // the counter mid-wait.
  const [elapsed, setElapsed] = useState(() => Math.max(0, Date.now() - since));
  useEffect(() => {
    const base = { perf: performance.now(), elapsed: Math.max(0, Date.now() - since) };
    setElapsed(base.elapsed);
    const iv = window.setInterval(() => {
      setElapsed(Math.max(0, base.elapsed + (performance.now() - base.perf)));
    }, 1000);
    return () => window.clearInterval(iv);
  }, [since]);
  const sec = Math.floor(elapsed / 1000);
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return <>working · {mm}:{ss}</>;
}

// ── Tools card (Grok anatomy) — a run of consecutive tool calls collapses
//    into ONE expandable card instead of N stacked pods eating the feed.
//    Collapsed: "8 tool calls · done" plus a one-line name summary. Expanded:
//    the individual ToolCards, each still expandable itself.
function ToolsCard({ blocks, turnLive = false }: { blocks: ToolBlock[]; turnLive?: boolean }) {
  const [open, setOpen] = useState(false);
  const running = blocks.some((b) => b.running);
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.tool, (counts.get(b.tool) ?? 0) + 1);
  const summary = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');
  const sameName = counts.size === 1 ? blocks[0].tool : null;
  const title = sameName ?? `${blocks.length} tool calls`;
  const oldestRunning = blocks.find((b) => b.running);
  // While the turn is still going, "done" reads as the whole turn: it only means this batch of calls.
  const doneMeta = `${blocks.length} call${blocks.length === 1 ? '' : 's'} · ${turnLive ? 'batch done' : 'done'}`;
  return (
    <div className={`tool tools-run${running ? ' running' : ' done'}${open ? ' open' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {running ? <span className="vortex tstar" aria-hidden="true" /> : <StarSigil className="tstar" />}
        <span className="tool-title">{title}</span>
        <span className="tool-meta">{running && oldestRunning ? <RunningMeta since={oldestRunning.ts} /> : doneMeta}</span>
        <ChevronDown className="tool-chev" />
      </button>
      {open ? null : <div className="tools-summary">{summary}</div>}
      <div className="tool-body">
        {/* Mounted only while open: a zero-height overflow-hidden box still
            exposes focusable buttons to keyboard/AT when collapsed. */}
        {open ? (
          <div className="tools-list">
            {blocks.map((b) => <ToolCard key={b.id} block={b} />)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function hasVisibleProse(b: Extract<ChatBlock, { kind: 'text' }>): boolean {
  return !b.pending && b.text.trim().length > 0;
}

/** Protocol no-ops that must not steal the Grok answer slot. Broader
 *  isQuietRoutineReply ("nothing happened", …) is for automation hide, not
 *  for promoting a human turn's last sentence. */
function isProtocolNoopText(text: string): boolean {
  return isNoopToken(text);
}

function isAnswerProse(b: Extract<ChatBlock, { kind: 'text' }>): boolean {
  const t = b.text.trim();
  return !b.pending && t.length > 0 && !isProtocolNoopText(t);
}

function visibleAssistantBlocks(blocks: AssistantBlock[], _collapseSteps: boolean): AssistantBlock[] {
  return blocks;
}

function showTextCaret(b: Extract<ChatBlock, { kind: 'text' }>, streaming: boolean): boolean {
  return Boolean(b.open) && streaming;
}

/** Preserve every user-facing text message, including between-tool updates.
 * Provider metadata controls presentation, not visibility. Thinking stays in
 * the thinking channel. Plain text that is not a tool call prints. */
// A run of consecutive assistant blocks that share a turnId render under a
// single "✦ TARDIS" header (the prototype's per-turn group).
function ReactionStrip({
  reactions,
  onReact,
}: {
  reactions: Array<{ emoji: string; from: string }>;
  onReact?: (emoji: string) => void;
}) {
  if (!reactions.length) return null;
  const counts = new Map<string, { count: number; mine: boolean }>();
  for (const item of reactions) {
    const current = counts.get(item.emoji) ?? { count: 0, mine: false };
    current.count += 1;
    if (item.from === 'Matt') current.mine = true;
    counts.set(item.emoji, current);
  }
  return (
    <div className="react-strip" aria-label="Reactions">
      {[...counts.entries()].map(([emoji, rec]) => (
        <button
          key={emoji}
          type="button"
          className={`react-chip${rec.mine ? ' mine' : ''}`}
          disabled={!onReact}
          onClick={(e) => {
            e.stopPropagation();
            onReact?.(emoji);
          }}
        >
          <span>{emoji}</span>
          {rec.count > 1 ? <span className="react-count">{rec.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

function RoutineResultBubble({
  block,
  streaming,
  mobile,
  collapseSteps,
  pin,
  onReact,
}: {
  block: Extract<ChatBlock, { kind: 'peer' }>;
  streaming: boolean;
  mobile: boolean;
  collapseSteps: boolean;
  pin?: ThreadPin;
  onReact?: (targetSeq: number, emoji: string) => void;
}) {
  const text = cleanPeerMessageText(block.text);
  const asMessage: AssistantBlock[] = [{
    kind: 'text',
    id: `${block.id}-routine`,
    text,
    ts: block.ts,
    ...(block.tsApprox ? { tsApprox: true } : {}),
    presentation: 'answer',
    open: false,
  } as AssistantBlock];
  return (
    <div className="routine-result-message">
      <div className="bt-peer-role" style={{ fontSize: 11, opacity: 0.65, margin: '0 0 4px 2px' }}>
        ⚙ {block.from} · routine update
      </div>
      <ElrondGroup blocks={asMessage} streaming={streaming} mobile={mobile} collapseSteps={collapseSteps} pin={pin} onReact={onReact} />
    </div>
  );
}

function ElrondGroup({
  blocks,
  streaming,
  turnLive = false,
  mobile,
  collapseSteps = false,
  pin,
  onReact,
}: {
  blocks: AssistantBlock[];
  streaming: boolean;
  /** This is the latest assistant group and the turn is still running. */
  turnLive?: boolean;
  mobile: boolean;
  collapseSteps?: boolean;
  pin?: ThreadPin;
  onReact?: (targetSeq: number, emoji: string) => void;
}) {
  const [acted, setActed] = useState(false);
  const visible = visibleAssistantBlocks(blocks, collapseSteps);
  if (!visible.length) return null;
  const first = visible[0];
  const textBlocks = visible.filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text');
  const isActivity = collapseSteps && textBlocks.length === 0;
  const copyText = () => {
    const src = textBlocks.filter(isAnswerProse);
    return (src.length ? src : textBlocks.filter(hasVisibleProse)).map((b) => b.text).join('\n\n');
  };
  const isPinned = Boolean(pin?.pinnedBlockIds.includes(first.id));
  // Collapse consecutive tool cards into one dropdown. Empty/noop text between
  // tool rounds used to break the run, which stacked a Bash card per call.
  // Real between-tool prose still prints and still splits the run.
  const toolRuns = new Map<string, ToolBlock[]>();
  const toolRunSkip = new Set<string>();
  if (collapseSteps) {
    let run: ToolBlock[] = [];
    const flush = () => {
      if (run.length > 1) {
        toolRuns.set(run[0].id, run);
        for (const b of run.slice(1)) toolRunSkip.add(b.id);
      }
      run = [];
    };
    for (const b of visible) {
      if (b.kind === 'tool') run.push(b);
      else if (b.kind === 'text' && (!b.text.trim() || isProtocolNoopText(b.text))) continue;
      else flush();
    }
    flush();
  }
  return (
    <div
      id={`msg-pin-${first.id}`}
      data-pin-block={first.id}
      className={`msg m-elrond${isActivity ? ' m-activity' : ''}${acted ? ' acted' : ''}${isPinned ? ' pinned' : ''}`}
      onClick={mobile ? () => setActed((a) => !a) : undefined}
    >
      <div className="who">
        <span className="mini">✦</span> {BRAND} {'tsApprox' in first && first.tsApprox ? null : <span className="when">{timeLabel(first.ts)}</span>}
      </div>
      {visible.map((b) => {
        switch (b.kind) {
          case 'tool': {
            if (toolRunSkip.has(b.id)) return null;
            const run = toolRuns.get(b.id);
            if (run) return <ToolsCard key={b.id} blocks={run} turnLive={turnLive} />;
            return <ToolCard key={b.id} block={b} />;
          }
          case 'text': {
            const open = showTextCaret(b, streaming);
            const display = isProtocolNoopText(b.text) ? '' : b.text;
            if (!open && !display) return null;
            if (b.thought) return <div key={b.id} className="bt-thought"><StreamText text={display} open={false} /></div>;
            return <StreamText key={b.id} text={display} open={open} />;
          }
          case 'doc-link':
            return <DocLinkCard key={b.id} path={b.path} title={b.title} />;
          case 'folder-link':
            return <FolderLinkCard key={b.id} path={b.path} title={b.title} />;
          case 'artifact':
            return <ArtifactCard key={b.id} artifactId={b.artifactId} artifactKind={b.artifactKind} title={b.title} />;
          default:
            return null;
        }
      })}
      {(() => {
        const answer = [...textBlocks].reverse().find((b) => isAnswerProse(b) && typeof b.seq === 'number')
          ?? [...textBlocks].reverse().find((b) => hasVisibleProse(b) && typeof b.seq === 'number');
        const targetSeq = answer?.seq;
        const reactions = textBlocks.flatMap((b) => b.reactions ?? []);
        const mine = reactions.filter((r) => r.from === 'Matt').map((r) => r.emoji);
        const canReact = Boolean(onReact && targetSeq && !streaming);
        return (
          <>
            <ReactionStrip
              reactions={reactions}
              onReact={canReact ? (emoji) => onReact!(targetSeq!, emoji) : undefined}
            />
            {(textBlocks.some(isAnswerProse) || textBlocks.some(hasVisibleProse)) && !streaming ? (
              <ActionsRow
                getText={copyText}
                pinned={isPinned}
                mine={mine}
                onReact={canReact ? (emoji) => onReact!(targetSeq!, emoji) : undefined}
                onTogglePin={pin ? () => {
                  const src = textBlocks.filter(isAnswerProse);
                  const visible = src.length ? src : textBlocks.filter(hasVisibleProse);
                  const last = visible[visible.length - 1];
                  return pin.onToggle({ blockId: first.id, text: last?.text ?? copyText(), ts: first.ts });
                } : undefined}
              />
            ) : null}
          </>
        );
      })()}
    </div>
  );
}

export type ChatThreadProps = {
  blocks: ChatBlock[];
  status: string;
  contentRef?: React.Ref<HTMLDivElement>;
  bottomRef?: React.Ref<HTMLDivElement>;
  mobile?: boolean;
  noteUnread?: () => void;
  /** Rotating working phrases for the live-turn pill (defaults to the ship's). */
  phrases?: string[];
  /** Grok shell: combine consecutive tool calls into compact expandable cards. */
  collapseSteps?: boolean;
  /** Grok shell: persist pin into the focused agent's right-pane pocket. */
  pin?: ThreadPin;
  /** Persist an emoji reaction on a finished assistant bubble. */
  onReact?: (targetSeq: number, emoji: string) => void;
  /** Suppress the typing indicator entirely (silent automation turn running). */
  suppressTyping?: boolean;
  /** Wall-clock start of the active turn, used for visible proof-of-life time. */
  workingSince?: number;
  /** Agent name for the queued-message wording. */
  agentName?: string;
  /** One-tap resend of a bubble that read "Not delivered". */
  onRetry?: (clientMsgId: string) => void;
  /** The model's own background shells/subagents still running after the turn
   *  ended. The jobs pill in the chat header lists them, so the feed only stops
   *  saying "Turn complete" while they run. */
  backgroundWork?: string[];
  /** Everything running behind the chat, by name (background jobs, then the
   *  model's own background work): the live line says it is waiting on these
   *  once the agent goes quiet. The header pill counts the same list, so the
   *  two never disagree. */
  waitingOn?: string[];
};

// Renders the full feed: day marks on day changes, user bubbles, per-turn
// assistant groups (tool cards + streaming prose), and the live-turn pill
// while a turn is live but no content has landed yet.
export function ChatThread({ blocks, status, contentRef, bottomRef, mobile = false, phrases = THINKING_PHRASES, collapseSteps = true, pin, onReact, suppressTyping = false, workingSince, backgroundWork = [], waitingOn = [], agentName, onRetry }: ChatThreadProps) {
  const streaming = status === 'streaming';
  // The indicator lives until something VISIBLE lands in the CURRENT turn.
  // Looking across the whole transcript made any historical terminal-error or
  // stale open block suppress every future thinking indicator.
  let currentTurnStart = 0;
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].kind === 'user' || blocks[i].kind === 'peer') {
      currentTurnStart = i + 1;
      break;
    }
  }
  const activeBlock = [...blocks.slice(currentTurnStart)].reverse().find(
    (b) => 'turnId' in b && b.turnId && (
      (b.kind === 'text' && b.open) || (b.kind === 'tool' && (b.open || b.running))
    ),
  );
  const activeTurnId = activeBlock && 'turnId' in activeBlock ? activeBlock.turnId : undefined;
  const currentBlocks = activeTurnId
    ? blocks.filter((b) => 'turnId' in b && b.turnId === activeTurnId)
    : blocks.slice(currentTurnStart);
  const currentBoundary = currentTurnStart > 0 ? blocks[currentTurnStart - 1] : undefined;
  const activePeerId = streaming && currentBoundary?.kind === 'peer' ? currentBoundary.id : null;
  // A provider-switch notice with the agent continuing is not a failure: the
  // continued turn still needs its liveness row and its completion marker.
  const hasCurrentTerminalFailure = currentBlocks.some((block) => block.kind === 'terminal-error' && !block.continuing);
  const latestQueued = [...blocks].reverse().find((block) => (
    block.kind === 'user' && block.deliveryState === 'queued'
  ));
  let lastUserIndex = -1;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index].kind === 'user') {
      lastUserIndex = index;
      break;
    }
  }
  const hasAssistantAfterLastUser = lastUserIndex >= 0 && blocks.slice(lastUserIndex + 1).some((block) => (
    (block.kind === 'text' && block.text.trim().length > 0)
    || block.kind === 'tool'
    || block.kind === 'terminal-error'
  ));

  // Group consecutive assistant blocks (same turnId) and user blocks.
  const groups: Array<
    | { type: 'user'; block: Extract<ChatBlock, { kind: 'user' }>; day: string }
    | { type: 'elrond'; blocks: Array<Extract<ChatBlock, { kind: 'text' } | { kind: 'tool' } | { kind: 'doc-link' } | { kind: 'folder-link' } | { kind: 'artifact' }>>; day: string }
    | { type: 'compact'; block: Extract<ChatBlock, { kind: 'compact' }>; day: string }
    | { type: 'restart'; block: Extract<ChatBlock, { kind: 'restart' }>; day: string }
    | { type: 'terminal-error'; block: Extract<ChatBlock, { kind: 'terminal-error' }>; day: string }
    | { type: 'switch'; block: Extract<ChatBlock, { kind: 'switch' }>; day: string }
    | { type: 'background'; block: Extract<ChatBlock, { kind: 'background' }>; day: string }
    | { type: 'peer'; block: Extract<ChatBlock, { kind: 'peer' }>; responseBlocks: AssistantBlock[]; responseTurnId?: string | null; day: string }
  > = [];
  type PeerGroup = Extract<(typeof groups)[number], { type: 'peer' }>;
  const peerGroupsById = new Map<string, PeerGroup>();
  let lastDay = '';
  for (const b of blocks) {
    // Hidden: the reply-case marker, and a thinking summary still waiting to
    // learn whether its message had text of its own.
    if (b.kind === 'replyask' || (b.kind === 'text' && b.pending)) continue;
    const day = dayLabel(b.ts);
    if (b.kind === 'compact') {
      groups.push({ type: 'compact', block: b, day: lastDay || day });
      continue;
    }
    if (b.kind === 'restart') {
      groups.push({ type: 'restart', block: b, day: lastDay || day });
      continue;
    }
    if (b.kind === 'terminal-error') {
      groups.push({ type: 'terminal-error', block: b, day: lastDay || day });
      continue;
    }
    if (b.kind === 'switch') {
      groups.push({ type: 'switch', block: b, day: lastDay || day });
      continue;
    }
    if (b.kind === 'background') {
      groups.push({ type: 'background', block: b, day: lastDay || day });
      continue;
    }
    if (b.kind === 'user') {
      groups.push({ type: 'user', block: b, day });
    } else if (b.kind === 'peer') {
      const peerGroup: PeerGroup = { type: 'peer', block: b, responseBlocks: [], day };
      groups.push(peerGroup);
      peerGroupsById.set(b.id, peerGroup);
    } else if (b.kind === 'text' || b.kind === 'tool' || b.kind === 'doc-link' || b.kind === 'folder-link' || b.kind === 'artifact') {
      const last = groups[groups.length - 1];
      // Reducer-stamped peerId is the authoritative association. Native
      // steering can create more than one provider message_start inside the
      // same outer turn, so turnId/adjoining position alone is not enough.
      const peerId = 'peerId' in b ? b.peerId : undefined;
      const peerGroup = peerId ? peerGroupsById.get(peerId) : undefined;
      if (peerGroup) {
        peerGroup.responseBlocks.push(b);
        peerGroup.day = day;
        continue;
      }
      // Legacy cached blocks predate peerId. Keep the conservative adjacent,
      // same-turn fallback so old exchanges do not suddenly expand the feed.
      const turnId = (b as { turnId?: string }).turnId;
      if (
        peerId === undefined
        && last?.type === 'peer'
        && !isAutomationPeer(last.block.from, last.block.fromRole, last.block.text)
        && (last.responseTurnId === undefined || last.responseTurnId === (turnId ?? null))
      ) {
        last.responseTurnId = turnId ?? null;
        last.responseBlocks.push(b);
        last.day = day;
        continue;
      }
      // Keep actual provider messages separate. Flattening every tool round
      // into one answer bubble made activity narration look like the reply.
      // Codex can tag multiple messages within one turnId: split on phase too.
      const priorText = last?.type === 'elrond'
        ? last.blocks.findLast((block) => block.kind === 'text') : undefined;
      const phaseChanged = b.kind === 'text' && priorText?.kind === 'text'
        && b.presentation && priorText.presentation && b.presentation !== priorText.presentation;
      const merge = last?.type === 'elrond' && turnId
        && (last.blocks[0] as { turnId?: string }).turnId === turnId && !phaseChanged;
      if (merge) {
        last.blocks.push(b);
        last.day = day;
      } else {
        groups.push({ type: 'elrond', blocks: [b], day });
      }
    }
  }

  // Each provider tool round often gets a fresh turnId, so consecutive Bash
  // cards used to land as separate bubbles and never hit ToolsCard. Fold
  // adjacent tool-only groups into one dropdown. Groups with real prose stay
  // put so agent text is not swallowed.
  const isToolOnlyElrond = (g: (typeof groups)[number]): g is Extract<(typeof groups)[number], { type: 'elrond' }> => (
    g.type === 'elrond'
    && g.blocks.length > 0
    && g.blocks.every((block) => (
      block.kind === 'tool'
      || (block.kind === 'text' && (!block.text.trim() || isProtocolNoopText(block.text)))
    ))
  );
  const coalescedGroups: typeof groups = [];
  for (const g of groups) {
    const prev = coalescedGroups[coalescedGroups.length - 1];
    if (prev && isToolOnlyElrond(prev) && isToolOnlyElrond(g)) {
      prev.blocks.push(...g.blocks);
      prev.day = g.day;
      continue;
    }
    coalescedGroups.push(g);
  }

  const lastElrondGroup = [...coalescedGroups].reverse().find((g) => g.type === 'elrond');
  const nodes: Array<ReactNode | FoldItem> = [];
  let pendingAutomation = false;
  let hideThinking = false;
  for (const g of coalescedGroups) {
    // A job result is an automation wake (the agent's reply to it follows the
    // same quiet-hiding rules) but the result itself shows, as a status card.
    const jobResult = g.type === 'peer' && isJobResultPeer(g.block.fromRole, g.block.text);
    if (g.type === 'peer' && isAutomationPeer(g.block.from, g.block.fromRole, g.block.text)) {
      pendingAutomation = true;
      hideThinking = true;
      if (!jobResult) continue;
    }
    if (!jobResult && (g.type === 'user' || g.type === 'compact' || g.type === 'restart' || g.type === 'terminal-error' || g.type === 'switch' || g.type === 'background' || g.type === 'peer')) {
      pendingAutomation = false;
      hideThinking = false;
    }
    if (g.type === 'elrond' && pendingAutomation) {
      pendingAutomation = false;
      const hasRunningTool = g.blocks.some((b) => b.kind === 'tool' && b.running);
      const isLive = g.blocks.some(
        (b) => (b.kind === 'text' && b.open) || (b.kind === 'tool' && b.running),
      );
      const texts = g.blocks.filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text').map((b) => b.text);
      const hasNonText = g.blocks.some((b) => b.kind !== 'text');
      if (shouldHideAutomationTurn({ texts, hasRunningTool, isLive, hasNonText })) {
        hideThinking = isLive;
        continue;
      }
      hideThinking = false;
    } else if (g.type === 'elrond') {
      const hasRunningTool = g.blocks.some((b) => b.kind === 'tool' && b.running);
      const isLive = g.blocks.some(
        (b) => (b.kind === 'text' && b.open) || (b.kind === 'tool' && b.running),
      );
      const texts = g.blocks.filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text').map((b) => b.text);
      // Standalone protocol no-ops (NO_UPDATE / Quiet) stay out of the feed.
      // Broader quiet-routine phrases ("nothing happened") still show on human
      // turns — automation hide is the pendingAutomation branch above.
      const hasNonText = g.blocks.some((b) => b.kind !== 'text');
      const hasRealProse = texts.some((t) => t.trim() && !isProtocolNoopText(t));
      if (!hasRunningTool && !isLive && !hasNonText && !hasRealProse && texts.some((t) => t.trim())) {
        continue;
      }
    }
    if (g.day !== lastDay) {
      nodes.push(<DayMark key={`dm-${g.day}-${nodes.length}`} label={g.day} />);
      lastDay = g.day;
    }
    if (g.type === 'user') {
      nodes.push(<UserBubble key={g.block.id} block={g.block} agentName={agentName} onRetry={onRetry} />);
    } else if (g.type === 'compact') {
      nodes.push(<CompactDivider key={g.block.id} block={g.block} />);
    } else if (g.type === 'restart') {
      nodes.push(<RestartDivider key={g.block.id} block={g.block} />);
    } else if (g.type === 'terminal-error') {
      nodes.push(<TerminalErrorCard key={g.block.id} block={g.block} />);
    } else if (g.type === 'switch') {
      nodes.push(<SwitchDivider key={g.block.id} block={g.block} />);
    } else if (g.type === 'background') {
      nodes.push(<BackgroundNote key={g.block.id} block={g.block} />);
    } else if (g.type === 'peer' && g.block.fromRole === 'automation-result') {
      // A routine's deliverable is the agent talking to Matt, so it reads as a
      // normal message with a small routine label, not a folded card he has to
      // open. Quiet routine turns never reach here (they produce no result).
      nodes.push(
        <RoutineResultBubble
          key={g.block.id}
          block={g.block}
          streaming={streaming}
          mobile={mobile}
          collapseSteps={collapseSteps}
          pin={pin}
          onReact={onReact}
        />,
      );
    } else if (g.type === 'peer') {
      const bubble = (
        <PeerBubble
          key={g.block.id}
          block={g.block}
          responseBlocks={g.responseBlocks}
          responseActive={activePeerId === g.block.id}
          streaming={streaming}
          mobile={mobile}
          collapseSteps={collapseSteps}
          pin={pin}
          onReact={onReact}
        />
      );
      // Settled and silent: it was answered (so it is not waiting on anyone),
      // nothing is still running, and the agent said nothing to the person.
      // (Routine deliverables never get here: they render in the branch above.)
      const foldable = !jobResult
        && g.block.fromRole !== 'automation-result'
        && g.responseBlocks.length > 0
        && !peerResponseBusy(g.responseBlocks, activePeerId === g.block.id)
        && publicPeerResponse(g.responseBlocks, streaming).length === 0;
      nodes.push(foldable
        ? { fold: true, key: g.block.id, from: g.block.from, ts: g.block.ts, tsApprox: g.block.tsApprox, node: bubble }
        : bubble);
    } else {
      nodes.push(<ElrondGroup key={g.blocks[0].id} blocks={g.blocks} streaming={streaming} turnLive={streaming && g === lastElrondGroup} mobile={mobile} collapseSteps={collapseSteps} pin={pin} onReact={onReact} />);
    }
  }

  // A silent routine stays silent, but the moment the current turn has work a
  // person can see (tool cards, prose), it needs its proof-of-life row too: a
  // turn that a person's message joined must never look dead.
  const currentTurnVisible = currentBlocks.some((b) => b.kind === 'tool' || (b.kind === 'text' && isAnswerProse(b)));
  const runningTool = [...currentBlocks].reverse().find((b): b is ToolBlock => b.kind === 'tool' && b.running);
  const lastCurrent = currentBlocks[currentBlocks.length - 1];
  const openText = currentBlocks.some((b) => b.kind === 'text' && b.open && b.text.trim().length > 0);
  const liveActivity = runningTool
    ? `Running ${runningTool.tool.replace(/^mcp__[^_]+(?:_[^_]+)*__/, '')}`
    : openText ? 'Writing' : currentBlocks.length > 0 ? 'Thinking' : undefined;
  const activityKey = `${currentBlocks.length}|${lastCurrent?.id ?? ''}|${lastCurrent && 'text' in lastCurrent ? lastCurrent.text.length : ''}|${runningTool?.id ?? ''}`;
  if (streaming && !hasCurrentTerminalFailure && (currentTurnVisible || (!hideThinking && !pendingAutomation && !suppressTyping))) {
    // Never make the user infer liveness from a Stop button. Keep one animated
    // proof-of-life row visible for the ENTIRE turn, even after user-facing
    // prose or completed tool cards have appeared, saying what it is doing now.
    // Once quiet it says what it is waiting on: a lone job by name, several as
    // a count. That is the very list the header pill counts (N jobs running),
    // so the line and the pill never disagree.
    nodes.push(
      <ActiveTurnIndicator
        key="active-turn"
        since={workingSince}
        phrases={phrases}
        activity={liveActivity}
        toolSince={runningTool?.ts}
        writing={openText}
        waiting={waitingOn.length > 0 ? (waitingOn.length === 1 ? waitingOn[0] : `${waitingOn.length} jobs`) : undefined}
        activityKey={activityKey}
      />,
    );
  } else if (!latestQueued && status === 'ready' && backgroundWork.length > 0) {
    // Nothing to add: the jobs pill in the header shows what is still
    // running, and "Turn complete" here would read as "nothing is happening".
  } else if (!latestQueued && status === 'ready' && hasAssistantAfterLastUser && !hasCurrentTerminalFailure) {
    // Absence of animation must mean something explicit. This permanent,
    // low-emphasis terminal marker distinguishes "finished" from "stalled".
    nodes.push(<TurnCompleteIndicator key="turn-complete" />);
  } else if ((status === 'connecting' || status === 'closed' || status === 'error') && blocks.length > 0) {
    nodes.push(<ConnectionStateIndicator key="connection-state" reconnecting={status !== 'error'} />);
  }

  // Consecutive silent handoffs (nothing else between them, not even a day
  // mark) become one line; a lone one stays the card it always was.
  const rendered: ReactNode[] = [];
  let foldRun: FoldItem[] = [];
  const flushFoldRun = () => {
    if (foldRun.length >= FOLD_MIN_RUN) rendered.push(<FoldedHandoffs key={`fold-${foldRun[0].key}`} items={foldRun} />);
    else for (const item of foldRun) rendered.push(item.node);
    foldRun = [];
  };
  for (const node of nodes) {
    if (isFoldItem(node)) {
      foldRun.push(node);
    } else {
      flushFoldRun();
      rendered.push(node);
    }
  }
  flushFoldRun();

  return (
    <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 18 : 22 }}>
      {rendered}
      <div ref={bottomRef} />
    </div>
  );
}
