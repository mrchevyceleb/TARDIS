import type { FileTreeNode, WorkspaceEditFileResponse, WorkspaceSaveResponse } from './types';

export async function dictationChunk(id:string,audio:Blob,signal:AbortSignal):Promise<{text:string;warning?:string}> {
  const combined=AbortSignal.any([signal,AbortSignal.timeout(240_000)]);
  for(;;) {
    const response=await fetch('/api/dictation/chunks',{method:'POST',headers:{'Content-Type':'application/octet-stream','X-Dictation-Chunk':id},body:audio,signal:combined});
    const data=await response.json().catch(()=>null);
    if(response.ok)return data;
    if(response.status!==409&&response.status!==429)throw new Error(data?.error||'Transcription failed. Your recording is saved for retry.');
    if(response.status===409&&!/Another recording/.test(data?.error??''))throw new Error(data?.error||'Recording conflict.');
    await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(combined.reason);};const timer=setTimeout(()=>{combined.removeEventListener('abort',abort);resolve();},2000);combined.addEventListener('abort',abort,{once:true});if(combined.aborted)abort();});
  }
}

export function setupRequest<T>(path: string, body?: unknown): Promise<T> {
  return apiJson<T>(`/api/setup${path}`,body === undefined ? undefined : {method:'POST',body:JSON.stringify(body)});
}
export async function uploadContentImage(file: File): Promise<{url:string}> {
  if(file.size > 10*1024*1024)throw new Error('Choose an image smaller than 10 MB.');
  const response=await fetch('/api/content/media/upload',{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});
  const data=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(data?.error || 'Image upload failed.');
  return data;
}

