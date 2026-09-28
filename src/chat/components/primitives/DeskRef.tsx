// Desk references in chat: `[desk:card-…]` / `[desk:todo-…]` tokens render as
// live pills with the card or Needs-you title. A click opens the Desk on it.

import { Fragment, type MouseEvent } from 'react';
import { useDeploymentFlags } from '../../../data/deploymentFlags';
import { focusDeskRef, hasDeskRef, splitDeskRefs, useDeskLookup, type DeskRef } from '../../../data/desk';

export function DeskRefPill({ target }: { target: DeskRef }) {
  const flags = useDeploymentFlags();
  const lookup = useDeskLookup(flags.deskRoom);
  const data = lookup.data;
  const card = target.kind === 'card' ? data?.cards.find((c) => c.id === target.id) : undefined;
  const todo = target.kind === 'todo' ? data?.todos.find((t) => t.id === target.id) : undefined;
  const gone = Boolean(data) && !card && !todo;
  const live = flags.deskRoom && !gone;
  const noun = target.kind === 'card' ? 'Card' : 'Needs-you item';
  const title = card?.title ?? todo?.title ?? (gone ? `${noun} removed` : target.id);
  const done = card ? card.column === 'done' : todo?.status === 'done';
  const where = card
    ? `${data?.columns.find((c) => c.key === card.column)?.title ?? card.column} · ${card.owner.name}`
    : todo ? (todo.status === 'done' ? 'Needs you · done' : 'Needs you') : '';
  const hint = !flags.deskRoom
    ? target.id
    : gone
      ? `That ${target.kind === 'card' ? 'card' : 'item'} is no longer on the Desk`
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
