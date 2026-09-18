import { useEffect,useRef,useState } from 'react';
import { Mic,Square,LoaderCircle } from 'lucide-react';

export function ContentDictation({onText,disabled=false}:{onText:(text:string)=>void;disabled?:boolean}){
  const [state,setState]=useState<'idle'|'starting'|'recording'|'transcribing'>('idle');const [error,setError]=useState('');
  const recorder=useRef<MediaRecorder|null>(null),stream=useRef<MediaStream|null>(null),timer=useRef<ReturnType<typeof setTimeout>|null>(null),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;if(timer.current)clearTimeout(timer.current);if(recorder.current?.state==='recording')recorder.current.stop();stream.current?.getTracks().forEach(t=>t.stop());};},[]);
  const start=async()=>{
    setError('');setState('starting');
    try{
      if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder)throw new Error('Microphone recording is unavailable in this browser. Type your change below.');
      const available=await fetch('/api/content/dictation').then(r=>r.json());if(!available.available)throw new Error('Local dictation needs setup. You can type your change below.');
      const input=await navigator.mediaDevices.getUserMedia({audio:true});if(!alive.current){input.getTracks().forEach(t=>t.stop());return;}
      stream.current=input;const chunks:Blob[]=[];const r=new MediaRecorder(input);recorder.current=r;
      r.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};
      r.onstop=async()=>{
        if(timer.current)clearTimeout(timer.current);input.getTracks().forEach(t=>t.stop());recorder.current=null;if(!alive.current)return;
        setState('transcribing');
        try{const res=await fetch('/api/content/dictation',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:new Blob(chunks,{type:r.mimeType})});const data=await res.json();if(!res.ok)throw new Error(data.error);if(alive.current){if(!data.text)throw new Error('No speech heard. Try again.');onText(data.text);}}
        catch(e){if(alive.current)setError((e as Error).message);}finally{if(alive.current)setState('idle');}
      };
      r.start();setState('recording');timer.current=setTimeout(()=>{if(r.state==='recording')r.stop();},120000);
    }catch(e){stream.current?.getTracks().forEach(t=>t.stop());setError((e as Error).message);setState('idle');}
  };
  return <div><button type="button" className={`content-button ${state==='recording'?'recording':''}`} disabled={disabled||state==='transcribing'||state==='starting'} onClick={()=>state==='recording'?recorder.current?.stop():void start()}>{state==='recording'?<Square size={16}/>:state==='transcribing'?<LoaderCircle className="content-spin" size={16}/>:<Mic size={16}/>} {state==='recording'?'Stop recording':state==='transcribing'?'Transcribing…':'Dictate a change'}</button>{state==='recording'&&<small role="status">Listening · up to two minutes</small>}{error&&<p className="content-notice error" role="alert">{error}</p>}</div>;
}
