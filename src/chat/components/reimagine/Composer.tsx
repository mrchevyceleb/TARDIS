// Reimagined composer — §3.2 / §3.7. One component, two layouts (desktop hint
// row + chip-in-row; mobile attach button + chip dock-meta above). Implements
// the slash-command popover (↑/↓ wrap, Enter/Tab pick, Esc close), the
// ready → stop send-button state machine, auto-grow to the mobile/desktop cap,
// Enter-sends / Shift+Enter-newlines, the egg-phrase spark bursts, and
// image attachment (paste, drag/drop, file picker) threaded through send/steer.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommandEntry } from '../../data/types';
import { ArrowUp, Plus, SquarePen, StopSquare } from './icons';
import { isEggPhrase } from '../../../theme/eggs';
import { ComputerControl } from '../ComputerControl';
import { RobotControl } from '../RobotControl';

export type SendImage = { mediaType: string; base64: string; previewDataUrl?: string };
type PendingImage = { id: string; mediaType: string; base64: string; previewUrl: string };

export type ComposerProps = {
  chatId?: string;
  mobile?: boolean;
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string, images?: SendImage[]) => void;
  onStop?: () => void;
  onSteer?: (text: string, images?: SendImage[]) => void;
  /** Wipe the conversation and start a fresh thread (desktop row button). */
  onFresh?: () => void;
  busy: boolean;
  commands?: CommandEntry[];
  commandPrefix?: string;
  modelChip?: React.ReactNode;
  hint?: React.ReactNode;
  attachButton?: React.ReactNode;
  attachMenu?: React.ReactNode;
  /** Accept image attachments (paste / drop / picker). Defaults to true. */
  acceptImages?: boolean;
  /** Parent (mobile) can trigger the file picker by calling this ref. */
  openFileInputRef?: React.MutableRefObject<() => void>;
  /** Grok shell: leading slot rendered inside the pill, before the textarea
      (the + attach button). Desktop only — mobile has its own attach. */
  leadingSlot?: React.ReactNode;
  /** Rotating placeholder strings (grok.com style). Falls back to the static
      'Where to, Doctor?' when omitted. */
  placeholders?: string[];
  /** Fixed placeholder (Grok Bot: "Message {agent}"). Wins over placeholders. */
  placeholder?: string;
  /** Grok Bot shell: rendered instead of the send disc when the composer is
      empty and idle (the white mic disc). Typing flips it back to send. */
  idleAction?: React.ReactNode;
  onMellon?: (sendRect: DOMRect) => void;
};

async function fileToImage(f: File): Promise<PendingImage | null> {
  if (!f.type.startsWith('image/')) return null;
  const buf = new Uint8Array(await f.arrayBuffer());
  // chunked btoa to avoid call-stack overflow on large files
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < buf.length; i += chunk) {
    bin += String.fromCharCode(...buf.subarray(i, i + chunk));
  }
  return {
    id: `img${Math.random().toString(36).slice(2, 8)}`,
    mediaType: f.type,
    base64: btoa(bin),
    previewUrl: URL.createObjectURL(f),
  };
}

