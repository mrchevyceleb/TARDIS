import { Check, Copy, ExternalLink, Pencil, Pin, PinOff, Plus, Search, Trash2, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Chip, EmptyState } from '../components/Primitives';
import { RoomHeader } from '../components/RoomHeader';
import { apiJson } from '../data/api';
import type { PinItem } from '../data/types';
import { usePins } from '../hooks/useRoomData';
import { timeAgo } from '../utils/format';
import { ROOM_NAMES } from '../data/roomNames';
import { useProxyViewer } from '../hooks/useProxyViewer';
import { parsePinLinkTarget } from '../chat/utils/proxyLinks';

type PinDraft = {
  title: string;
  content: string;
  category: string;
  pinned: boolean;
  color: string;
};

const emptyDraft: PinDraft = {
  title: '',
  content: '',
  category: 'general',
  pinned: true,
  color: 'gold',
};

const colorOptions = [
  { value: 'gold', label: 'Gold' },
  { value: 'blue', label: 'Blue' },
  { value: 'violet', label: 'Violet' },
  { value: 'emerald', label: 'Emerald' },
  { value: 'rose', label: 'Rose' },
  { value: 'amber', label: 'Amber' },
];

const categoryTone: Record<string, 'neutral' | 'gold' | 'elf' | 'rose' | 'emerald'> = {
  commands: 'gold',
  credentials: 'elf',
  links: 'elf',
  notes: 'emerald',
  contacts: 'rose',
};

