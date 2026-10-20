# Keeping the host responsive

The old orphan reaper is necessary but insufficient. Its ownership token proves
which **dead server** left a process behind; it deliberately does not touch a
living server's descendants. It neither limits live work nor owns scratch.
Detached grandchildren, long-lived CLI/MCP stacks, browser profiles and tmpfs
files could therefore accumulate while the server was healthy. Idle sessions
were retained for 24 hours (tracked background work could extend that to 72).
The spawn memory check covered only some engines, and read the cgroup mount
root instead of the process's membership and ancestors. Independent model
memory consumption and unconstrained background scopes completed the failure.

## Runtime policy

`RIVENDELL_RESOURCE_GUARD=required` enables strict Linux containment. Missing
policy, unsupported cgroups, denied user namespaces, or a failed launch means
work is held with a plain, retryable reason. Startup capability checks retry
every 30 seconds so a transient failure does not require a service restart.
There is no uncontained retry. Unset or `off`
retains portable launching; `/api/health.resourceGuard` explicitly says off.
Every screen surfaces new worker failures in one coalesced toast and an accessible
announcement; routine admission holds stay on the Desk, and historical notices
are not replayed on reload. The Desk displays
strict-mode readiness, pressure holds and recent incidents.
The durable incident file is bounded to 100 records; health returns at most 50.
No prompts, environment values or command output are stored in that file.

Every lane CLI, queue worker, content CLI, `job_start` command and command watch
uses the same policy. In strict mode Banana has a separate serve process per
lane, rather than one process whose OOM could terminate every Banana lane.
Each generation owns a separate provider-config file, removed on its exit;
concurrent lanes cannot overwrite one another’s provider configuration. A
manifest is saved before creating the file; boot cleanup removes only manifest
files whose server owner is proven dead by boot identity, PID namespace and
kernel process start time. It never scans legacy config names for deletion.

Each launch enters its own systemd user scope in `tardis-workers.slice`:

| Resource | Per worker | All workers |
| --- | --- | --- |
| Memory throttle / hard maximum | 6 / 8 GiB | 28 / 32 GiB |
| Swap maximum | 256 MiB | 1 GiB |
| Tasks, including threads | 512 | 4096 |
| CPU time | 2 cores | 12 cores |
| Private scratch | 4 GiB | Included in worker memory accounting |
| File size / core dumps | 1 GiB / disabled | — |

The worker's memory OOM group includes its descendants. The shared slice must
**not** be one OOM group: sacrificing every lane for one offender is forbidden.
Bubblewrap creates PID/IPC/mount namespaces, reaps orphaned grandchildren,
and discards private `/dev/shm` when its command ends, even after a crash.
TMPDIR, TMP and TEMP point into that private scratch. XDG_CACHE_HOME is
unchanged so installed Playwright browsers, uv environments and model caches
remain discoverable; those persistent caches are not treated as scratch. Host
`/tmp` stays visible so images and other server-provided inputs keep working.
Durable background jobs and watches omit parent-death termination so they
survive a server restart; lane workers terminate with their server. The PID
namespace cleans descendants when the job itself ends in both cases. Graceful
Stop signals target the inner CLI, allowing its state to flush before cleanup.
PID watches are rejected in strict mode because namespace PIDs are not host
PIDs. Use job_start, a command watch, or a workspace file watch instead. Private
scratch cannot be watched or used as another job’s source path; put shared inputs
and deliverables in the workspace. Neither legacy scratch names nor unrelated
processes are selected for cleanup.
Commands that deliberately write outside scratch still write to the workspace.
User-namespace isolation prevents privileged local sudo/setuid operations; use
the host owner’s maintenance path for those changes. The session bus remains
available for status checks and credential helpers. This is workload resource
isolation, not a security boundary against a fully privileged agent: Docker,
SSH and externally dispatched user services require their own resource budgets.
Treat scratch as disposable; save deliverables in the workspace.

Core dumps are disabled and each file has a kernel 1 GiB maximum. A two-second
non-overlapping monitor also reads each owned scope's kernel disk-write counter.
It stops a background job/watch if it writes over 16 GiB during its lifetime,
or a background job/watch that keeps writing with less than 32 GiB free
(or less than 1% free inodes). Conversation lanes stop at that reserve only
when writing over 256 MiB between samples, preserving light transcript writes.
At the critical 8 GiB reserve, any continuing writer can be stopped to protect
the host. Temporary filesystems use proportionally smaller reserves. The first sample establishes a baseline after a restart. Long-lived conversation
lanes have no cumulative write cap while storage is healthy. This is sampled disk protection, **not a filesystem quota**;
buffered writes can land between samples. The monitor resumes persisted
`job_start` and command-watch scopes after a server restart. Arbitrary external volumes and writes
dispatched to services outside the scope require their own host policies.