export async function integrationRequest<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api/integrations${path}`, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Could not reach integrations.');
  return data as T;
}

export async function contentRequest<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (method === 'POST' && /\/(approve|publish|schedule|resume)$/.test(path)) {
    const intent = await contentRequest<{ token: string }>('/review-intent', 'POST', { path, version: (body as { version?: number } | undefined)?.version,...((path.endsWith('/schedule')||path.endsWith('/resume'))?{plan:body}:{}) }, signal);
    headers['X-Content-Review'] = intent.token;
  }
  const response = await fetch(`/api/content${path}`, {
    method, signal, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || 'Could not reach the content desk. Please try again.'),{status:response.status});
  return data as T;
}

export type LinkedComputer = {
  id: string; name: string; platform: string;
  computer?: { supported: boolean; reason?: string; approvalMode?: 'ask' | 'automatic'; paused?: boolean; control: { owner: string; label: string; purpose: string; expiresAt: number } | null };
};
export type DefaultComputer = { id: string; name: string; online: boolean };
export type ComputerPreview = { image: string; width: number; height: number; capturedAt: number; displayId: string };
export function fetchComputers(chatId: string, signal?: AbortSignal) {
  return apiJson<{ devices: LinkedComputer[]; target: string; defaultDevice: DefaultComputer | null }>(`/api/devices?chatId=${encodeURIComponent(chatId)}`, { signal, cache: 'no-store' });
}
export function selectComputer(chatId: string, device: string) {
  return apiJson<{ target: string }>('/api/devices/target', { method: 'PUT', body: JSON.stringify({ chatId, device }) });
}
export function stopComputer(device: string) {
  return apiJson<{ stopped: boolean }>(`/api/devices/${encodeURIComponent(device)}/computer/stop`, { method: 'POST' });
}
export function resumeComputer(device: string) {
  return apiJson<{ resumed: boolean }>(`/api/devices/${encodeURIComponent(device)}/computer/resume`, { method: 'POST' });
}
export function previewComputer(device: string, signal?: AbortSignal) {
  return apiJson<ComputerPreview>(`/api/devices/${encodeURIComponent(device)}/computer/preview`, { method: 'POST', signal, cache: 'no-store' });
}

// Linked robot bodies (robot companions dialled in with kind:'robot').
export type RobotStatus = {
  battery?: number; charging?: boolean; voice?: 'off' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'connecting';
  expression?: string; moving?: boolean; hardware?: string; sdk?: string; errors?: string[]; updatedAt: number;
};
export type LinkedRobot = { id: string; name: string; platform: string; version: string; capabilities?: string[]; robot?: RobotStatus };
export type RobotEvent = { seq: number; robot: string; robotName: string; name: string; data: Record<string, unknown>; ts: number };
export type RobotCommand = 'status' | 'say' | 'express' | 'eyes' | 'leds' | 'drive' | 'turn' | 'stop' | 'arms' | 'look' | 'sensors' | 'volume' | 'play' | 'sleep' | 'wake';
export function fetchRobots(signal?: AbortSignal) {
  return apiJson<{ robots: LinkedRobot[]; eventAgent: string | null; motionAllowed: boolean; latestEventSeq: number }>('/api/robots', { signal, cache: 'no-store' });
}
export function fetchRobotEvents(opts: { robot?: string; since?: number; limit?: number } = {}, signal?: AbortSignal) {
  const q = new URLSearchParams();
  if (opts.robot) q.set('robot', opts.robot);
  if (opts.since) q.set('since', String(opts.since));
  if (opts.limit) q.set('limit', String(opts.limit));
  return apiJson<{ events: RobotEvent[]; latestEventSeq: number }>(`/api/robots/events?${q}`, { signal, cache: 'no-store' });
}
export function robotCommand<T = Record<string, unknown>>(robot: string, command: RobotCommand, params: Record<string, unknown> = {}, signal?: AbortSignal) {
  return apiJson<T & { robot: string; robotName: string }>(`/api/robots/${command}`, { method: 'POST', body: JSON.stringify({ robot, ...params }), signal });
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `${response.status} ${response.statusText}`);
  }

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function fetchWorkspaceFileForEdit(path: string): Promise<WorkspaceEditFileResponse> {
  return apiJson<WorkspaceEditFileResponse>(`/api/docs/file/edit?path=${encodeURIComponent(path)}`);
}

export function saveWorkspaceFile(path: string, content: string, expectedModifiedAt?: string): Promise<WorkspaceSaveResponse> {
  return apiJson<WorkspaceSaveResponse>('/api/docs/file', {
    method: 'PUT',
    body: JSON.stringify({ path, content, expectedModifiedAt }),
  });
}

export function createWorkspaceEntry(path: string, kind: 'file' | 'directory'): Promise<{ node: FileTreeNode }> {
  return apiJson<{ node: FileTreeNode }>('/api/docs/file', {
    method: 'POST',
    body: JSON.stringify({ path, kind }),
  });
}

export function renameWorkspaceEntry(from: string, to: string): Promise<{ path: string }> {
  return apiJson<{ path: string }>('/api/docs/rename', {
    method: 'POST',
    body: JSON.stringify({ from, to }),
  });
}

export function deleteWorkspaceEntry(path: string): Promise<{ path: string }> {
  return apiJson<{ path: string }>(`/api/docs/file?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
}

export type WorkspaceUploadResponse = { path: string; size: number; modifiedAt: string };

/** Mirrors the server's upload cap. */
export const UPLOAD_MAX_BYTES = 200 * 1024 * 1024;

/** Send a file to the ship's workspace. The server keeps it under `path`,
 *  adding a numeric suffix rather than overwriting. */
export async function uploadWorkspaceFile(path: string, file: Blob): Promise<WorkspaceUploadResponse> {
  const response = await fetch(`/api/files/upload?path=${encodeURIComponent(path)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  if (!response.ok) {
    const text = await response.text();
    let message = text;
    try {
      message = (JSON.parse(text) as { error?: string }).error ?? text;
    } catch {
      /* plain text */
    }
    throw new Error(message || `${response.status} ${response.statusText}`);
  }
  return (await response.json()) as WorkspaceUploadResponse;
}
