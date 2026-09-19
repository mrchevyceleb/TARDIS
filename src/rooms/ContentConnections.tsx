import { useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { contentRequest } from '../data/api';
import { CONTENT_GHL_CHANNELS, CONTENT_BRANDS, CONTENT_CHANNELS, type ContentBrand } from '../data/content';
import { AyrshareConnection } from './AyrshareConnection';

type Choice = { id: string; name: string; platform?: string };
type Connection = {
  configured: boolean; locationId: string; blogId?: string; authorId?: string; userId?: string;
  pinterestBoardId?:string;pinterestOauthId?:string;communityUser?:{id:string;name:string;avatar:string};categoryIds?: string[]; socialAccounts?: Record<string, string>; connectUrl?: string;
  accounts: Choice[]; blogs: Choice[]; authors: Choice[]; users: Choice[]; categories: Choice[]; issues: string[];
};
type Selection = { locationId: string; blogId: string; authorId: string; userId: string; socialAccounts: Record<string, string>; categoryIds: string[];pinterestBoardId:string;pinterestOauthId:string;communityUser:{id:string;name:string;avatar:string} };
const selectionOf = (value: Connection): Selection => ({ locationId: value.locationId || '', blogId: value.blogId || '', authorId: value.authorId || '', userId: value.userId || '', socialAccounts: value.socialAccounts || {}, categoryIds: value.categoryIds || [],pinterestBoardId:value.pinterestBoardId??'',pinterestOauthId:value.pinterestOauthId??'',communityUser:value.communityUser??{id:'',name:'',avatar:''} });
const safeGhlUrl = (value?: string) => { try { const url = new URL(value || ''); return url.protocol === 'https:' && url.hostname === 'app.gohighlevel.com' ? url.href : undefined; } catch { return undefined; } };

export function ContentConnections({ brand, onSaved }: { brand: ContentBrand; onSaved: () => void }) {
  const [connection, setConnection] = useState<Connection>();
  const [selection, setSelection] = useState<Selection>({ locationId: '', blogId: '', authorId: '', userId: '', socialAccounts: {}, categoryIds: [],pinterestBoardId:'',pinterestOauthId:'',communityUser:{id:'',name:'',avatar:''} });
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void contentRequest<Connection>(`/connections/${brand}`, 'GET', undefined, controller.signal).then((data) => { setConnection(data); setSelection(selectionOf(data)); }).catch((e) => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [brand]);
  const load = async () => {
    setBusy(true); setError(''); setNotice('');
    try { const data = await contentRequest<Connection>(`/connections/${brand}`); setConnection(data); setSelection(selectionOf(data)); onSaved(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not load connections.'); }
    finally { setBusy(false); }
  };
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await contentRequest(`/connections/${brand}`, 'PUT', { ...selection, ...(token.trim() ? { token: token.trim() } : {}) });
      setToken('');
      const data = await contentRequest<Connection>(`/connections/${brand}`);
      setConnection(data); setSelection(selectionOf(data)); setNotice('Connection settings saved. Choose the destinations below.'); onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save connections.'); }
    finally { setBusy(false); }
  };
  const choose = (field: 'blogId' | 'authorId' | 'userId', title: string, options: Choice[]) => <label className="content-field">{title}<select aria-label={title} value={selection[field]} disabled={busy} onChange={(e) => setSelection((old) => ({ ...old, [field]: e.target.value }))}><option value="">Choose {title.toLowerCase()}</option>{options.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>;
  return <div className="content-connection-setup">
    <details open><summary>Social posts, blogs & email drafts · GHL</summary>
    <p className="content-hint">Use GoHighLevel for connected social accounts, including YouTube and TikTok videos, blogs and email drafts. Connect each brand to its own GHL location. X needs a separate publishing connection.</p>
    {error && <p className="content-notice error" role="alert">{error}</p>}
    {notice && <p className="content-notice" role="status">{notice}</p>}
    <details open={!connection?.configured}><summary>GHL connection settings</summary><p className="content-hint">Use this brand’s GHL location and a private integration token with Blog, Social Planner and email campaign access. The token is stored privately on this computer.</p>
      <label className="content-field">Location ID<input autoComplete="off" value={selection.locationId} disabled={busy} onChange={(e) => setSelection((old) => ({ ...old, locationId: e.target.value, blogId: '', authorId: '', userId: '', socialAccounts: {}, categoryIds: [],pinterestBoardId:'',pinterestOauthId:'',communityUser:{id:'',name:'',avatar:''} }))}/></label>
      <label className="content-field">Private integration token<input type="password" autoComplete="new-password" value={token} disabled={busy} placeholder={connection?.configured ? 'Leave blank to keep the saved token' : 'Paste the GHL token'} onChange={(e) => setToken(e.target.value)}/></label>
      <button className="content-button" disabled={busy || !selection.locationId.trim() || (!connection?.configured && !token.trim())} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="content-spin"/> : null} Save connection</button>
    </details>
    {connection?.configured && <>
      <div className="content-connection-actions">{safeGhlUrl(connection.connectUrl) && <a className="content-button" href={safeGhlUrl(connection.connectUrl)} target="_blank" rel="noreferrer">Connect social accounts <ExternalLink size={14}/></a>}<button className="content-button quiet" disabled={busy} onClick={() => void load()}><RefreshCw size={14}/> Refresh accounts</button></div>
      <p className="content-hint">Sign in to your social accounts in the window above, then refresh and choose the pages TARDIS should use.</p>
      {connection.issues?.map((issue, i) => <p className="content-notice" key={i}>{issue}</p>)}
      {choose('blogId', 'Blog', connection.blogs || [])}
      {choose('authorId', 'Blog author', connection.authors || [])}
      {choose('userId', 'Publishing user', connection.users || [])}
      {CONTENT_GHL_CHANNELS.map((platform) => <label className="content-field" key={platform}>{CONTENT_CHANNELS[platform as keyof typeof CONTENT_CHANNELS]}<select value={selection.socialAccounts[platform] || ''} disabled={busy} onChange={(e) => setSelection((old) => ({ ...old, socialAccounts: { ...old.socialAccounts, [platform]: e.target.value },...(platform==='pinterest'?{pinterestBoardId:'',pinterestOauthId:''}:{}),...(platform==='community'?{communityUser:{id:'',name:'',avatar:''}}:{}) }))}><option value="">Choose an account</option>{(connection.accounts || []).filter((account) => account.platform === platform).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>)}
      {selection.socialAccounts.pinterest&&<fieldset><legend>Pinterest destination</legend><label className="content-field">Board ID<input value={selection.pinterestBoardId} disabled={busy} onChange={e=>setSelection(old=>({...old,pinterestBoardId:e.target.value}))}/></label><label className="content-field">Pinterest account OAuth ID<input value={selection.pinterestOauthId} disabled={busy} onChange={e=>setSelection(old=>({...old,pinterestOauthId:e.target.value}))}/></label><p className="content-hint">Use the board and OAuth account IDs from this GHL sub-account's Pinterest connection.</p></fieldset>}
      {selection.socialAccounts.community&&<fieldset><legend>GHL Community posting identity</legend>{(['id','name','avatar'] as const).map(field=><label className="content-field" key={field}>{field==='id'?'Community member ID':field==='name'?'Display name':'Avatar HTTPS URL (optional)'}<input value={selection.communityUser[field]} disabled={busy} onChange={e=>setSelection(old=>({...old,communityUser:{...old.communityUser,[field]:e.target.value}}))}/></label>)}</fieldset>}
      <p className="content-hint">These social accounts use GHL. If you later configure an Ayrshare brand profile, Facebook, Instagram, LinkedIn and X posts for that brand will use Ayrshare instead. The other networks keep using GHL.</p>
      <button className="content-button primary" disabled={busy} onClick={() => void save()}>Save publishing destinations</button>
    </>}
    {!connection && !busy && <button className="content-button" onClick={() => void load()}>Try again</button>}
    </details>
    <details><summary>Optional social publishing provider: Ayrshare</summary><p className="content-hint">Use Ayrshare if you prefer a separate social publishing provider. Separate brand profiles require its Business plan.</p><AyrshareConnection key={brand} brand={brand} onSaved={onSaved}/></details>
  </div>;
}
