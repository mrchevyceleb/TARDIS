import { useState } from 'react';
import { Bookmark, ChevronDown, Globe2, Heart, Image, MessageCircle, MoreHorizontal, Repeat2, Send, Sparkles, ThumbsUp, Monitor, Smartphone } from 'lucide-react';
import { CONTENT_BRANDS, CONTENT_CHANNELS, type ContentBrand, type ContentPost, type ContentChannel, type ContentImage } from '../data/content';
import './content-studio.css';

const networkNames = ['linkedin','instagram','facebook','x'];
const limits: Record<string,number> = {linkedin:3000,instagram:2200,facebook:63206,x:280};
const publicImage = (image?:ContentImage) => image?.status==='ok' && /^https:\/\//.test(image.url) ? image.url : undefined;

export function ContentSocialStudio({brand,posts,disabled,onChange,onRevise,renderImageEditor}:{
  brand:ContentBrand;posts:ContentPost[];disabled:boolean;
  onChange:(posts:ContentPost[])=>void;onRevise:(index:number)=>void;
  renderImageEditor:(post:ContentPost,index:number)=>React.ReactNode;
}) {
  const [network,setNetwork]=useState(posts[0]?.platform??'linkedin');
  const [variant,setVariant]=useState(0),[device,setDevice]=useState<'phone'|'desktop'>('phone'),[expanded,setExpanded]=useState(false);
  const platforms=networkNames.filter(p=>posts.some(post=>post.platform===p));
  const platform=platforms.includes(network)?network:platforms[0];
  const matches=posts.map((post,index)=>({post,index})).filter(p=>p.post.platform===platform);
  const selected=matches[Math.min(variant,matches.length-1)];
  if(!selected)return <p>No social posts in this draft.</p>;
  const {post,index}=selected;
  const name=CONTENT_BRANDS[brand],channel=CONTENT_CHANNELS[platform as ContentChannel]??platform;
  const image=publicImage(post.image),max=limits[platform]??3000;
  const long=post.text.length>280,shown=expanded||!long?post.text:post.text.slice(0,280).trimEnd();
  const initials=brand==='operly'?'o.':'r.';
  const text=<div className="social-post-copy"><p>{shown}{!expanded&&long?'…':''}</p>{long&&<button className="social-expand" onClick={()=>setExpanded(!expanded)}>{expanded?'Show less':'…see more'}</button>}</div>;
  const artwork=image?<img className="social-post-image" src={image} alt={post.image?.alt??''} referrerPolicy="no-referrer"/>:<div className="social-art-empty"><Image size={28}/><strong>{platform==='instagram'?'An image belongs here':'Your post, as text'}</strong><span>{platform==='instagram'?'Add an image before scheduling.':'Add artwork in the editor if this post needs it.'}</span></div>;
  return <div className="social-studio">
    <header className="studio-heading"><div><span className="content-eyebrow">SOCIAL STUDIO</span><h2>See it in the feed.</h2><p>Fine-tune each post. Your changes save automatically.</p></div><span className="studio-count">{posts.length} posts</span></header>
    <nav className="social-networks" aria-label="Social network">{platforms.map(p=><button key={p} aria-pressed={platform===p} onClick={()=>{setNetwork(p);setVariant(0);setExpanded(false);}}><span className={`network-mark ${p}`} aria-hidden="true">{p==='linkedin'?'in':p==='instagram'?'◎':p==='facebook'?'f':'𝕏'}</span>{CONTENT_CHANNELS[p as ContentChannel]}<small>{posts.filter(post=>post.platform===p).length}</small></button>)}</nav>
    <div className="social-studio-grid">
      <section className="social-preview-stage" aria-label={`${channel} post preview`}>
        <div className="studio-preview-toolbar"><span><i/> Draft preview</span><div className="studio-device-switch"><button aria-label="Phone preview" aria-pressed={device==='phone'} onClick={()=>setDevice('phone')}><Smartphone size={15}/></button><button aria-label="Desktop preview" aria-pressed={device==='desktop'} onClick={()=>setDevice('desktop')}><Monitor size={15}/></button></div></div>
        <div className={`social-preview-width ${device}`}>
          <div className={`social-network-chrome ${platform}`}><span>{platform==='instagram'?'Instagram':platform==='facebook'?'facebook':platform==='linkedin'?'LinkedIn':'𝕏'}</span><span aria-hidden="true"><MoreHorizontal size={20}/></span></div>
          <article className={`social-native-post ${platform}`}>
            <header className="social-post-author"><div className={`social-avatar ${brand}`}>{initials}</div><div><strong>{name}</strong><span>{platform==='x'?`@${brand.replace('-','')}`:platform==='instagram'?'Original post':'Brand page'} {platform!=='instagram'&&<Globe2 size={10}/>}</span></div><MoreHorizontal size={19} aria-hidden="true"/></header>
            {platform==='instagram'?<>{artwork}<div className="social-instagram-actions" aria-hidden="true"><Heart/><MessageCircle/><Send/><Bookmark/></div>{text}</>:<>{text}{image&&artwork}</>}
            {platform!=='instagram'&&<div className="social-native-actions" aria-hidden="true">{platform==='x'?<><MessageCircle/><Repeat2/><Heart/><Bookmark/><Send/></>:<><span><ThumbsUp/> {platform==='linkedin'?'Like':'Like'}</span><span><MessageCircle/> Comment</span><span><Repeat2/> {platform==='linkedin'?'Repost':'Share'}</span></>}</div>}
          </article>
        </div>
        <p className="studio-preview-note">Layout preview · your connected account is used when scheduling.</p>
      </section>
      <section className="social-editor-panel" aria-label="Post editor">
        <div className="social-editor-title"><div><span className="content-eyebrow">{channel.toUpperCase()}</span><h3>Make every word count.</h3></div><span>{Math.min(variant+1,matches.length)} / {matches.length}</span></div>
        {matches.length>1&&<div className="social-variants" aria-label="Post variant">{matches.map((entry,i)=><button key={entry.index} aria-pressed={selected.index===entry.index} onClick={()=>{setVariant(i);setExpanded(false);}}>Post {i+1}</button>)}</div>}
        <label className="content-field">Post copy<textarea aria-label={`${channel} post copy`} value={post.text} rows={9} disabled={disabled} onChange={e=>onChange(posts.map((p,i)=>i===index?{...p,text:e.target.value}:p))}/></label>
        <div className={`social-copy-count ${post.text.length>max?'over-limit':''}`}><span>{post.text.length>max?'Shorten this before scheduling.':'Line breaks appear in your post.'}</span><span>{post.text.length.toLocaleString()} / {max.toLocaleString()}</span></div>
        <button className="content-button studio-revise" disabled={disabled} onClick={()=>onRevise(index)}><Sparkles size={16}/> Ask for a change to this post</button>
        <div className="social-art-editor"><h4><Image size={16}/> Artwork</h4>{renderImageEditor(post,index)}</div>
        {post.visual_note&&<details className="social-visual-note"><summary>Creative direction <ChevronDown size={14}/></summary><p>{post.visual_note}</p></details>}
      </section>
    </div>
  </div>;
}
