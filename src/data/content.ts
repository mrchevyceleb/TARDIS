export type ContentEngine = 'claude' | 'codex' | 'xai';
export type ContentBrand = 'operly' | 'r-link';
export type ContentChannel = 'blog' | 'linkedin' | 'facebook' | 'instagram' | 'x';
export type ContentImage = { slot: string; url: string; alt: string; prompt: string; aspect_ratio: '16:9' | '1:1' | '9:16' | '4:3' | '3:4'; status: 'ok' | 'failed' };
export type ContentPost = { platform: string; text: string; visual_note?: string; image?: ContentImage; [key: string]: unknown };
export type ContentDraft = {
  id: string; brand: ContentBrand; kind: string; version: number; status: string;
  title: string | null; body_markdown: string; channels: string[];
  seo: { title: string; description: string; keyword: string } | null;
  payload: { posts?: ContentPost[]; featured_image?: ContentImage; [key: string]: unknown };
  quality?: Record<string, unknown> | null; created_at: string; edited_at?: string | null;
  publications?: Array<{ channel: string; status: string; public_url?: string; detail?: string; scheduled_at?: string | null }>;
};
export type ContentJob = { id: string; brand: ContentBrand; kind: string; status: string; progress: number; phase: string; error?: string; idea_headline?: string };
export type ContentStatus = {
  engines: unknown;
  brands: Array<{ brand: ContentBrand; channels: Array<{ channel: string; status: string; detail?: string; schedulingSupported?: boolean }> }>;
};
export const CONTENT_BRANDS: Record<ContentBrand, string> = { operly: 'Operly', 'r-link': 'R-Link' };
export const CONTENT_CHANNELS: Record<ContentChannel, string> = { blog: 'Blog', linkedin: 'LinkedIn', facebook: 'Facebook', instagram: 'Instagram', x: 'X' };
export const CONTENT_ENGINES: Record<ContentEngine, string> = { claude: 'Claude Code', codex: 'Codex', xai: 'Grok' };
