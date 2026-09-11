// Execution belongs to the durable agent thread, never to the audio socket.
export const VOICE_WORK_TOOL = {
  type: 'function',
  name: 'run_in_thread',
  description: 'Use your real agent tools to carry out a request the user made or approved. Call this BEFORE saying you are looking something up or starting work. Include a self-contained request with all relevant details. The work continues in the same chat even if the call ends. Never use this for unrequested actions; external changes still require normal review/approval.',
  parameters: {
    type: 'object', properties: { request: { type: 'string', description: 'The user-approved task, including relevant details from this conversation.' } },
    required: ['request'], additionalProperties: false,
  },
};

type Result = { delivered: boolean; reply?: string; reason?: string; queued?: boolean };
type Dispatch = (text: string, opts: { wait: boolean; onQueued: () => void }) => Promise<Result>;

export class VoiceWork {
  private userItems = new Set<string>();
  private calls = new Map<string, Promise<Result>>();
  private requests = new Map<string, Promise<Result>>();
  private pending = new Map<string, string>();
  private admissions = new Set<Promise<void>>();
  private finishPromise?: Promise<Result | undefined>;
  constructor(private readonly dispatch: Dispatch) {}

  userItem(id: string): void { if (id) this.userItems.add(id); }

  run(callId: string, rawArguments: string): Promise<Result> {
    const existing = this.calls.get(callId);
    if (existing) return existing;
    let request: string;
    try {
      if (!this.userItems.size) throw new Error('Wait for a user request on this call; do not execute historical tasks.');
      const args = JSON.parse(rawArguments);
      if (typeof args?.request !== 'string' || !args.request.trim() || args.request.length > 3500) {
        throw new Error('Provide a nonempty, self-contained request of at most 3500 characters.');
      }
      request = args.request.trim().normalize('NFC').replace(/\r\n/g, '\n');
    } catch (error) {
      const rejected = Promise.resolve({ delivered: false, reason: (error as Error).message });
      this.calls.set(callId, rejected);
      return rejected;
    }
    // Regeneration can change the provider call ID. The same request within
    // one user utterance must still execute once. Preserve internal whitespace
    // because it can matter in code the user dictated.
    const key = `${this.userItems.size}\0${request}`;
    const repeated = this.requests.get(key);
    if (repeated) { this.calls.set(callId, repeated); return repeated; }
    // Only an explicit, validated function request is a pending action. Never
    // launch an agent to classify ordinary conversation on hangup.
    this.pending.set(key, request);
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => { release = resolve; });
    this.admissions.add(admitted);
    const queued = () => { this.pending.delete(key); release(); };
    const job = Promise.resolve().then(async () => {
      // No AbortSignal from the WebSocket. Ending audio never cancels this job.
      const result = await this.dispatch(request, { wait: true, onQueued: queued });
      if (result.delivered) queued();
      return result;
    }).catch((error: Error) => ({ delivered: false, reason: error.message }))
      .finally(() => { release(); this.admissions.delete(admitted); });
    this.requests.set(key, job);
    this.calls.set(callId, job);
    return job;
  }

  finish(): Promise<Result | undefined> { return this.finishPromise ??= this.finishOnce(); }

  private async finishOnce(): Promise<Result | undefined> {
    await Promise.all([...this.admissions]);
    let result: Result | undefined;
    // Retry only validated actions whose durable admission failed. Admitted
    // tasks are owned by the outbox; a goodbye is never a new executable turn.
    for (const [key, request] of this.pending) {
      result = await this.dispatch(request, { wait: false, onQueued: () => { this.pending.delete(key); } });
      if (!result.delivered) return result;
      this.pending.delete(key);
    }
    return result;
  }
}
