import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { Check, RefreshCw, UserRound, Plus, ExternalLink, ArrowRight } from 'lucide-react';
import { fetchCliAccounts, selectCliAccount, startCliSignIn, fetchCliSignIn, submitCliSignInCode, cancelCliSignIn, type CliLogin, type CliAccount, type CliAccounts } from '../data/api';

export type AccountControlProps = { engine: string; agentId?: string; chatId: string; repo?: string };

// Sign-in belongs to the provider, so it survives closing a model picker or
// moving to another agent. Authorization codes stay local to the input.
const signIns = new Map<string, CliLogin>();
const signInListeners = new Set<() => void>();
function subscribeSignIn(listener: () => void) {
  signInListeners.add(listener);
  return () => { signInListeners.delete(listener); };
}

function planLabel(account: CliAccount): string {
  const labels: Record<string, string> = { max: 'Max', promax: 'Pro Max', pro: 'Pro', plus: 'Plus', team: 'Team', business: 'Business', enterprise: 'Enterprise' };
  return account.plan ? labels[account.plan.toLowerCase()] || account.plan : 'Subscription';
}

function accountColor(account: CliAccount): CSSProperties {
  const seed = `${account.email || account.id}:${account.organization || ''}`;
  const hue = [...seed].reduce((value, letter) => (value * 31 + letter.charCodeAt(0)) >>> 0, 7) % 360;
  return { '--account-hue': hue } as CSSProperties;
}

function statusLabel(account: CliAccount): string {
  return account.status === 'connected' ? planLabel(account)
    : account.status === 'signed_out' ? 'Sign-in needed'
    : account.status === 'unsupported' ? 'Subscription sign-in needed' : 'Could not check this account';
}

export function AccountControl(props: AccountControlProps) {
  const engine = props.engine === 'assistant' ? 'claude' : props.engine === 'codex-personal' ? 'codex' : props.engine;
  if (engine !== 'claude' && engine !== 'codex') return null;
  return <SubscriptionAccount key={`${engine}:${props.agentId || props.chatId}`} {...props} engine={engine} />;
}