export function Pins() {
  const queryClient = useQueryClient();
  const viewer = useProxyViewer();
  const { data: pins = [] } = usePins();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [editing, setEditing] = useState<PinItem | null>(null);
  const [draft, setDraft] = useState<PinDraft>(emptyDraft);
  const [composerOpen, setComposerOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [viewing, setViewing] = useState<PinItem | null>(null);

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const pin of pins) {
      const key = pin.category || 'general';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [pins]);

  const visiblePins = useMemo(() => {
    const q = search.trim().toLowerCase();
    return pins.filter((pin) => {
      const matchesCategory = category === 'all' || pin.category === category;
      const matchesSearch =
        !q ||
        pin.title.toLowerCase().includes(q) ||
        pin.content.toLowerCase().includes(q) ||
        pin.category.toLowerCase().includes(q);
      return matchesCategory && matchesSearch;
    });
  }, [category, pins, search]);

  const pinnedCount = pins.filter((pin) => pin.pinned).length;

  const replacePins = (next: PinItem[]) => {
    queryClient.setQueryData(['pins'], sortPins(next));
  };

  const openNew = () => {
    setEditing(null);
    setDraft(emptyDraft);
    setComposerOpen(true);
  };

  const openEdit = (pin: PinItem) => {
    setEditing(pin);
    setDraft({
      title: pin.title,
      content: pin.content,
      category: pin.category || 'general',
      pinned: pin.pinned,
      color: pin.color || colorFor(pin),
    });
    setComposerOpen(true);
  };

  const closeComposer = () => {
    setComposerOpen(false);
    setEditing(null);
    setDraft(emptyDraft);
  };

  const submitPin = async (event: FormEvent) => {
    event.preventDefault();
    const payload = normalizeDraft(draft);
    if (!payload.content && !payload.title) return;
    const saved = await apiJson<PinItem>(editing ? `/api/pins/${encodeURIComponent(editing.id)}` : '/api/pins', {
      method: editing ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
    });
    replacePins(editing ? pins.map((pin) => (pin.id === editing.id ? saved : pin)) : [saved, ...pins]);
    closeComposer();
  };

  const togglePin = async (pin: PinItem) => {
    const optimistic = { ...pin, pinned: !pin.pinned, updatedAt: new Date().toISOString() };
    replacePins(pins.map((item) => (item.id === pin.id ? optimistic : item)));
    try {
      const saved = await apiJson<PinItem>(`/api/pins/${encodeURIComponent(pin.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ pinned: !pin.pinned }),
      });
      replacePins(pins.map((item) => (item.id === pin.id ? saved : item)));
    } catch {
      replacePins(pins);
    }
  };

  const deletePin = async (pin: PinItem) => {
    if (!window.confirm(`Delete "${pin.title}"?`)) return;
    await apiJson<void>(`/api/pins/${encodeURIComponent(pin.id)}`, { method: 'DELETE' });
    replacePins(pins.filter((item) => item.id !== pin.id));
    if (editing?.id === pin.id) closeComposer();
  };

  const copyPin = async (pin: PinItem) => {
    await navigator.clipboard.writeText(pin.content);
    setCopiedId(pin.id);
    window.setTimeout(() => setCopiedId((value) => (value === pin.id ? null : value)), 1400);
  };

  /** One tap: a pin whose whole content is a link opens it (web in a new
   *  tab, workspace path in the viewer); anything else opens the detail view. */
  const openPin = (pin: PinItem) => {
    const target = parsePinLinkTarget(pin.content);
    if (target?.kind === 'web') { window.open(target.url, '_blank', 'noopener,noreferrer'); return; }
    if (target) { viewer.open({ source: target.kind, path: target.path, title: pin.title }); return; }
    setViewing(pin);
  };

  return (
    <div className="room-scroll r-scroll pins-room">
      <RoomHeader
        eyebrow={ROOM_NAMES.pins.eyebrow}
        title="Quick note saves"
        subtitle={`${pins.length} pins at hand${pinnedCount ? ` · ${pinnedCount} pinned` : ''}.`}
        actions={
          <Button tone="gold" onClick={openNew}>
            <Plus size={15} />
            New pin
          </Button>
        }
      />

      <section className="pins-toolbar" aria-label="Pin filters">
        <label className="pins-search">
          <Search size={16} />
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search pins..." />
        </label>
        <div className="pin-category-row">
          <button className={category === 'all' ? 'active' : ''} type="button" onClick={() => setCategory('all')}>
            All <span>{pins.length}</span>
          </button>
          {categories.map(([name, count]) => (
            <button className={category === name ? 'active' : ''} key={name} type="button" onClick={() => setCategory(name)}>
              {name} <span>{count}</span>
            </button>
          ))}
        </div>
      </section>

      {composerOpen ? (
        <form className="pin-composer" onSubmit={submitPin}>
          <div className="pin-composer-head">
            <div>
              <span className="r-eyebrow-gold">{editing ? 'Edit pin' : 'New pin'}</span>
              <h2>{editing ? editing.title : 'Save something useful'}</h2>
            </div>
            <button type="button" onClick={closeComposer} title="Close composer">
              <X size={16} />
            </button>
          </div>
          <div className="pin-form-grid">
            <label>
              Title
              <input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Optional title" autoFocus />
            </label>
            <label>
              Category
              <input value={draft.category} onChange={(event) => setDraft({ ...draft, category: event.target.value })} placeholder="general" />
            </label>
            <label>
              Accent
              <select value={draft.color} onChange={(event) => setDraft({ ...draft, color: event.target.value })}>
                {colorOptions.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="pin-checkbox">
              <input type="checkbox" checked={draft.pinned} onChange={(event) => setDraft({ ...draft, pinned: event.target.checked })} />
              Keep at top
            </label>
          </div>
          <label className="pin-content-field">
            Note
            <textarea value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} placeholder="Paste a command, prompt, URL, note, or anything you need nearby." rows={6} />
          </label>
          <div className="pin-form-actions">
            <Button tone="ghost" type="button" onClick={closeComposer}>
              Cancel
            </Button>
            <Button tone="gold" type="submit">
              <Check size={14} />
              Save pin
            </Button>
          </div>
        </form>
      ) : null}

      <div className="pins-grid">
        {visiblePins.length ? (
          visiblePins.map((pin) => (
            <article className={`pin-card ${pin.pinned ? 'is-pinned' : ''}`} key={pin.id} style={pinStyle(pin)}>
              <div className="pin-card-actions">
                <button type="button" onClick={() => togglePin(pin)} title={pin.pinned ? 'Unpin' : 'Pin'}>
                  {pin.pinned ? <PinOff size={14} /> : <Pin size={14} />}
                </button>
                <button type="button" onClick={() => openEdit(pin)} title="Edit pin">
                  <Pencil size={14} />
                </button>
                <button type="button" onClick={() => copyPin(pin)} title="Copy pin content">
                  {copiedId === pin.id ? <Check size={14} /> : <Copy size={14} />}
                </button>
                <button type="button" onClick={() => deletePin(pin)} title="Delete pin">
                  <Trash2 size={14} />
                </button>
              </div>
              <button
                type="button"
                className="pin-card-open"
                onClick={() => openPin(pin)}
                title={parsePinLinkTarget(pin.content) ? 'Open link' : 'Open pin'}
              >
                <header>
                  <h2>{pin.title}</h2>
                  <small>{pin.updatedAt ? timeAgo(pin.updatedAt) : 'saved'}</small>
                </header>
                <p>{pin.content}</p>
                <footer>
                  <Chip tone={categoryTone[pin.category] ?? 'neutral'}>{pin.category}</Chip>
                  {pin.pinned ? <span className="pin-status">pinned</span> : null}
                </footer>
              </button>
            </article>
          ))
        ) : (
          <EmptyState
            title={pins.length ? 'No matching pins' : 'No pins saved yet'}
            body={pins.length ? 'Clear the search or category filter to see more.' : 'Use New pin to save a note, link, prompt, or command.'}
          />
        )}
      </div>

      {viewing ? (
        <div className="r-modal-overlay" onClick={() => setViewing(null)}>
          <div className="r-modal-card" onClick={(event) => event.stopPropagation()} style={pinStyle(viewing)}>
            <div className="r-modal-head">
              <div>
                <span className="r-eyebrow-gold">{viewing.category || 'general'}</span>
                <h2>{viewing.title}</h2>
                <small style={{ color: 'var(--r-ink-mute)' }}>{viewing.updatedAt ? `updated ${timeAgo(viewing.updatedAt)}` : 'saved'}</small>
              </div>
              <button type="button" onClick={() => setViewing(null)} title="Close" className="r-modal-x">
                <X size={18} />
              </button>
            </div>
            <div className="r-modal-body">
              <pre className="pin-view-content">{viewing.content}</pre>
            </div>
            <div className="r-modal-foot">
              <div>
                <Chip tone={categoryTone[viewing.category] ?? 'neutral'}>{viewing.category}</Chip>
                {viewing.pinned ? <span className="pin-status">pinned</span> : null}
              </div>
              <div className="r-modal-foot-end">
                {contentLinkOf(viewing) ? (
                  <Button tone="ghost" onClick={() => { const url = contentLinkOf(viewing); if (url) window.open(url, '_blank', 'noopener,noreferrer'); }}>
                    <ExternalLink size={14} />
                    Open link
                  </Button>
                ) : null}
                <Button tone="ghost" onClick={() => copyPin(viewing)}>
                  {copiedId === viewing.id ? <Check size={14} /> : <Copy size={14} />}
                  {copiedId === viewing.id ? 'Copied' : 'Copy'}
                </Button>
                <Button tone="gold" onClick={() => { const pin = viewing; setViewing(null); openEdit(pin); }}>
                  <Pencil size={14} />
                  Edit
                </Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** First web URL anywhere in the content, for the detail view's Open button. */
function contentLinkOf(pin: PinItem): string | null {
  const match = pin.content.match(/https?:\/\/[^\s<>"']+/);
  const url = match ? match[0].replace(/[.,;:!?…`*)\]]+$/, '') : '';
  return url || null;
}

