import { useCallback, useEffect, useState } from 'react';
import { Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import { contentRequest } from '../data/api';
import { CONTENT_BRANDS, CONTENT_CHANNELS, type ContentBrand, type ContentChannel } from '../data/content';

type Status = { apiKeyConfigured: boolean; profileConfigured: boolean; verified: boolean; title: string; issue: string; xCredentialsConfigured: boolean; accounts: Array<{ platform: ContentChannel; linked: boolean; ready: boolean; name: string }> };
const emptyKeys = { apiKey: '', profileKey: '', xApiKey: '', xApiSecret: '' };
function safeLink(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'profile.ayrshare.com' || url.port || url.username || url.password) throw new Error('Unexpected connection address. Please try again.');
  return url.href;
}
export function AyrshareConnection({ brand, onSaved }: { brand: ContentBrand; onSaved: () => void }) {
  const [status, setStatus] = useState<Status>();
  const [keys, setKeys] = useState(emptyKeys);
  const [busy, setBusy] = useState('loading');
  const [error, setError] = useState('');
  const [link, setLink] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [notice, setNotice] = useState('');
  const base = `/connections/${brand}/ayrshare`;
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const result = await contentRequest<Status>(base, 'GET', undefined, signal);
    setStatus(result); return result;
  }, [base]);
  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal).catch((e) => { if (!controller.signal.aborted) setError(e.message); }).finally(() => { if (!controller.signal.aborted) setBusy(''); });
    const focus = () => { void refresh(controller.signal).then(onSaved).catch(() => {}); };
    window.addEventListener('focus', focus);
    return () => { controller.abort(); window.removeEventListener('focus', focus); };
  }, [refresh, onSaved]);
  const act = async (action: 'save' | 'profile' | 'connect' | 'refresh') => {
    setBusy(action); setError(''); setNotice('');
    if (action === 'connect') { setLink(''); setExpiresAt(''); }
    const popup = action === 'connect' ? window.open('about:blank', '_blank') : null;
    if (popup) popup.opener = null;
    try {
      if (action === 'save') {
        const values = Object.fromEntries(Object.entries(keys).map(([k,v]) => [k,v.trim()]).filter(([,v]) => v));
        setStatus(await contentRequest<Status>(base, 'PUT', values)); setKeys(emptyKeys); setNotice('Ayrshare settings saved.');
      } else if (action === 'profile') {
        setStatus(await contentRequest<Status>(`${base}/profile`, 'POST', {})); setNotice('Brand profile ready. Connect its social accounts next.');
      } else if (action === 'connect') {
        const result = await contentRequest<{ url: string; expiresAt: string | null }>(`${base}/connect`, 'POST', {});
        const url = safeLink(result.url); setLink(url); setExpiresAt(result.expiresAt || '');
        if (popup) popup.location.replace(url);
      } else await refresh();
      onSaved();
    } catch (e) { popup?.close(); setError(e instanceof Error ? e.message : 'Could not connect. Please try again.'); }
    finally { setBusy(''); }
  };
  useEffect(() => {
    if (!link) return;
    const remaining = expiresAt ? Date.parse(expiresAt) - Date.now() : 5 * 60_000;
    const timer = window.setTimeout(() => { setLink(''); setNotice('That sign-in link expired. Select Connect accounts for a fresh one.'); }, Math.max(0, Number.isFinite(remaining) ? remaining : 5 * 60_000));
    return () => window.clearTimeout(timer);
  }, [link, expiresAt]);
  return <section className="content-ayrshare" aria-label="Social account connections">
    <span className="content-eyebrow">SOCIAL ACCOUNTS</span>
    <h3>Connect once. Create here.</h3>
    <p className="content-hint">Connect {CONTENT_BRANDS[brand]} through Ayrshare. You sign in on the social network’s own page; your drafts and approvals stay in TARDIS.</p>
    {error && <p role="alert" className="content-notice error">{error}</p>}
    {notice && <p role="status" className="content-notice">{notice}</p>}
    {status?.issue && <p className="content-notice">{status.issue}</p>}
    {status?.profileConfigured ? <>
      <p className="content-hint">Brand profile: <strong>{status.title}</strong></p>
      <div className="content-connection-actions"><button className="content-button primary" disabled={!!busy} onClick={() => void act('connect')}>{busy === 'connect' ? <LoaderCircle size={16} className="content-spin"/> : <ExternalLink size={16}/>} Connect accounts</button><button className="content-button" disabled={!!busy} onClick={() => void act('refresh')}><RefreshCw size={14}/> Refresh</button></div>
      {link && <p className="content-hint"><a href={link} target="_blank" rel="noreferrer">Open the secure sign-in page</a>, then return here. This link expires shortly.</p>}
    </> : <p className="content-notice">An administrator needs to add the Ayrshare account below once. After that, all you need is Connect accounts.</p>}
    <div className="content-account-list">{(status?.accounts || ['facebook','instagram','linkedin','x'].map((platform) => ({ platform: platform as ContentChannel, ready: false, linked: false, name: '' }))).map((account) => <div key={account.platform}><span className={account.ready ? 'connected' : ''}>{account.ready ? <Check size={15}/> : <span className="content-account-dot"/>}{CONTENT_CHANNELS[account.platform]}</span><small>{account.ready ? account.name || 'Connected' : account.linked ? 'Needs attention' : 'Not connected'}</small></div>)}</div>
    {status && !status.xCredentialsConfigured && <p className="content-hint">X also needs developer credentials in administrator setup. Facebook, Instagram and LinkedIn can be connected first.</p>}
    <details><summary>Administrator setup</summary><p className="content-hint">Use an Ayrshare account with User Profiles and account linking enabled. Give each brand its own profile. Blank fields keep saved credentials.</p>
      <label className="content-field">Ayrshare API key<input type="password" autoComplete="new-password" value={keys.apiKey} disabled={!!busy} placeholder={status?.apiKeyConfigured ? 'Saved — leave blank to keep' : 'Paste the API key'} onChange={(e) => setKeys({ ...keys, apiKey: e.target.value })}/></label>
      <label className="content-field">Existing brand Profile Key <small>Optional when creating a new profile</small><input type="password" autoComplete="new-password" value={keys.profileKey} disabled={!!busy} placeholder={status?.profileConfigured ? 'Saved — leave blank to keep' : 'Paste an existing Profile Key, or create below'} onChange={(e) => setKeys({ ...keys, profileKey: e.target.value })}/></label>
      <details><summary>X developer credentials</summary><p className="content-hint">Use the X app’s API key and API secret. Its allowed callbacks must include https://profile.ayrshare.com/social-accounts and https://app.ayrshare.com/social-accounts.</p>{(['xApiKey','xApiSecret'] as const).map((key) => <label className="content-field" key={key}>{key === 'xApiKey' ? 'X API key' : 'X API secret'}<input type="password" autoComplete="new-password" value={keys[key]} disabled={!!busy} onChange={(e) => setKeys({ ...keys, [key]: e.target.value })}/></label>)}</details>
      <button className="content-button" disabled={!!busy || !Object.values(keys).some((v) => v.trim())} onClick={() => void act('save')}>{busy === 'save' && <LoaderCircle size={15} className="content-spin"/>} Save Ayrshare settings</button>
      {status?.apiKeyConfigured && !status.profileConfigured && <><p className="content-hint">Create a separate {CONTENT_BRANDS[brand]} profile under your existing Ayrshare plan. The profile is subject to that plan’s pricing.</p><button className="content-button" disabled={!!busy} onClick={() => void act('profile')}>Create {CONTENT_BRANDS[brand]} profile</button></>}
    </details>
  </section>;
}
