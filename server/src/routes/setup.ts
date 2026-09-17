import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { JsonStore } from '../lib/jsonStore.ts';
import { trustedWebSocketOrigin } from '../lib/origin.ts';
import { contentEngineRequest } from '../lib/contentEngine.ts';
import { officeMcpConfig } from '../chat/office-mcp.ts';
import { completeSubscription } from '../chat/content-completion.ts';
import { listAgents } from '../chat/agents.ts';
import { createRoutine, listRoutines, updateRoutine } from '../chat/routines.ts';

type Engine = 'claude' | 'codex' | 'xai';
type Check = { id:string; name:string; ready:boolean; detail:string; href?:string };
type Walkthrough = {requestId:string; brand:string; engine:Engine; brief:string; ideaId?:string; jobIds:string[]; bootId:string; startedAt:string};
type SetupState = { id:string; engine?:Engine; verified?:Partial<Record<Engine,string>>; routineId?:string;
  completedAt?:string;
  walkthrough?:Walkthrough; pendingWalkthrough?:Walkthrough; };
const store = new JsonStore<SetupState>('office-setup.json', []);
let stateQueue = Promise.resolve();
async function state() { return (await store.list())[0] ?? {id:'setup'}; }
function change(patch: (old:SetupState)=>Partial<SetupState>) {
  const work = stateQueue.then(async () => { const old = await state(); const next = {...old,...patch(old)}; await store.replace([next]); return next; });
  stateQueue = work.then(()=>{},()=>{}); return work;
}
const exec = promisify(execFile);
const serverBoot = randomUUID();
async function bootId() { return (await readFile('/proc/sys/kernel/random/boot_id','utf8').catch(()=>serverBoot)).trim(); }
const engineOf = (value:unknown):Engine => { if (!['claude','codex','xai'].includes(String(value))) throw new Error('Choose Claude Code, Codex or Grok.'); return value as Engine; };
const brandOf = (value:unknown) => { if (!['operly','r-link'].includes(String(value))) throw new Error('Choose a brand.'); return value as string; };
async function probe(command:string,args:string[]) { try { await exec(command,args,{timeout:8000,windowsHide:true,maxBuffer:64000}); return true; } catch { return false; } }
async function engineData(path:string):Promise<any> { return contentEngineRequest(path,'GET',undefined,AbortSignal.timeout(12000)); }

