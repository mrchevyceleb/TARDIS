import type { Appearance } from '../theme/themes';
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

/** A teammate's time-boxed lift of the overnight quiet window (/api/quiet-hours). */
export type QuietPass = { agentId: string; name: string; until: string; reason?: string; grantedBy: string; grantedAt?: string };
/** When each of the next 7 quiet windows ends (ISO), the one in force first. */
export function fetchQuietNightEnds() {
  return apiJson<{ nightEnds: string[] }>('/api/quiet-hours').then((overview) => overview.nightEnds);
}
/** Let a teammate work through quiet hours until `until` (an ISO instant). */
export function liftQuietHours(agentId: string, until: string, reason?: string) {
  return apiJson<{ pass: QuietPass }>(`/api/quiet-hours/passes/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify({ until, reason }) });
}
/** End a teammate's lift now; quiet hours hold them again. */
export function endQuietHoursLift(agentId: string) {
  return apiJson<{ ended: boolean }>(`/api/quiet-hours/passes/${encodeURIComponent(agentId)}`, { method: 'DELETE' });
}

/** A T3 Code session an agent has running (GET /api/t3-sessions). */
export type T3SessionView = { id: string; host: string; threadId: string; ownerId: string; title: string; link?: string; state: string; runningSince: number };
export function fetchT3Sessions(signal?: AbortSignal) {
  return apiJson<{ configured: boolean; now: number; sessions: T3SessionView[] }>('/api/t3-sessions', { signal, cache: 'no-store' });
}

/** A pull request T3 linked to a session; `state` is open, merged or closed. */
export type T3PullRequest = { repo: string; number: number; url: string; state: string };
/** working: a run is going. waiting: a run is blocked on its owner. finished: no run is going. */
export type T3SessionPhase = 'working' | 'waiting' | 'finished';
/** One session on the Sessions tab (GET /api/t3-sessions/all). `since` is when it entered its phase. */
export type T3SessionRow = {
  id: string; host: string; threadId: string; ownerId: string; title: string; link?: string;
  phase: T3SessionPhase; status: string; since: number;
  model?: string; pullRequests?: T3PullRequest[];
};
/** `reachable` turns false once a look fails; no `seenAt` means the host has not been read yet. */
export type T3HostStatus = { name: string; reachable: boolean; seenAt?: number };
export function fetchAllT3Sessions(signal?: AbortSignal) {
  return apiJson<{ configured: boolean; now: number; hosts: T3HostStatus[]; sessions: T3SessionRow[] }>('/api/t3-sessions/all', { signal, cache: 'no-store' });
}

export type LinkedComputer = {
  id: string; name: string; platform: string;
  computer?: { supported: boolean; reason?: string; approvalMode?: 'ask' | 'automatic'; paused?: boolean; pausedAt?: number; pausedReason?: string; control: { owner: string; label: string; purpose: string; expiresAt: number } | null };
};
export type DefaultComputer = { id: string; name: string; online: boolean };
export type ComputerPreview = { image: string; width: number; height: number; capturedAt: number; displayId: string };
export function fetchComputers(chatId: string, signal?: AbortSignal, repo?: string) {
  const query = repo ? `chatId=${encodeURIComponent(chatId)}&repo=${encodeURIComponent(repo)}` : `chatId=${encodeURIComponent(chatId)}`;
  return apiJson<{ devices: LinkedComputer[]; target: string; defaultDevice: DefaultComputer | null }>(`/api/devices?${query}`, { signal, cache: 'no-store' });
}
export function selectComputer(chatId: string, device: string, repo?: string) {
  return apiJson<{ target: string }>('/api/devices/target', { method: 'PUT', body: JSON.stringify({ chatId, device, repo }) });
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

export type CliAccount = {
  id: string;
  engine: 'claude' | 'codex';
  email?: string;
  organization?: string;
  plan?: string;
  status: 'connected' | 'signed_out' | 'unavailable' | 'unsupported';
  checkedAt: number;
  profileIds: string[];
};
export type CliAccounts = {
  accounts: CliAccount[];
  engine: 'claude' | 'codex';
  selectedId: string | null;
  activeId: string | null;
  activeEngine: string | null;
  activeEmail: string | null;
  selectionNotice: string | null;
  busy: boolean;
};
export function fetchCliAccounts(options: { engine: 'claude' | 'codex'; agentId?: string; chatId?: string; repo?: string; refresh?: boolean }, signal?: AbortSignal): Promise<CliAccounts> {
  const query = new URLSearchParams({ engine: options.engine });
  for (const key of ['agentId', 'chatId', 'repo'] as const) if (options[key]) query.set(key, options[key]);
  if (options.refresh) query.set('refresh', '1');
  return apiJson<CliAccounts>(`/api/accounts?${query}`, { signal, cache: 'no-store' });
}

export type CliAccountAssignment = {
  agentId: string; engine: 'claude' | 'codex'; email: string | null;
  selectedEmail: string | null; busy: boolean; status: CliAccount['status'];
};
export function fetchCliAccountAssignments(signal?: AbortSignal): Promise<{ assignments: CliAccountAssignment[] }> {
  return apiJson('/api/accounts/agents', { signal, cache: 'no-store' });
}

export type CliLogin = {
  id: string; engine: 'claude' | 'codex';
  status: 'starting' | 'waiting' | 'checking' | 'connected' | 'failed' | 'cancelled';
  expiresAt: number; url?: string; userCode?: string; accountId?: string; email?: string; message?: string;
};
export async function selectCliAccount(engine: string, agentId: string, accountId: string): Promise<{ ok: boolean; accountId: string }> {
  const response = await fetch('/api/accounts/select', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, agentId, accountId }),
  });
  const data = await response.json().catch(() => null) as { ok?: boolean; accountId?: string; error?: string } | null;
  if (!response.ok) throw new Error(data?.error || `${response.status} ${response.statusText}`);
  if (data?.ok !== true || data.accountId !== accountId) throw new Error('TARDIS did not confirm the selected account.');
  return data as { ok: boolean; accountId: string };
}
export function startCliSignIn(engine: string): Promise<CliLogin> {
  return apiJson('/api/accounts/logins', { method: 'POST', body: JSON.stringify({ engine }) });
}
export function fetchCliSignIn(id: string): Promise<CliLogin> {
  return apiJson(`/api/accounts/logins/${encodeURIComponent(id)}`, { cache: 'no-store' });
}
export function submitCliSignInCode(id: string, code: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/accounts/logins/${encodeURIComponent(id)}/code`, { method: 'POST', body: JSON.stringify({ code }) });
}
export function cancelCliSignIn(id: string): Promise<{ ok: boolean }> {
  return apiJson(`/api/accounts/logins/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

/** Mirrors the streaming route's cap. */
export const BIG_UPLOAD_MAX_BYTES = 16 * 1024 * 1024 * 1024;

/** Human-readable size for upload lines ("2.1 GB"). */
export function humanFileSize(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export type BigUpload = { path: string; name: string; bytes: number };

/** Stream any file (any type, multi-GB) to the server's
 *  ~/.rivendell/uploads store. XHR, not fetch, so the caller gets real
 *  upload progress. The response carries the saved absolute path so it can
 *  go into the message and any agent can open the file. `register` hands
 *  back an abort for an in-flight chip's remove button. */
export function uploadBigFile(
  file: File,
  opts: { onProgress?: (fraction: number) => void; register?: (abort: () => void) => void } = {},
): Promise<BigUpload> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/files/upload-stream?name=${encodeURIComponent(file.name)}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && opts.onProgress) opts.onProgress(e.loaded / e.total);
    };
    opts.register?.(() => xhr.abort());
    xhr.onerror = () => reject(new Error('the upload failed (network)'));
    xhr.onabort = () => reject(new Error('the upload was cancelled'));
    xhr.onload = () => {
      if (xhr.status === 201) {
        try {
          resolve(JSON.parse(xhr.responseText) as BigUpload);
          return;
        } catch {
          /* fall through to the error path */
        }
      }
      let message = `${xhr.status} ${xhr.statusText}`;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: string }).error ?? message;
      } catch {
        /* plain text */
      }
      reject(new Error(message || 'the upload failed'));
    };
    xhr.send(file);
  });
}

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

/** Per-deployment surfaces the server chooses to expose. Read once at boot;
 *  a failed probe leaves everything on so a health blip cannot blank the UI. */
export async function fetchDeploymentFlags(): Promise<{ contentRoom: boolean; deskRoom: boolean; t3Sessions: boolean }> {
  const fallback = { contentRoom: true, deskRoom: true, t3Sessions: true };
  try {
    const response = await fetch('/api/health');
    if (!response.ok) return fallback;
    const data = await response.json() as { contentRoom?: boolean; deskRoom?: boolean; t3Sessions?: boolean };
    return { contentRoom: data.contentRoom !== false, deskRoom: data.deskRoom !== false, t3Sessions: data.t3Sessions !== false };
  } catch {
    return fallback;
  }
}

// Matt's Priorities: one ordered board per enabled agent (/api/priorities).
export type PriorityItem = { id: string; text: string; done: boolean; createdAt: number; updatedAt: number; by: string };
export type PriorityBoard = { agentId: string; name: string; items: PriorityItem[] };
export type PriorityAction =
  | { action: 'add'; text: string }
  | { action: 'update'; id: string; text?: string; done?: boolean }
  | { action: 'remove'; id: string }
  | { action: 'move'; id: string; direction: 'up' | 'down' }
  | { action: 'clear-done' };

export function fetchPriorityBoards(): Promise<{ boards: PriorityBoard[] }> {
  return apiJson('/api/priorities');
}

export function priorityAction(agent: string, { action, ...body }: PriorityAction): Promise<{ items: PriorityItem[] }> {
  return apiJson(`/api/priorities/${action}`, { method: 'POST', body: JSON.stringify({ agent, ...body }) });
}

/** Native engine measurements, also available as an HTML nightly report. */
export async function getSessionHealth(date?: string): Promise<{ date: string; rows: Array<{ lane: string; engine: string; calls: number; starts: number[]; compacts: Array<{ before: number; after: number; trigger: string }>; replacements: number; cachedShare: number | null; maxHarnessChars: number; fixedPrefixes: number }> }> {
  const response = await fetch(`/api/session-health${date ? `?date=${encodeURIComponent(date)}` : ""}`);
  if (!response.ok) throw new Error("Session measurements could not be loaded.");
  return response.json();
}

// Appearance follows the shared office, with the browser cache as an offline fallback.
export function fetchAppearance() {
  return apiJson<{ appearance: Partial<Appearance> | null }>('/api/appearance', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
}
export async function saveAppearance(patch: Partial<Appearance>): Promise<{ appearance: Partial<Appearance> }> {
  const response = await fetch('/api/appearance', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ patch }), signal: AbortSignal.timeout(8000) });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || 'Could not save appearance.'), { status: response.status });
  if (!data?.appearance) throw new Error('The saved appearance response was incomplete.');
  return data;
}

// Rooms Matt made or kept (built-in rooms ship with the web app).
export type SavedRoom = { id: string; name: string; blurb: string; prompt?: string; look: Record<string, unknown> };
async function roomCall<T>(path: string, init: RequestInit, timeout = 10_000, cancel?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(timeout);
  const signal = cancel && typeof AbortSignal.any === 'function' ? AbortSignal.any([deadline, cancel]) : cancel ?? deadline;
  const response = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json' }, signal });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw Object.assign(new Error(data?.error || 'The room library is unavailable.'), { status: response.status });
  return data as T;
}
export const fetchRooms = () => roomCall<{ rooms: SavedRoom[] }>('/api/rooms', { cache: 'no-store' });
export const saveRoom = (room: Omit<SavedRoom, 'id'>) => roomCall<{ room: SavedRoom }>('/api/rooms', { method: 'POST', body: JSON.stringify({ room }) });
export const deleteRoom = (id: string) => roomCall<{ deleted: boolean }>(`/api/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' });
/** Ask the designer for a room. With `base`, the words tweak that room instead. */
export const imagineRoom = (prompt: string, base: { name: string; prompt?: string; look: Record<string, unknown> } | undefined, cancel: AbortSignal) =>
  roomCall<{ room: SavedRoom }>('/api/rooms/imagine', { method: 'POST', body: JSON.stringify({ prompt, base }) }, 80_000, cancel);
