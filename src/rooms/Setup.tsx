import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, RefreshCw, Sparkles } from 'lucide-react';
import { contentRequest, setupRequest } from '../data/api';
import { CONTENT_BRANDS, CONTENT_ENGINES, type ContentBrand, type ContentEngine, type ContentIdea, type ContentDraft } from '../data/content';
import { ContentMedia } from './ContentMedia';
import './content.css';
import './setup.css';

type SetupStatus={checks:Array<{id:string;name:string;ready:boolean;detail:string;href?:string}>;state:{engine?:ContentEngine;verified?:Record<string,string>};routine:{paused?:boolean;schedule:string}|null;timezone:string};
type Walk={walkthrough:null|{brand:ContentBrand;engine:ContentEngine;startedAt:string};jobs?:Array<{id:string;kind:string;status:string;phase:string;progress:number}>;drafts?:Array<ContentDraft & {edit_revision?:number;approved_revision?:number}>;restarted?:boolean};

export function Setup() {
  const cache=useQueryClient();
  const status=useQuery({queryKey:['setup'],queryFn:()=>setupRequest<SetupStatus>('/status'),retry:false,staleTime:15000});
  const walk=useQuery({queryKey:['setup','walk'],queryFn:()=>setupRequest<Walk>('/walkthrough'),retry:false,refetchInterval:8000});
  const [engine,setEngine]=useState<ContentEngine>('claude'),[brand,setBrand]=useState<ContentBrand>('operly');
  const ideas=useQuery({queryKey:['content','ideas',brand],queryFn:()=>contentRequest<{ideas:ContentIdea[]}>(`/ideas?brand=${brand}`),retry:false});
  const [idea,setIdea]=useState(''),[brief,setBrief]=useState(''),[time,setTime]=useState('09:00');
  const timeChosen=useRef(false),engineChosen=useRef(false);
  useEffect(()=>{
    if(!status.data)return;
    if(!timeChosen.current&&status.data.routine){setTime(status.data.routine.schedule.split(':').slice(1).join(':'));timeChosen.current=true;}
    if(!engineChosen.current&&status.data.state.engine){setEngine(status.data.state.engine);engineChosen.current=true;}
  },[status.data]);
  const [busy,setBusy]=useState(''),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const [replace,setReplace]=useState(false);
  const act=async(key:string,work:()=>Promise<unknown>,success:string)=>{
    setBusy(key);setError('');setNotice('');
    try{await work();await cache.invalidateQueries({queryKey:['setup']});await cache.invalidateQueries({queryKey:['content']});setNotice(success);}catch(e){setError(e instanceof Error?e.message:'Something went wrong.');}finally{setBusy('');}
  };
  const refresh=()=>{void cache.invalidateQueries({queryKey:['setup']});void cache.invalidateQueries({queryKey:['content']});};
  const tracked=walk.data?.drafts??[];
  const ready=tracked.length>=2;
  const edited=ready&&tracked.every(d=>(d.edit_revision??d.version)>1);
  const approved=ready&&tracked.every(d=>d.approved_revision===(d.edit_revision??d.version));
  return <section className="setup-room">
    <header className="setup-header"><div><span className="setup-eyebrow"><Sparkles size={15}/> YOUR FIRST DAY</span><h1>Make yourself at home.</h1><p>Connect your office, make your first drafts, and find your rhythm.</p></div><button aria-label="Refresh setup checks" onClick={refresh} disabled={!!busy||status.isFetching}><RefreshCw size={18}/></button></header>
    <nav className="setup-nav" aria-label="Setup steps"><a href="#connections">1 · Connect</a><a href="#first-content">2 · First content</a><a href="#media">3 · Media</a><a href="#daily">4 · Daily rhythm</a><a href="#help">5 · Get help</a></nav>
    {error&&<p className="setup-error" role="alert">{error}</p>}{notice&&<p className="setup-notice" role="status">{notice}</p>}{busy&&<p role="status">{busy==='verify'?'Checking a real subscription response. This may take a minute…':'Working…'}</p>}
    <article id="connections" className="setup-card"><span className="setup-step">01 / CONNECT</span><h2>Your office, ready when you are.</h2>
      <p>Open <strong>Finish TARDIS Setup</strong> from Applications to sign into Claude Code and Codex. <a href="/xai-oauth" target="_blank" rel="noreferrer">Connect Grok</a> in your browser. One working subscription is enough to start drafting.</p>
      <div className="setup-subscriptions">{Object.entries(CONTENT_ENGINES).map(([key,name])=><div key={key}><strong>{name}</strong><span>{status.data?.state.verified?.[key]?`Last successful check: ${new Date(status.data.state.verified[key]).toLocaleString()}`:'Not yet verified'}</span><button disabled={!!busy} onClick={()=>void act('verify',()=>setupRequest('/verify',{engine:key}),`${name} responded successfully.`)}>Test {name}</button></div>)}</div>
      <p className="content-hint">A test sends one short request using that subscription. It does not publish content or connect external accounts.</p>
      {status.isPending?<p>Checking installed tools and services…</p>:status.error?<p role="alert">Setup checks could not load. Refresh or open Get help.</p>:<div className="setup-checks">{status.data?.checks.map(check=><div key={check.id} className={`setup-check ${check.ready?'ready':''}`}><span className="setup-check-icon" aria-hidden="true">{check.ready?<Check size={16}/>:'○'}</span><div><strong>{check.name}</strong><p>{check.detail}</p>{check.href&&<a href={check.href}>{check.ready?'Open':'Set up'}</a>}</div><span>{check.ready?'Ready':'Needs setup'}</span></div>)}</div>}
      <a className="setup-link" href="/integrations">Connect Gmail, Slack and other office accounts →</a>
    </article>
    <article id="first-content" className="setup-card"><span className="setup-step">02 / FIRST CONTENT</span><h2>One idea. Two drafts. Yours to finish.</h2><p>Use a researched topic to make a blog and social posts. These drafts are saved in your shared brand workspace. Nothing is published by this walkthrough.</p>
      <div className="setup-form-row"><label className="content-field">Brand<select value={brand} onChange={e=>{setBrand(e.target.value as ContentBrand);setIdea('');}}>{Object.entries(CONTENT_BRANDS).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label><label className="content-field">Writer<select value={engine} onChange={e=>{engineChosen.current=true;setEngine(e.target.value as ContentEngine);}}>{Object.entries(CONTENT_ENGINES).map(([key,name])=><option key={key} value={key}>{name}</option>)}</select></label></div>
      <label className="content-field">Choose a research idea<select value={idea} onChange={e=>setIdea(e.target.value)}><option value="">Use my own brief</option>{ideas.data?.ideas.map(item=><option key={item.id} value={item.id}>{item.headline}</option>)}</select></label>
      {idea?<p><a href={`/content?brand=${brand}&tab=ideas`}>Read the idea’s sources before drafting →</a></p>:<label className="content-field">Your brief<textarea rows={3} value={brief} maxLength={12000} onChange={e=>setBrief(e.target.value)} placeholder="Describe a useful topic, the audience and the facts or sources to use."/></label>}
      {ideas.error&&<p className="content-hint">Research ideas could not load. Check the content engine or use your own sourced brief.</p>}
      <div className="setup-actions"><button disabled={!!busy} onClick={()=>void act('scan',()=>contentRequest('/scan','POST',{brand}),'Research requested. Results take time; refresh the ideas when it finishes.')}>Find fresh ideas</button><button onClick={()=>void cache.invalidateQueries({queryKey:['content','ideas',brand]})}>Refresh ideas</button></div>
      {walk.data?.walkthrough&&<label className="setup-toggle"><input type="checkbox" checked={replace} onChange={e=>setReplace(e.target.checked)}/> Start another walkthrough (existing drafts are kept)</label>}
      <button className="setup-primary" disabled={!!busy||(!idea&&brief.trim().length<5)||!!walk.data?.walkthrough&&!replace} onClick={()=>void act('drafts',()=>setupRequest('/walkthrough',{brand,engine,ideaId:idea||undefined,brief,replace}),'Drafts requested. Their progress appears below.')}>Create my first drafts</button>
      {walk.error&&<p role="alert">Walkthrough progress is unavailable. Your drafts remain saved; refresh after the content engine reconnects.</p>}
      {walk.data?.walkthrough&&<div className="setup-walk"><h3>Your saved walkthrough · {CONTENT_BRANDS[walk.data.walkthrough.brand]}</h3><ol>
        <li className={ready?'done':''}>{ready?'✓':'1.'} Generate the blog and social pack.</li><li className={edited?'done':''}>{edited?'✓':'2.'} Open each draft, make an edit, and let it save.</li><li>3. Preview both drafts and check facts, voice, links and images.</li><li className={approved?'done':''}>{approved?'✓':'4.'} Approve the saved versions after reviewing them.</li><li className={walk.data.restarted&&ready?'done':''}>{walk.data.restarted&&ready?'✓':'5.'} When all work is idle, reboot the computer and return here to verify the drafts persist.</li>
      </ol><p className="content-hint">Generation, edits, approvals and restart are checked from saved state. Preview and editorial quality are your review. Publishing stays separate in Content.</p>
      {walk.data.jobs?.map(job=><p key={job.id}>{job.kind==='social-pack'?'Social posts':'Blog'}: {job.status} · {job.progress}% {job.phase}</p>)}
      <div className="setup-actions">{tracked.map(draft=><a key={draft.id} href={`/content?brand=${draft.brand}&draft=${draft.id}`}>Open {draft.kind==='social-pack'?'social posts':'blog'} →</a>)}<a href={`/content?brand=${walk.data.walkthrough.brand}`}>Open writing queue / retry a failed job →</a></div></div>}
    </article>
    <article id="media" className="setup-card"><span className="setup-step">03 / MEDIA</span><h2>Give your words a little company.</h2><ContentMedia/></article>
    <article id="daily" className="setup-card"><span className="setup-step">04 / DAILY RHYTHM</span><h2>A small, steady content habit.</h2><p>On weekdays, Content Coordinator can select at most one fresh idea per brand and prepare a blog plus social posts. It reuses existing jobs and reports what needs review. It never approves or publishes.</p>
      <p><strong>{status.data?.routine?(status.data.routine.paused?'Paused':'Enabled'):'Ready to set up · off'}</strong>{status.data?.routine&&` · ${status.data.routine.schedule}`} · Computer time zone: {status.data?.timezone??'checking…'}</p>
      <label className="content-field">Weekday drafting time<input type="time" value={time} onChange={e=>{timeChosen.current=true;setTime(e.target.value);}}/></label>
      <p className="content-hint">This uses Content Coordinator’s chosen subscription. Check its writer in the agent’s settings first. Research scans run nightly at midnight Eastern; drafting uses the computer’s time zone.</p>
      <div className="setup-actions"><button className="setup-primary" disabled={!!busy||!time} onClick={()=>void act('routine',()=>setupRequest('/routine',{enabled:true,time}),'Daily drafting enabled.')}>Enable daily drafting</button><button disabled={!!busy||!time} onClick={()=>void act('routine',()=>setupRequest('/routine',{enabled:false,time}),'Routine saved and paused.')}>Save paused / pause drafting</button></div>
    </article>
    <article id="help" className="setup-card"><span className="setup-step">05 / GET HELP</span><h2>You don’t have to untangle it alone.</h2>
      <div className="setup-actions"><button onClick={refresh}>Run connection checks again</button><a href="/api/setup/diagnostics" download>Download a safe diagnostic report</a><a href="/integrations">Review account connections</a></div>
      <p>The report includes tool and connection status only. It excludes credentials, transcripts, draft text, account names and logs.</p>
      <details><summary>Something isn’t working</summary><ul><li><strong>Writer won’t respond:</strong> use Finish TARDIS Setup to sign in again, then test that writer above.</li><li><strong>No new ideas:</strong> check the research status, request a scan once, and give it time. Open Content → Ideas for its result.</li><li><strong>Draft failed:</strong> open the writing queue, read the error, resolve sign-in or connection issues, then use Retry.</li><li><strong>Publishing failed:</strong> check the destination account before retrying. An uncertain result may already have posted.</li><li><strong>Need remote help:</strong> open TARDIS Remote Support from Applications. Sign into your own Tailscale account, share this computer with your support person, then enable support. Pause support when finished.</li></ul></details>
      <details><summary>Service troubleshooting on this computer</summary><p>Open <strong>TARDIS Help</strong> from Applications for service status and local logs. It never stops an agent. Before an update or reboot, finish all agent turns and content jobs.</p><p>The USB’s START-HERE guide and RECOVERY guide remain available offline.</p></details>
    </article>
    <div className="setup-actions"><button disabled={!!busy} onClick={()=>void act('complete',()=>setupRequest('/complete',{}),'Your office will open to the team next time. Start here stays available in Plugins.')}>Open my team on future logins</button><a href="/">Go to my team →</a></div>
  </section>;
}
