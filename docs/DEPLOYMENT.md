# Home server deployment

TARDIS is designed to run continuously on a computer you control. An ordinary Linux mini PC, NAS with a full Node.js environment, repurposed laptop, or cloud VM inside a private network is enough. A GPU is only needed when you choose a local model.

## Recommended baseline

- 64-bit Linux
- Node.js 22.22+ and npm 10+
- 4 CPU cores and 8 GB RAM for one or two hosted-model lanes
- More memory for several simultaneously warm agents
- A private access layer such as Tailscale
- Claude Code and/or Codex installed and authenticated for any subscription-backed lanes you use

## Install

```bash
git clone https://github.com/mrchevyceleb/TARDIS.git "$HOME/rivendell"
cd "$HOME/rivendell"
npm ci
mkdir -p "$HOME/.config/rivendell"
cp .env.example "$HOME/.config/rivendell/env"
chmod 600 "$HOME/.config/rivendell/env"
```

Edit `~/.config/rivendell/env` and set at least:

```dotenv
HOST=127.0.0.1
PORT=8091
ELROND_WORKSPACE_PATH=/home/your-user/ASSISTANT-HUB
RIVENDELL_WORKER_RUNNER=dry-run
RIVENDELL_PREWARM_AGENTS=false
```

Once every selected CLI/provider is configured, set `RIVENDELL_PREWARM_AGENTS=true` if you want persistent teammate processes initialized at boot instead of on their first message.

Create the workspace if needed, then export the configured environment while building so Vite receives any `VITE_*` settings:

```bash
mkdir -p "$HOME/ASSISTANT-HUB"
set -a
. "$HOME/.config/rivendell/env"
set +a
npm run build
```

## systemd user service

Create `~/.config/systemd/user/rivendell.service`:

```ini
[Unit]
Description=TARDIS multi-agent office
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h/rivendell
EnvironmentFile=%h/.config/rivendell/env
ExecStart=/usr/bin/npm start
Restart=on-failure
RestartSec=3
TimeoutStopSec=10

[Install]
WantedBy=default.target
```

If Node was installed through a version manager, replace `ExecStart` with the absolute path returned by `command -v npm` in a non-interactive shell.

Enable and start it:

```bash
systemctl --user daemon-reload
systemctl --user enable --now rivendell
loginctl enable-linger "$USER"   # keep the user service alive after logout
curl http://127.0.0.1:8091/api/health
```

Updates are explicit:

```bash
cd "$HOME/rivendell"
git pull --ff-only
npm ci
set -a
. "$HOME/.config/rivendell/env"
set +a
npm run typecheck
npm run build
curl http://127.0.0.1:8091/api/health   # wait for busyTurns: 0
systemctl --user restart rivendell
```

Since Oct 13 2026, `scripts/start.sh` also self-heals the client bundle on every boot, best-effort: when the client's build inputs (sources, dependency manifests, build configs) are newer than `dist/`, it builds into a unique `dist.new.<pid>`, swaps by rename, and keeps the previous bundle under `dist.old.*`. When self-healing cannot run (no local vite, a failed or timed-out build, another build holding the lock), the old bundle stays in service and the reason is logged to `~/.rivendell/client-build.log` — inspect that log whenever a restart should have refreshed the client but did not. The explicit `npm run build` above stays for a logged, attended build.

## Private remote access with Tailscale

Install and authenticate Tailscale on the server, then run:

```bash
cd "$HOME/rivendell"
./scripts/tailscale-serve.sh
```

Keep the app bound to `127.0.0.1`. Tailscale Serve terminates the private connection and proxies to the loopback server. Add the exact HTTPS origin shown by `tailscale serve status` to the service environment, then restart once no turns are busy:

```dotenv
RIVENDELL_ALLOWED_ORIGINS=https://your-server.your-tailnet.ts.net
```

The desktop and Android apps connect to this same HTTPS address; see [Native apps](NATIVE.md).

This allowlist protects local WebSockets from DNS rebinding. Use tailnet ACLs to restrict which users and devices can reach the machine.

## Other operating systems

- **macOS:** run `npm start` under launchd, a process supervisor, or a login item. Keep state and environment files outside the repository.
- **Windows:** run under Task Scheduler, NSSM, or another service manager. The optional native workspace-link handler is in `scripts/windows/`. Pass its `-WorkspaceRoot` explicitly and set `VITE_RIVENDELL_WINDOWS_WORKSPACE_PATH` to that same value before building the frontend.
- **Docker/NAS:** a container can work, but agent CLIs, workspace mounts, OAuth state, browser bridges, and `~/.rivendell` must be deliberately persisted. The repository does not ship an insecure one-size-fits-all container image.

## Security checklist

- Keep `HOST=127.0.0.1`.
- Do not forward port `8091` from your router.
- Treat `~/.rivendell` and the workspace as private data.
- Store provider keys in the service environment or a secret manager.
- Restrict filesystem permissions on the environment file to the service user.
- Keep `RIVENDELL_WORKER_RUNNER=dry-run` until you intentionally enable headless agent execution.
- Review Tailscale ACLs before inviting another user to the tailnet.
