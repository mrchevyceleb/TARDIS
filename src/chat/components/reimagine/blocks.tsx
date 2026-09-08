// Shared building blocks for the reimagined chat thread, used by BOTH the
// desktop (Conversation) and mobile (Mobile) screens. These render the real
// ChatBlock stream from useChat into the "ship speaks on the page" anatomy
// defined in the approved prototypes (§3.3 – §3.8).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { ChatBlock } from '../../data/types';
import { Markdown } from '../primitives/Markdown';
import { ArtifactCard } from '../blocks/ArtifactCard';
import { DocLinkCard } from '../blocks/DocLinkCard';
import { FolderLinkCard } from '../blocks/FolderLinkCard';
import { ChevronDown, StarSigil } from './icons';
import { isAutomationPeer, isNoopToken, shouldHideAutomationTurn } from '../../utils/routineNoise';
import { BRAND, REGEN_QUOTES, THINKING_PHRASES, TIMEY_WIMEY } from '../../../theme/voice';

export function timeLabel(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
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

function ActiveTurnIndicator({ since, phrases }: { since?: number; phrases: string[] }) {
  const hasKnownStart = Boolean(since && since > 0);
  const startedAtRef = useRef(hasKnownStart ? since as number : Date.now());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    startedAtRef.current = since && since > 0 ? since : Date.now();
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [since]);
  const elapsed = Math.max(0, now - startedAtRef.current);
  const seconds = Math.floor(elapsed / 1000);
  const label = phrases[Math.floor(elapsed / 2800) % phrases.length] ?? 'Working';
  const clock = hasKnownStart
    ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
    : 'live';
  return (
    <div className="active-turn" role="status" aria-label="Agent is still working">
      <span className="vortex active-turn-star" aria-hidden="true" />
      <span key={label} className="active-turn-label bt-fade" aria-hidden="true">{label}</span>
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
}: {
  getText: () => string;
  pinned?: boolean;
  onTogglePin?: () => void | Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [localPinned, setLocalPinned] = useState(false);
  const [busy, setBusy] = useState(false);
  const isPinned = onTogglePin ? Boolean(pinned) : localPinned;
  return (
    <div className="acts">
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

function PeerBubble({
  block,
  responseBlocks,
  responseActive,
  streaming,
  mobile,
  collapseSteps,
  pin,
}: {
  block: Extract<ChatBlock, { kind: 'peer' }>;
  responseBlocks: AssistantBlock[];
  responseActive: boolean;
  streaming: boolean;
  mobile: boolean;
  collapseSteps: boolean;
  pin?: ThreadPin;
}) {
  const [open, setOpen] = useState(false);
  const initial = (block.from || '?').trim().slice(0, 1).toUpperCase();
  const routineResult = block.fromRole === 'automation-result';
  const text = cleanPeerMessageText(block.text);
  const bodyId = `peer-message-${block.id}`;
  const hasResponse = responseBlocks.length > 0;
  const publicResponseBlocks = responseBlocks.filter((item) => item.kind !== 'tool');
  const responseToolCount = responseBlocks.filter((item) => item.kind === 'tool').length;
  // The peer boundary, not individual content-block open flags, owns progress.
  // Providers can briefly close one block before opening the next; the exchange
  // must not flicker to "done" while its turn is still running.
  const responseBusy = responseActive || responseBlocks.some(
    (item) => (item.kind === 'text' && item.open) || (item.kind === 'tool' && item.running),
  );
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
            <div className="bt-peer-turn-text">{text}</div>
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
        />
      </div>
    ) : null}
    </>
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
    <div className="terminal-error" role="alert">
      <span className="terminal-error-mark" aria-hidden="true">!</span>
      <span>
        <strong>Couldn’t answer this turn</strong>
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

// ── user bubble ───────────────────────────────────────────────────────────
function UserBubble({ block }: { block: Extract<ChatBlock, { kind: 'user' }> }) {
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
      <div className="bubble">{block.text}</div>
      {block.deliveryState ? (
        <span className={`delivery-state ${block.deliveryState}`} role={block.deliveryState === 'failed' ? 'alert' : 'status'}>
          {block.deliveryState === 'queued' ? 'Queued · will run next' : 'Not delivered'}
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
function ToolsCard({ blocks }: { blocks: ToolBlock[] }) {
  const [open, setOpen] = useState(false);
  const running = blocks.some((b) => b.running);
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(b.tool, (counts.get(b.tool) ?? 0) + 1);
  const summary = [...counts.entries()].map(([n, c]) => (c > 1 ? `${n} ×${c}` : n)).join(' · ');
  const oldestRunning = blocks.find((b) => b.running);
  return (
    <div className={`tool tools-run${running ? ' running' : ' done'}${open ? ' open' : ''}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {running ? <span className="vortex tstar" aria-hidden="true" /> : <StarSigil className="tstar" />}
        <span className="tool-title">{blocks.length} tool calls</span>
        <span className="tool-meta">{running && oldestRunning ? <RunningMeta since={oldestRunning.ts} /> : 'done'}</span>
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
  return b.text.trim().length > 0;
}

/** Protocol no-ops that must not steal the Grok answer slot. Broader
 *  isQuietRoutineReply ("nothing happened", …) is for automation hide, not
 *  for promoting a human turn's last sentence. */
function isProtocolNoopText(text: string): boolean {
  return isNoopToken(text);
}

function isAnswerProse(b: Extract<ChatBlock, { kind: 'text' }>): boolean {
  const t = b.text.trim();
  return t.length > 0 && !isProtocolNoopText(t);
}

function showTextCaret(b: Extract<ChatBlock, { kind: 'text' }>, streaming: boolean): boolean {
  return Boolean(b.open) && streaming;
}

/** Preserve every user-facing text message, including between-tool updates.
 * Provider metadata controls presentation, not visibility. Never guess that
 * prose is private reasoning from its words or its position before a tool. */
// A run of consecutive assistant blocks that share a turnId render under a
// single "✦ TARDIS" header (the prototype's per-turn group).
function ElrondGroup({
  blocks,
  streaming,
  mobile,
  collapseSteps = false,
  pin,
}: {
  blocks: AssistantBlock[];
  streaming: boolean;
  mobile: boolean;
  collapseSteps?: boolean;
  pin?: ThreadPin;
}) {
  const [acted, setActed] = useState(false);
  const first = blocks[0];
  const textBlocks = blocks.filter((b): b is Extract<ChatBlock, { kind: 'text' }> => b.kind === 'text');
  const isUpdate = collapseSteps && textBlocks.length > 0 && textBlocks.every((b) => b.presentation === 'update');
  const isActivity = collapseSteps && textBlocks.length === 0;
  const copyText = () => {
    const src = textBlocks.filter(isAnswerProse);
    return (src.length ? src : textBlocks.filter(hasVisibleProse)).map((b) => b.text).join('\n\n');
  };
  const isPinned = Boolean(pin?.pinnedBlockIds.includes(first.id));
  // Grok mode collapses only consecutive tool calls. Assistant `text` blocks
  // always render in their original position so a long-running turn remains a
  // real conversation instead of hiding every message until the final result.
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
    for (const b of blocks) {
      if (b.kind === 'tool') run.push(b);
      else flush();
    }
    flush();
  }
  return (
    <div
      id={`msg-pin-${first.id}`}
      data-pin-block={first.id}
      className={`msg m-elrond${isUpdate ? ' m-update' : ''}${isActivity ? ' m-activity' : ''}${acted ? ' acted' : ''}${isPinned ? ' pinned' : ''}`}
      onClick={mobile ? () => setActed((a) => !a) : undefined}
    >
      <div className="who">
        <span className="mini">✦</span> {BRAND} <span className="when">{timeLabel(first.ts)}</span>
      </div>
      {isUpdate && <div className="update-label">Update</div>}
      {blocks.map((b) => {
        switch (b.kind) {
          case 'tool': {
            if (toolRunSkip.has(b.id)) return null;
            const run = toolRuns.get(b.id);
            if (run) return <ToolsCard key={b.id} blocks={run} />;
            return <ToolCard key={b.id} block={b} />;
          }
          case 'text': {
            const open = showTextCaret(b, streaming);
            const display = isProtocolNoopText(b.text) ? '' : b.text;
            if (!open && !display) return null;
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
      {(textBlocks.some(isAnswerProse) || textBlocks.some(hasVisibleProse)) && !streaming ? (
        <ActionsRow
          getText={copyText}
          pinned={isPinned}
          onTogglePin={pin ? () => {
            const src = textBlocks.filter(isAnswerProse);
            const visible = src.length ? src : textBlocks.filter(hasVisibleProse);
            const last = visible[visible.length - 1];
            return pin.onToggle({ blockId: first.id, text: last?.text ?? copyText(), ts: first.ts });
          } : undefined}
        />
      ) : null}
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
  /** Suppress the typing indicator entirely (silent automation turn running). */
  suppressTyping?: boolean;
  /** Wall-clock start of the active turn, used for visible proof-of-life time. */
  workingSince?: number;
};

// Renders the full feed: day marks on day changes, user bubbles, per-turn
// assistant groups (tool cards + streaming prose), and the live-turn pill
// while a turn is live but no content has landed yet.
export function ChatThread({ blocks, status, contentRef, bottomRef, mobile = false, phrases = THINKING_PHRASES, collapseSteps = false, pin, suppressTyping = false, workingSince }: ChatThreadProps) {
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
  const hasCurrentTerminalFailure = currentBlocks.some((block) => block.kind === 'terminal-error');
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
    | { type: 'peer'; block: Extract<ChatBlock, { kind: 'peer' }>; responseBlocks: AssistantBlock[]; responseTurnId?: string | null; day: string }
  > = [];
  type PeerGroup = Extract<(typeof groups)[number], { type: 'peer' }>;
  const peerGroupsById = new Map<string, PeerGroup>();
  let lastDay = '';
  for (const b of blocks) {
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

  const nodes: ReactNode[] = [];
  let pendingAutomation = false;
  let hideThinking = false;
  for (const g of groups) {
    if (g.type === 'peer' && isAutomationPeer(g.block.from, g.block.fromRole, g.block.text)) {
      pendingAutomation = true;
      hideThinking = true;
      continue;
    }
    if (g.type === 'user' || g.type === 'compact' || g.type === 'restart' || g.type === 'terminal-error' || g.type === 'switch' || g.type === 'peer') {
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
      nodes.push(<UserBubble key={g.block.id} block={g.block} />);
    } else if (g.type === 'compact') {
      nodes.push(<CompactDivider key={g.block.id} block={g.block} />);
    } else if (g.type === 'restart') {
      nodes.push(<RestartDivider key={g.block.id} block={g.block} />);
    } else if (g.type === 'terminal-error') {
      nodes.push(<TerminalErrorCard key={g.block.id} block={g.block} />);
    } else if (g.type === 'switch') {
      nodes.push(<SwitchDivider key={g.block.id} block={g.block} />);
    } else if (g.type === 'peer') {
      nodes.push(
        <PeerBubble
          key={g.block.id}
          block={g.block}
          responseBlocks={g.responseBlocks}
          responseActive={activePeerId === g.block.id}
          streaming={streaming}
          mobile={mobile}
          collapseSteps={collapseSteps}
          pin={pin}
        />,
      );
    } else {
      nodes.push(<ElrondGroup key={g.blocks[0].id} blocks={g.blocks} streaming={streaming} mobile={mobile} collapseSteps={collapseSteps} pin={pin} />);
    }
  }

  if (streaming && !hasCurrentTerminalFailure && !hideThinking && !pendingAutomation && !suppressTyping) {
    // Never make the user infer liveness from a Stop button. Keep one animated
    // proof-of-life row visible for the ENTIRE turn, even after user-facing
    // prose or completed tool cards have appeared.
    nodes.push(<ActiveTurnIndicator key="active-turn" since={workingSince} phrases={phrases} />);
  } else if (!latestQueued && status === 'ready' && hasAssistantAfterLastUser && !hasCurrentTerminalFailure) {
    // Absence of animation must mean something explicit. This permanent,
    // low-emphasis terminal marker distinguishes "finished" from "stalled".
    nodes.push(<TurnCompleteIndicator key="turn-complete" />);
  } else if ((status === 'connecting' || status === 'closed' || status === 'error') && blocks.length > 0) {
    nodes.push(<ConnectionStateIndicator key="connection-state" reconnecting={status !== 'error'} />);
  }

  return (
    <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: mobile ? 18 : 22 }}>
      {nodes}
      <div ref={bottomRef} />
    </div>
  );
}
