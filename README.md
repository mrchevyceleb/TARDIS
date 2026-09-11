# TARDIS

[![CI](https://github.com/mrchevyceleb/TARDIS/actions/workflows/ci.yml/badge.svg)](https://github.com/mrchevyceleb/TARDIS/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-gold.svg)](LICENSE)

Bigger on the inside. A local-first, always-on multi-agent office for Claude Code, Codex, Grok, GLM, OpenRouter, Fireworks, and local models.

TARDIS is a ship's mind with a crew of Companions: each companion gets a durable home thread, an editable role, model/effort controls, scheduled routines, and a shared team bus. Conversations survive browser changes, service restarts (regenerations), model switches, and rolling context compaction without turning the visible transcript into disposable model state.

> [!WARNING]
> TARDIS can read workspace files and launch powerful local agents. It has **no app-layer authentication**. The server binds to `127.0.0.1` by default. Only expose it through an authentication boundary you trust, such as a locked-down Tailscale tailnet. Never publish port `8091` directly to the internet.

## What it includes

- **Persistent companions** — one forever-thread and editable persona per agent.
- **Multi-engine conversations** — Claude Code, Codex, xAI Grok, Z.ai GLM, OpenRouter, Fireworks, and local OpenAI-compatible models.
- **Agent collaboration** — companions can message one another through the ship's built-in team MCP.
- **Durable memory** — append-only event logs, rolling compaction, restart recovery, and cross-device replay.
- **Human-first scheduling** — routines defer while a person is actively using a thread and remain draft/review-first for external side effects.
- **Workspace desk** — browse and edit an `ASSISTANT-HUB`, open artifacts, pin messages, and use the classic Studio at `/studio`.
- **Voice and PWA support** — installable desktop/mobile shell, live voice calls, optional Jarvis wake-word agent, and native Windows workspace links.
- **Robot body** — link a desk robot (Doly reference) so companions can see, speak, emote and move in the room; see [docs/ROBOT.md](docs/ROBOT.md).
- **Local operations** — health reporting, graceful shutdown markers, memory-aware process admission, and safe session prewarming.

## Requirements

- Node.js 22.22+
- npm 10+
- At least one supported agent/provider:
  - a locally authenticated `claude` CLI,
  - a locally authenticated `codex` CLI,
  - a Z.ai, xAI, OpenRouter, or Fireworks key,
  - or an OpenAI-compatible local model server.

Optional integrations such as Supabase, LiveKit, Railway, an external MCP backend, and boot-time agent prewarming are disabled until configured.

## Quick start

```bash
git clone https://github.com/mrchevyceleb/TARDIS.git
cd TARDIS
npm install
cp .env.example .env
npm run dev
```

Open <http://localhost:5173>. Vite proxies API and WebSocket traffic to the TARDIS server on `127.0.0.1:8091`.

At minimum, set an absolute workspace path in `.env`:

```dotenv
ELROND_WORKSPACE_PATH=/absolute/path/to/your/ASSISTANT-HUB
```

The workspace can be any local folder. TARDIS presents it as `ASSISTANT-HUB` so links remain portable between machines.

## Commands

```bash
npm run dev        # server + Vite with hot reload
npm run typecheck  # frontend and server TypeScript
npm test           # focused server tests
npm run build      # production frontend + server build
npm start          # serve the built app and API
npm run icons      # regenerate PWA icons
```

The optional voice worker is a separate package:

```bash
cd jarvis-agent
npm install
npm run typecheck
npm start
```

## Configuration

Start with [`.env.example`](.env.example). Important groups:

| Area | Variables |
| --- | --- |
| Core | `HOST`, `PORT`, `ELROND_WORKSPACE_PATH`, `RIVENDELL_STATE_DIR`, `RIVENDELL_PREWARM_AGENTS`, `RIVENDELL_ALLOWED_ORIGINS` |
| Z.ai | `Z_AI_API_KEY`, `RIVENDELL_ZAI_MODEL` |
| xAI | `GROK_PERSONAL_API_KEY` or the `/xai-oauth` connector |
| Hosted models | `OPENROUTER_API_KEY`, `FIREWORKS_API_KEY` |
| External MCP | `ASSISTANT_MCP_URL`, `ASSISTANT_MCP_TOKEN`, `RIVENDELL_ASSISTANT_MCP_PROXY` |
| Browser bridge | `RIVENDELL_BROWSER_MCP` |
| CLI profiles | `RIVENDELL_ACCOUNT_MAP`, `RIVENDELL_DEFAULT_CLI_ACCOUNT` (optional explicit account routing) |
| Calendar display | `RIVENDELL_CALENDAR_PRIMARY_*`, `RIVENDELL_CALENDAR_SECONDARY_*`, `RIVENDELL_CALENDAR_SECONDARY_MARKERS` |
| Windows links | `VITE_RIVENDELL_WINDOWS_WORKSPACE_PATH` |
| Persistence | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| Voice | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `ELEVENLABS_API_KEY`, `PICOVOICE_ACCESS_KEY` |

Secrets belong in environment variables or a secret manager, never in tracked files. TARDIS does not automatically read global Railway credentials or neighboring repositories.

By default, Claude Code and Codex use their normal authenticated CLI profiles. Advanced multi-profile routing is opt-in through `RIVENDELL_ACCOUNT_MAP`; point it at JSON containing `accounts`, `default_account`, and path-prefix `rules`. Set `RIVENDELL_DEFAULT_CLI_ACCOUNT` only when every TARDIS Claude/Codex lane should use one named profile regardless of workspace rules. It requires a matching account entry in `RIVENDELL_ACCOUNT_MAP`; TARDIS refuses to launch those CLIs rather than silently using the wrong profile. Keep the map private and outside the repository.

For a two-source calendar feed, `RIVENDELL_CALENDAR_SECONDARY_MARKERS` accepts comma-separated substrings matched against upstream source, account, calendar ID, calendar name, and organizer fields. For example, `work,company.example` groups matching events into the secondary calendar. Labels, names, and colors come from the corresponding `RIVENDELL_CALENDAR_*` variables in `.env.example`.

The Windows handler's `-WorkspaceRoot` value and `VITE_RIVENDELL_WINDOWS_WORKSPACE_PATH` must identify the same directory. The Vite value is baked into the frontend during `npm run build`.

An external scheduler can surface read-only jobs in Forge by setting `RIVENDELL_OBSERVED_JOBS_FILE` to an absolute JSON file:

```json
{
  "jobs": [
    { "id": "backup", "name": "Nightly backup", "schedule": "0 2 * * *", "status": "active", "runtime": "local" }
  ]
}
```

## Run it on your own home server

TARDIS does not require specialized hardware. An always-on Linux mini PC, NAS with a normal Node.js environment, repurposed laptop, or private VM works well; a GPU is only needed for local models. The complete install, systemd, update, Tailscale, macOS, and Windows instructions are in **[Home server deployment](docs/DEPLOYMENT.md)**.

Build first, then run the Node server under your process manager:

```bash
npm run build
npm start
```

A minimal systemd user service can run from the cloned directory with an `EnvironmentFile` outside the repository. Keep `HOST=127.0.0.1` and proxy through your private access layer.

For Tailscale Serve:

```bash
./scripts/tailscale-serve.sh
```

Verify health before and after restarts:

```bash
curl http://127.0.0.1:8091/api/health
```

Do not restart while `busyTurns` is greater than zero unless you intentionally accept an interrupted agent turn.

## Native apps

TARDIS also ships as a desktop app for Windows, macOS, and Linux and as a sideloadable Android app. Both are thin shells over one always-on server: download them from the GitHub Releases page, enter your server address once, and every device shows the same console. Setup, updates, and signing are covered in **[Native apps](docs/NATIVE.md)**.

## Data and privacy

Runtime state is stored outside Git by default under `~/.rivendell/`, including agent definitions, event logs, session metadata, attachments, and OAuth tokens. Workspace content remains in the directory configured by `ELROND_WORKSPACE_PATH`.

Before reporting a vulnerability, read [SECURITY.md](SECURITY.md). For architecture and extension points, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); for self-hosting, see [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Contributions are welcome under [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Matt Johnston
