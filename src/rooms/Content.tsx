import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ArrowLeft, Check, CheckCheck, ChevronRight, Clock3, FileText, LoaderCircle, Plus, RefreshCw, Search, Send, Sparkles, X } from 'lucide-react';
import { contentRequest, uploadContentImage } from '../data/api';
import { CONTENT_BRANDS, CONTENT_CHANNELS, CONTENT_ENGINES, type ContentImage, type ContentBrand, type ContentChannel, type ContentDraft, type ContentEngine, type ContentJob, type ContentStatus } from '../data/content';
import './content.css';
import { ContentConnections } from './ContentConnections';
import { ContentIdeas } from './ContentIdeas';
import type { ContentIdea } from '../data/content';

type DraftEdit = Pick<ContentDraft, 'title' | 'body_markdown' | 'seo' | 'payload'>;
const editOf = (draft: ContentDraft): DraftEdit => ({ title: draft.title, body_markdown: draft.body_markdown, seo: draft.seo, payload: draft.payload });
const serialize = (value: DraftEdit) => JSON.stringify(value);
const draftKey = (id: string) => `rivendell:content-draft:${id}`;
const recoveredEdit = (draft: ContentDraft): { version: number; edit: DraftEdit } | null => {
  try { const item = JSON.parse(localStorage.getItem(draftKey(draft.id)) || 'null'); return item?.edit && typeof item.edit.body_markdown === 'string' && item.edit.payload ? item : null; } catch { return null; }
};
const recoveryText = (edit: DraftEdit) => [edit.title, edit.payload.posts?.map((post) => `${post.platform}\n${post.text}`).join('\n\n') || edit.body_markdown].filter(Boolean).join('\n\n');
const label = (value: string) => value === 'in-review' || value === 'draft' ? 'Needs review' : value === 'in-progress' ? 'Writing' : value.charAt(0).toUpperCase() + value.slice(1);
const messageOf = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';
const safeUrl = (url?: string) => { try { const parsed = new URL(url ?? ''); return ['https:', 'http:'].includes(parsed.protocol) ? parsed.href : undefined; } catch { return undefined; } };