function SubscriptionAccount({ engine, agentId, chatId, repo }: AccountControlProps & { engine: 'claude' | 'codex' }) {
  const [data, setData] = useState<CliAccounts | null>(null);
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [noticeError, setNoticeError] = useState(false);
  const login = useSyncExternalStore(subscribeSignIn, () => signIns.get(engine) ?? null);
  const setLogin = (next: CliLogin | null | ((previous: CliLogin | null) => CliLogin | null)) => {
    const value = typeof next === 'function' ? next(signIns.get(engine) ?? null) : next;
    if (value) signIns.set(engine, value); else signIns.delete(engine);
    for (const notify of signInListeners) notify();
  };
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(false);
  const refresh = useRef<() => Promise<CliAccounts | null>>(async () => null);

  useEffect(() => {
    let closed = false;
    let epoch = 0;
    const controllers = new Set<AbortController>();
    const load = async (force = false): Promise<CliAccounts | null> => {
      const current = ++epoch;
      const controller = new AbortController();
      controllers.add(controller);
      setChecking(true);
      try {
        const result = await fetchCliAccounts({ engine, agentId, chatId, repo, refresh: force }, controller.signal);
        // A newer poll owns the render, not this request's result. A completed
        // account save still needs its own canonical read-back for confirmation.
        if (!closed && current === epoch) { setData(result); setError(false); }
        return result;
      } catch {
        if (!closed && current === epoch) setError(true);
        return null;
      } finally {
        controllers.delete(controller); if (!closed && current === epoch) setChecking(false);
      }
    };
    refresh.current = () => load(true);
    load();
    const timer = window.setInterval(() => load(), 15_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { closed = true; window.clearInterval(timer); window.removeEventListener('focus', onFocus); for (const controller of controllers) controller.abort(); };
  }, [engine, agentId, chatId, repo]);

  useEffect(() => {
    if (!login || !['starting', 'waiting', 'checking'].includes(login.status)) return;
    let closed = false;
    const timer = window.setInterval(() => {
      fetchCliSignIn(login.id).then(value => {
        if (closed) return;
        setLogin(value);
        if (value.status === 'connected') {
          setCode(''); refresh.current(); window.dispatchEvent(new Event('tardis:accounts-changed'));
          setNoticeError(false);
          setNotice(`Signed in as ${value.email || 'your new account'}. Choose it above to use it here.`);
        }
      }).catch(() => { if (!closed) setLogin(previous => previous ? { ...previous, status: 'failed', message: 'This sign-in has ended. Start a fresh one.' } : null); });
    }, 1500);
    return () => { closed = true; window.clearInterval(timer); };
  }, [login?.id, login?.status]);

  const choose = async (account: CliAccount) => {
    if (!agentId || saving || account.status !== 'connected' || account.id === data?.selectedId) return;
    setSaving(account.id); setNotice(''); setNoticeError(false);
    try {
      await selectCliAccount(engine, agentId, account.id);
      window.dispatchEvent(new Event('tardis:accounts-changed'));
      // A 200 is not proof that this device still shows the saved choice. Read
      // the canonical selection back before telling Matt which subscription
      // will bill the next reply, including when another device raced a change.
      const confirmed = await refresh.current();
      if (!confirmed || confirmed.selectedId !== account.id) throw new Error('The account choice could not be confirmed. Review the current selection and try again before replying.');
      setNotice(`Confirmed: new replies will use ${account.email || 'this account'}.`);
    } catch (error) {
      setNoticeError(true);
      setNotice(error instanceof Error ? error.message : 'The account could not be saved. Try again.');
    } finally { setSaving(null); }
  };
  const signIn = async () => {
    setStarting(true); setNotice(''); setNoticeError(false); setCode('');
    try { setLogin(await startCliSignIn(engine)); }
    catch { setNoticeError(true); setNotice('Sign-in could not start. Try again.'); }
    finally { setStarting(false); }
  };
  const cancelSignIn = async () => {
    if (!login) return;
    setNotice(''); setNoticeError(false);
    try { await cancelCliSignIn(login.id); setLogin(null); setCode(''); }
    catch { setNoticeError(true); setNotice('I could not cancel sign-in. Try again.'); }
  };
  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault(); if (!login || !code.trim()) return;
    setNotice(''); setNoticeError(false);
    try { await submitCliSignInCode(login.id, code); setCode(''); setLogin({ ...login, status: 'checking' }); }
    catch (error) { setNoticeError(true); setNotice(error instanceof Error ? error.message : 'The code could not be checked. Try again.'); }
  };

  const selected = data?.accounts.find((account) => account.id === data.selectedId);
  const active = data?.accounts.find((account) => account.id === data.activeId);
  const pending = Boolean(data?.busy && data.activeId !== data.selectedId);
  const title = engine === 'claude' ? 'Claude' : 'Codex';
  const accounts = data?.accounts.filter((account) => account.engine === engine) ?? [];
  const connectedCount = accounts.filter((account) => account.status === 'connected').length;
  return <section className="bt-account-inline" aria-label={`${title} subscription`}>
      <div className="bt-account-pop-head"><span className="bt-account-emblem"><UserRound size={18} /></span><div><strong>Subscription</strong><small>{checking && !data ? 'Checking sign-ins…' : `${connectedCount} ${title} ${connectedCount === 1 ? 'account' : 'accounts'} signed in`}</small></div></div>
      {error || data?.selectionNotice || pending ? <p className="bt-account-current" role={error ? 'alert' : 'status'}>{error ? 'I could not check your accounts. Try refreshing.' : data?.selectionNotice || `This reply is using ${data?.activeEmail || active?.email || 'its original account'}. ${selected?.email || 'Your saved account'} takes over next turn.`}</p> : null}
      <div className="bt-account-list" aria-label="Available accounts">{accounts.map((account) => <button type="button" key={account.id} disabled={Boolean(saving) || !agentId || account.status !== 'connected'} onClick={() => void choose(account)} aria-pressed={account.id === data?.selectedId} className={`bt-account-row${account.id === data?.selectedId ? ' is-selected' : ''}`}><span className="bt-account-avatar" style={accountColor(account)} aria-hidden="true">{account.email?.slice(0, 2).toUpperCase() || '?'}</span><span className="bt-account-row-copy"><strong>{account.email || 'Account not signed in'}</strong><small>{statusLabel(account)}{account.organization ? ` · ${account.organization}` : ''}{account.id === data?.activeId && data.busy ? ' · using now' : account.id === data?.selectedId ? ' · selected' : ''}</small></span>{saving === account.id ? <RefreshCw size={16} className="is-checking" aria-label="Saving account" /> : account.id === data?.selectedId ? <Check size={16} aria-label="Selected account" /> : <ArrowRight size={15} className="bt-account-select-arrow" />}</button>)}</div>
      <p key={noticeError ? 'error' : 'status'} className={notice ? `bt-account-notice${noticeError ? ' is-error' : ''}` : 'bt-account-promise'} role={noticeError ? 'alert' : notice ? 'status' : undefined}>{notice || (data?.busy ? 'A new account takes over after this reply. Your conversation stays here.' : 'Choose an account for your next reply. Your conversation stays here.')}</p>
      {login && ['starting', 'waiting', 'checking'].includes(login.status) ? <div className="bt-account-signin">
        <strong>{login.status === 'checking' ? 'Checking your sign-in…' : login.status === 'starting' ? 'Getting sign-in ready…' : 'One sign-in, then you’re set.'}</strong>
        <p>{login.status !== 'waiting' ? 'This usually takes a moment.' : engine === 'claude' ? 'Open Claude, sign in to the account you want, then paste the code it gives you here.' : 'Open ChatGPT, sign in to the account you want, and enter this device code.'}</p>
        {login.status === 'waiting' && login.userCode ? <code className="bt-account-device-code">{login.userCode}</code> : null}
        {login.status === 'waiting' && login.url ? <a className="bt-account-login-link" href={login.url} target="_blank" rel="noopener noreferrer">Open {title} sign-in <ExternalLink size={14} /></a> : null}
        {engine === 'claude' && login.status === 'waiting' && login.url ? <form onSubmit={event => void sendCode(event)}><label htmlFor="bt-account-code">Code from Claude</label><div><input id="bt-account-code" type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} placeholder="Paste your sign-in code" /><button type="submit" disabled={!code.trim()} aria-label="Complete sign-in"><ArrowRight size={16} /></button></div></form> : null}
        <button type="button" className="bt-account-refresh" onClick={() => void cancelSignIn()}>Cancel sign-in</button>
      </div> : <>
        {login?.status === 'failed' ? <p className="bt-account-notice is-error" role="alert">{login.message || 'Sign-in did not finish. Try again.'}</p> : null}
        <button type="button" className="bt-account-add" disabled={starting} onClick={() => void signIn()}><Plus size={16} />{starting ? 'Getting sign-in ready…' : `Add ${title} account`}</button>
      </>}
      <button type="button" className="bt-account-refresh" disabled={checking} onClick={() => refresh.current()}><RefreshCw size={14} className={checking ? 'is-checking' : ''} />{checking ? 'Checking sign-ins…' : 'Refresh sign-ins'}</button>
  </section>;
}
