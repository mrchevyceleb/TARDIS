import { useEffect,useRef,useState } from 'react';
import { Mic,Square,LoaderCircle,X,RotateCcw } from 'lucide-react';
import { capture } from './capture';
import { loadRecording,saveRecording,loadSection,saveSection,finishSection,clearRecording,type Recording,type Section } from './store';
import { dictationChunk } from '../../data/api';
import './dictation.css';

type Phase='idle'|'starting'|'recording'|'finishing'|'recover'|'error';
export function ChatDictation({chatId,onText,onActive}:{chatId:string;onText:(text:string)=>void;onActive:(active:boolean)=>void}) {
 const [phase,setPhase]=useState<Phase>('starting'),[error,setError]=useState(''),[seconds,setSeconds]=useState(0),[processed,setProcessed]=useState(0),[notice,setNotice]=useState('');
 const alive=useRef(true),record=useRef<Recording|undefined>(undefined),microphone=useRef<Awaited<ReturnType<typeof capture>>|undefined>(undefined),saving=useRef(Promise.resolve()),working=useRef(false),processing=useRef(0),failure=useRef(false),stopping=useRef(false),unsaved=useRef<Section[]>([]),controller=useRef<AbortController|undefined>(undefined),stopped=useRef(Promise.resolve()),inserted=useRef(false);
 const callbacks=useRef({onText,onActive});callbacks.current={onText,onActive};
 const scope=useRef('');
 const update=(next:Phase)=>{if(alive.current){setPhase(next);callbacks.current.onActive(next!=='idle'&&next!=='recover');}};
 const report=(e:unknown,stopRecording=true)=>{failure.current=true;if(stopRecording)void stopCapture();if(alive.current){setError(e instanceof Error?e.message:'Dictation interrupted. Your recording is saved.');if(stopRecording||!microphone.current)update('error');}};
 const pump=async()=>{
  if(working.current||failure.current||!record.current||!alive.current)return;
  working.current=true;
  try {
   while(record.current&&processing.current<record.current.next&&!failure.current&&alive.current) {
    await saving.current;
    const section=await loadSection(record.current.id,processing.current);
    if(!section)throw new Error('A recording section could not be saved. Retry before closing this page.');
    if(section.text===undefined) {
     if(!section.audio)throw new Error('Recording section missing audio.');
     controller.current=new AbortController();
     const result=await dictationChunk(`${section.session}:${section.index}`,section.audio,controller.current.signal);
     await finishSection({session:section.session,index:section.index,...result});
     if(result.warning&&alive.current)setNotice(result.warning);
    }
    processing.current++;if(alive.current)setProcessed(processing.current);
   }
  } catch(e){if(alive.current)report(e,false);}
  finally{working.current=false;}
 };
 const enqueue=(audio:Blob)=>{
  const r=record.current;if(!r)return;
  const section:Section={session:r.id,index:r.next++,audio};unsaved.current.push(section);
  const snapshot={...r};
  saving.current=saving.current.then(async()=>{await saveSection(snapshot,section);unsaved.current=unsaved.current.filter(s=>s!==section);}).catch(e=>{report(e);void stopCapture();});
  void saving.current.then(pump);
 };
 const stopCapture=()=>{const mic=microphone.current;microphone.current=undefined;if(mic)stopped.current=mic.stop();return stopped.current;};
 const finish=async()=>{
  if(stopping.current)return;stopping.current=true;update('finishing');
  await stopCapture();await saving.current;await pump();
  while(working.current&&alive.current)await new Promise(resolve=>setTimeout(resolve,100));
  if(!alive.current){stopping.current=false;return;}
  if(failure.current){update('error');stopping.current=false;return;}
  try {
   const r=record.current;if(!r)return;
   const texts:string[]=[];
   for(let i=0;i<r.next;i++){const part=await loadSection(r.id,i);if(part?.text===undefined)throw new Error('A section is unfinished. Retry to keep your entire recording.');if(part.text.trim())texts.push(part.text.trim());}
   const text=texts.join('\n\n');
   if(!alive.current)return;
   if(text&&!inserted.current){callbacks.current.onText(text);inserted.current=true;}else if(!text)setNotice('No speech heard. Try again.');
   await clearRecording(r);record.current=undefined;update('idle');
  } catch(e){report(e);}finally{stopping.current=false;}
 };
 const retry=async()=>{failure.current=false;setError('');if(!record.current){update('idle');return;}try{for(const section of unsaved.current)await saveSection({...record.current},section);unsaved.current=[];if(microphone.current)await pump();else await finish();}catch(e){report(e);}};
 const discard=async()=>{failure.current=true;controller.current?.abort();await stopCapture();await saving.current;while(working.current)await new Promise(resolve=>setTimeout(resolve,100));if(record.current)await clearRecording(record.current);record.current=undefined;unsaved.current=[];setError('');setNotice('');update('idle');};
 const start=async()=>{
  update('starting');setError('');setNotice('');setSeconds(0);setProcessed(0);processing.current=0;failure.current=false;stopping.current=false;inserted.current=false;stopped.current=Promise.resolve();
  let pendingMic:ReturnType<typeof capture>|undefined;
  try {
   const r={scope:scope.current,id:crypto.randomUUID(),next:0,updatedAt:Date.now()};record.current=r;
   // Start AudioContext while still inside the user gesture (Safari/iPhone).
   pendingMic=capture(enqueue,()=>{if(alive.current){setNotice('Microphone paused or disconnected. The recorded portion is being kept.');void finish();}});
   void pendingMic.catch(()=>{});
   await saveRecording(r);const mic=await pendingMic;
   if(!alive.current){await mic.stop();return;}
   microphone.current=mic;update('recording');
  }catch(e){if(pendingMic)await pendingMic.then(mic=>mic.stop(),()=>{});report(e);}
 };
 useEffect(()=>{
  alive.current=true;let cancelled=false;
  const client=sessionStorage.getItem('rivendell:dictation-tab')||crypto.randomUUID();sessionStorage.setItem('rivendell:dictation-tab',client);scope.current=`${client}:${chatId}`;
  void loadRecording(scope.current).then(r=>{if(alive.current&&!cancelled){record.current=r;update(r?'recover':'idle');}}).catch(e=>{if(!cancelled)report(e);});
  return()=>{cancelled=true;alive.current=false;controller.current?.abort();void stopCapture();callbacks.current.onActive(false);};
 // Each instance belongs to exactly one conversation.
 // eslint-disable-next-line react-hooks/exhaustive-deps
 },[]);
 useEffect(()=>{if(phase!=='recording')return;const id=setInterval(()=>setSeconds(s=>s+1),1000);return()=>clearInterval(id);},[phase]);
 const recording=phase==='recording',busy=phase==='starting'||phase==='finishing';
 return <div className={`chat-dictation ${recording?'is-recording':''}`}>
  {phase==='idle'?<button type="button" className="dictation-button" onClick={()=>void start()} aria-label="Dictate a message" title="Record, clean up with AI, and insert into your message"><Mic size={17}/><span>Dictate</span></button>:<div className="dictation-panel" role="group" aria-label="Message dictation">
   <div className="dictation-status" role="status">{recording?<><span className="dictation-dot"/>Recording {Math.floor(seconds/60)}:{String(seconds%60).padStart(2,'0')}</>:busy?<><LoaderCircle size={16} className="dictation-spin"/>{phase==='starting'?'Opening microphone…':'Transcribing & cleaning up…'}</>:phase==='recover'?'Unfinished dictation saved on this device.':'Dictation needs attention.'}{processed>0&&<small>{processed} section{processed===1?'':'s'} ready</small>}</div>
   {recording&&<><small>Keep this page open. Stop when you’re done.</small><button type="button" className="dictation-button" onClick={()=>void finish()}><Square size={15}/>Stop & insert</button></>}
   {recording&&error&&<><small>Still recording. Speech is saved on this device while transcription waits.</small><button type="button" className="dictation-button" onClick={()=>void retry()}>Retry transcription</button></>}
   {(phase==='recover'||phase==='error')&&<button type="button" className="dictation-button" onClick={()=>void retry()}><RotateCcw size={15}/>{phase==='recover'?'Recover & insert':'Retry & insert'}</button>}
   {!busy&&<button type="button" className="dictation-discard" onClick={()=>void discard()} aria-label="Discard dictation"><X size={16}/></button>}
   {error&&<p role="alert">{error}</p>}
  </div>}
  {notice&&<small role="status" className="dictation-notice">{notice}</small>}
 </div>;
}
