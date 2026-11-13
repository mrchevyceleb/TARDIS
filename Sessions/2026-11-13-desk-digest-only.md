# Desk phone alerts: digests only

## Focus

Keep new Desk items quiet at every priority. Preserve the three existing weekday
digests, answer delivery retries and guardian outage pages.

## What changed

- Removed per-item Pushover jobs, three-hour reminders and their obsolete tracking
  in `server/src/lib/deskNotify.ts`. Existing digest receipts survive upgrades.
- Updated `desk_todo_add` guidance and `docs/DESK-NOTIFICATIONS.md`.
- Updated snooze expectations and added isolated Desk storage / HTTP receiver
  coverage. PR #363 contains the implementation and review record.

## Bugs found and root causes

The same notifier scheduled item pushes, digests and answer retries. Disabling it
would also disable wanted behavior, so only the per-item scheduling was removed.

## Gotchas for future agents

- `RIVENDELL_DESK_NOTIFY=off` also stops answer retries; leave it enabled.
- Digest age resets when a snoozed item wakes. Desktop alerts remain unchanged.
- An initial account-usage test read an empty renewal file; it passed against the
  unchanged base and on subsequent full runs. No unrelated code was changed.

## Open items

Release belongs to the separate release session. Do not restart or deploy the
live server as part of this merge.

## How to verify

`npm run typecheck`, `npm test` (411 tests) and `npm run build` passed.
The side Desk sent zero requests for new high/normal/low items or legacy reminders,
and sent only scheduled digests. Snooze wake, empty/weekend slots and restart
deduplication passed. Real saved-answer delivery retried through 25 hours, reached
the correct synthetic recipient, persisted success and stopped retrying.

## Anything else

No-crap-allowed ran two rounds with Haiku 5.5 as required by the agent instructions.
Final behavior score was 10/10 with no blocking code findings. A documentation-only
clarification followed review. Max reviewed the change and authorized merging to
main while explicitly reserving restart and deployment for the release session.
