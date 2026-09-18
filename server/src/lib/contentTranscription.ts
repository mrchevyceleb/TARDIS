import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

let active=false;
export function transcriptionReady(){return Boolean(process.env.CONTENT_TRANSCRIBE_PYTHON);}
export async function transcribeContent(bytes:Buffer){
  const python=process.env.CONTENT_TRANSCRIBE_PYTHON;
  if(!python)throw Object.assign(new Error('Local dictation needs setup on this computer. You can still type your changes.'),{status:503});
  if(active)throw Object.assign(new Error('Another recording is being transcribed. Try again shortly.'),{status:409});
  active=true;let dir:string|undefined;
  try{
    dir=await mkdtemp(join(tmpdir(),'tardis-dictation-'));const file=join(dir,'recording.webm');await writeFile(file,bytes,{mode:0o600});
    const script=fileURLToPath(new URL('../../../scripts/content-transcribe.py',import.meta.url));
    const {stdout}=await promisify(execFile)(python,[script,file],{timeout:120000,maxBuffer:256000,windowsHide:true});
    const result=JSON.parse(stdout);if(typeof result.text!=='string'||result.text.length>10000)throw new Error('Invalid transcript');
    return {text:result.text};
  }finally{active=false;if(dir)await rm(dir,{recursive:true,force:true});}
}