All launches check memory. Strict mode also holds launches when the shared
worker slice has fewer than 512 free task/thread slots, reserving capacity
for simultaneous cold starts during their first ten seconds; the aggregate task
budget includes normal browser and verifier stacks, not only Node processes. Strict mode also checks disk space/inodes and Linux
memory/I/O PSI, holding new work at 10% sustained full stalls. The memory
reserve is the greater of 2 GiB and 10% of host RAM; finite cgroup headroom is
checked separately against its own capacity, including all ancestors. Available
headroom discounts reclaimable inactive file cache, so cached model weights
and workspace reads cannot permanently hold launches. Existing
healthy conversations are not interrupted by admission holds. Background jobs
and watch commands have scope runtime backstops two minutes after their
requested timeout; the scheduler remains the primary timeout reporter.
Command-watch timeout wakes explicitly warn that this hard stop is pending.
Storage stops retain their scope identity in durable incident receipts so
job and command-watch result wakes explain storage protection after a restart.

Unsubscribed idle Claude/Codex/Pi/Agy sessions retire after ten minutes in strict
mode; busy work, open viewers and tracked background work retain their existing
protections, including the fixed 72-hour tracked-background-work grace. Banana
retains its existing 24-hour TTL while comfortable, avoiding repeated native
context loss; when pressure holds new work, unused private serves retire after
ten idle minutes and recover from durable history on their next start. Retirement preserves durable history; a retired
Banana serve recovers from durable history rather than its former native
process context. A finished
job's namespace releases its children/scratch; its small job record/log retains
the existing 72-hour policy. Inspect systemd's `Result=oom-kill` before clearing
an owned failed lane scope; exit 137 alone is never called a confirmed OOM.
Durable scopes use automatic collection so failed-unit metadata cannot pile up
while the server is down. If the scope result has been collected, a bounded
unit-specific journal query reads only UNIT_RESULT and manager/unit identity
fields. It never reads MESSAGE or command output. A confirmed OOM is recorded
on the job and included in its normal result wake; command-watch wakes also
retain a confirmed OOM or timeout cause, including after a server
restart. If both sources are unavailable, the cause remains explicitly
unconfirmed. This uses systemd’s [structured unit failure record](https://github.com/systemd/systemd/blob/v257/src/core/unit.c#L5535). Missing disk accounting on an existing scope holds new
work temporarily and recovers when readings return; completed scopes are dropped
without treating their disappearance as a host failure.

## Host policy for a 128 GiB / 20 CPU workstation

These are operator changes, not actions performed by the application or this
patch. Apply them to the **user manager that runs TARDIS**, not a root user
manager. Install `bubblewrap` and `util-linux` using the host package manager
(`sudo apt-get install bubblewrap util-linux` on Ubuntu).
The system user manager must delegate all required controllers. Create
`/etc/systemd/system/user@1000.service.d/controllers.conf` (replace 1000 only
if the TARDIS account has a different UID):

```ini
[Service]
Delegate=cpu cpuset io memory pids
```

This requires a future planned user-manager reload/restart or reboot; restarting
it ends that user’s sessions, so do not apply it during active work. Strict mode
checks the available controllers and refuses work if disk accounting is missing.

Bubblewrap must be allowed by the host's user-namespace/AppArmor policy; do not
globally disable AppArmor. Required-mode startup performs a harmless real
namespace capability check, including real /dev/null and random-device I/O,
and otherwise holds work. Device mounts are preserved with --dev-bind before
replacing /dev/shm with the private scratch mount.

For durable cause attribution, retain user-manager journal records. If the
host does not already do this, create
`/etc/systemd/journald.conf.d/tardis.conf`:

```ini
[Journal]
Storage=persistent
SplitMode=uid
SystemMaxUse=512M
RuntimeMaxUse=128M
MaxRetentionSec=7d
```

Apply at the same planned maintenance; do not restart journald during this
work. The TARDIS account must be able to read its own user journal.

Create `~/.config/systemd/user/tardis-workers.slice`:

```ini
[Unit]
Description=TARDIS worker resource budget

[Slice]
MemoryAccounting=yes
MemoryHigh=28G
MemoryMax=32G
MemorySwapMax=1G
MemoryOOMGroup=no
TasksAccounting=yes
TasksMax=4096
CPUAccounting=yes
CPUQuota=1200%
IOAccounting=yes
IOWeight=25
```

Create `~/.config/systemd/user/tardis-models.slice`:

```ini
[Unit]
Description=Local model resource budget

[Slice]
MemoryAccounting=yes
MemoryHigh=56G
MemoryMax=64G
MemorySwapMax=0
MemoryOOMGroup=yes
TasksAccounting=yes
TasksMax=256
CPUAccounting=yes
CPUQuota=400%
IOAccounting=yes
IOWeight=25
```

Existing model processes do not move when a slice file is installed. Their
operator must arrange a safe idle shutdown and launch the model runtime through
the slice. For an existing **user service**, add this exact drop-in to that
service (retain its actual service name and existing ExecStart):

```ini
[Service]
Slice=tardis-models.slice
```

For a desktop/CLI model runtime, prefix its normal executable/arguments with:

```bash
systemd-run --user --scope --unit=tardis-model --slice=tardis-models.slice --expand-environment=no --
```

The command is a prefix, not a standalone invocation. Ensure an already-running
daemon is not merely reused outside the slice. Verify its actual ControlGroup;
unmanaged GPU/unified-memory allocations need the model runtime's own memory
limit as well. Increasing swap is not a substitute for the combined budgets.

Create `~/.config/systemd/user/rivendell.service.d/resources.conf`:

```ini
[Service]
Environment=RIVENDELL_RESOURCE_GUARD=required
MemoryAccounting=yes
MemoryHigh=4G
MemoryMax=8G
MemorySwapMax=256M
TasksAccounting=yes
TasksMax=256
CPUAccounting=yes
CPUQuota=200%
IOAccounting=yes
IOWeight=100
```

Keep the server out of `tardis-workers.slice` and retain its existing OOM score
protection. The budgets above leave roughly 24 GiB for the desktop/kernel and
other applications; they are ceilings, not allocations. Review other heavy
services separately; TARDIS cannot constrain programs it did not launch.
For a final host-wide ceiling covering processes outside worker scopes, create
`/etc/systemd/system/user-1000.slice.d/resources.conf`:

```ini
[Slice]
MemoryAccounting=yes
MemoryHigh=104G
MemoryMax=112G
MemorySwapMax=2G
MemoryOOMGroup=no
TasksAccounting=yes
TasksMax=8192
CPUAccounting=yes
CPUQuota=1800%
```

This cap includes the desktop and all programs for that UID; coordinate it
with the owner and apply at planned maintenance. It leaves physical memory
and CPU headroom for the host even if an agent dispatches work through another
service. It does not provide per-job attribution for such external work.

To bound **future host** `/dev/shm` usage outside private worker namespaces,
the operator can add `/etc/systemd/system/dev-shm.mount.d/resources.conf`:

```ini
[Mount]
Options=mode=1777,nosuid,nodev,size=8G
```

Apply this only at a planned idle maintenance/reboot; do not remount a busy
tmpfs or remove legacy files based on names/age. The setting does not reclaim
existing allocations. Inventory legacy scratch and old process ownership,
then let their owners end/recover that work. No automated legacy sweep is
introduced by this patch. No sudoers changes or extra swap are required.

After writing the unit files, `systemctl --user daemon-reload` reloads definitions
without restarting TARDIS. For system-level delegation, user-slice and mount drop-ins, Max also needs
`sudo systemctl daemon-reload`; neither reload restarts a service. The new
definitions take effect at the planned maintenance/idle deployment. User
worker definitions take effect for new scopes; the service drop-in
requires a later approved idle deployment. Check `/api/health` first: neither
busyTurns nor backgroundTasks may be active for a non-interrupting restart.
No live deployment, service restart, existing-process termination or legacy-file
deletion was performed while preparing this patch.

## Verification and rollout boundary

Compile frontend and server, build Vite and run the existing tests. Before
declaring host protection operational, the operator must verify on the actual
deployment that health reports required/ready, worker scopes sit under
`tardis.slice/tardis-workers.slice`, and their effective memory/task/CPU/swap
limits match the table. Verify a **new, disposable owned** job can hit a small
test memory/task limit without interrupting another lane, reports the reason,
and leaves no processes/private scratch after completion. Also verify a saved
workspace deliverable survives. These destructive limit exercises are deferred
to the operator; no live jobs, old scratch or live services are touched here.
