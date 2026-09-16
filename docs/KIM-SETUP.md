# Kim's TARDIS appearance

Use the shared TARDIS repository for both installations. Appearance settings
are saved in each browser's local storage, so a Git update does not overwrite
Kim's or Matt's choices, agents, or conversations.

## First-run defaults

Set these variables when building Kim's frontend (for example in a local,
untracked `.env.local` file):

```dotenv
VITE_TARDIS_STYLE=lavender
VITE_TARDIS_THEME=light
```

Then run `npm run build`. These are build-time defaults, not server runtime
settings. Without them, the existing Console style and dark mode remain the
defaults. Existing saved preferences take priority over deployment defaults.
A new browser/device starts with the installation's build defaults.

## Changing the appearance

Open **You** in the bottom of the sidebar. Choose **Lavender** or **Console**,
then choose **Light** or **Dark** separately. Lavender has a white/lilac day
palette and a dark purple night palette. The setting applies immediately;
there is no Save step. The existing chat brightness toggle still works.

The keys are `rivendell:style` and `rivendell:theme`. They are local preferences,
not account identity or credentials; they are not synchronized across devices.
This preset does not provision Linux, accounts, agents, or publishing access.

## USB installation on the AMD computer

Copy [`scripts/setup-kim.sh`](../scripts/setup-kim.sh) onto a USB stick. Keep the
manufacturer's Linux installation and its AMD/ROCm stack. Finish its first boot,
create Kim's normal user account, and connect to the internet. This installer
supports Ubuntu/Debian on x86-64 or ARM64; other vendor distributions stop with
a clear message instead of replacing the OS.

Before the visit, put the reviewed TARDIS and RallyPoint release commits on their
shared GitHub repositories. Kim's GitHub account needs access to both
`mrchevyceleb/TARDIS` and private `R-Link-LLC/RallyPoint`. Provision her intended
content database and apply RallyPoint migrations through
`0010_headless_content.sql`; have its URL and service-role key available privately.
The script does not copy credentials or conversations from another installation.

Open a terminal in the USB folder and run:

```bash
bash setup-kim.sh
```

Enter the Linux administrator password when requested, complete GitHub's browser
login, then enter the database URL and hidden service-role key. A missing private
repository permission, missing database credential, or unapplied migration stops
setup clearly. Fix it and run the same command again.

The script adds GNOME only when absent, enables graphical boot, installs isolated
Node 22.22.0, pnpm 10.28.2, Claude Code 2.1.272 and Codex 0.154.0, builds TARDIS
with Lavender/Light defaults, and starts both loopback-only services. It generates
new local gateway tokens and stores private configuration under
`~/.config/tardis/` with user-only permissions. It adds **TARDIS** to GNOME's
application launcher. If GNOME was newly installed, reboot when ready and choose
the GNOME session; setup does not interrupt the machine with an automatic reboot.

Finish Kim's subscription logins from a terminal:

```bash
~/.local/bin/tardis-cli claude auth login
~/.local/bin/tardis-cli codex login
```

Open `http://127.0.0.1:8091/xai-oauth` to connect her Grok subscription. Then open
TARDIS **Content → Connections**, configure each brand's publishing connections,
and verify the real accounts before sending anything. Create a draft, edit it,
request a revision, and approve it. Publishing remains a separate explicit action.
Account consent, subscription access, and publishing credentials require human
sign-in; plugging in the USB alone cannot authorize them.

## Versions, reruns, and maintenance

By default, setup resolves each repository's `main` to a fixed commit for that
run and records the SHAs in `~/.config/tardis/install-commits.txt`. For a tested
release, supply both exact reviewed commit IDs:

```bash
TARDIS_REF=YOUR_TARDIS_COMMIT RALLYPOINT_REF=YOUR_RALLYPOINT_COMMIT bash setup-kim.sh
```

Reruns preserve the existing private environment files and local content state.
They refuse dirty checkouts, unexpected remotes, divergent history, and backwards
updates. There is no force reset. Before updating, close TARDIS, finish all agent turns and content jobs, and
stop both services yourself. Setup refuses to change an installation while
either service is running; it never races a health check with an automatic stop.
It then checks prerequisites and storage, rebuilds, and starts both services. If a build fails, services remain stopped until the issue is fixed
and setup is rerun; this is an attended installer, not a release rollback manager.

```bash
# Confirm busyTurns is 0 and Content has no queued/running jobs first.
curl http://127.0.0.1:8091/api/health
systemctl --user stop rallypoint-engine tardis
# Now rerun setup. To inspect status or troubleshoot afterward:
systemctl --user status tardis rallypoint-engine
journalctl --user -u tardis -u rallypoint-engine -n 80
```

### Linux rehearsal

The installer was exercised on a clean Ubuntu 24.04 ARM64 VM with systemd,
GNOME, an isolated PostgreSQL/PostgREST database and synthetic content. Installation,
the Lavender/Light defaults, the desktop launcher, automatic service startup after
reboot, and refusal to update running services passed. Browser checks against the
real Linux services covered autosave, exact-version approval, approval invalidation
after edits, disconnected publishing protection, reload persistence and mobile layout.

The rehearsal used committed source snapshots in place of GitHub sign-in and did
not copy anyone's subscription credentials. Separate live deployment checks verified
Claude, Codex and Grok subscription completions. Media uploads and real publishing
were not exercised in the isolated database.

The actual AMD vendor image still needs an on-device check for x86 binaries,
graphics/ROCm, peripherals and account sign-ins. ARM Linux testing does not certify
that hardware. The script can also be syntax-checked without changing the OS:
`bash -n scripts/setup-kim.sh`.