function normalizeDraft(draft: PinDraft) {
  const content = draft.content.trim();
  const title = draft.title.trim() || content.split('\n')[0]?.trim().slice(0, 90) || 'Untitled pin';
  return {
    title,
    content,
    category: draft.category.trim() || 'general',
    pinned: draft.pinned,
    color: draft.color,
  };
}

function sortPins(pins: PinItem[]): PinItem[] {
  return [...pins].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime();
  });
}

function pinStyle(pin: PinItem): CSSProperties {
  return { '--pin-accent': accentFor(pin) } as CSSProperties;
}

function colorFor(pin: PinItem): string {
  const value = (pin.color || '').toLowerCase();
  if (colorOptions.some((option) => option.value === value)) return value;
  if (pin.category === 'credentials') return 'blue';
  if (pin.category === 'commands') return 'amber';
  if (pin.category === 'links') return 'violet';
  if (pin.category === 'notes') return 'emerald';
  return 'gold';
}

function accentFor(pin: PinItem): string {
  switch (colorFor(pin)) {
    case 'blue':
      return 'var(--r-elf-blue)';
    case 'violet':
      return 'var(--r-violet)';
    case 'emerald':
      return 'var(--r-emerald)';
    case 'rose':
      return 'var(--r-rose)';
    case 'amber':
      return 'var(--r-amber)';
    default:
      return 'var(--r-gold)';
  }
}
