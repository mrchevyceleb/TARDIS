import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, RefreshCw, UserRound, X, Plus, ExternalLink, ArrowRight } from 'lucide-react';
import { fetchCliAccounts, selectCliAccount, startCliSignIn, fetchCliSignIn, submitCliSignInCode, cancelCliSignIn, type CliLogin, type CliAccount, type CliAccounts } from '../data/api';

type AccountControlProps = { engine: string; agentId?: string; chatId: string; repo?: string };

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
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [login, setLogin] = useState<CliLogin | null>(null);
  const [code, setCode] = useState('');
  const [starting, setStarting] = useState(false);
  const [position, setPosition] = useState({ top: 64, left: 12 });
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const refresh = useRef<() => void>(() => {});

  useEffect(() => {
    let closed = false;
    let epoch = 0;
    const controllers = new Set<AbortController>();
    const load = (force = false) => {
      const current = ++epoch;
      const controller = new AbortController();
      controllers.add(controller);
      setChecking(true);
      fetchCliAccounts({ engine, agentId, chatId, repo, refresh: force }, controller.signal)
        .then((result) => { if (!closed && current === epoch) { setData(result); setError(false); } })
        .catch(() => { if (!closed && current === epoch) setError(true); })
        .finally(() => { controllers.delete(controller); if (!closed && current === epoch) setChecking(false); });
    };
    refresh.current = () => load(true);
    load();
    const timer = window.setInterval(() => load(), 15_000);
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => { closed = true; window.clearInterval(timer); window.removeEventListener('focus', onFocus); for (const controller of controllers) controller.abort(); };
  }, [engine, agentId, chatId, repo]);

  useEffect(() => {
    if (!open) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      const width = Math.min(360, window.innerWidth - 24);
      setPosition({ top: Math.min((rect?.bottom ?? 48) + 8, window.innerHeight - 160), left: Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - width - 12)) });
    };
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); }
      if (event.key === 'Tab') {
        const elements = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input') || [])];
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
    };
    place();
    panel.current?.focus();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', key);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key); };
  }, [open]);

  useEffect(() => {
    if (!login || !['starting', 'waiting', 'checking'].includes(login.status)) return;
    let closed = false;
    const timer = window.setInterval(() => {
      fetchCliSignIn(login.id).then(value => {
        if (closed) return;
        setLogin(value);
        if (value.status === 'connected') {
          setCode(''); refresh.current(); window.dispatchEvent(new Event('tardis:accounts-changed'));
          setNotice(`Signed in as ${value.email || 'your new account'}. Choose it above to use it here.`);
        }
      }).catch(() => { if (!closed) setLogin(previous => previous ? { ...previous, status: 'failed', message: 'This sign-in has ended. Start a fresh one.' } : null); });
    }, 1500);
    return () => { closed = true; window.clearInterval(timer); };
  }, [login?.id, login?.status]);

  const choose = async (account: CliAccount) => {
    if (!agentId || saving || account.status !== 'connected') return;
    setSaving(account.id); setNotice('');
    try {
      await selectCliAccount(engine, agentId, account.id);
      setData(previous => previous ? { ...previous, selectedId: account.id } : previous);
      setNotice('Account saved for the next reply. Your conversation stays here.');
      refresh.current(); window.dispatchEvent(new Event('tardis:accounts-changed'));
    } catch (error) { setNotice(error instanceof Error ? error.message : 'The account could not be saved. Try again.'); }
    finally { setSaving(null); }
  };
  const signIn = async () => {
    setStarting(true); setNotice(''); setCode('');
    try { setLogin(await startCliSignIn(engine)); }
    catch { setNotice('Sign-in could not start. Try again.'); }
    finally { setStarting(false); }
  };
  const cancelSignIn = async () => {
    if (!login) return;
    try { await cancelCliSignIn(login.id); setLogin(null); setCode(''); }
    catch { setNotice('I could not cancel sign-in. Try again.'); }
  };
  const sendCode = async (event: React.FormEvent) => {
    event.preventDefault(); if (!login || !code.trim()) return;
    try { await submitCliSignInCode(login.id, code); setCode(''); setLogin({ ...login, status: 'checking' }); }
    catch (error) { setNotice(error instanceof Error ? error.message : 'The code could not be checked. Try again.'); }
  };

  const selected = data?.accounts.find((account) => account.id === data.selectedId);
  const active = data?.accounts.find((account) => account.id === data.activeId);
  const current = data?.busy ? active : selected;
  const pending = Boolean(data?.busy && data.activeId !== data.selectedId);
  const email = error ? 'Check account' : (data?.busy ? data.activeEmail || active?.email : current?.email) || (checking && !data ? 'Checking account…' : 'Account needs attention');
  const title = engine === 'claude' ? 'Claude' : 'Codex';
  const accounts = data?.accounts.filter((account) => account.engine === engine) ?? [];
  return <>
    <button type="button" ref={trigger} className={`bt-account-chip${error || current?.status !== 'connected' ? ' needs-attention' : ''}`} onClick={() => setOpen((value) => !value)} aria-haspopup="dialog" aria-expanded={open} aria-label={`${title} account: ${email}${pending ? '; another account is saved for the next turn' : ''}`} title={`${title} · ${email}`}>
      <span className="bt-account-dot" aria-hidden="true" /><span>{email}</span><ChevronDown size={11} />
    </button>
    {open ? createPortal(<div ref={panel} className="bt-account-pop" style={position} role="dialog" aria-label={`${title} accounts`} tabIndex={-1}>
      <div className="bt-account-pop-head"><span className="bt-account-emblem"><UserRound size={18} /></span><div><strong>{title} accounts</strong><small>{accounts.filter((account) => account.status === 'connected').length} signed in</small></div><button type="button" className="bt-iconbtn" onClick={() => { setOpen(false); trigger.current?.focus(); }} aria-label="Close accounts"><X size={16} /></button></div>
      <p className="bt-account-current">{error ? 'I could not check your accounts. Try refreshing.' : data?.selectionNotice ? data.selectionNotice : pending ? `This reply is using ${data?.activeEmail || active?.email || 'its original account'}. ${selected?.email || 'Your saved account'} takes over next turn.` : current?.email ? `This conversation uses ${current.email}.` : 'Sign in to a subscription to use this engine.'}</p>
      <div className="bt-account-list" aria-label="Available accounts">{accounts.map((account) => <button type="button" key={account.id} disabled={Boolean(saving) || !agentId || account.status !== 'connected'} onClick={() => void choose(account)} aria-pressed={account.id === data?.selectedId} className={`bt-account-row${account.id === data?.selectedId ? ' is-selected' : ''}`}><span className="bt-account-avatar" style={accountColor(account)} aria-hidden="true">{account.email?.slice(0, 2).toUpperCase() || '?'}</span><span className="bt-account-row-copy"><strong>{account.email || 'Account not signed in'}</strong><small>{statusLabel(account)}{account.organization ? ` · ${account.organization}` : ''}{account.id === data?.activeId && data.busy ? ' · using now' : account.id === data?.selectedId ? ' · selected' : ''}</small></span>{saving === account.id ? <RefreshCw size={16} className="is-checking" aria-label="Saving account" /> : account.id === data?.selectedId ? <Check size={16} aria-label="Selected account" /> : <ArrowRight size={15} className="bt-account-select-arrow" />}</button>)}</div>
      <p className="bt-account-promise">{data?.busy ? 'A new account takes over after this reply. Your conversation stays here.' : 'Choose an account for your next reply. Your conversation stays here.'}</p>
      {notice ? <p className="bt-account-notice" role="status">{notice}</p> : null}
      {login && ['starting', 'waiting', 'checking'].includes(login.status) ? <div className="bt-account-signin">
        <strong>{login.status === 'checking' ? 'Checking your sign-in…' : login.status === 'starting' ? 'Getting sign-in ready…' : 'One sign-in, then you’re set.'}</strong>
        <p>{login.status !== 'waiting' ? 'This usually takes a moment.' : engine === 'claude' ? 'Open Claude, sign in to the account you want, then paste the code it gives you here.' : 'Open ChatGPT, sign in to the account you want, and enter this device code.'}</p>
        {login.status === 'waiting' && login.userCode ? <code className="bt-account-device-code">{login.userCode}</code> : null}
        {login.status === 'waiting' && login.url ? <a className="bt-account-login-link" href={login.url} target="_blank" rel="noopener noreferrer">Open {title} sign-in <ExternalLink size={14} /></a> : null}
        {engine === 'claude' && login.status === 'waiting' && login.url ? <form onSubmit={event => void sendCode(event)}><label htmlFor="bt-account-code">Code from Claude</label><div><input id="bt-account-code" type="password" autoComplete="off" value={code} onChange={event => setCode(event.target.value)} placeholder="Paste your sign-in code" /><button type="submit" disabled={!code.trim()} aria-label="Complete sign-in"><ArrowRight size={16} /></button></div></form> : null}
        <button type="button" className="bt-account-refresh" onClick={() => void cancelSignIn()}>Cancel sign-in</button>
      </div> : <>
        {login?.status === 'failed' ? <p className="bt-account-notice" role="alert">{login.message || 'Sign-in did not finish. Try again.'}</p> : null}
        <button type="button" className="bt-account-add" disabled={starting} onClick={() => void signIn()}><Plus size={16} />{starting ? 'Getting sign-in ready…' : `Add ${title} account`}</button>
      </>}
      <button type="button" className="bt-account-refresh" disabled={checking} onClick={() => refresh.current()}><RefreshCw size={14} className={checking ? 'is-checking' : ''} />{checking ? 'Checking sign-ins…' : 'Refresh sign-ins'}</button>
    </div>, document.body) : null}
  </>;
}
