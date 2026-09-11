# TARDIS contributor guide

## Project

TARDIS (formerly Rivendell) is a local-first, always-on multi-agent office. It serves a React PWA and an Express/WebSocket backend from one Node process. There is no app-layer authentication; loopback or a trusted private proxy is the security boundary. Native shells for desktop (`desktop/`, Electron) and Android (`android/`, Kotlin WebView) are thin clients over that same server; see `docs/NATIVE.md`.

Internal identifiers keep the old name on purpose and must never be renamed: `RIVENDELL_*` / `ELROND_WORKSPACE_PATH` env vars, `~/.rivendell`, `rivendell:*` localStorage keys and DOM events, the `rivendell://` scheme and `rivendell-doc:` / `rivendell-folder:` links, the `rivendell-team` / `rivendell-browser` MCPs and `<rivendell-…>` prompt tags, `_rivendellTombstone`, the `rivendell_jobs` tables, the manifest `id`, and the `x-rivendell-*` headers. User-facing copy lives in `src/theme/voice.ts` and room labels in `src/data/roomNames.ts`.

## Stack

- React 19, Vite 8, TypeScript, Tailwind v4, TanStack Query, react-markdown.
- Express 5 and `ws`, run through `tsx`.
- Local JSON/JSONL state under `~/.rivendell`; optional Supabase queue/event persistence.

## Commands

```bash
npm install
npm run dev
npm run typecheck
npm test
npm run build
npm start
```

The development frontend runs on `:5173` and proxies API/WebSocket traffic to `127.0.0.1:8091`. Production serves `dist/` from the Express server.

Never restart a live TARDIS service while `/api/health` reports `busyTurns > 0` unless interruption is explicitly intended.

## Layout

```text
src/
  grok/                    default teammate shell
  chat/                    chat transport, transcript, pickers, composer
  rooms/                   task/calendar/mail/workspace/operations rooms
  shell/                   classic Studio at /studio
  voice/, jarvis/          realtime voice and wake-word clients
server/src/
  index.ts                 app lifecycle and route mounting
  chat/                    runners, sessions, durable logs, compaction, team bus
  routes/                  /api/* and local control surfaces
  worker/                  optional queue and Scribe stream
  lib/                     persistence, workspace, integrations
jarvis-agent/              optional standalone LiveKit voice worker
desktop/                   Electron desktop shell (thin client, own package)
android/                   Android WebView shell (Kotlin, Gradle)
server/src/devices/        linked computers and robots (dial in over /ws/device)
robot/                     Python robot companion (Doly SDK or mock body; own package)
supabase/migrations/       optional queue/event schema
scripts/                   startup, Tailscale, PWA and native icons, Windows handler
```

## Architecture rules

- TypeScript + ESM. Server-relative imports include `.ts`.
- New HTTP APIs use `/api/<noun>`; WebSocket surfaces use `/ws/...` or the existing `/api/ws` chat transport.
- Agent home threads use one engine-neutral durable event log. Native provider session IDs remain engine-specific.
- Visible history is durable server state; browser cache is disposable.
- Rolling compaction must never kill a healthy live process. It seeds only a genuine future process start.
- Scheduled routines yield to visible human conversations.
- Steering is non-destructive. Only explicit Stop may terminate a turn.
- External side effects remain draft/review-first.
- Use `lib/jsonStore.ts` helpers for state under `~/.rivendell`.
- A new room belongs in `src/rooms/` and must be registered in the Grok shell/sidebar.
- A new API belongs in `server/src/routes/`, is mounted in `server/src/index.ts`, and is mirrored in `src/data/api.ts`.
- UI work should remain responsive, tactile, and accessible.
- The native shells stay thin: no server code, no state beyond the server address and window chrome. Behaviour belongs in the web app.
- Linked computers are the one exception: the desktop app executes on its own machine. It always dials out, and the machine's own user approves each command or out-of-workspace file. Credential paths are refused in the shell, not the server.

## Open-source safety

- Keep the default bind address on loopback.
- Never add personal service URLs, deployment IDs, emails, hostnames, absolute user paths, credentials, transcripts, or real workspace data.
- Optional private integrations must be disabled until explicitly configured by environment variables.
- Do not automatically borrow credentials from unrelated global CLIs or neighboring repositories.
- Use synthetic data in documentation and screenshots.
- Run a full-history secret scan before public releases.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build` before declaring work complete. Run the repository's Codex review workflow once after a complete task. Keep tests focused; do not add broad suites for small changes.
