export type ContentEngine = 'claude' | 'codex' | 'xai';
export type ContentIdea = {
  id: string; brand: ContentBrand; headline: string; description: string; score: number | null;
  created_at: string; recommended_angle?: string; source: string;
  signals: Array<{ url: string; date?: string; engagement?: string }>;
  generation_jobs: Array<{ id: string; kind: string; status: string; draft_id?: string }>;
};
export type ContentBrand = 'operly' | 'r-link' | 'kim-garst';
export type ContentChannel = 'blog' | 'email' | 'video' | 'linkedin' | 'facebook' | 'instagram' | 'x' | 'threads' | 'bluesky' | 'google' | 'pinterest' | 'community' | 'youtube' | 'tiktok';
export type ContentImage = { slot: string; url: string; alt: string; prompt: string; aspect_ratio: '16:9' | '1:1' | '9:16' | '4:3' | '3:4'; status: 'ok' | 'failed' };
export type ContentPost = { platform: string; text: string; visual_note?: string; image?: ContentImage; [key: string]: unknown };
export function missingContentImages(draft: Pick<ContentDraft, 'kind' | 'payload' | 'body_markdown'>): boolean {
  const ready = (image?: ContentImage) => image?.status === 'ok' && /^https:\/\//.test(image.url);
  if (draft.kind === 'social-pack') return !draft.payload.posts?.length || draft.payload.posts.some(post => !ready(post.image));
  if (draft.kind === 'email') return !ready(draft.payload.image);
  if (draft.kind === 'blog') return !ready(draft.payload.featured_image) || ['inline-1','inline-2','inline-3'].some(slot => !draft.payload.inline_images?.some(image => image.slot === slot && ready(image) && draft.body_markdown.includes(`](${image.url})`)));
  return false;
}
export type ContentDraft = {
  id: string; idea_id?:string; brand: ContentBrand; kind: string; version: number; generation_version?:number; package_plan_id?:string|null; publish_channels?:string[]|null;publish_scheduled_at?:string|null; status: string;
  title: string | null; body_markdown: string; channels: string[];
  seo: { title: string; description: string; keyword: string } | null;
  payload: { posts?: ContentPost[]; featured_image?: ContentImage; image?: ContentImage; inline_images?: ContentImage[]; video_url?:string; beats?:Array<{beat:number;on_screen_text:string;visual_prompt:string;duration_seconds?:number;clip?:{status:'ok'|'failed';url?:string}}>; [key: string]: unknown };
  quality?: Record<string, unknown> | null; created_at: string; edited_at?: string | null;
  publications?: Array<{ channel: string; status: string; public_url?: string; provider_id?:string|null; detail?: string; scheduled_at?: string | null }>;
};
export type ContentJob = { id: string; brand: ContentBrand; kind: string; status: string; progress: number; phase: string; error?: string; idea_headline?: string };
export type ContentStatus = {
  engines: unknown;
  brands: Array<{ brand: ContentBrand; channels: Array<{ channel: string; status: string; detail?: string; schedulingSupported?: boolean }> }>;
};
export const CONTENT_BRANDS: Record<ContentBrand, string> = { operly: 'Operly', 'r-link': 'R-Link', 'kim-garst': 'Kim Garst' };
export const CONTENT_CHANNELS: Record<ContentChannel, string> = { blog: 'Blog', email:'Email',video:'Video',linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', x: 'X',threads:'Threads',bluesky:'Bluesky',google:'Google Business Profile',pinterest:'Pinterest',community:'GHL Community',youtube:'YouTube',tiktok:'TikTok' };
export const CONTENT_ENGINES: Record<ContentEngine, string> = { claude: 'Claude Code', codex: 'Codex', xai: 'Grok' };

export const CONTENT_VIDEO_CHANNELS = ['instagram','facebook','linkedin','youtube','tiktok','threads','bluesky','pinterest','community','x'];
export const CONTENT_GHL_CHANNELS = ['facebook','instagram','linkedin','threads','bluesky','google','pinterest','youtube','tiktok','community'];
