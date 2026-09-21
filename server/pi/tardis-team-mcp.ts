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
    child.on('exit', () => {
      for (const rpc of this.pending.values()) rpc.reject(new Error(`${this.name} MCP exited`));
      this.pending.clear();
      this.child = null;
    });
    this.child = child;
    return child;
  }

  private call(method: string, params: unknown, timeoutMs = 60_000): Promise<any> {
    const child = this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${this.name} ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { id, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  private notify(method: string, params: unknown): void {
    this.start().stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  async connect(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    await this.call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'tardis-pi', version: '1' },
    }, 20_000);
    this.notify('notifications/initialized', {});
    const result = await this.call('tools/list', {}, 20_000);
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  callTool(name: string, args: unknown): Promise<any> {
    return this.call('tools/call', { name, arguments: args ?? {} });
  }
}

export default function (pi: ExtensionAPI) {
  const raw = process.env.RIVENDELL_PI_MCP;
  if (!raw) return;
  let servers: Record<string, StdioServer>;
  try { servers = JSON.parse(raw); } catch { return; }

  for (const [serverName, spec] of Object.entries(servers)) {
    const client = new StdioMcp(serverName, spec);
    const prefix = spec.prefix ?? '';
    void client.connect().then((tools) => {
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
    }).catch((err: Error) => {
      console.error(`[tardis-team-mcp] ${serverName}: ${err.message}`);
    });
  }
}
