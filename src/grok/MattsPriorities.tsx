// Matt's Priorities on My desk: one small ordered board per agent (Max,
// Riley). Matt adds here; the agent sees the open items on every turn.

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronDown, ChevronUp, X } from 'lucide-react';
import { useState } from 'react';
import { fetchPriorityBoards, priorityAction, type PriorityAction, type PriorityBoard, type PriorityItem } from '../data/api';
import { showToast } from '../native/shell';

const KEY = ['priorities'];

export function MattsPriorities() {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: KEY, queryFn: fetchPriorityBoards, refetchInterval: 20_000 });
  const boards = query.data?.boards ?? [];
  const [picked, setPicked] = useState<string>();
  const board = boards.find((b) => b.agentId === picked) ?? boards[0];
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<{ id: string; text: string }>();

  const run = async (op: PriorityAction) => {
    if (!board) return;
    try {
      const { items } = await priorityAction(board.agentId, op);
      qc.setQueryData<{ boards: PriorityBoard[] }>(KEY, (prev) => prev && ({
        boards: prev.boards.map((b) => (b.agentId === board.agentId ? { ...b, items } : b)),
      }));
    } catch {
      showToast("Couldn't save that priority. Try again.");
      void query.refetch();
    }
  };

  const add = () => {
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void run({ action: 'add', text });
  };

  const saveEdit = () => {
    if (!editing) return;
    const text = editing.text.trim();
    const current = board?.items.find((i) => i.id === editing.id);
    setEditing(undefined);
    if (text && current && text !== current.text) void run({ action: 'update', id: editing.id, text });
  };

  if (!boards.length) return null;
  const items = board?.items ?? [];
  const open = items.filter((i) => !i.done);
  const done = items.filter((i) => i.done);

  const row = (item: PriorityItem) => {
    const index = items.indexOf(item);
    return (
      <li key={item.id} className={`mp-row${item.done ? ' is-done' : ''}`}>
        <button
          type="button"
          className="md-check mp-check"
          aria-pressed={item.done}
          aria-label={item.done ? `Reopen ${item.text}` : `Mark ${item.text} done`}
          onClick={() => void run({ action: 'update', id: item.id, done: !item.done })}
        >
          <Check size={13} aria-hidden="true" />
        </button>
        {editing?.id === item.id ? (
          <input
            className="mp-input mp-edit"
            value={editing.text}
            autoFocus
            maxLength={240}
            aria-label="Edit priority"
            onChange={(e) => setEditing({ id: item.id, text: e.target.value })}
            onBlur={saveEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveEdit();
              if (e.key === 'Escape') setEditing(undefined);
            }}
          />
        ) : (
          <button type="button" className="mp-text" title="Click to edit" onClick={() => setEditing({ id: item.id, text: item.text })}>
            {item.text}
          </button>
        )}
        <span className="mp-tools">
          {!item.done ? (
            <>
              <button type="button" className="mp-tool" aria-label="Move up" disabled={index === 0} onClick={() => void run({ action: 'move', id: item.id, direction: 'up' })}>
                <ChevronUp size={13} aria-hidden="true" />
              </button>
              <button type="button" className="mp-tool" aria-label="Move down" disabled={index >= open.length - 1} onClick={() => void run({ action: 'move', id: item.id, direction: 'down' })}>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
            </>
          ) : null}
          <button type="button" className="mp-tool is-danger" aria-label={`Delete ${item.text}`} onClick={() => void run({ action: 'remove', id: item.id })}>
            <X size={13} aria-hidden="true" />
          </button>
        </span>
      </li>
    );
  };

  return (
    <section className="mp" aria-label="Matt's Priorities">
      <div className="md-sub">
        Matt&apos;s Priorities
        {open.length ? <span className="desk-count is-quiet">{open.length}</span> : null}
      </div>
      <div className="mp-tabs" role="tablist" aria-label="Whose board">
        {boards.map((b) => (
          <button
            key={b.agentId}
            type="button"
            role="tab"
            aria-selected={b.agentId === board?.agentId}
            className="mp-tab"
            onClick={() => { setPicked(b.agentId); setEditing(undefined); }}
          >
            {b.name}
            <span className="mp-tab-count">{b.items.filter((i) => !i.done).length}</span>
          </button>
        ))}
      </div>
      <input
        className="mp-input"
        value={draft}
        maxLength={240}
        placeholder={`Add a priority for ${board?.name ?? 'them'}, then Enter`}
        aria-label="Add a priority"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter') add(); }}
      />
      {open.length ? <ol className="mp-list">{open.map(row)}</ol> : (
        <div className="md-empty is-quiet"><span>Nothing on {board ? `${board.name}'s` : 'this'} board yet.</span></div>
      )}
      {done.length ? (
        <>
          <ul className="mp-list is-done">{done.map(row)}</ul>
          <button type="button" className="md-more" onClick={() => void run({ action: 'clear-done' })}>
            Clear {done.length} done
          </button>
        </>
      ) : null}
    </section>
  );
}