export function Composer(props: ComposerProps) {
  const { mobile = false, acceptImages = true } = props;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const touchSubmitRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const touchSubmittedAtRef = useRef(0);
  const cap = mobile ? 128 : 148;
  const [popSel, setPopSel] = useState(0);
  const [popDismissed, setPopDismissed] = useState(false);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [phIdx, setPhIdx] = useState(0);

  // grok.com rotates the empty-composer placeholder every few seconds.
  const phrases = props.placeholders;
  useEffect(() => {
    if (!phrases || phrases.length < 2) return;
    const iv = window.setInterval(() => setPhIdx((i) => (i + 1) % phrases.length), 6000);
    return () => window.clearInterval(iv);
  }, [phrases]);

  const matches = useMemo(() => {
    const m = /^\/([a-z]*)$/.exec(props.value);
    if (!m) return [];
    const q = m[1];
    return (props.commands ?? []).filter((c) => c.name.startsWith(q));
  }, [props.value, props.commands]);
  const popOpen = matches.length > 0 && !popDismissed;

  useEffect(() => {
    setPopSel(0);
  }, [props.value]);

  // Let the mobile attach menu open the file picker imperatively.
  useEffect(() => {
    if (props.openFileInputRef) {
      props.openFileInputRef.current = () => fileInputRef.current?.click();
    }
  }, [props.openFileInputRef]);

  // Revoke object URLs on unmount so we never leak preview blobs.
  useEffect(
    () => () => {
      for (const img of images) URL.revokeObjectURL(img.previewUrl);
    },
    [images],
  );

  const ingest = async (files: FileList | File[]) => {
    if (!acceptImages) return;
    const next: PendingImage[] = [];
    for (const f of Array.from(files)) {
      const img = await fileToImage(f);
      if (img) next.push(img);
    }
    if (next.length) setImages((prev) => [...prev, ...next]);
  };
  const removeImage = (id: string) =>
    setImages((prev) => {
      const t = prev.find((i) => i.id === id);
      if (t) URL.revokeObjectURL(t.previewUrl);
      return prev.filter((i) => i.id !== id);
    });

  const grow = () => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, cap)}px`;
    el.style.overflowY = el.scrollHeight > cap ? 'auto' : 'hidden';
  };
  useLayoutEffect(grow, [props.value, cap]);

  const payload = (): SendImage[] | undefined =>
    images.length ? images.map((i) => ({ mediaType: i.mediaType, base64: i.base64, previewDataUrl: i.previewUrl })) : undefined;

  const clearImages = () =>
    setImages((prev) => {
      for (const i of prev) URL.revokeObjectURL(i.previewUrl);
      return [];
    });

  const submit = (allowStop = false) => {
    // Read the DOM value, not only the controlled prop. Android keyboards can
    // fire Enter/pointer-up before React commits the final input event; the old
    // stale empty prop took the Stop branch and killed the warm agent even
    // though the user had plainly typed a reply.
    const v = (taRef.current?.value ?? props.value).trim();
    const imgs = payload();
    const hasLiveContent = Boolean(v || imgs?.length);
    // While the backend still owns a turn, any text OR image is queued guidance.
    // Only an explicit click/tap on an empty red Stop button may cancel.
    // Keyboard Enter with an empty/stale draft is a no-op, never an interrupt.
    // A bare trigger phrase bursts sparks (presentation only); the text still
    // sends or steers exactly as typed, so this sits before the busy branch.
    if (isEggPhrase(v) && props.onMellon && sendRef.current) {
      props.onMellon(sendRef.current.getBoundingClientRect());
    }
    if (props.busy) {
      if (hasLiveContent && props.onSteer) {
        props.onSteer(v, imgs);
        props.onChange('');
        clearImages();
      } else if (allowStop && !hasLiveContent) {
        props.onStop?.();
      }
      return;
    }
    if (!v && !imgs?.length) return;
    props.onSend(v, imgs);
    props.onChange('');
    clearImages();
  };

  const pick = (i: number) => {
    const c = matches[i];
    if (!c) return;
    props.onChange(`/${c.name} `);
    taRef.current?.focus();
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (popOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPopSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (e.nativeEvent.isComposing) return;
        e.preventDefault();
        pick(Math.min(popSel, matches.length - 1));
        return;
      }
      if (e.key === 'Escape') {
        setPopDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      e.preventDefault();
      submit(false);
    }
  };

  const trimmed = props.value.trim();
  const hasContent = trimmed.length > 0 || images.length > 0;
  const ready = hasContent && !props.busy;
  // Text and image-only drafts both queue safely. An attached image must never
  // leave the button in destructive Stop mode.
  const canSteer = props.busy && hasContent && Boolean(props.onSteer);

  const sendBtn = (extraClass = '') => (
    <button
      ref={sendRef}
      type="button"
      className={`send${ready ? ' ready' : ''}${canSteer ? ' steer' : ''}${props.busy && !canSteer ? ' streaming' : ''} ${extraClass}`}
      aria-label={canSteer ? 'Send after the current response' : props.busy ? 'Stop generating' : 'Send'}
      title={canSteer ? 'Send after the current response' : props.busy ? 'Stop generating' : 'Send'}
      onPointerDown={(e) => {
        if (e.pointerType !== 'touch') return;
        // iOS/Android blur the textarea first; the keyboard viewport resize can
        // move/unmount this button before `click`, so the first tap only hides
        // the keyboard. Prevent that blur, then submit on pointer-up so a drag
        // or canceled touch cannot accidentally send.
        e.preventDefault();
        touchSubmitRef.current = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
      }}
      onPointerMove={(e) => {
        const touch = touchSubmitRef.current;
        if (!touch || touch.pointerId !== e.pointerId) return;
        if (Math.hypot(e.clientX - touch.x, e.clientY - touch.y) > 12) touchSubmitRef.current = null;
      }}
      onPointerUp={(e) => {
        const touch = touchSubmitRef.current;
        touchSubmitRef.current = null;
        if (e.pointerType !== 'touch' || !touch || touch.pointerId !== e.pointerId) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const stayedPut = Math.hypot(e.clientX - touch.x, e.clientY - touch.y) <= 12;
        const inside = e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom;
        if (!stayedPut || !inside) return;
        e.preventDefault();
        touchSubmittedAtRef.current = Date.now();
        submit(true);
      }}
      onPointerCancel={(e) => {
        if (touchSubmitRef.current?.pointerId === e.pointerId) touchSubmitRef.current = null;
      }}
      onClick={() => {
        if (Date.now() - touchSubmittedAtRef.current < 1000) return;
        submit(true);
      }}
    >
      <ArrowUp className="ic-send" />
      <svg className="ic-steer" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <polyline points="15 14 20 9 15 4" />
        <path d="M4 20v-7a4 4 0 0 1 4-4h12" />
      </svg>
      <StopSquare className="ic-stop" />
      <span className="stop-txt" aria-hidden="true">Stop</span>
    </button>
  );

  const trailingBtn = (extraClass = '') =>
    !ready && !props.busy && props.idleAction ? props.idleAction : sendBtn(extraClass);

  return (
    <>
      {mobile && (props.modelChip || props.busy) ? (
        <div className="dock-meta">
          {props.modelChip}
          {props.busy ? <span className="steer-cue">Reply will send next ↪</span> : null}
        </div>
      ) : null}
      {popOpen ? (
        <div className="pop show" role="listbox">
          <div className="pop-h">Console commands</div>
          {matches.map((c, i) => (
            <button key={c.name} type="button" className={`cmd${i === popSel ? ' sel' : ''}`} onClick={() => pick(i)}>
              <span className="cn">/{c.name}</span>
              <span className="ch">{c.description ?? c.title ?? ''}</span>
            </button>
          ))}
        </div>
      ) : null}
      {props.chatId && <ComputerControl key={props.chatId} chatId={props.chatId} />}
      {props.chatId && <RobotControl />}
      {props.attachMenu}
      <div className={`composer${images.length > 0 ? ' has-attach' : ''}`}>
        {images.length > 0 ? (
          <div className="attach-tray">
            {images.map((img) => (
              <div key={img.id} className="attach-thumb">
                <img src={img.previewUrl} alt="attached" />
                <button type="button" className="attach-x" aria-label="remove" onClick={() => removeImage(img.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        ) : null}
        {mobile ? props.attachButton : props.leadingSlot ?? null}
        <textarea
          ref={taRef}
          rows={1}
          value={props.value}
          placeholder={props.busy ? 'Reply — it will send next…' : props.placeholder ?? phrases?.[phIdx] ?? 'Where to, Doctor?'}
          aria-label="Message"
          onChange={(e) => {
            setPopDismissed(false);
            props.onChange(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!acceptImages) return;
            const files: File[] = [];
            for (const item of Array.from(e.clipboardData.items)) {
              if (item.kind === 'file' && item.type.startsWith('image/')) {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length) {
              e.preventDefault();
              void ingest(files);
            }
          }}
          onDragOver={(e) => {
            if (acceptImages && Array.from(e.dataTransfer.types).includes('Files')) {
              e.preventDefault();
              e.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDrop={(e) => {
            if (!acceptImages) return;
            const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'));
            if (files.length) {
              e.preventDefault();
              void ingest(files);
            }
          }}
        />
        {!mobile ? (
          <div className="composer-row">
            {props.onFresh ? (
              <button
                type="button"
                className="freshbtn"
                title="Start a fresh thread"
                aria-label="Start a fresh thread"
                onClick={props.onFresh}
              >
                <SquarePen />
                fresh
              </button>
            ) : null}
            {props.modelChip}
            {props.busy ? (
              <span className="hint steer-cue">Reply will send next ↪</span>
            ) : (
              props.hint ?? (
                <span className="hint">
                  <b>/</b> commands · <b>shift+enter</b> new line
                </span>
              )
            )}
            {trailingBtn()}
          </div>
        ) : (
          trailingBtn()
        )}
      </div>
      {acceptImages ? (
        <input
          type="file"
          ref={fileInputRef}
          accept="image/*"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void ingest(e.target.files);
            if (fileInputRef.current) fileInputRef.current.value = '';
          }}
        />
      ) : null}
    </>
  );
}

// Mobile attach (+) button shell — the menu rows are rendered by the parent so
// the toast / insert actions can stay in the screen that owns the composer.
export function AttachButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="attach" aria-label="Attach" onClick={onClick}>
      <Plus />
    </button>
  );
}
