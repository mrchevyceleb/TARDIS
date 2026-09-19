import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Mail, Plug, RefreshCw, ShieldCheck } from 'lucide-react';
import { integrationRequest } from '../data/api';
import './integrations.css';

type Status = { configured: boolean; error?: string; integrations: Record<string,boolean>; gmailAccounts: string[]; googleRedirectUri: string; githubAccount?:string|null };
type Approval = { id: string; tool_name: string; status: string; arguments: unknown; result?: unknown; created_at: string };
const connections = [
  { id:'github', name:'GitHub', description:'Let your team read repositories, work on code, and prepare issues and draft pull requests. Changes require your review.', hint:'Create a token in your own GitHub account. Choose the resource owner and repositories you want to connect. Use Contents, Issues, and Pull requests permissions: read and write for agent edits, or read-only for browsing. Organization approval may be required.' },
  { id:'google', name:'Gmail', description:'One inbox across your connected Google accounts.', hint:'An administrator sets up a Google OAuth web app once, then each account uses Google sign-in.' },
  { id:'slack', name:'Slack', description:'Read conversations and prepare messages.', hint:'Use a Slack user token from her own Slack app and account.' },
  { id:'ghl', name:'GoHighLevel', description:'Work with contacts, opportunities and locations.', hint:'Use her GoHighLevel private integration token with access to the intended subaccount.' },
  { id:'web_search', name:'Web search', description:'Find sources for research and planning.', hint:'Use a Brave Search API subscription key.' },
  { id:'doppler', name:'Doppler', description:'Use saved credentials from your connected project and config. Secret changes require your review.', hint:'Use a personal token (dp.pt.) with a project and config, or a service token (dp.st.) from your config’s Access tab. Agents use only the saved destination. Existing connections are not automatically imported.' },
  { id:'vercel', name:'Vercel', description:'Inspect projects, deployments and build logs. Redeployments require your review.', hint:'Create an access token in your Vercel account settings, scoped to the intended team. Enter its Team ID below, or leave blank for a personal account.' },
  { id:'railway', name:'Railway', description:'Inspect and maintain her services.', hint:'Use a Railway API token scoped to the intended R-Link workspace.' },
  { id:'supabase', name:'Supabase', description:'Inspect and maintain authorized projects.', hint:'Use her Supabase management access token. This is separate from the private memory database.' },
];
const message = (e:unknown) => e instanceof Error ? e.message : 'Something went wrong.';
const preview = (value: unknown) => JSON.stringify(value, (key,item) => /token|secret|password|api.?key/i.test(key) ? '[hidden credential]' : item, 2);

function RequestDetails({ request }: { request: Approval }) {
  const args = request.arguments as { action?: string; params?: Record<string,unknown> } | null;
  const params = args?.params;
  if (request.tool_name === 'gmail' && params && ['send','reply'].includes(args?.action ?? '')) {
    const envelope = (args?.action === 'reply' ? params.reviewedReply : params) as { to?: unknown; subject?: unknown } | undefined;
    return <div className="integration-email-preview"><dl>
      <dt>From</dt><dd>{String(params.account ?? '')}</dd>
      {Array.isArray(envelope?.to) && <><dt>To</dt><dd>{envelope.to.map(String).join(', ')}</dd></>}
      {envelope?.subject != null && <><dt>Subject</dt><dd>{String(envelope.subject)}</dd></>}
      {params.messageId != null && <><dt>Reply to message</dt><dd>{String(params.messageId)}</dd></>}
      <dt>Format</dt><dd>{String(params.format ?? 'plain')}</dd>
    </dl><div className="integration-email-body">{String(params.body ?? '')}</div></div>;
  }
  return <pre>{preview(request.arguments)}</pre>;
}

