# Architecture

TARDIS is a React application and an Express/WebSocket server in one repository.

## Runtime shape

```text
Browser / installed PWA
  ├─ HTTP /api/* ───────────────┐
  └─ WebSocket /api/ws          │
                                ▼
                      Express + ws server
                       ├─ chat session registry
                       ├─ durable event logs
                       ├─ teammate/routine bus
                       ├─ workspace API
                       ├─ optional worker queue
                       └─ optional external services
                                │
              ┌─────────────────┼─────────────────┐
              ▼                 ▼                 ▼
         Claude Code          Codex        OpenAI-compatible
        Claude/xAI/Z.ai                    hosted/local models
```

The production server also serves the Vite build from `dist/`. Development uses Vite on port 5173 and proxies API/WebSocket traffic to port 8091.

## Frontend

- `src/grok/` — default teammate shell, sidebar, chat, history, agent editor, and artifact desk.
- `src/chat/` — transport hooks, transcript reconstruction, model pickers, composer, blocks, and responsive chat UI.
- `src/rooms/` — task, calendar, email, finance, routine, workspace, and activity views.
- `src/shell/` — the classic Studio file/chat workspace at `/studio`.
- `src/voice/` and `src/jarvis/` — voice call and wake-word clients.

TanStack Query owns request caching. Chat events are streamed over one WebSocket per open conversation and reconstructed into display blocks client-side.

## Server

- `server/src/index.ts` — HTTP server, route mounting, startup, teammate prewarm, and graceful shutdown.
- `server/src/chat/register.ts` — WebSocket protocol, attachment handling, session binding, send/steer/stop semantics, and replay.
- `server/src/chat/runner.ts` — persistent Claude-family processes, including Claude, xAI, and Z.ai.
- `server/src/chat/codex-runner.ts` — Codex process/session transport.
- `server/src/chat/banana-runner.ts` — OpenRouter, Fireworks, and local OpenAI-compatible models.
- `server/src/chat/event-log-store.ts` — append-only durable conversation events.
- `server/src/chat/compaction.ts` and `threadWindow.ts` — rolling memory and bounded fresh-process primers.
- `server/src/chat/teamBus.ts` — rate-limited agent-to-agent delivery.
- `server/src/chat/routines.ts` — scheduled agent work with visible-human priority.
- `server/src/routes/` — HTTP APIs.
- `server/src/worker/` — optional durable job queue and Scribe activity stream.

## Durable conversation model

The visible transcript is not the model process. Every semantic event is appended to a per-thread JSONL log under `RIVENDELL_STATE_DIR` (default `~/.rivendell`). Native provider session IDs are stored separately.

When a thread grows, TARDIS:

1. extracts complete visible turns from durable history,
2. generates a credential-redacted rolling compact,
3. preserves a recent working window,
4. keeps the healthy live process running, and
5. seeds compact plus recent turns only when a genuine new process is required.

This avoids routine compaction handoff gaps while keeping model context bounded.

## Teammates

Agent records and persona scopes live under `~/.rivendell/personas/`. An agent's home thread keeps one engine-neutral event log, so changing brains does not fork its visible identity. Engine-specific native session IDs remain separate to prevent invalid cross-provider resumes.

The built-in `rivendell-team` MCP is created for each Claude-family process. It calls the local `/api/team` surface and carries the sender identity. Hop and rate limits prevent runaway agent loops.

## Optional integrations

TARDIS starts without private service dependencies. Features activate only when configured:

- Supabase for durable queue/Scribe storage.
- An assistant admin/MCP backend for task, mail, calendar, and tool integrations.
- A browser MCP bridge.
- Railway redeploy controls.
- LiveKit, ElevenLabs, and Picovoice for voice/Jarvis.
- A robot companion (`robot/`, see `docs/ROBOT.md`) linking a physical body over `/ws/device`.

External side effects are designed to stay draft/review-first.

## Trust boundary

There is no built-in user login. The intended boundary is the local machine or a trusted private reverse proxy such as Tailscale Serve. The default bind address is loopback. See [DEPLOYMENT.md](DEPLOYMENT.md) and [../SECURITY.md](../SECURITY.md).