export function Content() {
  const cache = useQueryClient();
  const [brand, setBrand] = useState<ContentBrand>(()=>new URLSearchParams(location.search).get('brand')==='r-link'?'r-link':'operly');
  const [tab, setTab] = useState(()=>new URLSearchParams(location.search).get('tab')==='ideas'?'ideas':'review');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<string | null>(()=>{const id=new URLSearchParams(location.search).get('draft');return id&&/^[a-f0-9-]{36}$/.test(id)?id:null;});
  const [creating, setCreating] = useState(false);
  const [sourceIdea, setSourceIdea] = useState<ContentIdea | null>(null);
  const [connecting, setConnecting] = useState(()=>new URLSearchParams(location.search).get('connections')==='1');
  const [error, setError] = useState('');
  const [jobAction, setJobAction] = useState('');
  const drafts = useQuery({ queryKey: ['content', 'drafts', brand], queryFn: ({ signal }) => contentRequest<{ drafts: ContentDraft[] }>(`/drafts?brand=${brand}`, 'GET', undefined, signal), refetchInterval: 5000, retry: false });
  const jobs = useQuery({ queryKey: ['content', 'jobs', brand], queryFn: ({ signal }) => contentRequest<{ jobs: ContentJob[] }>(`/jobs?brand=${brand}`, 'GET', undefined, signal), refetchInterval: 5000, retry: false });
  const status = useQuery({ queryKey: ['content', 'status'], queryFn: ({ signal }) => contentRequest<ContentStatus>('/status', 'GET', undefined, signal), refetchInterval: 30000, retry: false });
  const detail = useQuery({ queryKey: ['content', 'draft', selected], queryFn: ({ signal }) => contentRequest<{ draft: ContentDraft }>(`/drafts/${selected}`, 'GET', undefined, signal), enabled: !!selected, refetchInterval: selected ? 5000 : false, retry: false });
  const refresh = useCallback(() => { void cache.invalidateQueries({ queryKey: ['content'] }); }, [cache]);
  const all = drafts.data?.drafts ?? [];
  const visible = all.filter((draft) => {
    const matches = tab === 'all' || (tab === 'review' ? ['draft', 'in-review', 'in-progress'].includes(draft.status) : draft.status === tab);
    return matches && `${draft.title ?? ''} ${draft.body_markdown}`.toLowerCase().includes(search.toLowerCase());
  });
  const activeJobs = (jobs.data?.jobs ?? []).filter((job) => ['queued', 'running', 'failed'].includes(job.status));
  const channels = status.data?.brands?.find((item) => item.brand === brand)?.channels ?? [];
  const unavailable = channels.filter((channel) => !['ready', 'connected'].includes(channel.status));
  const jobCommand = async (id: string, action: 'retry' | 'cancel') => {
    setJobAction(id); setError('');
    try { await contentRequest(`/jobs/${id}/${action}`, 'POST', {}); refresh(); }
    catch (e) { setError(messageOf(e)); } finally { setJobAction(''); }
  };

  if (selected && detail.data) return <DraftDesk key={selected} initial={detail.data.draft} status={status.data} onBack={() => { setSelected(null); refresh(); }} onSaved={refresh} />;
  return <section className="content-room">
    <a className="content-hint" href="/setup">Start here · first content, media and help →</a>
    <header className="content-header"><div><span className="content-eyebrow"><Sparkles size={14} /> YOUR CONTENT STUDIO</span><h1>A little idea.<br /><span>A lot of possibilities.</span></h1><p>Create something worth sharing. Make it yours before it goes out.</p></div><button className="content-button primary" onClick={() => setCreating(true)}><Plus size={18} /> Create content</button></header>
    <div className="content-toolbar"><div className="content-segment" aria-label="Brand">{Object.entries(CONTENT_BRANDS).map(([value, name]) => <button key={value} aria-pressed={brand === value} onClick={() => setBrand(value as ContentBrand)}>{name}</button>)}</div><label className="content-search"><Search size={16} /><input aria-label="Search content" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a draft…" /></label></div>
    <div className="content-steps" aria-label="Content workflow"><span><i>1</i> Create</span><ChevronRight size={15}/><span><i>2</i> Make it yours</span><ChevronRight size={15}/><span><i>3</i> Approve & share</span></div>
    <div className="content-connection-actions"><button className="content-button quiet" onClick={() => setConnecting(true)}>Manage publishing connections</button></div>
    {unavailable.length > 0 && <details className="content-connections"><summary><span className="content-dot" /> {unavailable.length} publishing connection{unavailable.length > 1 ? 's' : ''} need setup <span>Check connections</span></summary><div>{channels.map((item) => <p key={item.channel}><strong>{CONTENT_CHANNELS[item.channel as ContentChannel] ?? item.channel}</strong><span>{['ready', 'connected'].includes(item.status) ? 'Connected' : item.detail || 'Ask Matt to connect this account before publishing.'}</span></p>)}</div></details>}
    {(error || drafts.error || status.error || jobs.error || detail.error) && <div className="content-notice error" role="alert">{error || messageOf(drafts.error || status.error || jobs.error || detail.error)} <button onClick={refresh}>Try again</button></div>}
    {selected && detail.isPending && <div className="content-notice" role="status"><LoaderCircle className="content-spin" size={16} /> Opening your draft…</div>}
    {activeJobs.length > 0 && <div className="content-jobs" aria-label="Writing progress">{activeJobs.map((job) => <div className="content-job" key={job.id}><span className={job.status === 'running' ? 'content-spin' : ''}>{job.status === 'failed' ? <RefreshCw size={17}/> : <Sparkles size={17}/>}</span><div><strong>{job.idea_headline || `${CONTENT_BRANDS[job.brand]} ${job.kind}`}</strong><span>{job.status === 'failed' ? job.error || 'The writer needs another try.' : `${job.status === 'queued' ? 'Up next' : 'Writing'} · ${Math.round(job.progress || 0)}%`}</span></div><button disabled={jobAction === job.id} onClick={() => void jobCommand(job.id, job.status === 'failed' ? 'retry' : 'cancel')}>{job.status === 'failed' ? 'Try again' : 'Stop'}</button></div>)}</div>}
    <nav className="content-tabs" aria-label="Content status">{[['ideas', 'Ideas'], ['review', 'Needs review'], ['approved', 'Approved'], ['published', 'Published'], ['all', 'Everything']].map(([key, title]) => <button key={key} aria-current={tab === key ? 'page' : undefined} onClick={() => setTab(key)}>{title}{key === 'review' && <span>{all.filter((d) => ['draft', 'in-review'].includes(d.status)).length}</span>}</button>)}</nav>
    {tab === 'ideas' ? <ContentIdeas key={brand} brand={brand} onCreate={(idea) => { setSourceIdea(idea); setCreating(true); }} /> : drafts.isPending ? <div className="content-empty" role="status"><LoaderCircle className="content-spin" /><h2>Finding your drafts…</h2></div> : visible.length ? <div className="content-grid">{visible.map((draft) => <button className="content-card" key={draft.id} onClick={() => setSelected(draft.id)}><div className="content-card-top"><span className="content-kind"><FileText size={14} />{draft.kind === 'social-pack' ? 'Social posts' : label(draft.kind)}</span><span className={`content-badge ${draft.status}`}>{label(draft.status)}</span></div><h2>{draft.title || 'Untitled draft'}</h2><p>{draft.kind === 'social-pack' ? draft.payload.posts?.[0]?.text : draft.body_markdown.replace(/[#*_`>]/g, '')}</p><div className="content-card-footer"><span>{draft.channels.map((ch) => CONTENT_CHANNELS[ch as ContentChannel] ?? ch).join(' · ')}</span><span className="content-open">Open <ChevronRight size={14}/></span></div></button>)}</div> : <div className="content-empty"><span className="content-empty-icon"><FileText size={30}/></span><h2>{search ? 'No matching drafts' : tab === 'review' ? 'Your next good idea starts here.' : `Nothing ${tab === 'all' ? 'here' : tab} yet.`}</h2><p>{search ? 'Try a different word or another brand.' : 'Give your writer a topic, or ask a teammate to create something for you.'}</p>{!search && <button className="content-button primary" onClick={() => setCreating(true)}><Plus size={17}/> Create your first draft</button>}</div>}
    {creating && <CreateContent brand={sourceIdea?.brand ?? brand} idea={sourceIdea} onClose={() => { setCreating(false); setSourceIdea(null); }} onCreated={() => { setCreating(false); setSourceIdea(null); setTab('review'); refresh(); }} />}
    {connecting && <ContentModal title={`${CONTENT_BRANDS[brand]} publishing connections`} onClose={() => setConnecting(false)}><ContentConnections brand={brand} onSaved={refresh}/></ContentModal>}
  </section>;
}

function CreateContent({ brand, idea, onClose, onCreated }: { brand: ContentBrand; idea: ContentIdea | null; onClose: () => void; onCreated: () => void }) {
  const [brief, setBrief] = useState('');
  const [engine, setEngine] = useState<ContentEngine>('claude');
  const [kinds, setKinds] = useState(['blog', 'social-pack']);
  const request = useRef({ signature: '', id: crypto.randomUUID() });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    const signature = JSON.stringify({ brand, brief, kinds, engine });
    if (request.current.signature !== signature) request.current = { signature, id: crypto.randomUUID() };
    setBusy(true); setError('');
    try { await contentRequest(idea ? `/ideas/${idea.id}/generate` : '/generate', 'POST', idea ? { kinds, engine } : { brand, brief, kinds, engine, requestId: request.current.id }); onCreated(); }
    catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  return <ContentModal title={`Create for ${CONTENT_BRANDS[brand]}`} onClose={busy ? undefined : onClose}><form onSubmit={(e) => { e.preventDefault(); void submit(); }}>{idea ? <div className="content-notice"><strong>{idea.headline}</strong><p>Sources and research stay attached. Existing drafts are reused; failed jobs can be retried in the writing queue.</p></div> : <label className="content-field">What would you like to say?<textarea autoFocus required maxLength={12000} rows={5} placeholder="A helpful post about… Include your angle, audience, or a link to work from." value={brief} onChange={(e) => setBrief(e.target.value)} /></label>}<fieldset className="content-choices"><legend>Make it into</legend>{[['blog','A blog post'],['social-pack','Social posts']].map(([id,name]) => <label key={id}><input type="checkbox" checked={kinds.includes(id)} onChange={(e) => setKinds((old) => e.target.checked ? [...old,id] : old.filter((kind) => kind !== id))}/>{name}</label>)}</fieldset><EngineSelect value={engine} onChange={setEngine}/><p className="content-hint">Your brand voice is included automatically. Everything starts as a draft.</p>{error && <p className="content-notice error" role="alert">{error}</p>}<button className="content-button primary" type="submit" disabled={busy || (!idea && brief.trim().length < 5) || !kinds.length}>{busy ? <LoaderCircle className="content-spin" size={17}/> : <Sparkles size={17}/>} {busy ? 'Starting your drafts…' : 'Create drafts'}</button></form></ContentModal>;
}

function EngineSelect({ value, onChange }: { value: ContentEngine; onChange: (value: ContentEngine) => void }) {
  return <label className="content-field">Writer<select aria-label="Writer" value={value} onChange={(e) => onChange(e.target.value as ContentEngine)}>{Object.entries(CONTENT_ENGINES).map(([id, name]) => <option key={id} value={id}>{name} subscription</option>)}</select></label>;
}

function ImagePreview({ value }: { value?: ContentImage }) {
  return value?.status === 'ok' && safeUrl(value.url) ? <img className="content-image" src={safeUrl(value.url)} alt={value.alt} referrerPolicy="no-referrer"/> : null;
}

function ImageEdit({ value, disabled, required, onChange }: { value?: ContentImage; disabled: boolean; required?: boolean; onChange: (value: ContentImage) => void }) {
  const [url, setUrl] = useState(value?.url || '');
  const [alt, setAlt] = useState(value?.alt || '');
  const [uploading,setUploading]=useState(false),[uploadError,setUploadError]=useState('');
  const upload=async(file?:File)=>{
    if(!file||disabled||uploading)return;
    if(!['image/jpeg','image/png','image/webp'].includes(file.type)){setUploadError('Choose a JPEG, PNG or WebP image.');return;}
    setUploading(true);setUploadError('');
    try{const result=await uploadContentImage(file);setUrl(result.url);}catch(e){setUploadError(messageOf(e));}finally{setUploading(false);}
  };
  const valid = (() => { try { return new URL(url).protocol === 'https:'; } catch { return false; } })();
  useEffect(() => { setUrl(value?.url || ''); setAlt(value?.alt || ''); }, [value?.url, value?.alt]);
  return <div className="content-image-editor"><ImagePreview value={value}/><details><summary>{value?.status === 'ok' ? 'Change image' : required ? 'Add an image before publishing' : 'Add an image (optional)'}</summary><p className="content-hint">Upload an image or paste a public link. Uploaded images get a public publishing link; only use media intended for public use. Changes need fresh approval.</p><div className="content-image-drop" onDragOver={e=>{e.preventDefault();}} onDrop={e=>{e.preventDefault();e.stopPropagation();void upload(e.dataTransfer.files[0]);}}><label className="content-field">Choose or drop an image (10 MB maximum)<input type="file" accept="image/jpeg,image/png,image/webp" disabled={disabled||uploading} onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></label>{uploading&&<p role="status">Uploading your image…</p>}{uploadError&&<p role="alert">{uploadError}</p>}</div><label className="content-field">Image link<input type="url" placeholder="https://…" value={url} disabled={disabled||uploading} onChange={(e) => setUrl(e.target.value)}/></label><label className="content-field">Image description<input value={alt} disabled={disabled||uploading} onChange={(e) => setAlt(e.target.value)}/></label><button className="content-button" disabled={disabled || uploading || !valid || !alt.trim() || (url === value?.url && alt === value?.alt)} onClick={() => onChange({ slot: value?.slot || 'featured', url: url.trim(), alt: alt.trim(), prompt: value?.prompt || '', aspect_ratio: value?.aspect_ratio || '1:1', status: 'ok' })}>Use this image</button></details></div>;
}

function ContentModal({ title, onClose, children }: { title: string; onClose?: () => void; children: React.ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog className="content-modal" aria-labelledby={headingId} ref={dialog} onCancel={(e) => { e.preventDefault(); onClose?.(); }}><div className="content-modal-heading"><h2 id={headingId}>{title}</h2><button className="content-icon-button" aria-label="Close" disabled={!onClose} onClick={onClose}><X size={20}/></button></div>{children}</dialog>;
}

function DraftDesk({ initial, status, onBack, onSaved }: { initial: ContentDraft; status?: ContentStatus; onBack: () => void; onSaved: () => void }) {
  const [draft, setDraft] = useState(initial);
  const [edit, setEdit] = useState<DraftEdit>(() => {
    const recovered = recoveredEdit(initial); if (recovered?.version === initial.version) return recovered.edit;
    return editOf(initial);
  });
  const [recovery, setRecovery] = useState(() => { const item = recoveredEdit(initial); return item && item.version !== initial.version ? recoveryText(item.edit) : ''; });
  const [preview, setPreview] = useState(false);
  const [saveStatus, setSaveStatus] = useState('Saved');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [reviseOpen, setReviseOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const [engine, setEngine] = useState<ContentEngine>('claude');
  const [publishOpen, setPublishOpen] = useState(false);
  const [scheduledAt, setScheduledAt] = useState('');
  const [selectedChannels, setSelectedChannels] = useState<string[]>(initial.channels.filter((ch) => ch in CONTENT_CHANNELS));
  const saved = useRef(initial);
  const current = useRef(edit);
  const inFlight = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  current.current = edit;
  const readOnly = ['published','spiked','in-progress'].includes(draft.status) || !!draft.publications?.some((item) => ['sending','scheduled','published','unknown'].includes(item.status));
  const dirty = serialize(edit) !== serialize(editOf(draft));
  const connections = status?.brands?.find((item) => item.brand === draft.brand)?.channels ?? [];
  const available = selectedChannels.length > 0 && selectedChannels.every((channel) => connections.some((item) => item.channel === channel && ['ready','connected'].includes(item.status)));
  const scheduling = selectedChannels.length > 0 && selectedChannels.every((channel) => connections.some((item) => item.channel === channel && item.schedulingSupported));

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (initial.version < saved.current.version || inFlight.current) return;
    if (serialize(current.current) !== serialize(editOf(saved.current))) {
      if (initial.version !== saved.current.version) setError('A newer version is available. Your unsaved text is safe; load the latest version to compare.');
      return;
    }
    saved.current = initial; current.current = editOf(initial);
    setDraft(initial); setEdit(current.current);
  }, [initial]);
  const flush = useCallback(async (): Promise<void> => {
    if (inFlight.current) { await inFlight.current; return flush(); }
    const captured = current.current;
    if (serialize(captured) === serialize(editOf(saved.current))) return;
    setSaveStatus('Saving…');
    const work = (async () => {
      const patch = {
        version: saved.current.version,
        ...(captured.title !== null ? { title: captured.title } : {}),
        ...(initial.kind === 'social-pack' ? { payload: { posts: captured.payload.posts } } : { body_markdown: captured.body_markdown }),
        ...(captured.seo ? { seo: captured.seo } : {}),
        ...(initial.kind === 'blog' && captured.payload.featured_image ? { payload: { featured_image: captured.payload.featured_image } } : {}),
        ...(initial.kind === 'email' ? { payload: { subject: captured.payload.subject, preview_text: captured.payload.preview_text, alt_subjects: captured.payload.alt_subjects } } : {}),
      };
      const result = await contentRequest<{ draft: ContentDraft }>(`/drafts/${initial.id}`, 'PATCH', patch);
      saved.current = result.draft;
      if (serialize(current.current) === serialize(captured)) {
        current.current = editOf(result.draft);
        if (alive.current) setEdit(current.current);
        try { localStorage.removeItem(draftKey(initial.id)); } catch { /* storage unavailable */ }
      } else {
        try { localStorage.setItem(draftKey(initial.id), JSON.stringify({ version: result.draft.version, edit: current.current })); } catch { /* storage unavailable */ }
      }
      if (alive.current) { setDraft(result.draft); setSaveStatus('Saved'); setError(''); }
      onSaved();
    })();
    inFlight.current = work;
    try { await work; } catch (e) { if (alive.current) { setSaveStatus('Not saved'); setError(messageOf(e)); } throw e; }
    finally { inFlight.current = null; }
    if (serialize(current.current) !== serialize(editOf(saved.current))) await flush();
  }, [initial.id, initial.kind, onSaved]);

  useEffect(() => {
    if (readOnly || serialize(edit) === serialize(editOf(saved.current))) return;
    try { localStorage.setItem(draftKey(initial.id), JSON.stringify({ version: saved.current.version, edit })); } catch { /* storage unavailable */ }
    setSaveStatus('Unsaved changes');
    const timer = setTimeout(() => { void flush().catch(() => {}); }, 900);
    return () => clearTimeout(timer);
  }, [edit, flush, initial.id, readOnly]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => { if (serialize(current.current) !== serialize(editOf(saved.current))) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const action = async (name: string, payload: Record<string, unknown> = {}) => {
    setBusy(name); setError('');
    try {
      await flush();
      const result = await contentRequest<{ draft?: ContentDraft }>(`/drafts/${initial.id}/${name}`, 'POST', { ...payload, version: saved.current.version });
      const latest = result.draft ?? (await contentRequest<{ draft: ContentDraft }>(`/drafts/${initial.id}`)).draft;
      saved.current = latest; current.current = editOf(latest); setDraft(latest); setEdit(current.current);
      setReviseOpen(false); setPublishOpen(false); onSaved();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  };
  const change = (next: Partial<DraftEdit>) => setEdit((old) => ({ ...old, ...next }));
  const reloadLatest = async () => {
    setBusy('reload');
    try {
      if (inFlight.current) await inFlight.current.catch(() => {});
      const result = await contentRequest<{ draft: ContentDraft }>(`/drafts/${initial.id}`);
      setRecovery(recoveryText(current.current));
      saved.current = result.draft; current.current = editOf(result.draft);
      setDraft(result.draft); setEdit(current.current); setError(''); setSaveStatus('Saved');
    } catch (e) { setError(messageOf(e)); } finally { setBusy(''); }
  };
  return <section className="content-room content-desk">
    <header className="content-desk-header"><button className="content-button quiet" disabled={!!busy} onClick={() => { void flush().then(onBack).catch(() => {}); }}><ArrowLeft size={17}/> All content</button><div className="content-save" role="status">{saveStatus === 'Saved' ? <Check size={14}/> : saveStatus === 'Saving…' ? <LoaderCircle className="content-spin" size={14}/> : null}{saveStatus}</div></header>
    <div className="content-draft-heading"><div><span className="content-eyebrow">{CONTENT_BRANDS[draft.brand]} · {draft.kind === 'social-pack' ? 'SOCIAL POSTS' : draft.kind.toUpperCase()}</span><h1>Make it yours.</h1></div><span className={`content-badge ${dirty ? 'draft' : draft.status}`}>{dirty ? 'Needs review' : label(draft.status)}</span></div>
    {error && <div className="content-notice error" role="alert">{error} {dirty && <button disabled={!!busy} onClick={() => void flush().catch(() => {})}>Retry save</button>}<button disabled={!!busy} onClick={() => void reloadLatest()}>Load latest version</button></div>}
    {recovery && <details className="content-quality"><summary>Your unsaved text from an earlier version</summary><p className="content-hint">The latest draft is below. Copy any changes you want to keep from this saved text.</p><textarea aria-label="Recovered draft text" readOnly rows={7} value={recovery}/></details>}
    <div className="content-edit-bar"><div className="content-segment"><button aria-pressed={!preview} onClick={() => setPreview(false)}>Edit</button><button aria-pressed={preview} onClick={() => setPreview(true)}>Preview</button></div><button className="content-button" disabled={readOnly || !!busy} onClick={() => setReviseOpen(true)}><Sparkles size={16}/> Ask for a change</button></div>
    <div className="content-paper">
      {preview ? <><h2 className="content-preview-title">{edit.title || 'Untitled'}</h2>{draft.kind === 'social-pack' ? edit.payload.posts?.map((post,index) => <article className="content-social-preview" key={index}><span className="content-kind">{CONTENT_CHANNELS[post.platform as ContentChannel] || post.platform}</span><p>{post.text}</p><ImagePreview value={post.image}/>{post.visual_note && <small>Visual idea: {post.visual_note}</small>}</article>) : <div className="content-prose"><ImagePreview value={edit.payload.featured_image}/><ReactMarkdown remarkPlugins={[remarkGfm]}>{edit.body_markdown}</ReactMarkdown></div>}</> : <>
        <label className="content-field">Title<input className="content-title-input" aria-label="Draft title" readOnly={draft.kind === 'social-pack'} value={edit.title ?? ''} disabled={readOnly || !!busy} onChange={(e) => change({ title: e.target.value })}/></label>
        {draft.kind === 'social-pack' && edit.payload.posts ? edit.payload.posts.map((post,index) => <div className="content-social-editor" key={index}><label className="content-field"><span>{CONTENT_CHANNELS[post.platform as ContentChannel] || post.platform} <small>{post.text.length}{post.platform === 'x' ? ' / 280 characters' : ' characters'}</small></span><textarea rows={Math.min(14,Math.max(4,Math.ceil(post.text.length / 65)))} value={post.text} disabled={readOnly || !!busy} onChange={(e) => change({ payload: { ...edit.payload, posts: edit.payload.posts!.map((p,i) => i === index ? { ...p, text: e.target.value } : p) } })}/></label>{post.platform === 'x' && post.text.length > 280 && <p className="content-inline-error">Shorten this post to 280 characters before publishing.</p>}{post.visual_note && <p className="content-hint">Visual idea: {post.visual_note}</p>}<ImageEdit value={post.image} disabled={readOnly || !!busy} required={post.platform === 'instagram'} onChange={(image) => change({ payload: { ...edit.payload, posts: edit.payload.posts!.map((p,i) => i === index ? { ...p, image } : p) } })}/></div>) : <label className="content-field">Your draft<textarea className="content-body-input" rows={20} aria-label="Draft content" value={edit.body_markdown} disabled={readOnly || !!busy} onChange={(e) => change({ body_markdown: e.target.value })}/></label>}
        {draft.kind === 'blog' && <ImageEdit value={edit.payload.featured_image} required disabled={readOnly || !!busy} onChange={(image) => change({ payload: { ...edit.payload, featured_image: image } })}/>}
        {draft.kind === 'blog' && <details className="content-seo"><summary>Search preview</summary>{(['title','description','keyword'] as const).map((key) => <label className="content-field" key={key}>{key === 'title' ? 'Search title' : key === 'description' ? 'Search description' : 'Focus keyword'}<input value={edit.seo?.[key] ?? ''} disabled={readOnly || !!busy} onChange={(e) => change({ seo: { title: '', description: '', keyword: '', ...edit.seo, [key]: e.target.value } })}/></label>)}</details>}
      </>}
    </div>
    {draft.quality && Array.isArray(draft.quality.issues) && draft.quality.issues.length > 0 && <details className="content-quality"><summary>Things to check before sharing ({draft.quality.issues.length})</summary>{draft.quality.issues.map((issue: { message?: string }, i: number) => <p key={i}>{issue.message || 'Review this draft carefully.'}</p>)}</details>}
    {draft.publications?.length ? <div className="content-publications">{draft.publications.map((pub,index) => <p key={index}><strong>{CONTENT_CHANNELS[pub.channel as ContentChannel] || pub.channel}</strong> {label(pub.status)} {pub.scheduled_at && Number.isFinite(Date.parse(pub.scheduled_at)) && <time dateTime={pub.scheduled_at}>{new Date(pub.scheduled_at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })} ({Intl.DateTimeFormat().resolvedOptions().timeZone})</time>} {safeUrl(pub.public_url) && <a href={safeUrl(pub.public_url)} target="_blank" rel="noreferrer">View post ↗</a>}{pub.detail && <span>{pub.detail}</span>}</p>)}</div> : null}
    <footer className="content-desk-footer"><span>{dirty ? 'Changes will need a fresh approval.' : draft.status === 'approved' ? 'Approved. Ready when you are.' : 'Nothing goes live until you publish.'}</span><div><button className="content-button" disabled={readOnly || !!busy || (draft.status === 'approved' && !dirty)} onClick={() => void action('approve')}><CheckCheck size={17}/> {busy === 'approve' ? 'Approving…' : 'Approve draft'}</button><button className="content-button primary" disabled={dirty || !!busy || draft.status !== 'approved'} onClick={() => setPublishOpen(true)}><Send size={16}/> Publish</button></div></footer>
    {reviseOpen && <ContentModal title="What would you like to change?" onClose={busy ? undefined : () => setReviseOpen(false)}><label className="content-field">Tell your writer<textarea autoFocus rows={4} placeholder="Make it shorter, warmer, more specific…" value={revision} onChange={(e) => setRevision(e.target.value)}/></label><EngineSelect value={engine} onChange={setEngine}/><p className="content-hint">The revision comes back for your review.</p>{error && <p role="alert" className="content-notice error">{error}</p>}<button className="content-button primary" disabled={!!busy || revision.trim().length < 3} onClick={() => void action('revise', { instruction: revision, engine })}><Sparkles size={16}/>{busy ? 'Revising…' : 'Revise draft'}</button></ContentModal>}
    {publishOpen && <ContentModal title="Ready to share?" onClose={busy ? undefined : () => setPublishOpen(false)}><p className="content-hint">Publish your approved version to the selected destinations.</p><fieldset className="content-choices"><legend>Where it will appear</legend>{draft.channels.filter((ch) => ch in CONTENT_CHANNELS).map((channel) => { const connection = connections.find((item) => item.channel === channel); return <label key={channel}><input type="checkbox" checked={selectedChannels.includes(channel)} onChange={(e) => setSelectedChannels((old) => e.target.checked ? [...old,channel] : old.filter((c) => c !== channel))}/>{CONTENT_CHANNELS[channel as ContentChannel]} <small>{connection && ['ready','connected'].includes(connection.status) ? 'Connected' : 'Connection needed'}</small></label>; })}</fieldset>{!available && <p className="content-notice">A selected account still needs connecting. Your approved draft will stay here until it is ready.</p>}{scheduling && <label className="content-field"><span><Clock3 size={14}/> Schedule for later <small>Optional · your local time</small></span><input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)}/></label>}{error && <p className="content-notice error" role="alert">{error}</p>}<button className="content-button primary" disabled={!!busy || !available || (!!scheduledAt && (!scheduling || !Number.isFinite(Date.parse(scheduledAt)) || new Date(scheduledAt).getTime() <= Date.now()))} onClick={() => void action('publish', { channels: selectedChannels, ...(scheduledAt ? { scheduledAt: new Date(scheduledAt).toISOString() } : {}) })}><Send size={16}/>{busy ? 'Sending…' : scheduledAt ? 'Schedule approved content' : 'Publish approved content'}</button></ContentModal>}
  </section>;
}
