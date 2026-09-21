# Routine gates

A routine fires a prompt into an agent on a schedule. Most ticks end in
`NO_UPDATE` after a full frontier-model turn with tool calls. A **gate** does
the mechanical part first — fetch, drop noise, ask a few yes/no questions —
and wakes the agent only when something crossed a threshold, handing it a
digest of exactly those items.

Judgments go to TypeSafe **Jev** (`TYPESAFE_API_KEY`), a System One model that
answers a batch of yes/no questions with calibrated probabilities in a few
hundred milliseconds. With no key configured, every routine runs its plain
turn exactly as before.

The engine is `server/src/chat/routineGate.ts`. A gate is data on the routine
record (`~/.rivendell/routines.json`, field `gate`).

## Shape

```jsonc
{
  "sources": [
    {
      "id": "inbox_0",                 // stable; cursors are kept per routine+source
      "label": "Inbox matt@example.com",
      "kind": "mcp",                   // "mcp" (assistant-mcp tool) or "http"
      "tool": "gmail",                 // router tool: tool + action + params
      "action": "gmail_get_messages",  //   (omit action for a flat tool)
      "params": { "accounts": ["matt@example.com"], "labelIds": ["INBOX"], "query": "newer_than:3d", "maxResults": 100 },
      "items": "messages",             // dot path to the item array ("" = the response is the array; may be a list of paths)
      "itemId": "id",                  // stable id field
      "itemTs": "date",                // optional timestamp field (ISO or epoch)
      "watermark": "id",               // "id": remember judged ids | "ts": high-water on itemTs | "none": a state queue, judge every tick
      "fields": ["from", "subject", "snippet", "date"],   // what the model may see (default: every scalar)
      "drop": [ { "field": "user", "equals": ["me"] }, { "field": "text", "empty": true } ],
      "optional": false                // true: a failing source is skipped, not fatal (never for the primary source)
    },
    {
      "id": "prs",
      "kind": "http",
      "url": "https://api.github.com/repos/org/repo/pulls?state=open",
      "headers": { "authorization": "Bearer ${env:GITHUB_TOKEN}" },   // ${env:NAME} resolved at fetch time, never logged
      "items": "", "itemId": "number", "watermark": "none",
      "drop": [ { "field": "draft", "equals": [true] } ]
    }
  ],
  "protect": [                          // never acted on by archive judges; excluded from judges with respectProtect
    { "field": "from", "matches": "clientco|partnerllc" },
    { "field": "subject", "matches": "receipt|invoice|security" }
  ],
  "judges": [
    { "id": "promo",   "sources": ["inbox_0"], "action": "archive_gmail", "threshold": 0.92,
      "question": "Is this email obviously promotional mail?",
      "criteria": { "true": "…", "false": "…" } },
    { "id": "urgent",  "sources": ["inbox_0"], "action": "wake", "threshold": 0.75,
      "question": "Given `now` and the email date, does this need a same-day answer?" },
    { "id": "mine",    "sources": ["prs"],     "action": "wake", "threshold": 0.5,
      "question": "Does this pull request need the operator to act now?" }
  ],
  "wakeOnAnyNew": false,                // true: any surviving item wakes, no model call
  "digestNote": "What the agent must not redo."
}
```

Rules that make it safe:

- **Fail open.** A tool error, a partial per-account failure (`errors` in the
  response), or a changed shape (item path missing) throws; the routine runs
  its plain turn. A failed source is never mistaken for a quiet one.
- **Cursors commit late.** Watermarks advance only after side effects
  succeed, and on a wake only after the agent turn is delivered.
- **Least disclosure.** Only items that carry a question are sent to the
  model. Protected items have no question, so they never leave the box.
- **Near-misses are "not yet".** A wake score within 0.25 under its
  threshold is judged again next tick (with the current time in `now`)
  instead of being acknowledged forever.
- **Digest is data.** Items reach the agent as JSON records inside
  `<gate-findings>`, declared untrusted, so a message cannot phrase itself
  as an instruction.
- **No identities in source.** Accounts, ids and relationship rules live in
  the gate config, not the repository.

Thresholds: archiving is destructive-ish (reversible from All Mail) so it
needs near-certainty; waking is cheap so it sits lower. Jev's probability is
calibrated — 0.84 means roughly a one-in-six chance of being wrong.

Dry-run a config against live data with no side effects:
`runRoutineGate(routineId, gate, { dryRun: true })`.
