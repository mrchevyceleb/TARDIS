class DictationPCM extends AudioWorkletProcessor {
  constructor() {
    super();this.phase=0;this.sum=0;this.count=0;this.stopped=false;this.buffer=new Int16Array(32000);this.length=0;this.inflight=0;
    this.port.onmessage=event=>{if(event.data==='ack'){this.inflight=Math.max(0,this.inflight-1);if(this.length>=1600)this.flush();}if(event.data==='stop'){this.stopped=true;this.flush(true);this.port.postMessage({stopped:true});}};
  }
  flush(force=false){
    if(!this.length||(!force&&this.inflight>=2))return;
    const pcm=this.buffer.slice(0,this.length);this.length=0;this.inflight++;this.port.postMessage({pcm,rate:16000},[pcm.buffer]);
  }
  process(inputs) {
    if(this.stopped)return false;
    const input=inputs[0]?.[0];if(!input)return true;
    for(const value of input){this.sum+=value;this.count++;this.phase+=16000;
      let emitted=false;
      while(this.phase>=sampleRate){const average=Math.max(-1,Math.min(1,this.sum/this.count));this.buffer[this.length++]=average*(average<0?32768:32767);this.phase-=sampleRate;emitted=true;
        if(this.length>=1600)this.flush();
        if(this.length===this.buffer.length){this.stopped=true;this.flush(true);this.port.postMessage({interrupted:true});return false;}
      }
      if(emitted){this.sum=0;this.count=0;}
    }
    // At most two unacknowledged transfers plus a two-second safety buffer.
    // If the UI stops consuming audio, preserve the tail and stop explicitly.
    return true;
  }
}
registerProcessor('dictation-pcm',DictationPCM);
