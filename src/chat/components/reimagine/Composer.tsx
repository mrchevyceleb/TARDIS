// Reimagined composer — §3.2 / §3.7. One component, two layouts (desktop hint
// row + chip-in-row; mobile attach button + chip dock-meta above). Implements
// the slash-command popover (↑/↓ wrap, Enter/Tab pick, Esc close), the
// ready → stop send-button state machine, auto-grow to the mobile/desktop cap,
// Enter-sends / Shift+Enter-newlines, the egg-phrase spark bursts, and
// attachment (paste, drag/drop, file picker) threaded through send/steer:
// images under the vision cap go as base64 exactly as before; any other file
// (and any oversized image) streams to the server with a progress bar and
// lands in the draft as a path line the receiving agent can open.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CommandEntry } from '../../data/types';
import { ArrowUp, Plus, SquarePen, StopSquare } from './icons';
import { isEggPhrase } from '../../../theme/eggs';
import { RobotControl } from '../RobotControl';
import { ChatDictation } from '../../dictation/ChatDictation';
import { BIG_UPLOAD_MAX_BYTES, humanFileSize, uploadBigFile } from '../../../data/api';

export type SendImage = { mediaType: string; base64: string; previewDataUrl?: string };
type PendingImage = { id: string; mediaType: string; base64: string; previewUrl: string };
type PendingUpload = { id: string; name: string; size: number; progress: number; error?: string };

/** Images up to this size in server-supported vision formats go as base64
 *  vision attachments (mirroring saveChatAttachments: PNG/JPEG/WebP/GIF,
 *  <=12 MB each, <=6 images, <=18 MB raw / <=24 MB encoded total). Anything
 *  else streams to the server's upload store so no file is silently dropped. */
const IMAGE_DIRECT_MAX = 12 * 1024 * 1024;
const IMAGE_DIRECT_MAX_COUNT = 6;
const IMAGE_DIRECT_MAX_TURN_BYTES = 18 * 1024 * 1024;
const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export type ComposerProps = {
  chatId?: string;
  /** false hides the robot remote control (channel composers keep dictation
   *  but have no robot to drive). Default keeps it. */
  robotControl?: boolean;
  mobile?: boolean;
  value: string;
  onChange: (v: string) => void;
  onSend: (text: string, images?: SendImage[]) => void | Promise<boolean | void>;
  /** Queue-next-turn (card-504beb): when present alongside a busy lane, the
 *  composer shows a Next turn chip; a send with it armed goes to the next
 *  turn instead of steering the live one. */
  onSendQueued?: (text: string, images?: SendImage[]) => void | Promise<boolean | void>;
  /** Surfaces the chip even without a steerable one-on-one lane (channel
 *  composers: any member working means a queued post is meaningful). */
  queueAvailable?: boolean;
  /** Reply-to-message (card-cbb4af): the armed reply context — shown as a
   *  quote bar above the draft, cleared with its ✕ or after the send. */
  replyTo?: { from: string; snippet: string } | null;
  onClearReply?: () => void;
  onStop?: () => void;
  onSteer?: (text: string, images?: SendImage[]) => void;
  /** Wipe the conversation and start a fresh thread (desktop row button). */
  onFresh?: () => void;
  busy: boolean;
  commands?: CommandEntry[];
  commandPrefix?: string;
  /** Channel member names for @-tag autocomplete (card-1327b9). Absent in
   *  one-on-one threads: @-addressing is a channel thing. */
  mentionMembers?: string[];
  modelChip?: React.ReactNode;
  hint?: React.ReactNode;
  attachButton?: React.ReactNode;
  attachMenu?: React.ReactNode;
  /** Accept attachments (images as vision, any other file as an upload).
   *  Defaults to true. */
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
  /** Reference chips (Desk cards, Needs-you items) shown in the tray above
      the textarea. They count as content, so a chip alone can be sent; the
      parent adds their tokens to the outgoing text. */
  refChips?: React.ReactNode;
  refCount?: number;
  /** Backspace in an empty draft: drop the last chip. */
  onBackspaceEmpty?: () => void;
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

// A stalled read must never wedge the attach gate shut (review 3): the gate
// blocks every send while a conversion runs, so conversion is bounded. On
// timeout the existing error chip shows and is dismissible, and the gate
// opens again.
const IMAGE_CONVERT_TIMEOUT_MS = 30_000;
async function fileToImageBounded(f: File): Promise<PendingImage | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fileToImage(f),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('image read timed out')), IMAGE_CONVERT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

