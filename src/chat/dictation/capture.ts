import workletUrl from './pcm-worklet.js?url';

export function wav(pcm:Int16Array,rate:number):Blob {
 const bytes=new ArrayBuffer(44+pcm.length*2),view=new DataView(bytes);
 const label=(at:number,value:string)=>{for(let i=0;i<value.length;i++)view.setUint8(at+i,value.charCodeAt(i));};
 label(0,'RIFF');view.setUint32(4,36+pcm.length*2,true);label(8,'WAVE');label(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,rate,true);view.setUint32(28,rate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);label(36,'data');view.setUint32(40,pcm.length*2,true);
 for(let i=0;i<pcm.length;i++)view.setInt16(44+i*2,pcm[i],true);
 return new Blob([bytes],{type:'audio/wav'});
}
export async function capture(onSection:(audio:Blob)=>void,onInterrupted:()=>void) {
 if(!navigator.mediaDevices?.getUserMedia||!window.AudioContext)throw new Error('Microphone access needs HTTPS. Open your private TARDIS link.');
 const context=new AudioContext();
 let stream:MediaStream|undefined,node:AudioWorkletNode|undefined,stopping=false;
 try {
  await context.resume();
  stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}});
  await context.audioWorklet.addModule(workletUrl);
  node=new AudioWorkletNode(context,'dictation-pcm');
  const QUIET=393,FRAME=320,MIN_SPEECH_FRAMES=13;
  const samples=new Int16Array(16000*60);let length=0,quiet=0;
  //A section is judged by sustained speech, not single samples (Sam's retest,
  //Oct 17): whisper invents a phrase for a silent stretch ("Thank you.") and
  //a completed dictation auto-sends it, and a single 4ms click kept a whole
  //silent stretch alive when the trim walked sample by sample. ~20ms frames:
  //trailing quiet frames trim, and a section with under ~250ms of frames
  //above the quiet level — room noise, one click — never reaches the model,
  //so the "No speech heard" path stays reachable.
  const above=(from:number)=>{for(let i=from;i<from+FRAME;i++)if(Math.abs(samples[i])>=QUIET)return true;return false;};
  const flush=()=>{
    let end=Math.floor(length/FRAME)*FRAME;
    while(end>=FRAME&&!above(end-FRAME))end-=FRAME;
    let speech=0;for(let i=0;i<end;i+=FRAME)if(above(i))speech++;
    if(speech>=MIN_SPEECH_FRAMES)onSection(wav(samples.slice(0,end),16000));
    length=0;quiet=0;
  };
  let stopped=()=>{};
  node.port.onmessage=({data})=>{
   if(data.pcm){for(const sample of data.pcm as Int16Array){samples[length++]=sample;quiet=Math.abs(sample)<QUIET?quiet+1:0;if(length===samples.length||(length>=16000*35&&quiet>16000*.4))flush();}node!.port.postMessage('ack');}
   if(data.interrupted&&!stopping)onInterrupted();
   if(data.stopped)stopped();
  };
  context.createMediaStreamSource(stream).connect(node);node.connect(context.destination);
  stream.getAudioTracks().forEach(track=>{track.onended=()=>{if(!stopping)onInterrupted();};});
  context.onstatechange=()=>{if(!stopping&&context.state!=='running')onInterrupted();};
  return {stop:async()=>{
   if(stopping)return;stopping=true;
   await new Promise<void>(resolve=>{const timeout=setTimeout(resolve,1500);stopped=()=>{clearTimeout(timeout);resolve();};node!.port.postMessage('stop');});
   stream!.getTracks().forEach(track=>track.stop());node!.disconnect();
   try{if(context.state!=='closed')await context.close();}finally{node!.port.close();flush();}
  }};
 } catch(error){stream?.getTracks().forEach(track=>track.stop());await context.close();throw error;}
}