export function Integrations() {
  const cache = useQueryClient();
  const [editing,setEditing] = useState('');
  const [credential,setCredential] = useState('');
  const [clientId,setClientId] = useState('');
  const [teamId,setTeamId] = useState('');
  const [dopplerProject,setDopplerProject] = useState('');
  const [dopplerConfig,setDopplerConfig] = useState('');
  const [busy,setBusy] = useState('');
  const [notice,setNotice] = useState('');
  const [error,setError] = useState('');
  const [loginUrl,setLoginUrl] = useState('');
  const status = useQuery({ queryKey:['integrations','status'], queryFn:() => integrationRequest<Status>('/status'), retry:false });
  const approvals = useQuery({ queryKey:['integrations','approvals'], queryFn:() => integrationRequest<{requests:Approval[]}>('/approvals'), enabled:!!status.data?.configured, refetchInterval:10000, retry:false });
  const refresh = () => { void cache.invalidateQueries({queryKey:['integrations']}); };
  const run = async (key:string, work:()=>Promise<void>) => {
    setBusy(key); setError(''); setNotice('');
    try { await work(); refresh(); } catch(e) { setError(message(e)); } finally { setBusy(''); }
  };
  const save = () => run('save',async () => {
    const token = credential.trim();
    if (!token) throw new Error('Paste your credential before saving.');
    if (editing === 'github' && !/^(github_pat_|ghp_)[A-Za-z0-9_]+$/.test(token)) throw new Error('Paste a GitHub personal access token, not your password.');
    if (editing === 'doppler') {
      if (!/^dp\.(st|pt)\./.test(token)) throw new Error('Use a Doppler personal token (dp.pt.) or service token (dp.st.).');
      if ((token.startsWith('dp.pt.') || dopplerProject.trim() || dopplerConfig.trim()) && (!dopplerProject.trim() || !dopplerConfig.trim())) throw new Error('Enter both the Doppler project and config. Personal tokens require a destination.');
    }
    await integrationRequest('/credentials','POST',editing === 'google' ? {integration:editing,clientId:clientId.trim(),clientSecret:token} : {integration:editing,token,...(editing === 'vercel' ? {teamId:teamId.trim() || undefined} : {}),...(editing === 'doppler' ? {project:dopplerProject.trim() || undefined,config:dopplerConfig.trim() || undefined} : {})});
    setCredential(''); setClientId(''); setTeamId(''); setDopplerProject(''); setDopplerConfig(''); setEditing(''); setNotice(editing === 'github' ? 'GitHub verified and connected. Your agents can use it through the integration.' : 'Connection settings saved. Your agents can use them now.');
  });
  const connectGmail = () => run('gmail',async () => {
    const result = await integrationRequest<{url:string}>('/gmail/start','POST',{});
    const url = new URL(result.url);
    if (url.protocol !== 'https:') throw new Error('Invalid sign-in link');
    setLoginUrl(url.href);
  });
  const decide = (id:string,decision:'approve'|'reject') => run(id,async () => {
    const result = await integrationRequest<{status:string}>(`/approvals/${id}`,'POST',{decision});
    if (result.status === 'failed') throw new Error('The action failed or its outcome is uncertain. Check the destination before requesting another attempt.');
    setNotice(decision === 'approve' ? 'Action completed.' : 'Request declined.');
  });
  return <section className="integration-room">
    <header><div><span className="integration-eyebrow"><Plug size={14}/> YOUR OFFICE, CONNECTED</span><h1>Integrations</h1><p>Connect once. Your whole team can help.</p></div><button onClick={refresh} aria-label="Refresh integrations"><RefreshCw size={17}/></button></header>
    {(error || status.error || approvals.error) && <p role="alert" className="integration-error">{error || message(status.error || approvals.error)}</p>}
    {notice && <p role="status" className="integration-notice">{notice}</p>}
    {status.isPending ? <p>Checking your office connections…</p> : !status.data?.configured ? <div className="integration-empty"><Plug size={35}/><h2>Your integration hub is not connected yet</h2><p>Your installer can connect the private hub for this computer. Shared brand connections stay in Content.</p></div> : <>
      <div className="integration-private"><ShieldCheck size={22}/><div><strong>Private memory is ready</strong><p>Your team’s saved knowledge and tool activity stay in this office. Shared brand content lives in Content.</p></div></div>
      <div className="integration-grid">{connections.map(item => <article key={item.id}>
        <div className="integration-card-title"><h2>{item.name}</h2><span>{status.data.integrations[item.id] ? <><Check size={13}/> Configured</> : 'Not connected'}</span></div>
        <p>{item.description}</p>
        {item.id === 'github' && status.data.githubAccount && <p>Connected as <strong>{status.data.githubAccount}</strong></p>}
        {editing === item.id ? <form onSubmit={e => { e.preventDefault(); void save(); }}>
          <p>{item.hint}</p>
          {item.id === 'github' && <><a href="https://github.com/settings/personal-access-tokens/new?name=TARDIS&amp;description=Connect%20my%20TARDIS%20team&amp;expires_in=90&amp;contents=write&amp;issues=write&amp;pull_requests=write" target="_blank" rel="noopener noreferrer">Create a GitHub token ↗</a><p>Copy the generated token, return here, and save it below. This connects your agents through Integrations; terminal GitHub sign-in stays separate.</p></>}
          {item.id === 'google' && <><p>Google redirect URI: <code>{status.data.googleRedirectUri}</code></p><label>Client ID<input required value={clientId} onChange={e=>setClientId(e.target.value)} autoComplete="off"/></label></>}
          {item.id === 'vercel' && <label>Team ID (optional)<input value={teamId} onChange={e=>setTeamId(e.target.value)} autoComplete="off" placeholder="team_…"/></label>}
          {item.id === 'doppler' && <><label>Project<input value={dopplerProject} onChange={e=>setDopplerProject(e.target.value)} autoComplete="off" placeholder="Project slug"/></label><label>Config<input value={dopplerConfig} onChange={e=>setDopplerConfig(e.target.value)} autoComplete="off" placeholder="prd"/></label></>}
          <label>{item.id === 'google' ? 'Client secret' : item.id === 'github' ? 'GitHub personal access token' : 'Access token / API key'}<input type="password" required value={credential} onChange={e=>setCredential(e.target.value)} autoComplete="new-password"/></label>
          {error && <p role="alert" className="integration-error">{error}</p>}
          <div className="integration-actions"><button type="submit" disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save connection'}</button><button type="button" disabled={!!busy} onClick={()=>{setEditing('');setCredential('');setClientId('');setTeamId('');setDopplerProject('');setDopplerConfig('');setError('');}}>Cancel</button></div>
        </form> : <button disabled={!!busy} onClick={()=>{setEditing(item.id);setCredential('');setClientId('');setTeamId('');setDopplerProject('');setDopplerConfig('');setError('');setNotice('');}}>{status.data.integrations[item.id] ? 'Update connection' : 'Set up'}</button>}
        {item.id === 'github' && status.data.integrations.github && editing !== 'github' && <div className="integration-actions">
          <button disabled={!!busy} onClick={()=>void run('github-check',async()=>{const account=await integrationRequest<{login:string}>('/github/status');setNotice(`GitHub connection works for ${account.login}. Repository permissions are controlled by your token.`);})}>{busy==='github-check'?'Checking…':'Check connection'}</button>
          <button disabled={!!busy} onClick={()=>void run('github-disconnect',async()=>{await integrationRequest('/github','DELETE');setNotice('GitHub disconnected from this office. You can revoke the token in GitHub settings.');})}>Disconnect</button>
        </div>}
        {item.id === 'google' && status.data.integrations.google && <div className="integration-gmail">
          {status.data.gmailAccounts.map(account=><p key={account}><Mail size={13}/> {account}</p>)}
          <button disabled={!!busy} onClick={()=>void connectGmail()}>Connect a Gmail account</button>
          {loginUrl && <a href={loginUrl} target="_blank" rel="noopener noreferrer">Continue with Google →</a>}
          {loginUrl && <small>After signing in, return here and press Refresh.</small>}
        </div>}
      </article>)}</div>
      <div className="integration-review-title"><h2>Ready for your approval</h2><p>Review the details before your team sends or changes anything.</p></div>
      {approvals.isPending && <p>Loading requests…</p>}
      {approvals.data?.requests.length === 0 && <p className="integration-empty">All clear. Requests from your team will appear here.</p>}
      {approvals.data?.requests.map(item=><article className="integration-review" key={item.id}><div className="integration-card-title"><h3>{item.tool_name === 'gmail' ? 'Email for review' : item.tool_name}</h3><span>{item.status}</span></div><time>{new Date(item.created_at).toLocaleString()}</time><RequestDetails request={item}/>
        {item.status === 'pending' && <div className="integration-actions"><button disabled={!!busy} onClick={()=>void decide(item.id,'approve')}>{busy === item.id ? 'Working…' : 'Approve & run'}</button><button disabled={!!busy} onClick={()=>void decide(item.id,'reject')}>Decline</button></div>}
        {item.status === 'running' && <p>In progress. If interrupted, check the destination before requesting another attempt.</p>}
        {item.status === 'failed' && <><p role="status" className="integration-error">Failed, partially completed or uncertain. Check these results and the destination before trying again.</p><pre>{preview(item.result)}</pre></>}
      </article>)}
    </>}
  </section>;
}
