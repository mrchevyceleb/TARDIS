# Desk phone alerts

Desk items wait quietly, at every priority. Creating, promoting, reopening or
waking an item from snooze never sends an individual Pushover notification.
There is no three-hour “Still waiting” reminder, including for items that were
pushed before this policy changed.

The only Desk phone alerts are the existing short digests on weekdays at
09:30, 13:30 and 16:30 in America/New_York, and only when something is open.
Snoozed items stay out until they wake. High items rank first, except when their
linked card is in Not started. Titles may appear on the lock screen;
keep private details in the item's detail field.

Digest behavior is unchanged: at most three titles, items older than 24 hours
count only in “+N more” (age restarts when a snoozed item wakes), a 20-minute
catch-up window, and persisted receipts to
avoid repeating a slot after restart. Failed sends retain their existing bounded
retries during that weekday's daytime. A first run seeds earlier slots instead
of sending them late; an empty slot is recorded and is not sent later that slot.

Answers still close the item and reach the owning agent through the existing
delivery path. Failed deliveries keep retrying until they land, with slower
retries after half an hour and after a day. Keep the notifier running:
`RIVENDELL_DESK_NOTIFY=off` also disables digests and answer retries.

This policy governs Desk Pushover alerts only. Desktop alerts, Desk badges and
guardian/watchdog pages about TARDIS outages and recovery are unchanged.
