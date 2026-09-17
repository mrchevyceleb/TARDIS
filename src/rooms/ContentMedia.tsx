import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { contentRequest, uploadWorkspaceFile } from '../data/api';

export function ContentMedia() {
  const cache=useQueryClient();
  const query=useQuery({queryKey:['content','media'],queryFn:()=>contentRequest<{imagesEnabled:boolean;videosEnabled:boolean}>('/media/settings'),retry:false});
  const [google,setGoogle]=useState(''),[fal,setFal]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const save=async(kind:'images'|'videos',enabled:boolean)=>{
    setBusy(true);setError('');setNotice('');
    try {
      await contentRequest('/media/settings','PUT',kind==='images'?{imagesEnabled:enabled,...(google.trim()?{googleApiKey:google.trim()}:{})}:{videosEnabled:enabled,...(fal.trim()?{falApiKey:fal.trim()}:{})});
      setGoogle('');setFal(''); await cache.invalidateQueries({queryKey:['content','media']}); setNotice('Media settings saved. New jobs use these settings.');
    }catch(e){setError(e instanceof Error?e.message:'Could not save media settings.');}finally{setBusy(false);}
  };
  const upload=async(file?:File)=>{
    if(!file)return;
    if(file.size>200*1024*1024){setError('Choose a clip smaller than 200 MB. Keep larger originals in your workspace.');return;}
    setBusy(true);setError('');setNotice('');
    try {
      const name=file.name.replace(/[^a-zA-Z0-9._-]/g,'_').slice(-100)||'footage';
      const path=`resources/content-media/footage/${crypto.randomUUID()}-${name}`;
      const result=await uploadWorkspaceFile(path,file);
      setNotice(`Footage saved as ${result.path}. Ask Video Editor to edit this file; the original is preserved.`);
    }catch(e){setError(e instanceof Error?e.message:'Could not save footage.');}finally{setBusy(false);}
  };
  return <div className="setup-media">
    <p>Start with your own images and footage. In a draft, choose <strong>Add an image</strong> and upload or drop a JPEG, PNG or WebP. Images are stored at a public link for publishing; upload only media intended for public use.</p>
    <label className="content-field">Add original video footage (up to 200 MB)<input type="file" accept="video/*" disabled={busy} onChange={e=>{void upload(e.target.files?.[0]);e.target.value='';}}/></label>
    <p className="content-hint">Video Editor can work with footage using FFmpeg. Your AMD’s preinstalled generation apps are separate; this setup does not automatically connect them.</p>
    <details><summary>Optional paid image and video generation</summary>
      <p>These providers bill separately from your AI subscriptions. Saving a key does not generate anything. Enabling images adds generated artwork to new content jobs. Generated video uses the existing RallyPoint video workflow; the TARDIS Content desk currently creates blog and social drafts.</p>
      {query.isPending?<p>Checking media settings…</p>:query.error?<p role="alert">Media settings are unavailable. Check the content engine.</p>:<>
        <label className="content-field">Google AI Studio key<input type="password" autoComplete="new-password" value={google} onChange={e=>setGoogle(e.target.value)} placeholder="Leave blank to keep an existing key" disabled={busy}/></label>
        <p>Automatic images: <strong>{query.data?.imagesEnabled?'Enabled':'Off'}</strong></p>
        <div className="setup-actions"><button disabled={busy} onClick={()=>void save('images',true)}>Save and enable images</button><button disabled={busy} onClick={()=>void save('images',false)}>Turn images off</button></div>
        <label className="content-field">fal.ai key<input type="password" autoComplete="new-password" value={fal} onChange={e=>setFal(e.target.value)} placeholder="Leave blank to keep an existing key" disabled={busy}/></label>
        <p>Generated video provider: <strong>{query.data?.videosEnabled?'Enabled':'Off'}</strong></p>
        <div className="setup-actions"><button disabled={busy} onClick={()=>void save('videos',true)}>Save and enable video provider</button><button disabled={busy} onClick={()=>void save('videos',false)}>Turn video provider off</button></div>
      </>}
    </details>
    {busy&&<p role="status">Working…</p>}{error&&<p role="alert" className="setup-error">{error}</p>}{notice&&<p role="status">{notice}</p>}
  </div>;
}