async function readiness() {
  const saved = await state();
  const results = await Promise.allSettled([
    engineData('/status'), engineData('/scanner?brand=operly'), engineData('/scanner?brand=r-link'),
    engineData('/media/settings'), probe('claude',['--version']), probe(process.env.RIVENDELL_CODEX_BIN || 'codex',['--version']), probe('ffmpeg',['-version']),
    (async()=>{const config=officeMcpConfig(); if(!config)return false; const r=await fetch(`${config.base}/tools`,{headers:{Authorization:`Bearer ${config.token}`},redirect:'error',signal:AbortSignal.timeout(10000)}); return r.ok;})(),
  ]);
  const value = (i:number) => results[i].status==='fulfilled' ? (results[i] as PromiseFulfilledResult<any>).value : undefined;
  const content = value(0);
  const checks:Check[] = [
    {id:'claude',name:'Claude Code installed',ready:!!value(4),detail:'Sign in using Finish TARDIS Setup, then test your subscription below.'},
    {id:'codex',name:'Codex installed',ready:!!value(5),detail:'Sign in using Finish TARDIS Setup, then test your subscription below.'},
    {id:'office',name:'Private integration hub',ready:!!value(7),detail:value(7)?'Agent connection responds. Connect accounts in Integrations.':'Check the private office connection or network.',href:'/integrations'},
    {id:'storage',name:'Content engine and database',ready:content?.storage==='connected',detail:content?.storage==='connected'?'Saved drafts are reachable.':'Open Get help below to inspect the local services.',href:'/content'},
    {id:'ffmpeg',name:'Video editing tools',ready:!!value(6),detail:value(6)?'FFmpeg is installed for working with your footage.':'Install FFmpeg using the USB setup.'},
    ...(['operly','r-link'] as const).map((brand,i)=>({id:`scanner-${brand}`,name:`${brand==='operly'?'Operly':'R-Link'} research`,ready:!!value(i+1)?.connected,detail:value(i+1)?.connected?'Scanner responds; use the walkthrough to check real results.':'Research scanner needs attention.',href:`/content?brand=${brand}&tab=ideas`})),
  ];
  for(const brand of content?.brands ?? []) for(const channel of brand.channels ?? []) if(channel.channel!=='email') checks.push({id:`${brand.brand}-${channel.channel}`,name:`${brand.brand==='operly'?'Operly':'R-Link'} · ${channel.channel}`,ready:['ready','connected'].includes(channel.status),detail:['ready','connected'].includes(channel.status)?'Destination configured. Review its account name before publishing.':'Optional: connect this destination when you are ready.',href:`/content?brand=${brand.brand}&connections=1`});
  return {checks,media:value(3)??null,state:saved,routine:listRoutines().find(r=>r.id===saved.routineId)??null,timezone:Intl.DateTimeFormat().resolvedOptions().timeZone};
}
export const setupRouter = Router();
setupRouter.use((req,res,next)=>{
  if(!trustedWebSocketOrigin(req) || (req.method!=='GET' && (!req.headers.origin || req.headers['sec-fetch-site']!=='same-origin'))) {res.status(403).json({error:'Use Start here in TARDIS.'});return;}
  res.setHeader('Cache-Control','no-store'); next();
});
setupRouter.get('/status',async(_req,res)=>{try{res.json(await readiness());}catch{res.status(500).json({error:'Could not load setup. Your saved progress has been preserved.'});}});
setupRouter.get('/launch',async(_req,res)=>{res.redirect((await state()).completedAt?'/':'/setup');});
setupRouter.post('/complete',async(_req,res)=>{try{await change(()=>({completedAt:new Date().toISOString()}));res.json({ok:true});}catch{res.status(500).json({error:'Could not save your preference.'});}});
setupRouter.get('/diagnostics',async(_req,res)=>{
  try {
    const data=await readiness();
    // Deliberate allowlist: never include logs, env, account names, paths, prompts or drafts.
    res.setHeader('Content-Disposition','attachment; filename="tardis-help.json"');
    res.json({generatedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,node:process.version,checks:data.checks.map(({id,ready})=>({id,ready})),media:{images:!!data.media?.imagesEnabled,videos:!!data.media?.videosEnabled}});
  }catch{res.status(500).json({error:'Could not generate the report.'});}
});
let verifying=false;
setupRouter.post('/verify',async(req,res)=>{
  if(verifying){res.status(409).json({error:'A subscription check is already running.'});return;}
  try {
    const engine=engineOf(req.body?.engine); verifying=true;
    await change(old=>({verified:{...old.verified,[engine]:undefined}}));
    const result=await completeSubscription({model:engine,messages:[{role:'user',content:'Reply with exactly READY.'}],max_tokens:32},AbortSignal.timeout(90000));
    if(!result.content?.includes('READY'))throw new Error('No verification response');
    await change(old=>({engine,verified:{...old.verified,[engine]:new Date().toISOString()}}));
    res.json({ok:true});
  }catch{res.status(400).json({error:'Subscription check failed. Finish sign-in, check subscription access, then try again.'});}finally{verifying=false;}
});
let starting=false;
setupRouter.post('/walkthrough',async(req,res)=>{
  if(starting){res.status(409).json({error:'Your first drafts are already being started.'});return;}
  starting=true;
  try {
    const brand=brandOf(req.body?.brand), engine=engineOf(req.body?.engine);
    const ideaId=typeof req.body?.ideaId==='string'&&/^[a-f0-9-]{36}$/.test(req.body.ideaId)?req.body.ideaId:undefined;
    const brief=typeof req.body?.brief==='string'?req.body.brief.trim():'';
    if(!ideaId&&(brief.length<5||brief.length>12000))throw new Error('Choose a research idea or enter a short brief.');
    const old=await state();
    if(old.walkthrough?.jobIds.length && !req.body?.replace) {res.status(409).json({error:'Continue your existing walkthrough or explicitly start another.'});return;}
    const pending=old.pendingWalkthrough;
    const reuse=pending&&pending.brand===brand&&pending.engine===engine&&pending.brief===brief&&pending.ideaId===ideaId;
    const walk=reuse?pending!:{requestId:randomUUID(),brand,engine,brief,ideaId,jobIds:[],bootId:await bootId(),startedAt:new Date().toISOString()};
    // Keep the previous walkthrough visible until acceptance. Manual requests reuse
    // p_request; headless_generate_idea deduplicates by original idea + format in SQL.
    await change(()=>({pendingWalkthrough:walk}));
    const result=await contentEngineRequest(ideaId?`/ideas/${ideaId}/generate`:'/generate','POST',ideaId?{kinds:['blog','social-pack'],engine}:{brand,engine,brief,kinds:['blog','social-pack'],requestId:walk.requestId}) as {jobs:Array<{id:string}>};
    await change(()=>({walkthrough:{...walk,jobIds:result.jobs.map(j=>j.id)},pendingWalkthrough:undefined})); res.json({ok:true});
  }catch{res.status(400).json({error:'Could not start the walkthrough. Check your writer and content connection, then retry the same brief.'});}finally{starting=false;}
});
setupRouter.get('/walkthrough',async(_req,res)=>{
  try {
    const walk=(await state()).walkthrough;
    if(!walk){res.json({walkthrough:null});return;}
    const [jobs,drafts]=await Promise.all([engineData(`/jobs?brand=${walk.brand}`),engineData(`/drafts?brand=${walk.brand}`)]);
    const tracked=jobs.jobs.filter((j:any)=>walk.jobIds.includes(j.id));
    const ids=new Set(tracked.map((j:any)=>j.draft_id));
    res.json({walkthrough:walk,jobs:tracked,drafts:drafts.drafts.filter((d:any)=>ids.has(d.id)),restarted:walk.bootId!==await bootId()});
  }catch{res.status(502).json({error:'Cannot check walkthrough drafts yet. Check the content engine and refresh.'});}
});
setupRouter.post('/routine',async(req,res)=>{
  try {
    if(typeof req.body?.enabled!=='boolean')throw new Error('Choose whether to enable drafting.');
    const at=String(req.body?.time??'09:00'); if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(at))throw new Error('Choose a valid time.');
    // Serialized with the setup record so double clicks cannot create duplicate routines.
    await change(old=>{
      const saved=listRoutines().find(r=>r.id===old.routineId);
      if(saved){updateRoutine(saved.id,{paused:!req.body.enabled,schedule:`weekdays:${at}`});return {};}
      const agent=listAgents().find(a=>a.name==='Content Coordinator');
      if(!agent)throw new Error('Create the Content Coordinator first.');
      const routine=createRoutine({name:'Morning content drafts',agentId:agent.id,schedule:`weekdays:${at}`,paused:!req.body.enabled,prompt:'Read content_ideas for Operly and R-Link. For each brand choose at most ONE strong, sourced idea from the last seven days with no existing writing jobs. Use content_generate_idea with its original idea ID for a blog and social-pack. Respect existing jobs; never duplicate them. If research is stale or failed, report that instead of inventing sources or repeatedly starting scans. Review the writing against the brand guide and report which drafts need human review. Never approve, publish, send, buy media, or enable other schedules.'});
      if(!routine)throw new Error('Could not create routine.'); return {routineId:routine.id};
    }); res.json({ok:true});
  }catch{res.status(400).json({error:'Could not save the routine. Check the time and that Content Coordinator exists.'});}
});
