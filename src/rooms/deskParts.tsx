// Small shared pieces for the Desk room (Needs you + Board + card drawer).

import { useQuery } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { AlertTriangle, Check, ImagePlus, MessageCircle, SendHorizontal, X } from 'lucide-react';
import { apiJson } from '../data/api';
import { deskApi, deskImageUrl, useDeskWrite, type DeskActor, type DeskCard, type DeskPriority, type DeskTodo, type TodoAnswerInput } from '../data/desk';
import { uploadBigFile } from '../data/api';
import { agentColor, DISC_INK, type Agent } from '../grok/agents';
import { MarkdownLink } from '../chat/components/primitives/Markdown';
import { scanWorkspaceMentionSpans } from '../chat/utils/proxyLinks';

/** Agents for owner pickers and name lookups. The sidebar already polls the
 *  roster; keep Desk team membership current too. */
export function useDeskAgents(): Agent[] {
  const query = useQuery({
    queryKey: ['desk-agents'],
    queryFn: () => apiJson<{ agents: Agent[] }>('/api/agents'),
    staleTime: 4_000,
    refetchInterval: 4_000,
    retry: 1,
  });
  return query.data?.agents ?? [];
}

const URL_RUN = /https?:\/\/[^\s<>]+/g;

/** Plain text with http(s) URLs and workspace-path mentions turned into
 *  links. URLs open in a new tab. Workspace paths (ASSISTANT-HUB/... or the
 *  absolute Windows / Unix forms) are found by chat's own mention scanner,
 *  so a path in a Needs-you detail behaves exactly like the same path in
 *  chat (paths with spaces included) and renders through chat's proxy-link
 *  component, opening the same surfaces a path in chat opens (this PC's
 *  app, the in-app folder list, Studio). Nothing but text and anchors is
 *  produced (no HTML); sentence punctuation after a path stays outside the
 *  link. */