type MentionMatch = {
  at: number;
  len: number;
  hits: string[];
};

function matchMentionToken(value: string, rawCaret: number, members?: string[]): MentionMatch | null {
  if (!members?.length) return null;
  const caret = Math.max(0, Math.min(rawCaret, value.length));
  const before = value.slice(0, caret);
  const m = /(?<![\p{L}\p{N}_])@([\p{L}\p{N}_'-]*)$/u.exec(before);
  if (!m) return null;
  const afterCaret = value.slice(caret);
  const tail = /^([\p{L}\p{N}_'-]*)/u.exec(afterCaret)?.[1] ?? '';
  const q = m[1].toLowerCase();
  const scored: { name: string; rank: number; idx: number }[] = [];
  members.forEach((rawName, idx) => {
    const name = rawName.trim();
    const norm = name.toLowerCase();
    if (!norm) return;
    let rank: number | null = null;
    if (!q || norm === q) rank = 0;
    else if (norm.startsWith(q)) rank = 1;
    else if (norm.split(/[\s'-]+/).some((w) => w.startsWith(q))) rank = 2;
    if (rank !== null) scored.push({ name, rank, idx });
  });
  if (!scored.length) return null;
  scored.sort((a, b) => a.rank - b.rank || a.idx - b.idx);
  return {
    at: caret - m[1].length - 1,
    len: 1 + m[1].length + tail.length,
    hits: scored.slice(0, 12).map((s) => s.name),
  };
}

export function Composer(props: ComposerProps) {
  const { mobile = false, acceptImages = true } = props;
  const hasMentions = Boolean(props.mentionMembers && props.mentionMembers.length > 0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sendRef = useRef<HTMLButtonElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const touchSubmitRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const touchSubmittedAtRef = useRef(0);
  const cap = mobile ? 128 : 148;
  const [popSel, setPopSel] = useState(0);
  const [popDismissed, setPopDismissed] = useState(false);
  // Caret of the composer textarea, tracked only when mentionMembers is set so
  // one-on-one threads pay zero selection-state overhead.
  const [caret, setCaret] = useState(0);
  const [images, setImages] = useState<PendingImage[]>([]);
  const [imageIngesting,setImageIngesting]=useState(0);
  const imageIngestingRef=useRef(0);
  const [uploads, setUploads] = useState<PendingUpload[]>([]);
  const [queueArmed, setQueueArmed] = useState(false);
  const uploadAborts = useRef(new Map<string, () => void>());
  // One shared in-flight-upload gate: submit, the dictation auto-send effect
  // and the send button all read this single derivation, so they can never
  // drift on what "an upload is still running" means (review 1 P1).
  const uploading = uploads.some((u) => !u.error);
  // One attach gate (review 2, verify regression): everything that must wait
  // for attachments — submit, the auto-send effect, the ready/steer/stop
  // button states, the tray, the waiting chip — reads this single
  // derivation, so the image-conversion state can never drift from the
  // upload state again. The ref covers conversions begun this tick, before
  // the state commits.
  const attachPending = uploading || imageIngesting > 0;
  const [phIdx, setPhIdx] = useState(0);
  const [dictating,setDictating]=useState(false);
  const [dictationOutcomeVersion,setDictationOutcomeVersion]=useState(0);
  const [pendingSendArmed,setPendingSendArmed]=useState(false);
  const [sendNotice,setSendNotice]=useState('');
  const pendingDictation=useRef<{chatId:string;completed:boolean;text:string}|null>(null);
  const latest=useRef(props);latest.current=props;
  const clearPendingDictation=()=>{pendingDictation.current=null;setPendingSendArmed(false);};
  const queueDictation=(text:string)=>{
    const dictated=text.trim();
    if(!dictated)return;
    const current=taRef.current?.value??latest.current.value;
    const next=current.trim()?`${current.trimEnd()}\n\n${dictated}`:dictated;
    if ( latest.current.mentionMembers?.length ) setCaret(next.length);
    latest.current.onChange(next);
    // Write the DOM value in the same tick as the append (review 2 P2): the
    // completion snapshot reads the DOM, and if the controlled re-render has
    // not committed yet, a snapshot taken before it would read the pre-
    // dictation draft and silently cancel the auto-send as a mismatch.
    if (taRef.current) taRef.current.value = next;
    taRef.current?.focus();
    // A new dictation supersedes any waiting auto-send: its text is already
    // in the draft, and its own completion re-arms the send.
    setPendingSendArmed(false);
    pendingDictation.current={chatId:latest.current.chatId??'',completed:false,text:next};
  };
  const completeDictation=()=>{
    if(pendingDictation.current){
      pendingDictation.current.completed=true;
      // The waiting send is bound to the draft as the person last saw it
      // complete. Uploads may append path lines to this snapshot; nothing
      // else may (review 1 P0).
      pendingDictation.current.text=taRef.current?.value??latest.current.value;
      setPendingSendArmed(true);
      setDictationOutcomeVersion(v=>v+1);
    }
  };
  // ChatDictation discards come from a session that never completed (no
  // speech heard, mic disconnect, explicit abandon). A completed send that
  // is waiting on uploads is cancelled only through its own chip, so a
  // later no-speech session cannot kill an earlier waiting send.
  const discardDictation=()=>{if(pendingDictation.current?.completed)return;clearPendingDictation();};

  // grok.com rotates the empty-composer placeholder every few seconds.
  const phrases = props.placeholders;
  useEffect(() => {
    // Arming a reply moves the conversation: focus the draft so the next
    // words land where they are going (card-cbb4af, review 1 P2 14). The deps
    // are the primitive fields, not the object identity: parents pass a fresh
    // object each render, and an object dep would steal focus on every
    // re-render (verify P1 4).
    if (props.replyTo) taRef.current?.focus();
  }, [props.replyTo?.from, props.replyTo?.snippet]);
  useEffect(() => {
    if (!phrases || phrases.length < 2) return;
    const iv = window.setInterval(() => setPhIdx((i) => (i + 1) % phrases.length), 6000);
    return () => window.clearInterval(iv);
  }, [phrases]);
  useEffect(() => {
    if (!sendNotice) return;
    const t = window.setTimeout(() => setSendNotice(''), 6000);
    return () => window.clearTimeout(t);
  }, [sendNotice]);

  const matches = useMemo(() => {
    const m = /^\/([a-z]*)$/.exec(props.value);
    if (!m) return [];
    const q = m[1];
    return (props.commands ?? []).filter((c) => c.name.startsWith(q));
  }, [props.value, props.commands]);
  const slashOpen = matches.length > 0 && !popDismissed;
  // @-tag autocomplete (card-1327b9): a caret-scoped mention token, so the
  // popover opens mid-draft wherever the typing is, not only at the start.
  // Exact full-name match ranks first, then full-name prefix, then word prefix;
  // picking replaces the whole @token (including any tail past the caret) and
  // adds a separating space unless whitespace already follows.
  const mention = useMemo(
    () => (hasMentions ? matchMentionToken(props.value, caret, props.mentionMembers) : null),
    [hasMentions, props.value, caret, props.mentionMembers],
  );
  const mentionOpen = !slashOpen && mention !== null && !popDismissed;
  const popOpen = slashOpen || mentionOpen;

  useEffect(() => {
    setPopSel(0);
  }, [props.value, hasMentions ? caret : 0]);

  // Let the mobile attach menu open the file picker imperatively.
  useEffect(() => {
    if (props.openFileInputRef) {
      props.openFileInputRef.current = () => fileInputRef.current?.click();
    }
  }, [props.openFileInputRef]);

  // Revoke object URLs only on unmount (not on every images array change,
  // which would revoke existing thumbnails when a second image is added or
  // while an async send is in flight).
  const imagesRef = useRef<PendingImage[]>([]);
  imagesRef.current = images;
  useEffect(
    () => () => {
      for (const img of imagesRef.current) URL.revokeObjectURL(img.previewUrl);
    },
    [],
  );
  // Unmount mid-upload aborts it (the path line never landed, so the draft
  // must not pretend the file is attached).
  useEffect(
    () => () => {
      for (const abort of uploadAborts.current.values()) abort();
      uploadAborts.current.clear();
    },
    [],
  );

  const ingest = async (files: FileList | File[]) => {
    if (!acceptImages) return;
    const selected = Array.from(files);
    const gated = selected.filter(f => INLINE_IMAGE_TYPES.has(f.type) && f.size <= IMAGE_DIRECT_MAX);
    const next: PendingImage[] = [];
    let inlineCount = imagesRef.current.length;
    let inlineBytes = imagesRef.current.reduce((sum, img) => sum + Math.floor((img.base64.length * 3) / 4), 0);
    if (gated.length) {
      imageIngestingRef.current += gated.length;
      setImageIngesting(imageIngestingRef.current);
    }
    try {
      for (const f of selected) {
        if (
          INLINE_IMAGE_TYPES.has(f.type)
          && f.size <= IMAGE_DIRECT_MAX
          && inlineCount < IMAGE_DIRECT_MAX_COUNT
          && inlineBytes + f.size <= IMAGE_DIRECT_MAX_TURN_BYTES
        ) {
          try {
            const img = await fileToImageBounded(f);
            if (img) {
              next.push(img);
              inlineCount += 1;
              inlineBytes += f.size;
              continue;
            }
          } catch (error) {
            setUploads((prev) => [...prev, {
              id:`imgerr${Math.random().toString(36).slice(2,8)}`,
              name:f.name,
              size:f.size,
              progress:0,
              error:error instanceof Error?error.message:'Image could not be read',
            }]);
            continue;
          }
        }
        void uploadFile(f);
      }
      if(next.length)setImages(prev=>[...prev,...next]);
    } finally {
      if (gated.length) {
        imageIngestingRef.current = Math.max(0, imageIngestingRef.current - gated.length);
        setImageIngesting(imageIngestingRef.current);
      }
    }
  };
  const removeImage = (id: string) => {
    // Removing an attachment edits the message the waiting send would carry.
    if (pendingDictation.current?.completed) clearPendingDictation();
    setImages((prev) => {
      const t = prev.find((i) => i.id === id);
      if (t) URL.revokeObjectURL(t.previewUrl);
      return prev.filter((i) => i.id !== id);
    });
  };
  const uploadFile = (f: File) => {
    const id = `up${Math.random().toString(36).slice(2, 8)}`;
    setUploads((prev) => [...prev, { id, name: f.name, size: f.size, progress: 0 }]);
    if (f.size > BIG_UPLOAD_MAX_BYTES) {
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, error: 'over the 16 GB cap' } : u)));
      return;
    }
    uploadBigFile(f, {
      onProgress: (fraction) => setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, progress: fraction } : u))),
      register: (abort) => uploadAborts.current.set(id, abort),
    }).then(
      (saved) => {
        uploadAborts.current.delete(id);
        setUploads((prev) => prev.filter((u) => u.id !== id));
        // The path line IS the attachment: whichever agent gets the message
        // can open the file at that path.
        const line = `${saved.name} (${humanFileSize(saved.bytes)}): ${saved.path}`;
        const cur = taRef.current?.value ?? props.value;
        const next = cur ? `${cur.trimEnd()}\n${line}` : line;
        if (latest.current.mentionMembers?.length) setCaret(next.length);
        props.onChange(next);
        // Write the DOM value in the same tick (review 3): the dictation
        // snapshot and the dictation append both read the DOM, so a path
        // line that has not committed yet must not be invisible to them.
        if (taRef.current) taRef.current.value = next;
        // An upload finishing after dictation completion may extend the
        // waiting send's snapshot with its path line — and nothing else.
        if (pendingDictation.current?.completed) pendingDictation.current.text = next;
      },
      (error) => {
        uploadAborts.current.delete(id);
        setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, error: (error as Error).message } : u)));
      },
    );
  };
  const removeUpload = (id: string) => {
    // Dismissing an in-flight chip aborts the upload the waiting send was
    // waiting for: the send stands down too.
    if (pendingDictation.current?.completed) clearPendingDictation();
    uploadAborts.current.get(id)?.();
    uploadAborts.current.delete(id);
    setUploads((prev) => prev.filter((u) => u.id !== id));
  };

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

  const submit = (allowStop = false): boolean => {
    if(dictating)return false;
    // Read the DOM value, not only the controlled prop. Android keyboards can
    // fire Enter/pointer-up before React commits the final input event; the old
    // stale empty prop took the Stop branch and killed the warm agent even
    // though the user had plainly typed a reply.
    const v = (taRef.current?.value ?? props.value).trim();
    const imgs = payload();
    const refs = (props.refCount ?? 0) > 0;
    const hasLiveContent = Boolean(v || imgs?.length || refs);
    // A direct image is not part of the payload until fileToImage completes;
    // a streaming upload is still writing its file. One gate covers both
    // (attachPending above): neither can be sent past, and an explicit Stop
    // tap on an empty draft still interrupts the running agent (it sends
    // nothing), so an in-flight upload never locks the person out of Stop
    // (review 1). A converting image is the exception (review 3): the person
    // just pasted it and the tray says so, so a tap in that moment means
    // send, never stop — the button promises "Attaching an image" and
    // keeps that promise.
    if(attachPending||imageIngestingRef.current>0){
      const converting=imageIngesting>0||imageIngestingRef.current>0;
      if(props.busy&&allowStop&&!hasLiveContent&&!converting)props.onStop?.();
      return false;
    }
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
        clearPendingDictation();
        if (queueArmed && props.onSendQueued && (canSteer || props.queueAvailable === true)) {
          props.onSendQueued(v, imgs);
          props.onChange('');
          if (taRef.current) taRef.current.value = '';
          clearImages();
          setQueueArmed(false);
        } else {
          props.onSteer(v, imgs);
          props.onChange('');
          if (taRef.current) taRef.current.value = '';
          clearImages();
        }
        return true;
      } else if (allowStop && !hasLiveContent) {
        props.onStop?.();
      }
      return false;
    }
    if (!v && !imgs?.length && !refs) return false;
    clearPendingDictation();
    // A queued send on a channel (never busy-blocked there): the chip arms
    // the next-turn choice even when the composer itself is not busy.
    const sendQueued = queueArmed && props.onSendQueued && (canSteer || props.queueAvailable === true);
    setQueueArmed(false);
    const prevImages = images;
    const res = sendQueued ? props.onSendQueued!(v, imgs) : props.onSend(v, imgs);
    props.onChange('');
    // Clear the DOM value in the same tick as the send: a manual Enter that
    // lands before the controlled re-render commits must not re-read and
    // re-send the same text (review 1 P2).
    if (taRef.current) taRef.current.value = '';
    if (res && typeof (res as Promise<boolean | void>).then === 'function') {
      setImages([]);
      void (res as Promise<boolean | void>).then(
        (ok) => {
          if (ok === false) {
            props.onChange(v);
            setImages((cur) => (cur.length ? cur : prevImages));
          } else {
            for (const i of prevImages) URL.revokeObjectURL(i.previewUrl);
          }
        },
        () => {
          props.onChange(v);
          setImages((cur) => (cur.length ? cur : prevImages));
        },
      );
    } else {
      clearImages();
    }
    return true;
  };

  // Dictation finishes before ChatDictation reports itself inactive and before
  // the controlled draft has committed. Wait for both, and also for any file
  // upload to finish, then reuse the canonical Send/Steer path exactly once.
  useEffect(()=>{
    const pending=pendingDictation.current;
    if(!pending||!pending.completed||dictating||pending.chatId!==(props.chatId??''))return;
    // A failed attachment is not permission to send an incomplete request.
    // Keep the dictated text in the draft and require an explicit Send after
    // the person removes or replaces the failed upload.
    if(uploads.some(u=>Boolean(u.error))){
      clearPendingDictation();
      setSendNotice('Dictation not sent · clear the failed attachment, then send.');
      return;
    }
    if(attachPending||imageIngestingRef.current>0)return;
    // The waiting send fires only on the draft the person last saw complete:
    // uploads may append path lines, but any other change means they kept
    // typing, so the auto-send stands down and the text waits for an explicit
    // Send (review 1 P0).
    const cur=taRef.current?.value??props.value;
    if(cur!==pending.text){clearPendingDictation();return;}
    // submit reports whether a message actually went out; a busy surface
    // with no steer path keeps the send waiting for the idle boundary
    // instead of silently dropping it (review 1 P1).
    if(submit(false))clearPendingDictation();
  },[dictating,dictationOutcomeVersion,imageIngesting,props.value,props.chatId,uploads,props.busy]);
  useEffect(()=>()=>{clearPendingDictation();},[props.chatId]);

  const pick = (i: number) => {
    const c = matches[i];
    if (!c) return;
    if (pendingDictation.current?.completed) clearPendingDictation();
    props.onChange(`/${c.name} `);
    taRef.current?.focus();
  };

  const pickMention = (i: number) => {
    const curVal = taRef.current?.value ?? props.value;
    const curCaret = taRef.current?.selectionStart ?? caret;
    const live = matchMentionToken(curVal, curCaret, props.mentionMembers) ?? mention;
    const name = live?.hits[i] ?? mention?.hits[i];
    if (!live || !name) return;
    const before = curVal.slice(0, live.at);
    const after = curVal.slice(live.at + live.len);
    const hasLeadingSpace = /^\s/.test(after);
    const sep = hasLeadingSpace ? '' : ' ';
    const next = `${before}@${name}${sep}${after}`;
    const pos = (before + `@${name}`).length + 1;
    if (pendingDictation.current?.completed) clearPendingDictation();
    setCaret(pos);
    props.onChange(next);
    taRef.current?.focus();
    requestAnimationFrame(() => {
      taRef.current?.focus();
      taRef.current?.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape' && props.replyTo && props.onClearReply) {
      e.stopPropagation();
      props.onClearReply();
      return;
    }
    if (popOpen && !e.nativeEvent.isComposing && e.nativeEvent.keyCode !== 229) {
      const count = slashOpen ? matches.length : (mention?.hits.length ?? 0);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setPopSel((s) => (s + (e.key === 'ArrowDown' ? 1 : -1) + count) % count);
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        e.preventDefault();
        if (slashOpen) pick(Math.min(popSel, matches.length - 1));
        else pickMention(Math.min(popSel, count - 1));
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPopDismissed(true);
        return;
      }
    }
    if (e.key === 'Backspace' && props.onBackspaceEmpty && (props.refCount ?? 0) > 0 && !e.currentTarget.value && !e.repeat) {
      e.preventDefault();
      props.onBackspaceEmpty();
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
      e.preventDefault();
      submit(false);
    }
  };

  // The keep-open note is for phone surfaces: a phone browser suspends
  // background tabs and kills the upload. The mobile prop covers the mobile
  // shells; the Grok phone surface renders this composer desktop-shaped, so
  // fall back to the viewport shape (a snapshot check; the chip re-renders
  // on every progress tick, so it stays fresh while uploading).
  const phoneSurface = mobile || (typeof window !== 'undefined' && window.matchMedia('(max-width: 760px)').matches);
  const trimmed = props.value.trim();
  const refCount = props.refCount ?? 0;
  // A converting image counts as content (review 3): the tray shows it, it
  // settles in seconds, and it must never leave the send button in
  // destructive Stop mode while the person waits to send it.
  const hasContent = trimmed.length > 0 || images.length > 0 || refCount > 0 || imageIngesting > 0;
  const ready = hasContent && !props.busy && !attachPending;
  // Text and image-only drafts both queue safely. An attached image must never
  // leave the button in destructive Stop mode.
  const canSteer = props.busy && hasContent && !attachPending && Boolean(props.onSteer);
  // Stop is shown exactly when a tap really stops: an empty-draft Stop still
  // interrupts while an upload streams, but with draft content the tap is
  // gated (the path line is not in the draft yet), so the button must not
  // promise Stop then. The upload chip carries that state instead. A busy
  // composer with no onStop handler renders Send, never a no-op Stop.
  const stopLive = props.busy && Boolean(props.onStop) && !canSteer && !(attachPending && hasContent);

  const sendBtn = (extraClass = '') => (
    <button
      ref={sendRef}
      type="button"
      className={`send${ready ? ' ready' : ''}${canSteer ? ' steer' : ''}${stopLive ? ' streaming' : ''} ${extraClass}`}
      aria-label={canSteer ? 'Send after the current response' : stopLive ? 'Stop generating' : uploading ? 'Uploading a file' : imageIngesting > 0 ? 'Attaching an image' : 'Send'}
      title={canSteer ? 'Send after the current response' : stopLive ? 'Stop generating' : uploading ? 'Uploading a file' : imageIngesting > 0 ? 'Attaching an image' : 'Send'}
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
    dictating ? null : !ready && !props.busy && props.idleAction ? props.idleAction : sendBtn(extraClass);

  // Next-turn chip (card-504beb): one-shot arm — the send after arming goes
  // to the next turn instead of steering. Shown only when a queued send is
  // meaningful (busy one-on-one lane, or working channel members).
  // Eligibility is the delivery-mode choice, not attachment timing (review
  // 3): a converting image or streaming upload must not disarm an armed
  // chip — the person pastes a screenshot and the Next-turn choice they
  // made survives it. The send itself still waits on attachPending either
  // way.
  const queueEligible = props.busy && Boolean(props.onSteer);
  const queueChip = props.onSendQueued && hasContent && (queueEligible || props.queueAvailable === true) ? (
    <button
      type="button"
      className={`queue-chip${queueArmed ? ' on' : ''}`}
      aria-pressed={queueArmed}
      title="Send as the next message after this turn, instead of steering it"
      aria-label="Queue this message for the next turn"
      onPointerDown={(e) => {
        // Same as the send button: a touch tap must not blur the textarea
        // first — the keyboard resize moves the chip and eats the tap.
        if (e.pointerType === 'touch') e.preventDefault();
      }}
      onClick={() => setQueueArmed((a) => !a)}
    >
      Next turn
    </button>
  ) : null;
  // The arm is strictly one-shot and strictly visible: it can never linger
  // armed into a later busy period, a channel switch, or an idle send.
  const queueLive = Boolean(queueChip);
  useEffect(() => {
    if (!queueLive) setQueueArmed(false);
  }, [queueLive]);

  // A completed dictation waiting on uploads is visible and cancellable: it
  // sends itself the moment the last upload settles, so the send slot says
  // so until then (review 1 P0).
  const pendingSendChip = pendingSendArmed && attachPending ? (
    <button
      type="button"
      className="queue-chip on"
      title="This dictated message sends itself when attachments finish"
      aria-label="Cancel the waiting auto-send"
      onClick={clearPendingDictation}
    >
      Auto-send waiting · Cancel
    </button>
  ) : null;

  const popListId = props.chatId ? `composer-pop-${props.chatId}` : 'composer-pop';
  const popCount = slashOpen ? matches.length : (mention?.hits.length ?? 0);
  const activeOptIdx = popCount > 0 ? Math.min(popSel, popCount - 1) : 0;

  const ingestRef = useRef(ingest);
  ingestRef.current = ingest;
  // Pasting a screenshot right after opening a channel or chat (before
  // clicking inside the textarea) should still attach the image, while never
  // stealing a paste from another focused input/textarea/editable element.
  useEffect(() => {
    if (!acceptImages) return;
    const onWindowPaste = (e: ClipboardEvent) => {
      if (e.defaultPrevented) return;
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== taRef.current && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        return;
      }
      const files: File[] = [];
      for (const item of Array.from(e.clipboardData?.items ?? [])) {
        if (item.kind === 'file') {
          const f = item.getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        void ingestRef.current(files);
        taRef.current?.focus();
      }
    };
    window.addEventListener('paste', onWindowPaste);
    return () => window.removeEventListener('paste', onWindowPaste);
  }, [acceptImages]);

  return (
    <>
      {mobile && (props.modelChip || props.busy) ? (
        <div className="dock-meta">
          {props.modelChip}
          {props.busy && !uploading ? <span className="steer-cue">Reply will send next ↪</span> : null}
        </div>
      ) : null}
      {slashOpen ? (
        <div id={popListId} className="pop show" role="listbox" aria-label="Console commands">
          <div className="pop-h">Console commands</div>
          {matches.map((c, i) => (
            <button
              key={c.name}
              id={`${popListId}-opt-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeOptIdx}
              className={`cmd${i === activeOptIdx ? ' sel' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span className="cn">/{c.name}</span>
              <span className="ch">{c.description ?? c.title ?? ''}</span>
            </button>
          ))}
        </div>
      ) : null}
      {mentionOpen ? (
        <div id={popListId} className="pop show" role="listbox" aria-label="Channel members">
          <div className="pop-h">Members</div>
          {mention?.hits.map((name, i) => (
            <button
              key={name}
              id={`${popListId}-opt-${i}`}
              type="button"
              role="option"
              aria-selected={i === activeOptIdx}
              className={`cmd${i === activeOptIdx ? ' sel' : ''}`}
              onMouseDown={(e) => e.preventDefault()}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pickMention(i)}
            >
              <span className="cn">@{name}</span>
            </button>
          ))}
        </div>
      ) : null}
      {props.chatId && props.robotControl !== false && <RobotControl />}
      {props.attachMenu}
      <div
        className={`composer${images.length > 0 || refCount > 0 || uploads.length > 0 || imageIngesting > 0 ? ' has-attach' : ''}${dictating ? ' dictating' : ''}`}
        onDragOver={(e) => {
          if (acceptImages && Array.from(e.dataTransfer.types).includes('Files')) {
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'copy';
          }
        }}
        onDrop={(e) => {
          if (!acceptImages) return;
          const files = Array.from(e.dataTransfer.files);
          if (files.length) {
            e.preventDefault();
            e.stopPropagation();
            void ingest(files);
          }
        }}
      >
        {props.replyTo && props.onClearReply ? (
          <div className="reply-arm" role="status" aria-label={`Replying to ${props.replyTo.from}`}>
            <span className="reply-quote">
              <b>{props.replyTo.from}</b>
              {props.replyTo.snippet}
            </span>
            <button type="button" className="reply-clear" aria-label="Clear reply" title="Clear reply" onClick={props.onClearReply}>✕</button>
          </div>
        ) : null}
        {sendNotice ? (
          <small role="status" className="dictation-notice composer-send-note">{sendNotice}</small>
        ) : null}
        {images.length > 0 || refCount > 0 || uploads.length > 0 || imageIngesting > 0 ? (
          <div className={`attach-tray${refCount > 0 ? ' has-refs' : ''}`}>
            {refCount > 0 ? props.refChips : null}
            {imageIngesting > 0 ? (
              <div className="up-chip" role="status" aria-busy="true">
                <span className="up-txt">{imageIngesting > 1 ? `Converting ${imageIngesting} images…` : 'Converting image…'}</span>
              </div>
            ) : null}
            {uploads.map((u) => (
              <div key={u.id} className={`up-chip${u.error ? ' up-err' : ''}`}>
                <div className="up-bar" style={{ width: `${Math.round((u.error ? 0 : u.progress) * 100)}%` }} />
                <span className="up-txt">
                  {u.error
                    ? `${u.name} · ${u.error}`
                    : `${u.name} · ${Math.round(u.progress * 100)}%${phoneSurface ? ' · keep this tab open' : ''}`}
                </span>
                <button type="button" className="attach-x" aria-label="remove" onClick={() => removeUpload(u.id)}>
                  ×
                </button>
              </div>
            ))}
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
          placeholder={dictating ? 'Listening…' : props.busy ? 'Reply — it will send next…' : props.placeholder ?? phrases?.[phIdx] ?? 'Where to, Doctor?'}
          aria-label="Message"
          aria-autocomplete={hasMentions || (props.commands?.length ?? 0) > 0 ? 'list' : undefined}
          aria-expanded={popOpen ? true : undefined}
          aria-controls={popOpen ? popListId : undefined}
          aria-activedescendant={popOpen && popCount > 0 ? `${popListId}-opt-${activeOptIdx}` : undefined}
          onChange={(e) => {
            setPopDismissed(false);
            // Any manual keystroke after dictation completion cancels the
            // waiting auto-send: the person took the draft back (review 1 P0).
            if (pendingDictation.current?.completed) clearPendingDictation();
            if (hasMentions) setCaret(e.target.selectionStart ?? e.target.value.length);
            props.onChange(e.target.value);
          }}
          onSelect={(e) => {
            if (hasMentions) setCaret(e.currentTarget.selectionStart ?? 0);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (!acceptImages) return;
            const files: File[] = [];
            for (const item of Array.from(e.clipboardData.items)) {
              if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f) files.push(f);
              }
            }
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
                disabled={dictating}
                onClick={() => {
                  clearPendingDictation();
                  props.onFresh?.();
                }}
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
            {props.chatId && <ChatDictation key={props.chatId} chatId={props.chatId} onText={queueDictation} onActive={setDictating} onComplete={completeDictation} onDiscard={discardDictation} />}
            <div className="send-slot">
              {pendingSendChip}
              {queueChip}
              {trailingBtn()}
            </div>
          </div>
        ) : (
          <>
            {props.chatId && <ChatDictation key={props.chatId} chatId={props.chatId} onText={queueDictation} onActive={setDictating} onComplete={completeDictation} onDiscard={discardDictation} />}
            <div className="send-slot">
              {pendingSendChip}
              {queueChip}
              {trailingBtn()}
            </div>
          </>
        )}
      </div>
      {acceptImages ? (
        <input
          type="file"
          ref={fileInputRef}
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
