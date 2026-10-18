// The agent's live checklist section (card-a77246): every write the agent's
// sidebar_checklist tool makes lands here live (the server broadcasts each
// one through the chat socket), with slide-in items, an animated check-off,
// a progress fill, and the assigned teammate on each line. Read-only for the
// viewer: the agent owns every change through its tool — nothing here writes.
import { useChecklist } from './useChecklist';

const initial = (name: string): string => (name.trim()[0] ?? '?').toUpperCase();

export function ChecklistSection({ owner, name, pollMs }: { owner: string; name: string; pollMs?: number }) {
  const { checklist, loadError } = useChecklist(owner, pollMs);
  // A missing or empty checklist renders nothing: the section appears the
  // moment the agent creates its first list (the live push mounts it).
  if ((!checklist || !checklist.items.length) && !loadError) return null;
  if (!checklist) return null;
  const done = checklist.items.filter((it) => it.done).length;
  const pct = checklist.items.length ? Math.round((done / checklist.items.length) * 100) : 0;
  return (
    <section className="bt-pane-sec bt-checklist" aria-label={`${name}'s live checklist`}>
      <div className="bt-pane-title-row">
        <div className="bt-pane-title">{checklist.title ?? 'Checklist'}</div>
        <span className="bt-cl-progress-num">{done}/{checklist.items.length}</span>
      </div>
      <div className="bt-cl-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${name}'s checklist progress`}>
        <div className="bt-cl-progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <ul className="bt-cl-items">
        {checklist.items.map((it) => (
          <li key={it.id} className={`bt-cl-item${it.done ? ' done' : ''}`}>
            <span className="bt-cl-check" aria-hidden="true">{it.done ? '✓' : ''}</span>
            <span className="bt-cl-body">
              <span className="bt-cl-text">{it.text}</span>
              {it.status ? <span className="bt-cl-status">{it.status}</span> : null}
              {it.assignee ? (
                <span className="bt-cl-assignee">
                  <span className="bt-cl-face" aria-hidden="true">{initial(it.assignee)}</span>
                  <span>{it.assignee}</span>
                </span>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
