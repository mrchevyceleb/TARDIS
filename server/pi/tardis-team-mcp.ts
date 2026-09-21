/** TARDIS Pi extension: mount the lane's MCP servers as Pi tools.
 *
 *  Claude Code spawns take `--mcp-config` per lane. Pi has no such flag — its
 *  mcp-manager reads a global or per-project mcp.json — and the team server
 *  carries a per-agent identity in its environment, so a shared file cannot
 *  express it. Instead TARDIS passes the lane's stdio servers as JSON in
 *  RIVENDELL_PI_MCP and this extension speaks MCP over stdio to each one and
 *  registers every tool it lists. No SDK: the protocol here is three JSON-RPC
 *  methods over newline-delimited JSON.
 *
 *  Loaded with `-e` on every TARDIS Pi spawn; inert without the env var. */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { spawn, type ChildProcess } from 'node:child_process';

type StdioServer = { command: string; args?: string[]; env?: Record<string, string>; prefix?: string };
type Rpc = { id: number; resolve: (v: any) => void; reject: (e: Error) => void };

class StdioMcp {
  private child: ChildProcess | null = null;
  private pending = new Map<number, Rpc>();
  private nextId = 1;
  private buffer = '';
  constructor(private readonly name: string, private readonly spec: StdioServer) {}

  private start(): ChildProcess {
    if (this.child && this.child.exitCode === null) return this.child;
    const child = spawn(this.spec.command, this.spec.args ?? [], {
      env: { ...process.env, ...(this.spec.env ?? {}) },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      this.buffer += chunk;
      let nl: number;
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl).trim();
        this.buffer = this.buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          const rpc = typeof msg.id === 'number' ? this.pending.get(msg.id) : undefined;
          if (!rpc) continue;
          this.pending.delete(msg.id);
          if (msg.error) rpc.reject(new Error(msg.error.message ?? 'MCP error'));
          else rpc.resolve(msg.result);
        } catch { /* not JSON-RPC, ignore */ }
      }
    });
    // A spawn failure (ENOENT, EACCES, EMFILE) and a broken pipe both arrive
    // as `error` events; unhandled, either one takes the whole Pi process
    // down with it. Fail this client's calls instead and let the others live.
    const fail = (why: string) => {
      for (const rpc of this.pending.values()) rpc.reject(new Error(`${this.name} ${why}`));
      this.pending.clear();
      if (this.child === child) this.child = null;
    };
    child.on('error', (err) => fail(`MCP failed: ${err.message}`));
    child.stdin!.on('error', (err) => fail(`MCP stdin: ${err.message}`));
    child.on('exit', () => fail('MCP exited'));
    this.child = child;
    return child;
  }

  private send(child: ChildProcess, msg: unknown, onError: (e: Error) => void): void {
    const stdin = child.stdin;
    if (!stdin || stdin.destroyed || !stdin.writable) { onError(new Error(`${this.name} MCP stdin closed`)); return; }
    stdin.write(JSON.stringify(msg) + '\n', (err) => { if (err) onError(err); });
  }

  private call(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { id, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.send(child, { jsonrpc: '2.0', id, method, params }, (err) => {
        if (this.pending.delete(id)) { clearTimeout(timer); reject(err); }
      });
    });
  }
  private notify(method: string, params: unknown): void {
    this.send(this.start(), { jsonrpc: '2.0', method, params }, () => { /* the next call reports it */ });
  }

  /** initialize + tools/list. Both calls are short: a healthy server answers
   *  in well under a second, and the whole handshake has to fit inside the
   *  readiness budget TARDIS gives the Pi process (see HANDSHAKE_BUDGET_MS). */
  async connect(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tardis-pi', version: '1' },
    }, 10_000);
    this.notify('notifications/initialized', {});
    const result = await this.call('tools/list', {}, 10_000);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  /** Drop the child so the next call starts a fresh one. */
  reset(): void {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }

  callTool(name: string, args: unknown): Promise<any> {
    return this.call('tools/call', { name, arguments: args ?? {} });
  }
}

/** TARDIS probes readiness with `get_state` and gives the whole Pi start
 *  45s; earlier extensions load first. Every server connects in parallel,
 *  so this is the most any one of them may hold the factory. A straggler
 *  is not abandoned: it keeps connecting and registers its tools when it
 *  arrives, which is still better than never. */
const HANDSHAKE_BUDGET_MS = 25_000;
const RETRY_DELAY_MS = 1_500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Pi awaits an async factory, and `get_state` (TARDIS's readiness probe)
 *  only answers once every extension has loaded. Awaiting the connections
 *  here is what makes "ready" mean "the lane's tools exist": a prompt that
 *  arrives the same second the process spawns still sees them. One failing
 *  server never blocks the rest, and a server that dies mid-handshake (or
 *  a proxy still warming up) gets one more try. */
export default async function (pi: ExtensionAPI) {
  const raw = process.env.RIVENDELL_PI_MCP;
  if (!raw) return;
  let servers: Record<string, StdioServer>;
  try { servers = JSON.parse(raw); } catch { return; }

  const mount = async (serverName: string, spec: StdioServer): Promise<void> => {
    const client = new StdioMcp(serverName, spec);
    const prefix = spec.prefix ?? '';
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const tools = await client.connect();
        for (const tool of tools) {
          pi.registerTool({
            name: `${prefix}${tool.name}`,
            label: tool.name,
            description: tool.description ?? `${serverName}: ${tool.name}`,
            parameters: (tool.inputSchema as any) ?? { type: 'object', properties: {} },
            async execute(_id, params) {
              const result = await client.callTool(tool.name, params);
              const content = Array.isArray(result?.content) ? result.content : [];
              const text = content
                .filter((c: any) => c?.type === 'text')
                .map((c: any) => ({ type: 'text' as const, text: String(c.text ?? '') }));
              return {
                content: text.length ? text : [{ type: 'text', text: '(no output)' }],
                details: { raw: result },
                isError: result?.isError === true,
              };
            },
          });
        }
        console.error(`[tardis-team-mcp] ${serverName}: ${tools.length} tools${attempt > 1 ? ' (retry)' : ''}`);
        return;
      } catch (err) {
        lastError = err as Error;
        client.reset();
        if (attempt < 2) await sleep(RETRY_DELAY_MS);
      }
    }
    console.error(`[tardis-team-mcp] ${serverName}: FAILED, tools unavailable: ${lastError?.message}`);
  };

  const pendingNames = new Set(Object.keys(servers));
  const all = Promise.all(Object.entries(servers).map(([name, spec]) => mount(name, spec).finally(() => pendingNames.delete(name))));
  await Promise.race([all, sleep(HANDSHAKE_BUDGET_MS)]);
  if (pendingNames.size) console.error(`[tardis-team-mcp] still connecting past ${HANDSHAKE_BUDGET_MS}ms: ${[...pendingNames].join(', ')}`);
}
