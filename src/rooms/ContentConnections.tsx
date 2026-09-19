import { useEffect, useState } from 'react';
import { ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { contentRequest } from '../data/api';
import { CONTENT_BRANDS, CONTENT_CHANNELS, type ContentBrand } from '../data/content';
import { AyrshareConnection } from './AyrshareConnection';

type Choice = { id: string; name: string; platform?: string };
type Connection = {
  configured: boolean; locationId: string; blogId?: string; authorId?: string; userId?: string;
  categoryIds?: string[]; socialAccounts?: Record<string, string>; connectUrl?: string;
  accounts: Choice[]; blogs: Choice[]; authors: Choice[]; users: Choice[]; categories: Choice[]; issues: string[];
};
type Selection = { locationId: string; blogId: string; authorId: string; userId: string; socialAccounts: Record<string, string>; categoryIds: string[] };
const selectionOf = (value: Connection): Selection => ({ locationId: value.locationId || '', blogId: value.blogId || '', authorId: value.authorId || '', userId: value.userId || '', socialAccounts: value.socialAccounts || {}, categoryIds: value.categoryIds || [] });
const safeGhlUrl = (value?: string) => { try { const url = new URL(value || ''); return url.protocol === 'https:' && url.hostname === 'app.gohighlevel.com' ? url.href : undefined; } catch { return undefined; } };

export function ContentConnections({ brand, onSaved }: { brand: ContentBrand; onSaved: () => void }) {
  const [connection, setConnection] = useState<Connection>();
  const [selection, setSelection] = useState<Selection>({ locationId: '', blogId: '', authorId: '', userId: '', socialAccounts: {}, categoryIds: [] });
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
    <p className="content-hint">Use GoHighLevel to publish or schedule Facebook, Instagram and LinkedIn posts, publish blogs, and save marketing emails as drafts. Connect each brand to its own GHL location. X needs a separate publishing connection.</p>
    {error && <p className="content-notice error" role="alert">{error}</p>}
    {notice && <p className="content-notice" role="status">{notice}</p>}
    <details open={!connection?.configured}><summary>GHL connection settings</summary><p className="content-hint">Use this brand’s GHL location and a private integration token with Blog, Social Planner and email campaign access. The token is stored privately on this computer.</p>
      <label className="content-field">Location ID<input autoComplete="off" value={selection.locationId} disabled={busy} onChange={(e) => setSelection((old) => ({ ...old, locationId: e.target.value, blogId: '', authorId: '', userId: '', socialAccounts: {}, categoryIds: [] }))}/></label>
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
      {['facebook', 'instagram', 'linkedin'].map((platform) => <label className="content-field" key={platform}>{CONTENT_CHANNELS[platform as keyof typeof CONTENT_CHANNELS]}<select value={selection.socialAccounts[platform] || ''} disabled={busy} onChange={(e) => setSelection((old) => ({ ...old, socialAccounts: { ...old.socialAccounts, [platform]: e.target.value } }))}><option value="">Choose an account</option>{(connection.accounts || []).filter((account) => account.platform === platform).map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}</select></label>)}
      <p className="content-hint">These social accounts use GHL. If you later configure an Ayrshare brand profile, social posts for that brand will use Ayrshare instead.</p>
      <button className="content-button primary" disabled={busy} onClick={() => void save()}>Save publishing destinations</button>
    </>}
    {!connection && !busy && <button className="content-button" onClick={() => void load()}>Try again</button>}
    </details>
    <details><summary>Optional social publishing provider: Ayrshare</summary><p className="content-hint">Use Ayrshare if you prefer a separate social publishing provider. Separate brand profiles require its Business plan.</p><AyrshareConnection key={brand} brand={brand} onSaved={onSaved}/></details>
  </div>;
}
