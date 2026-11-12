# Session: Gemini 4 Hydrogen - Thursday, November 12, 2026

## Focus

Add Gemini 4 Hydrogen to every Antigravity brain picker, preserve its selected reasoning level for the next real turn, and display its friendly name consistently. Verify against the real provider in an isolated copy without touching the live service.

## What changed

- `server/src/shared/agyModels.ts` supplies one browser-safe catalog for model IDs, labels, supported efforts, defaults and context windows. Hydrogen offers low, medium, high and xhigh, defaults to high, and has a verified 1,000,000-token window. Carbon and Argon retain low, medium and high with their existing defaults.
- `server/src/chat/agy-models.ts` retains server-only operator defaults. `src/chat/agyModels.ts` exposes the catalog and model-change feedback to the client.
- The companion picker, agent editor and canonical agent-brain saves normalize the model and effort together. Unsupported effort changes explain the fallback. Focused tests cover save, remount, legacy suffixed IDs and model switching.
- Team status, the session card and session reports use friendly model names. The phone composer gives the message and controls separate rows so the full model name fits.
- Antigravity context usage comes from the latest measured call. `agy-context.ts` restores it from durable history independently of the browser's replay cursor. Tool-only and unfinished-step events no longer manufacture usage.
- Work started from `e2be1dd`. This record accompanies the Hydrogen implementation commit; remote merge state is recorded by its pull request.

## Bugs found and root causes

- Hydrogen xhigh would have been rejected by a provider-wide three-level list. Effort validation and pickers now use each model's metadata.
- The context meter ignored Antigravity's message-delta usage because it expected full assistant frames. It now consumes the provider's per-call events.
- Cached transcripts could attach without replaying any usage event, leaving the meter empty after reload. The server now supplies a usage snapshot on attachment.
- Synthetic tool cards supplied zero usage, and interrupted steps supplied cumulative totals. Neither represents a measured call, so both now omit usage.
- A fixed 90px phone chip hid the distinguishing part of the model name. The composer now reserves a separate controls row.

## Gotchas for future agents

- The CLI accepts a base model ID plus `--effort`. Do not combine a suffixed model ID with a conflicting effort argument.
- Antigravity result totals are cumulative across a conversation. Context size is the last call's uncached input plus cached input, not the result total.
- The shared catalog must remain free of server configuration and Node dependencies.
- Isolated browser verification used `RIVENDELL_SIDE_COPY=1`, separate state and an empty workspace. Do not set side-copy mode for the full test suite: it intentionally disables behavior exercised by quiet-hours tests.
- All three allowed no-crap-allowed rounds were used. Do not start another review round for this branch without an explicit user override.

## Open items

- No staging target or deployment workflow is configured. The deployment guide documents explicit updates to a self-hosted service; the user prohibited touching the live service.
- Existing minor follow-ups include effort-change dividers using the raw engine label, optional integrations being unavailable in an isolated copy, and an unused internal cumulative Antigravity context counter. These do not block Hydrogen selection or runtime execution.

## How to verify

- `npm run typecheck`, `npm test`, and `npm run build` passed. The full suite contained 400 passing tests.
- `agy --version` reported 1.5.7. `agy models` and ACP configuration confirmed all four Hydrogen reasoning levels.
- In an isolated server, create a test agent, choose Antigravity, select Hydrogen and xhigh, save, then send a one-line prompt. Confirm both the answer and the actual process model/effort.
- Real browser checks covered 1440px desktop and 390px phone widths, saves and reloads, a low-to-xhigh change between real turns, friendly labels, and restored context usage.
- Final independent review: Opus 5.5 high for code, Opus 5.5 medium for browser. All four required flows passed, browser score 10/10, no P0/P1 code findings. No source changes followed that review.

## Anything else

- Provider facts: [Antigravity model documentation](https://antigravity.google/docs/models) and [Google's Hydrogen release announcement](https://blog.google/innovation-and-ai/models-and-research/gemini-models/introducing-gemini-4-hydrogen/).
- Test servers, Antigravity children and owned browser tabs were stopped. Task scratch state was removed. Screenshots and verification evidence remain outside the repository.
- This is a sanitized engineering handoff for the requested bloom operation, not a personal transcript or runtime-state export.
