import { useRef, useState } from 'react';
import { ArrowUpRight, Film, Play, Sparkles } from 'lucide-react';
import type { ContentDraft } from '../data/content';
import './content-studio.css';

export function ContentVideoStudio({draft,disabled,onRevise}:{draft:ContentDraft;disabled:boolean;onRevise:(scene:number)=>void}) {
  const video=useRef<HTMLVideoElement>(null),[selected,setSelected]=useState(0),[time,setTime]=useState(0),[ready,setReady]=useState(false);
  const beats=draft.payload.beats??[];
  const playable=beats.filter(b=>b.clip?.status!=='failed');
  let offset=0;
  const scenes=beats.map(beat=>{const available=beat.clip?.status!=='failed';const start=offset;if(available)offset+=beat.duration_seconds??(Number(draft.payload.duration_seconds)||30)/Math.max(playable.length,1);return {...beat,start,available};});
  const url=typeof draft.payload.video_url==='string'&&draft.payload.video_url.startsWith('https://')?draft.payload.video_url:undefined;
  const seek=(index:number)=>{setSelected(index);if(video.current){video.current.currentTime=scenes[index].start;setTime(scenes[index].start);void video.current.play().catch(()=>{});}};
  const stamp=(s:number)=>`${Math.floor(s/60)}:${String(Math.floor(s%60)).padStart(2,'0')}`;
  return <div className="video-studio">
    <header className="studio-heading"><div><span className="content-eyebrow">VIDEO STUDIO</span><h2>Give the story its rhythm.</h2><p>Review the cut, jump between scenes, and ask for precise changes.</p></div><span className="studio-count">9:16 · {stamp(offset)}</span></header>
    <div className="video-studio-grid"><section className="video-preview-stage" aria-label="Video preview"><div className="studio-preview-toolbar"><span><i/> Current render</span>{url&&<a href={url} target="_blank" rel="noreferrer">Open video <ArrowUpRight size={14}/></a>}</div><div className="video-portrait">{url?<video ref={video} controls playsInline preload="metadata" src={url} onLoadedMetadata={()=>setReady(true)} onTimeUpdate={e=>{const t=e.currentTarget.currentTime;setTime(t);const index=scenes.findLastIndex(scene=>scene.available&&t>=scene.start);if(index>=0)setSelected(index);}}/>:<div className="video-unavailable"><Film/><p>The finished video will appear here.</p></div>}</div><p className="studio-preview-note">{stamp(time)} / {stamp(offset)} · Text on screen, B-roll & motion graphics</p></section>
    <section className="video-scene-panel" aria-label="Video scenes"><div className="social-editor-title"><div><span className="content-eyebrow">THE STORYBOARD</span><h3>One scene at a time.</h3></div><span>{scenes.length} scenes</span></div><p className="content-hint">Caption changes reuse the footage. New visual directions generate replacement clips.</p><div className="video-scene-list">{scenes.map((scene,index)=><article className={`video-scene ${selected===index?'selected':''}`} key={scene.beat}><button className="video-scene-seek" disabled={!ready||!url||!scene.available} aria-label={`Play scene ${scene.beat}`} aria-pressed={selected===index} onClick={()=>seek(index)}><span className="video-scene-number">{selected===index?<Play size={15}/>:String(scene.beat).padStart(2,'0')}</span><span><small>{stamp(scene.start)} · SCENE {scene.beat}</small><strong>{scene.on_screen_text}</strong>{!scene.available&&<small>Footage unavailable in this render</small>}</span></button><details><summary>Visual direction</summary><p>{scene.visual_prompt}</p></details><button className="video-scene-edit" disabled={disabled} onClick={()=>onRevise(scene.beat)}><Sparkles size={13}/> Edit this scene</button></article>)}</div></section></div>
  </div>;
}
