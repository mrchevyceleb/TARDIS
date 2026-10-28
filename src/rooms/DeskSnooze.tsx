import { AlarmClock, ChevronDown, MoonStar, RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState, type RefObject } from 'react';
import { deskApi, focusDeskRef, isTodoSnoozed, useDeskWrite, type DeskTodo } from '../data/desk';
import { showToast } from '../native/shell';
import { errorText, linkifyText } from './deskParts';

const DURATIONS = [[24, '24h'], [48, '48h'], [72, '72h'], [168, '1 week']] as const;
export const wakeLabel = (at: string) => new Date(at).toLocaleString([], {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

export function SnoozeTodoControl({ todo, disabled = false }: { todo: DeskTodo; disabled?: boolean }) {
  const write = useDeskWrite();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const sleeping = isTodoSnoozed(todo);
  const change = async (hours: number | null) => {
    if (busy) return;
    // Keep focus on the stable trigger while its drawer row is saving.
    if (trigger.current?.closest('.desk-snooze')?.contains(document.activeElement)) trigger.current.focus({ preventScroll: true });
    setBusy(true);
    const until = new Date(Date.now() + (hours ?? 0) * 3_600_000).toISOString();
    // The focused row may leave its list. Keep focus near the item that moved.
    const section = trigger.current?.closest('section');
    const row = trigger.current?.closest('li');
    const enabledControls = '.desk-check:not(:disabled), .md-check:not(:disabled), .desk-snooze-trigger:not(:disabled):not([aria-disabled="true"])';
    const nextControl = row?.nextElementSibling?.querySelector<HTMLElement>(enabledControls);
    const returnFocus = (saved = false) => {
      if (!section?.isConnected) return;
      const active = document.activeElement;
      if (active && active !== document.body && !row?.contains(active)) return;
      const inPlace = row?.isConnected ? row.querySelector<HTMLElement>('.desk-snooze-trigger:not(:disabled):not([aria-disabled="true"])') : null;
      const returned = section?.querySelector<HTMLElement>(`[data-todo-id="${CSS.escape(todo.id)}"] .desk-snooze-trigger:not(:disabled):not([aria-disabled="true"])`);
      const fallback = section?.querySelector<HTMLElement>('.desk-snoozed > summary') ?? section?.querySelector<HTMLElement>('.desk-snooze-trigger:not(:disabled):not([aria-disabled="true"]), .md-open:not(:disabled)');
      (inPlace ?? (!saved || hours === null ? returned ?? fallback : nextControl?.isConnected ? nextControl : fallback))?.focus({ preventScroll: true });
    };
    try {
      await write(() => deskApi.snoozeTodo(todo.id, hours), (d) => ({
        ...d, todos: d.todos.map((t) => t.id === todo.id ? { ...t, snoozedUntil: until, snoozeReturnedPriority: hours === null ? t.priority : undefined } : t),
      }));
      showToast(hours === null ? 'Back on your Desk.' : `Tucked away. Back ${wakeLabel(until)}.`);
      setChoosing(false);
      window.requestAnimationFrame(() => returnFocus(true));
    } catch (error) {
      showToast(`Could not change the snooze: ${errorText(error)}`);
      window.requestAnimationFrame(() => returnFocus());
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="desk-snooze" onKeyDown={(event) => {
      if (event.key === 'Escape' && choosing) { event.stopPropagation(); setChoosing(false); trigger.current?.focus(); }
    }}>
      <button ref={trigger} type="button" className="desk-mini-btn desk-snooze-trigger" disabled={disabled} aria-disabled={busy || undefined}
        aria-label={`${sleeping ? 'Bring back' : 'Snooze'} ${todo.title}`}
        aria-expanded={sleeping ? undefined : choosing}
        onClick={() => { if (!busy) { if (sleeping) void change(null); else setChoosing((v) => !v); } }}>
        {sleeping ? <RotateCcw size={13} aria-hidden="true" /> : <MoonStar size={13} aria-hidden="true" />}
        {busy ? 'Saving…' : sleeping ? 'Bring back now' : 'Snooze'}
      </button>
      {choosing && !sleeping ? (
        <div className="desk-snooze-options" role="group" aria-label="Snooze for">
          {DURATIONS.map(([hours, label]) => (
            <button key={hours} type="button" className="desk-mini-btn" disabled={busy || disabled} onClick={() => void change(hours)}>{label}</button>
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
  const [lit, setLit] = useState<string | null>(null);
  useEffect(() => {
    if (!focusId || focus?.at === handledFocus.current) return;
    const target = todos.find((t) => t.id === focusId);
    if (!target) return;
    // A focus request already served in Needs you must not open the Snoozed fold
    // when the owner subsequently snoozes that same item.
    if (!isTodoSnoozed(target)) { handledFocus.current = focus?.at ?? null; return; }
    if (!fold.current?.querySelector(`[data-todo-id="${CSS.escape(focusId)}"]`)) return;
    fold.current.open = true;
    handledFocus.current = focus?.at ?? null;
    setLit(focusId);
  }, [focus, focusId, sleepingIds, todos, handledFocus]);
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
          <li key={todo.id} data-todo-id={todo.id} className={lit === todo.id ? 'is-lit' : undefined}>
            <button type="button" className="desk-snoozed-title" onClick={() => focusDeskRef({ kind: 'todo', id: todo.id })}>{todo.title}</button>
            <span className="desk-snoozed-wake"><AlarmClock size={12} aria-hidden="true" /> Back {wakeLabel(todo.snoozedUntil!)}</span>
            {focusId === todo.id && todo.detail ? <p className="desk-snoozed-detail">{linkifyText(todo.detail)}</p> : null}
            <SnoozeTodoControl todo={todo} />
          </li>
        ))}
      </ul>
    </details>
  );
}