export function linkifyText(text: string): ReactNode[] {
  type Hit = { at: number; end: number; node: ReactNode };
  const hits: Hit[] = [];
  for (const match of text.matchAll(URL_RUN)) {
    let url = match[0];
    for (;;) {
      const tail = url[url.length - 1];
      const unmatched = tail === ')' ? (url.match(/\)/g)?.length ?? 0) > (url.match(/\(/g)?.length ?? 0)
        : tail === ']' ? (url.match(/\]/g)?.length ?? 0) > (url.match(/\[/g)?.length ?? 0)
        : false;
      if (unmatched || /[.,;:!?'"}]/.test(tail ?? '')) url = url.slice(0, -1); else break;
    }
    if (!/^https?:\/\/[^/.]/.test(url)) continue;
    const at = match.index ?? 0;
    hits.push({
      at,
      end: at + url.length,
      node: <a key={`u-${at}`} className="desk-detail-link" href={url} target="_blank" rel="noreferrer noopener">{url}</a>,
    });
  }
  for (const span of scanWorkspaceMentionSpans(text)) {
    // Never linkify inside a URL that was already matched above.
    if (hits.some((hit) => span.at < hit.end && hit.at < span.end)) continue;
    hits.push({
      at: span.at,
      end: span.end,
      node: (
        <MarkdownLink key={`w-${span.at}`} href={`rivendell-${span.kind}:${encodeURIComponent(span.path)}`}>
          {span.display}
        </MarkdownLink>
      ),
    });
  }
  hits.sort((a, b) => a.at - b.at);
  const out: ReactNode[] = [];
  let last = 0;
  for (const hit of hits) {
    if (hit.at > last) out.push(text.slice(last, hit.at));
    out.push(hit.node);
    last = hit.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export const PRIORITY_LABEL: Record<DeskPriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

/** Maps Desk priority onto the shared priority color classes. */
export function priorityClass(priority: DeskPriority): string {
  return priority === 'high' ? 'priority-high' : priority === 'low' ? 'priority-low' : 'priority-medium';
}

export function ActorChip({ actor, prefix, compact }: { actor: DeskActor; prefix?: string; compact?: boolean }) {
  const owner = actor.kind === 'owner';
  return (
    <span className={`desk-actor${owner ? ' is-owner' : ''}${compact ? ' is-compact' : ''}`} title={`${prefix ? `${prefix} ` : ''}${actor.name}`}>
      <span
        className="desk-actor-disc"
        aria-hidden="true"
        style={owner ? undefined : { background: agentColor(actor.name), color: DISC_INK }}
      >
        {actor.name.trim().slice(0, 1).toUpperCase() || '?'}
      </span>
      {compact ? null : <span className="desk-actor-name">{prefix ? `${prefix} ` : ''}{actor.name}</span>}
    </span>
  );
}

/** Pretty label for a stored link. */
export function linkLabel(link: string, agents: Agent[]): string {
  if (link.startsWith('thread:')) {
    const id = link.slice('thread:'.length);
    const agent = agents.find((a) => a.id === id);
    return `${agent?.name ?? id} thread`;
  }
  try {
    const url = new URL(link);
    const pr = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (url.hostname === 'github.com' && pr) return `${pr[2]} #${pr[3]}`;
    return url.hostname.replace(/^www\./, '') + (url.pathname.length > 1 ? url.pathname.slice(0, 24) : '');
  } catch {
    return link;
  }
}

/** Server errors arrive as JSON text; show just the message. */
export function errorText(error: unknown): string {
  const raw = (error as Error)?.message ?? String(error);
  try {
    const parsed = JSON.parse(raw) as { error?: string };
    if (parsed?.error) return parsed.error;
  } catch { /* plain text */ }
  return raw.slice(0, 200);
}

/** Opens the Desk chat with this card or item as a reference chip. */
export function DiscussButton({ onClick, subject, label }: { onClick: () => void; subject: string; label?: string }) {
  return (
    <button
      type="button"
      className={`desk-icon-btn desk-discuss-btn${label ? ' has-label' : ''}`}
      onClick={(event) => { event.stopPropagation(); onClick(); }}
      aria-label={`Discuss ${subject} in chat`}
      title="Discuss in chat"
    >
      <MessageCircle size={14} aria-hidden="true" />
      {label ? <span>{label}</span> : null}
    </button>
  );
}

/** True while the Desk chat is open beside the room. The card drawer stops
 *  acting as a modal then, so the chat stays usable. */
export const DeskChatOpenContext = createContext(false);
export function useDeskChatOpen(): boolean {
  return useContext(DeskChatOpenContext);
}

// ---- one-tap answers ------------------------------------------------------------------

/** The buttons an item offers: the agent's own choices, else Yes / No. */
export function answerChoices(todo: Pick<DeskTodo, 'choices'>): string[] {
  const list = [...new Set((todo.choices ?? []).map((c) => c.trim()).filter(Boolean))].slice(0, 4);
  return list.length ? list : ['Yes', 'No'];
}

/** Every open Needs-you item takes an answer (the server decides who hears it;
 *  the owner's own items may have nobody to tell). */
export function canAnswer(todo: DeskTodo): boolean {
  return todo.status === 'open' && (todo.from.kind !== 'owner' || Boolean(todo.choices?.length));
}

/** Invite an answer visibly on pointer taps as well as keyboard focus. */
export function focusTodoAnswer(button: HTMLButtonElement): boolean {
  const bar = button.closest('li')?.querySelector<HTMLElement>('.desk-answer');
  if (!bar) return false;
  bar.classList.add('is-invited');
  bar.focus();
  window.setTimeout(() => bar.classList.remove('is-invited'), 1800);
  return true;
}

/** Who hears the answer: the agent who asked, else the card's agent owner, else
 *  the Chief of Staff. Mirrors the server's routing; used for labels only. */
export function answerRecipient(todo: DeskTodo, card: DeskCard | undefined, agents: Agent[]): string {
  if (todo.from.kind === 'agent') return todo.from.name;
  if (card?.owner.kind === 'agent') return card.owner.name;
  return agents.find((a) => a.id === 'chief-of-staff')?.name ?? 'your Chief of Staff';
}

/** The same routing as an agent object, so Discuss can open that teammate's
 *  own thread: the asker, else the card's agent owner (or its agent creator),
 *  else the Chief of Staff. */
export function recipientAgent(actor: DeskActor | undefined, card: DeskCard | undefined, agents: Agent[]): Agent | undefined {
  const match = (a: DeskActor | undefined) => (a?.kind === 'agent'
    ? agents.find((x) => x.id === a.id) ?? agents.find((x) => x.name.trim().toLowerCase() === a.name.trim().toLowerCase())
    : undefined);
  return match(actor) ?? match(card?.owner) ?? match(card?.createdBy) ?? agents.find((a) => a.id === 'chief-of-staff') ?? agents[0];
}

/** A choice that means "let me write instead": tapping it opens the notes
 *  box, never sends the label itself as the answer. */
export function isNotesChoice(choice: string): boolean {
  const c = choice.trim().toLowerCase().replace(/[.!]+$/, '');
  // Anchored at both ends, so real decisions that merely mention notes
  // ("Write release notes", "Add notes to the PR") still send as choices.
  return c === 'notes' || /^(i'?ll|i will|let me)?\s*(send|leave|write|add)\s+(some\s+)?notes$/.test(c);
}

// ---- pasted images --------------------------------------------------------------------

export type DeskImageDraft = { id: string; name: string; previewUrl: string; path?: string; uploading: boolean; error?: string };
export const DESK_IMAGE_MAX = 4;
const DESK_IMAGE_TYPE = /^image\/(png|jpe?g|gif|webp)$/;
type SetImageDrafts = (fn: (prev: DeskImageDraft[]) => DeskImageDraft[]) => void;

/** Upload pasted/picked image files into a draft list (the chat composer's
 *  own big-upload path: the saved path is what the teammate opens). */
const uploadAborts = new Map<string, () => void>();
const EXT_BY_TYPE: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

export function addImageFiles(set: SetImageDrafts, files: File[] | FileList, currentCount: number): number {
  const room = DESK_IMAGE_MAX - currentCount;
  if (room <= 0) return 0;
  const fresh = Array.from(files).filter((f) => DESK_IMAGE_TYPE.test(f.type)).slice(0, room)
    .map((original) => {
      // The server validates by extension; give extensionless or .jfif
      // pastes the extension their type already proved.
      const ext = EXT_BY_TYPE[original.type] ?? '.png';
      const file = /\.(png|jpe?g|gif|webp)$/i.test(original.name)
        ? original
        : new File([original], `${(original.name || 'pasted-image').replace(/\.[^.]*$/, '')}${ext}`, { type: original.type });
      return { file, draft: { id: `img${Math.random().toString(36).slice(2, 9)}`, name: file.name, previewUrl: URL.createObjectURL(file), uploading: true } as DeskImageDraft };
    });
  if (!fresh.length) return 0;
  set((prev) => [...prev, ...fresh.map((f) => f.draft)]);
  for (const { file, draft } of fresh) {
    uploadBigFile(file, { register: (abort) => uploadAborts.set(draft.id, abort) }).then(
      (saved) => { uploadAborts.delete(draft.id); set((prev) => prev.map((d) => (d.id === draft.id ? { ...d, path: saved.path, uploading: false } : d))); },
      (error) => { uploadAborts.delete(draft.id); set((prev) => prev.map((d) => (d.id === draft.id ? { ...d, uploading: false, error: (error as Error).message } : d))); },
    );
  }
  return fresh.length;
}

/** Drop one draft (aborting its upload) from a draft list. */
export function dropImageDraft(prev: DeskImageDraft[], id: string): DeskImageDraft[] {
  const gone = prev.find((d) => d.id === id);
  if (gone) {
    uploadAborts.get(id)?.();
    uploadAborts.delete(id);
    URL.revokeObjectURL(gone.previewUrl);
  }
  return prev.filter((d) => d.id !== id);
}

/** One notes box's image drafts (card drawer). The answer bars keep theirs
 *  per todo inside useTodoAnswers. */
export function useImageDrafts() {
  const [drafts, setDraftsState] = useState<DeskImageDraft[]>([]);
  const set = useCallback<SetImageDrafts>((fn) => setDraftsState(fn), []);
  // Reserved synchronously, so two pastes before a re-render cannot pass 4.
  const reserved = useRef(0);
  const addFiles = useCallback((files: File[] | FileList) => {
    reserved.current += addImageFiles(set, files, reserved.current);
  }, [set]);
  const remove = useCallback((id: string) => {
    reserved.current = Math.max(0, reserved.current - 1);
    setDraftsState((prev) => dropImageDraft(prev, id));
  }, []);
  const clear = useCallback(() => {
    reserved.current = 0;
    setDraftsState((prev) => {
      for (const d of prev) URL.revokeObjectURL(d.previewUrl);
      return [];
    });
  }, []);
  return {
    drafts,
    addFiles,
    remove,
    clear,
    paths: drafts.flatMap((d) => (d.path ? [d.path] : [])),
    uploading: drafts.some((d) => d.uploading),
  };
}

/** Thumbnails for pasted images: drafts still being written, or saved paths. */
export function DeskImageThumbs({ drafts, onRemove }: { drafts: DeskImageDraft[]; onRemove?: (id: string) => void }) {
  if (!drafts.length) return null;
  return (
    <div className="desk-image-row">
      {drafts.map((d) => (
        <span key={d.id} className={`desk-image-chip${d.uploading ? ' is-uploading' : ''}${d.error ? ' is-error' : ''}`} title={d.error ? `${d.name}: ${d.error}` : d.name}>
          <img src={d.previewUrl} alt={d.name} />
          {d.uploading ? <span className="desk-image-state">Sending…</span> : d.error ? <span className="desk-image-state">Failed</span> : null}
          {onRemove ? (
            <button type="button" className="desk-image-x" aria-label={`Remove ${d.name}`} onClick={() => onRemove(d.id)}>
              <X size={11} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}

/** Saved pasted images on an answer or comment, served back by the server. */
export function DeskSavedImages({ images }: { images?: string[] }) {
  const urls = (images ?? []).flatMap((path) => {
    const url = deskImageUrl(path);
    return url ? [{ path, url }] : [];
  });
  if (!urls.length) return null;
  return (
    <div className="desk-image-row">
      {urls.map(({ path, url }) => (
        <a key={path} className="desk-image-chip" href={url} target="_blank" rel="noreferrer noopener" title={path}>
          <img src={url} alt="Pasted image" loading="lazy" />
        </a>
      ))}
    </div>
  );
}

export type PendingAnswer = TodoAnswerInput & { phase: 'sending' | 'sent' | 'undelivered' | 'conflict' | 'rejected'; to?: string; error?: string };

/** How long an answered row stays in the open list before it leaves. */
const ANSWER_LINGER_MS = 1100;

type IdMap<V> = ReadonlyMap<string, V>;
function withEntry<V>(prev: IdMap<V>, id: string, value: V | undefined): IdMap<V> {
  if (value === undefined ? !prev.has(id) : prev.get(id) === value) return prev;
  const next = new Map(prev);
  if (value === undefined) next.delete(id); else next.set(id, value);
  return next;
}

/** Answering Needs-you items, shared by the Desk room and My desk. The row shows
 *  the answer at once (the item is marked done in the cache), stays in place
 *  until the server confirms, then leaves like a check-off. A failed save rolls
 *  back and keeps the typed words; a save the agent was not told about stays on
 *  screen until it is dismissed. */
export function useTodoAnswers(todos: DeskTodo[] | undefined) {
  const write = useDeskWrite();
  const [pending, setPending] = useState<IdMap<PendingAnswer>>(() => new Map());
  const [drafts, setDrafts] = useState<IdMap<string>>(() => new Map());
  const [imageDrafts, setImageDrafts] = useState<IdMap<DeskImageDraft[]>>(() => new Map());
  const [errors, setErrors] = useState<IdMap<string>>(() => new Map());
  const timers = useRef(new Map<string, number>());
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    const live = timers.current;
    return () => { for (const t of live.values()) window.clearTimeout(t); };
  }, []);
  // The server keeps retrying a delivery that failed. Once the poll says the
  // agent was told (or the item is gone), the warning row stops claiming
  // otherwise and leaves for Done.
  useEffect(() => {
    if (!todos) return;
    setPending((prev) => {
      let next = prev;
      for (const [id, entry] of prev) {
        if (entry.phase !== 'undelivered') continue;
        const todo = todos.find((t) => t.id === id);
        if (!todo || todo.answer?.delivery === 'sent') next = withEntry(next, id, undefined);
      }
      return next;
    });
  }, [todos]);

  const setDraft = useCallback((id: string, text: string) => setDrafts((prev) => withEntry(prev, id, text || undefined)), []);
  const setImagesFor = useCallback((id: string): SetImageDrafts => (fn) => {
    setImageDrafts((prev) => {
      const next = fn(prev.get(id) ?? []);
      return withEntry(prev, id, next.length ? next : undefined);
    });
  }, []);
  const reservedImages = useRef(new Map<string, number>());
  const addImages = useCallback((id: string, files: File[] | FileList) => {
    const added = addImageFiles(setImagesFor(id), files, reservedImages.current.get(id) ?? 0);
    reservedImages.current.set(id, (reservedImages.current.get(id) ?? 0) + added);
  }, [setImagesFor]);
  const removeImage = useCallback((id: string, imageId: string) => {
    reservedImages.current.set(id, Math.max(0, (reservedImages.current.get(id) ?? 0) - 1));
    setImagesFor(id)((prev) => dropImageDraft(prev, imageId));
  }, [setImagesFor]);
  const dismiss = useCallback((id: string) => {
    setPending((prev) => withEntry(prev, id, undefined));
    setErrors((prev) => withEntry(prev, id, undefined));
  }, []);

  const answer = useCallback(async (todo: DeskTodo, input: TodoAnswerInput) => {
    const choice = input.choice?.trim() || undefined;
    const text = input.text?.trim().slice(0, 4000) || undefined;
    const images = input.images?.length ? input.images.slice(0, DESK_IMAGE_MAX) : undefined;
    if ((!choice && !text && !images) || inflight.current.has(todo.id)) return;
    inflight.current.add(todo.id);
    window.clearTimeout(timers.current.get(todo.id));
    setErrors((prev) => withEntry(prev, todo.id, undefined));
    setPending((prev) => withEntry(prev, todo.id, { choice, text, images, phase: 'sending' }));
    const now = new Date().toISOString();
    try {
      const result = await write(
        () => deskApi.answerTodo(todo.id, { ...(choice ? { choice } : {}), ...(text ? { text } : {}), ...(images ? { images } : {}) }),
        (d) => ({
          ...d,
          todos: d.todos.map((t) => (t.id === todo.id
            ? { ...t, status: 'done' as const, completedAt: now, updatedAt: now, answer: { choice, text, images, at: now, delivery: t.from.kind === 'owner' ? 'none' as const : 'sent' as const } }
            : t)),
        }),
      );
      const saved = result?.todo?.answer;
      const delivery = saved?.delivery ?? (result?.notified && !result.notified.delivered ? 'failed' : 'sent');
      const shown = saved ? { choice: saved.choice, text: saved.text, images: saved.images } : { choice, text, images };
      if (!result?.conflict) {
        setDrafts((prev) => withEntry(prev, todo.id, undefined));
        reservedImages.current.delete(todo.id);
        setImageDrafts((prev) => {
          for (const d of prev.get(todo.id) ?? []) URL.revokeObjectURL(d.previewUrl);
          return withEntry(prev, todo.id, undefined);
        });
      }
      if (result?.conflict) {
        setPending((prev) => withEntry(prev, todo.id, { ...shown, phase: 'conflict' }));
      } else if (delivery === 'failed') {
        setPending((prev) => withEntry(prev, todo.id, { ...shown, phase: 'undelivered', to: result?.notified?.to }));
      } else {
        setPending((prev) => withEntry(prev, todo.id, { ...shown, phase: 'sent' }));
        timers.current.set(todo.id, window.setTimeout(() => {
          timers.current.delete(todo.id);
          setPending((prev) => withEntry(prev, todo.id, undefined));
        }, ANSWER_LINGER_MS));
      }
    } catch (error) {
      const message = `Your answer was not saved: ${errorText(error)}`;
      // Keep this attempted answer visible even if polling has already moved
      // the question to Done. An error inside AnswerBar would disappear.
      setPending((prev) => withEntry(prev, todo.id, { choice, text, images, phase: 'rejected', error: message }));
      setErrors((prev) => withEntry(prev, todo.id, message));
    } finally {
      inflight.current.delete(todo.id);
    }
  }, [write]);

  return { pending, drafts, imageDrafts, errors, answer, setDraft, addImages, removeImage, dismiss };
}
export type TodoAnswers = ReturnType<typeof useTodoAnswers>;

const YES = /^(yes|yep|approve|approved|go|ship it)$/i;
const NO = /^(no|nope|hold|stop|reject)$/i;

/** One button per choice plus a real notes box: multi-line text and pasted
 *  images, all of it delivered straight to the teammate who asked. Tapping a
 *  choice sends it with whatever notes and images are in the box; a choice
 *  that means "I'll send notes" just opens the box instead. */
export function AnswerBar({ todo, answers, compact, recipient }: { todo: DeskTodo; answers: TodoAnswers; compact?: boolean; recipient?: string }) {
  const draft = answers.drafts.get(todo.id) ?? '';
  const imageDrafts = answers.imageDrafts.get(todo.id) ?? [];
  const error = answers.errors.get(todo.id);
  const text = draft.trim();
  const uploading = imageDrafts.some((d) => d.uploading);
  const failed = imageDrafts.some((d) => d.error);
  const paths = imageDrafts.flatMap((d) => (d.path ? [d.path] : []));
  const canSend = (Boolean(text) || paths.length > 0) && !uploading && !failed;
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const focusNotes = () => {
    notesRef.current?.focus();
    notesRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };
  const pasteImages = (files: File[] | FileList | null) => {
    if (files && Array.from(files).some((f) => f.type.startsWith('image/'))) answers.addImages(todo.id, files);
  };
  const send = (event: FormEvent) => {
    event.preventDefault();
    if (canSend) void answers.answer(todo, { text, images: paths });
  };
  const who = recipient ?? 'the teammate who asked';
  return (
    <div className={`desk-answer${compact ? ' is-compact' : ''}`} role="group" tabIndex={-1} aria-label={`Answer ${todo.title}`}>
      <div className="desk-answer-choices">
        {answerChoices(todo).map((choice) => {
          const notes = isNotesChoice(choice);
          return (
            <button
              key={choice}
              type="button"
              className="desk-answer-choice"
              data-tone={YES.test(choice) ? 'yes' : NO.test(choice) ? 'no' : undefined}
              onClick={() => {
                if (notes) { focusNotes(); return; }
                if (!uploading && !failed) void answers.answer(todo, { choice, text, images: paths });
              }}
              aria-label={notes ? `Write notes for ${who}` : text || paths.length ? `Answer ${choice} with your notes` : `Answer ${choice}`}
              title={notes ? 'Write your notes below, then Send' : text || paths.length ? `Answer ${choice} with your notes` : `Answer ${choice}`}
            >
              {choice}
            </button>
          );
        })}
      </div>
      <form
        className="desk-notes"
        onSubmit={send}
        onDragOver={(event) => { if (Array.from(event.dataTransfer.types).includes('Files')) event.preventDefault(); }}
        onDrop={(event) => { event.preventDefault(); pasteImages(event.dataTransfer.files); }}
      >
        <textarea
          ref={notesRef}
          value={draft}
          onChange={(event) => answers.setDraft(todo.id, event.target.value)}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files ?? []);
            if (!files.length) return;
            // Office apps copy an image rendering beside the text: only an
            // image-only clipboard replaces the paste; text always lands.
            if (!event.clipboardData.getData('text/plain')) event.preventDefault();
            pasteImages(files);
          }}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend) {
              event.preventDefault();
              void answers.answer(todo, { text, images: paths });
            }
          }}
          placeholder={`Notes for ${who}. Paste images right in.`}
          aria-label={`Notes for ${who} on ${todo.title}`}
          rows={compact ? 2 : 3}
          maxLength={4000}
        />
        <DeskImageThumbs drafts={imageDrafts} onRemove={(imageId) => answers.removeImage(todo.id, imageId)} />
        <div className="desk-notes-actions">
          <button type="button" className="desk-notes-attach" onClick={() => fileRef.current?.click()} aria-label="Attach an image" title="Attach an image (or paste one)">
            <ImagePlus size={14} aria-hidden="true" />
            <span>Image</span>
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            multiple
            hidden
            onChange={(event) => { pasteImages(event.target.files); event.target.value = ''; }}
          />
          {failed ? <span className="desk-notes-hint is-error">An image did not upload. Remove it to send.</span>
            : uploading ? <span className="desk-notes-hint">Uploading image…</span> : null}
          <button type="submit" className="desk-answer-send desk-notes-send" disabled={!canSend} aria-label={`Send notes to ${who}`} title="Send (Ctrl Enter)">
            <SendHorizontal size={14} aria-hidden="true" />
            <span>Send to {who}</span>
          </button>
        </div>
      </form>
      {error ? <p className="desk-answer-error" role="alert">{error}</p> : null}
    </div>
  );
}

/** What was answered, on a row that is leaving or in the Done list. */
export function AnsweredNote({ answer, phase, to, error, onDismiss }: {
  answer: TodoAnswerInput;
  phase?: PendingAnswer['phase'] | 'failed';
  to: string;
  error?: string;
  onDismiss?: () => void;
}) {
  const warn = phase === 'undelivered' || phase === 'failed' || phase === 'conflict' || phase === 'rejected';
  return (
    <div className={`desk-answered${phase ? ` is-${phase}` : ''}`} role={phase === 'rejected' ? 'alert' : phase && phase !== 'failed' ? 'status' : undefined}>
      <p className="desk-answered-line">
        {phase === 'rejected' ? <AlertTriangle size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" className="desk-answered-icon" />}
        <span className="desk-answered-text">
          {phase === 'rejected' ? 'Your answer: ' : 'Answered: '}{answer.choice ? <strong>{answer.choice}</strong> : null}
          {answer.choice && answer.text ? <span aria-hidden="true"> · </span> : null}
          {answer.text ? <q>{answer.text}</q> : null}
        </span>
        <DeskSavedImages images={answer.images} />
        {phase === 'sending' ? <span className="desk-answered-sending">Sending</span> : null}
      </p>
      {warn ? (
        <p className="desk-answered-warn">
          <AlertTriangle size={13} aria-hidden="true" />
          <span>{phase === 'rejected' ? error ?? 'Your answer was not saved. Dismiss this notice to try again.' : phase === 'conflict' ? 'This was already answered. Your new answer was not saved. Reopen it to change the answer.' : `Saved, but ${to} was not told.`}</span>
          {onDismiss ? (
            <button type="button" className="desk-answered-ok" onClick={onDismiss} aria-label="Dismiss" title="Dismiss">
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </p>
      ) : null}
    </div>
  );
}
