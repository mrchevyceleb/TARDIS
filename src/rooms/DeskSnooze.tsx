import { AlarmClock, ChevronDown, MoonStar, RotateCcw } from 'lucide-react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { deskApi, focusDeskRef, isTodoSnoozed, useDeskWrite, wakeLabel, type DeskTodo } from '../data/desk';
import { showToast } from '../native/shell';
import { errorText, linkifyText } from './deskParts';

const DURATIONS = [[24, '24h'], [48, '48h'], [72, '72h'], [168, '1 week']] as const;
export { wakeLabel } from '../data/desk';

export function SnoozeTodoControl({ todo, disabled = false }: { todo: DeskTodo; disabled?: boolean }) {
  const write = useDeskWrite();
  const queryClient = useQueryClient();
  const [choosing, setChoosing] = useState(false);
  // The same item has controls in several lists. Keep its pending action in
  // Query's shared mutation cache so an optimistic list move cannot re-enable it.
  const latest = useMutationState({
    filters: { mutationKey: ['desk-snooze', todo.id] },
    select: (mutation) => mutation.state,
  }).at(-1);
  const busy = latest?.status === 'pending' ? (latest.variables === null ? 'return' : 'snooze') : null;
  const control = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const optionsId = useId();
  const restoreFocus = useRef<(() => void) | null>(null);
  // Retained rows can move in the drawer. Restore after React commits that
  // movement, before paint, instead of guessing when the cache has rendered.
  useLayoutEffect(() => {
    if (busy) restoreFocus.current?.();
  }, [busy, todo.snoozedUntil]);
  useLayoutEffect(() => () => {
    // A list move unmounts this control. The next frame is now guaranteed
    // to follow that removal and can find the replacement row or neighbor.
    const restore = restoreFocus.current;
    if (restore) window.requestAnimationFrame(restore);
  }, []);
  useEffect(() => {
    if (!choosing) return;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !control.current?.contains(event.target)) setChoosing(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [choosing]);
  const sleeping = isTodoSnoozed(todo);
  const change = async (hours: number | null) => {
    // Keep focus on the stable trigger while its drawer row is saving.
    if (trigger.current?.closest('.desk-snooze')?.contains(document.activeElement)) trigger.current.focus({ preventScroll: true });
    const until = new Date(Date.now() + (hours ?? 0) * 3_600_000).toISOString();
    // The focused row may leave its list. Keep focus near the item that moved.
    const section = trigger.current?.closest('section');
    const row = trigger.current?.closest('li');
    const enabledControls = '.desk-snooze-trigger:not(:disabled):not([aria-disabled="true"])';
    let nextControl: HTMLElement | null = null;
    for (let sibling = row?.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      if (sibling.classList.contains('is-leaving')) continue;
      nextControl = sibling.querySelector<HTMLElement>(enabledControls)
        ?? sibling.querySelector<HTMLElement>('.md-row-main, button.desk-todo-text');
      if (nextControl) break;
    }
    let restoredTo: HTMLElement | null = null;
    const returnFocus = (saved = false) => {
      if (!section?.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !control.current?.contains(active) && (saved || active !== restoredTo)) return;
      // An aria-disabled saving trigger remains focusable, unlike a native
      // disabled button. Keep the same item selected in a retained drawer row.
      const inPlace = row?.isConnected ? row.querySelector<HTMLElement>('.desk-snooze-trigger:not(:disabled)') : null;
      const returned = section?.querySelector<HTMLElement>(`[data-todo-id="${CSS.escape(todo.id)}"] .desk-snooze-trigger:not(:disabled):not([aria-disabled="true"])`);
      const fallback = section?.querySelector<HTMLElement>('.desk-snoozed > summary') ?? section?.querySelector<HTMLElement>('.desk-snooze-trigger:not(:disabled):not([aria-disabled="true"]), .md-open:not(:disabled)');
      const target = inPlace ?? (!saved || hours === null ? returned ?? fallback : nextControl?.isConnected ? nextControl : fallback);
      // A failed last-item bring-back remounts its fold closed. Reveal the
      // returned control before restoring focus into it.
      const returnedFold = target?.closest<HTMLDetailsElement>('details.desk-snoozed');
      if (!saved && returnedFold) returnedFold.open = true;
      target?.focus({ preventScroll: true });
      restoredTo = document.activeElement === target ? target : null;
    };
    restoreFocus.current = () => returnFocus(true);
    try {
      const { todo: saved } = await write(() => deskApi.snoozeTodo(todo.id, hours), (d) => ({
        ...d, todos: d.todos.map((t) => t.id === todo.id ? { ...t, snoozedUntil: until, snoozeReturnedPriority: hours === null ? t.priority : undefined } : t),
      }));
      showToast(hours === null ? 'Back on your Desk.' : `Tucked away. Back ${wakeLabel(saved.snoozedUntil ?? until)}.`);
      setChoosing(false);
      window.requestAnimationFrame(() => returnFocus(true));
    } catch (error) {
      showToast(`Could not change the snooze: ${errorText(error)}`);
      window.requestAnimationFrame(() => returnFocus());
      throw error;
    } finally {
      restoreFocus.current = null;
    }
  };
  const save = useMutation({ mutationKey: ['desk-snooze', todo.id], mutationFn: change, networkMode: 'always' });
  const submit = (hours: number | null) => {
    // Read the cache synchronously: a second tap can precede React's render.
    if (!queryClient.isMutating({ mutationKey: ['desk-snooze', todo.id] })) save.mutate(hours);
  };
  return (
    <div ref={control} className="desk-snooze" onBlur={(event) => {
      if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setChoosing(false);
    }} onKeyDown={(event) => {
      if (event.key === 'Escape' && choosing) { event.stopPropagation(); setChoosing(false); trigger.current?.focus(); }
    }}>
      <button ref={trigger} type="button" className="desk-mini-btn desk-snooze-trigger" disabled={disabled} aria-disabled={Boolean(busy) || undefined}
        aria-label={busy ? `${busy === 'return' ? 'Bringing back' : 'Saving snooze for'} ${todo.title}` : `${sleeping ? 'Bring back' : 'Snooze'} ${todo.title}`}
        aria-expanded={sleeping ? undefined : choosing}
        aria-controls={choosing && !sleeping ? optionsId : undefined}
        onClick={() => { if (!busy) { if (sleeping) submit(null); else setChoosing((v) => !v); } }}>
        {sleeping ? <RotateCcw size={13} aria-hidden="true" /> : <MoonStar size={13} aria-hidden="true" />}
        {busy ? 'Saving…' : sleeping ? 'Bring back now' : 'Snooze'}
      </button>
      <span className="desk-snooze-status" role="status">{busy ? (busy === 'return' ? 'Bringing it back…' : 'Saving snooze…') : ''}</span>
      {latest?.status === 'error' ? <p className="desk-answer-error" role="alert">That didn’t save. {errorText(latest.error)}</p> : null}
      {choosing && !sleeping ? (
        <div id={optionsId} className="desk-snooze-options" role="group" aria-label="Snooze for">
          {DURATIONS.map(([hours, label]) => (
            <button key={hours} type="button" className="desk-mini-btn" disabled={Boolean(busy) || disabled} onClick={() => submit(hours)}>{label}</button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Shared by the sidebar and full Desk, with every parked item a tap away. */
export function SnoozedTodos({ todos, focus, handledFocus: parentHandledFocus }: { todos: DeskTodo[]; focus?: { id: string; at: number } | null; handledFocus?: RefObject<number | null> }) {
  const fold = useRef<HTMLDetailsElement>(null);
  const focusId = focus?.id;
  const sleeping = todos.filter((t) => isTodoSnoozed(t)).sort((a, b) => a.snoozedUntil!.localeCompare(b.snoozedUntil!));
  const sleepingIds = sleeping.map((t) => t.id).join(',');
  const localHandledFocus = useRef<number | null>(null);
  const handledFocus = parentHandledFocus ?? localHandledFocus;
  const [lit, setLit] = useState<{ id: string; at: number } | null>(null);
  useLayoutEffect(() => {
    if (!focusId || focus?.at === handledFocus.current) return;
    const target = todos.find((t) => t.id === focusId);
    if (!target) return;
    // A focus request already served in Needs you must not open the Snoozed fold
    // when the owner subsequently snoozes that same item.
    if (!isTodoSnoozed(target)) {
      // Full Desk handles awake/Done targets in NeedsYou; the sidebar has
      // no matching effect, so consume those requests here only locally.
      if (!parentHandledFocus) handledFocus.current = focus?.at ?? null;
      return;
    }
    const row = fold.current?.querySelector<HTMLElement>(`[data-todo-id="${CSS.escape(focusId)}"]`);
    if (!row || !fold.current) return;
    // Reveal and locate the item in the same committed layout. Deferring this
    // to a frame can lose the handoff when the Desk refreshes in between.
    fold.current.open = true;
    row.querySelector<HTMLButtonElement>('.desk-snoozed-title')?.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    handledFocus.current = focus?.at ?? null;
    setLit(focus ?? null);
  }, [focus, focusId, sleepingIds, todos, handledFocus, parentHandledFocus]);
  useEffect(() => {
    if (!lit) return;
    const timer = window.setTimeout(() => setLit(null), 2400);
    return () => window.clearTimeout(timer);
  }, [lit]);
  if (!sleeping.length) return null;
  return (
    <details className="desk-done desk-snoozed" ref={fold}>
      <summary><ChevronDown size={15} aria-hidden="true" /><MoonStar size={14} aria-hidden="true" /> Snoozed <span className="desk-count is-quiet">{sleeping.length}</span></summary>
      <ul className="desk-snoozed-list">
        {sleeping.map((todo) => (
          <li key={todo.id} data-todo-id={todo.id} className={lit?.at === focus?.at && lit?.id === todo.id ? 'is-lit' : undefined}>
            <button type="button" className="desk-snoozed-title" aria-label={`${todo.title}, open on the Desk`} onClick={() => focusDeskRef({ kind: 'todo', id: todo.id })}>{todo.title}</button>
            <span className="desk-snoozed-wake"><AlarmClock size={12} aria-hidden="true" /> Back {wakeLabel(todo.snoozedUntil!)}</span>
            {focusId === todo.id && todo.detail ? <p className="desk-snoozed-detail">{linkifyText(todo.detail)}</p> : null}
            <SnoozeTodoControl todo={todo} />
          </li>
        ))}
      </ul>
    </details>
  );
}
