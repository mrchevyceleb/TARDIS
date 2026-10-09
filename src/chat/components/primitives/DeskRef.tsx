// Desk references in chat: `[desk:card-…]` / `[desk:todo-…]` tokens render as
// live pills with the card or Needs-you title. A click opens the Desk on it.

import { Fragment, useEffect, useRef, type MouseEvent } from 'react';
import { useDeploymentFlags } from '../../../data/deploymentFlags';
import { focusDeskRef, hasDeskRef, splitDeskRefs, useDeskLookup, type DeskRef } from '../../../data/desk';

export function DeskRefPill({ target }: { target: DeskRef }) {
  const flags = useDeploymentFlags();
  const lookup = useDeskLookup(flags.deskRoom);
  const data = lookup.data;
  const card = target.kind === 'card' ? data?.cards.find((c) => c.id === target.id) : undefined;
  const todo = target.kind === 'todo' ? data?.todos.find((t) => t.id === target.id) : undefined;
  const gone = Boolean(data) && !card && !todo;
  // The shared snapshot may predate this reference (an agent just made the
  // card). Revalidate once before calling it removed; the Desk re-checks too,
  // so the pill stays clickable either way.
  const revalidated = useRef(false);
  const { refetch, isFetching } = lookup;
  useEffect(() => {
    if (!gone || revalidated.current || isFetching) return;
    revalidated.current = true;
    // Many pills can hit this in one commit; join one fetch instead of restarting it.
    void refetch({ cancelRefetch: false });
  }, [gone, isFetching, refetch]);
  const live = flags.deskRoom;
  const noun = target.kind === 'card' ? 'Card' : 'Needs-you item';
  const title = card?.title ?? todo?.title ?? (gone ? `${noun} removed` : target.id);
  const done = card ? card.column === 'in_production' : todo?.status === 'done';
  const where = card
    ? `${data?.columns.find((c) => c.key === card.column)?.title ?? card.column} · ${card.owner.name}`
    : todo ? (todo.status === 'done' ? 'Needs you · done' : 'Needs you') : '';
  const hint = !flags.deskRoom
    ? target.id
    : gone
      ? `That ${target.kind === 'card' ? 'card' : 'item'} is not on the Desk right now`
      : `Open on the Desk${where ? ` · ${where}` : ''}`;

  const open = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (live) focusDeskRef(target);
  };

  return (
    <button
      type="button"
      className={`desk-ref-pill${gone ? ' is-gone' : ''}${done ? ' is-done' : ''}`}
      data-kind={target.kind}
      data-ref={target.id}
      aria-disabled={!live || undefined}
      title={hint}
      aria-label={`${noun}: ${title}. ${hint}`}
      onClick={open}
    >
      <span className="desk-ref-pin" aria-hidden="true">📌</span>
      <span className="desk-ref-title">{title}</span>
    </button>
  );
}

/** Plain text with any Desk references swapped for pills. */
export function DeskRefText({ text }: { text: string }) {
  if (!hasDeskRef(text)) return <>{text}</>;
  return (
    <>
      {splitDeskRefs(text).map((part, i) => (typeof part === 'string'
        ? <Fragment key={i}>{part}</Fragment>
        : <DeskRefPill key={i} target={part} />))}
    </>
  );
}
