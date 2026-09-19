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
The appearance preference itself does not provision accounts or publishing access.
The installer below also provisions the six-agent content team.

## USB installation on the AMD computer

For the least typing, prepare a USB kit from the clean, reviewed repositories.
The packaging computer needs Python 3.11 or newer; this requirement applies to
the kit builder, not the Linux installation script:

```bash
python scripts/build-kim-usb.py --rallypoint /path/to/RallyPoint --output /private/path/TARDIS-USB --workspace-config /private/path/workspace.json --support-public-key /private/path/support.pub --support-peer-ip 100.100.10.20
```

The optional private `workspace.json` contains `SUPABASE_URL` and
`SUPABASE_SERVICE_KEY` for the intended shared RallyPoint database. It is copied
into the kit, so keep the kit private. Never commit or publish it. No chat history,
personal settings, subscription tokens or unrelated credentials are copied.
Without this file the installer asks for the database credentials.

Copy the generated folder onto a USB. In the installed Linux, open that folder
in Terminal and run `bash INSTALL.sh`. Enter the Linux password when asked.
Source snapshots, checksums and release commits are included; GitHub login is
deferred until future updates. Internet is still required for Linux packages and
pinned runtimes. The kit never formats a disk, installs an OS or changes GPU
drivers. It deliberately refuses a temporary live-USB session: installing there
would disappear on reboot. This is a one-command vendor-preserving setup, not a
bootable unattended OS image.

Alternatively copy [`scripts/setup-kim.sh`](../scripts/setup-kim.sh) alone onto a USB stick. Keep the
manufacturer's Linux installation and its AMD/ROCm stack. Finish its first boot,
create Kim's normal user account, and connect to the internet. This installer
supports Ubuntu/Debian on x86-64 or ARM64; other vendor distributions stop with
a clear message instead of replacing the OS.

Before the visit, put the reviewed TARDIS and RallyPoint release commits on their
shared GitHub repositories. Kim's GitHub account needs access to both
`mrchevyceleb/TARDIS` and private `R-Link-LLC/RallyPoint`. Provision her intended
content database (the existing shared Operly/R-Link database may be used) and apply RallyPoint migrations through
`0011_scanner_content_bridge.sql`; have its URL and service-role key available privately.
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
Node 22.22.0, pnpm 10.28.2, Claude Code 2.1.272, Codex 0.154.0 and FFmpeg, builds TARDIS
with Lavender/Light defaults, and starts both loopback-only services. It generates
new local gateway tokens and stores private configuration under
`~/.config/tardis/` with user-only permissions. It adds **TARDIS** to GNOME's
application launcher. If GNOME was newly installed, reboot when ready and choose
the GNOME session; setup does not interrupt the machine with an automatic reboot.
GNOME opens TARDIS after login once the server is healthy. Disable its entry in
`~/.config/autostart/` if automatic opening is not wanted.

The installer adds Chief of Staff, Operly / R-Link Coding Agent, Content
Coordinator, Content Writer, Video Editor and Editor. The coding agent starts
with Codex; the others with Claude. Each can switch among the three subscription
engines. Existing agents and custom scopes are preserved. A one-time preset
marker ensures future installs do not resurrect agents the user deleted.
The Video Editor can work with supplied footage using FFmpeg; paid media
generation and product repository access are separate setup steps.

With the shared database, both installations see the same drafts, revisions,
approval state and publication ledger. Their chats, agents and subscriptions
remain local. A connected engine may claim jobs from this shared queue. Configure
publishing credentials on the installation that will publish; they are stored
locally and are not synchronized through the draft database.

Open **Finish TARDIS Setup** from GNOME Applications for the sign-in menu, or
finish Kim's subscription logins from a new terminal:

```bash
claude auth login
codex login
grok login
```

`grok login` is a browser launcher for `http://127.0.0.1:8091/xai-oauth`,
not a standalone Grok CLI. Existing terminal windows must be reopened after setup.
The setup preserves existing shell configuration and saves backups before adding
the runtime paths. Then open
TARDIS **Content → Connections**, configure Ayrshare once for each brand,
and verify the real accounts before sending anything. Create a draft, edit it,
request a revision, and approve it. Publishing remains a separate explicit action.
Account consent, subscription access, and publishing credentials require human
sign-in; plugging in the USB alone cannot authorize them.

For social accounts, an administrator first saves the Ayrshare API key and a
distinct Profile Key per brand, or creates a brand profile under the existing
Ayrshare plan. After that, **Connect accounts** opens Ayrshare's short-lived
hosted sign-in page. Return to TARDIS to see verified account names. X requires
X developer API credentials as well. GHL blog setup remains available separately;
email sending is not implemented. No plan purchase or real publishing is
performed by the installer.

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

## Separate tailnet and remote support

The two support flags above are optional as a pair. Use the support computer's
actual `tailscale ip -4` address and its OpenSSH **public** key. The builder puts
only the public key and allowed source IP in `support.json`. No Tailscale login,
auth key, SSH private key, or remote desktop password goes on the USB.

With that file, installation adds Tailscale from its signed stable APT repository,
checksum-pinned RustDesk 1.4.9, and a dedicated `tardis-support` SSH account. It
starts **paused**. In GNOME, open **TARDIS Remote Support**, also available as
step 7 of **Finish TARDIS Setup**:

1. Sign into the machine owner's **own Tailscale account and separate tailnet**.
2. In Tailscale Machines, share **only this workstation** using a single-use link.
   The support person accepts from their own account. Do not invite them as a
   tailnet member, share an exit node, or share their machines back.
3. Enable support after checking the displayed tailnet and support computer IP.
   This explicitly grants key-based **administrator access** for unattended repairs.
4. For screen help, open RustDesk and accept the expected incoming connection.
   GNOME/Wayland may also ask which screen to share. Stable RustDesk is not a
   promise of unattended access to a Wayland login screen; SSH is the recovery path.

Network access is restricted by a separate nftables table to `tailscale0`, the
configured support computer's IPv4 address, and TCP ports 2222/21118. Other
interfaces and IPv6 cannot reach those ports. Existing firewall tables and SSH
services are preserved. A newly installed distribution SSH service stays masked;
the support service uses its own configuration and host key on port 2222.
The managed firewall rules are reapplied after native nftables start/reload;
stopping or restarting nftables also stops or restarts the support services.
SSH independently checks the support computer's source address, and the RustDesk
service has an independent network restriction to that address and loopback.
RustDesk uses direct IP access, a localhost rendezvous setting, no LAN discovery,
and an additional service network restriction against public relays. Screen help
uses click-to-accept; file transfer, clipboard, terminal and tunneling features
in RustDesk are disabled. TARDIS itself stays on loopback.

**Connection details** displays commands for the support person:

```bash
ssh -p 2222 tardis-support@WORKSTATION_TAILSCALE_IP
# Optional: inspect TARDIS from your own browser through this SSH tunnel:
ssh -p 2222 -N -L 18091:127.0.0.1:8091 tardis-support@WORKSTATION_TAILSCALE_IP
# Then browse http://127.0.0.1:18091
```

Connect RustDesk directly to `WORKSTATION_TAILSCALE_IP:21118`. The support account
can use `sudo` without the owner's password while support is enabled. This is a
trusted administrator relationship, not a sandbox around the owner's files.

**Pause support** blocks the two ports, stops managed support services/sessions,
and removes the account's sudo grant. It leaves Tailscale connected for the owner's
devices. Revoke the machine share in Tailscale to remove the sharing relationship.
Rerunning installation pauses support; it never silently re-enables it. To replace
the support computer or key, an administrator must update the private root-owned
`/etc/tardis-support/config.json` and rerun setup; never broaden this to every
Tailscale address. Confirm the effective shared source IP if a tailnet IP collision
causes Tailscale to remap an address. Existing restrictive Tailscale policies must
allow the recipient to reach ports 2222 and 21118; do not replace policies with an
allow-all rule. The local firewall adds a restriction, not an override of other rules.

Before leaving: test SSH and `sudo`, an accepted and a rejected desktop connection,
Pause, and reboot from the actual support computer. Real cross-tailnet authorization
needs the owner's sign-in and device share; a sandbox test cannot complete that step.

Installer recovery notes: an interruption after the RustDesk package installs but
before the managed setup marker is written can require administrator inspection
before rerunning (the installer refuses to adopt an ambiguous existing install).
APT may update an existing OpenSSH package and restart its service; perform initial
installation locally. A pre-existing Snap/static Tailscale install needs review:
the support tools expect `/usr/bin/tailscale` and `tailscaled.service` from the DEB.

References: [Tailscale device sharing](https://tailscale.com/docs/features/sharing),
[RustDesk through Tailscale](https://tailscale.com/docs/solutions/access-remote-desktops-with-rustdesk),
[RustDesk Linux limitations](https://rustdesk.com/docs/en/client/linux/).

### Research and the Coordinator

The installer also enables `rallypoint-scan.service`, with a private loopback
connection to the engine and a nightly midnight Eastern scan. Apply RallyPoint
migrations through `0011_scanner_content_bridge.sql` before setup. Content → Ideas
shows scanner health, recent runs, sourced ideas, and Create drafts. Both offices
share this research; database claims prevent duplicate nightly scans and duplicate
idea/format generation. Use the same scanner release in both offices.

To automate drafting, add a routine to Content Coordinator, for example weekdays
at 09:00: “Read content_ideas for Operly and R-Link. For each brand select up to
three strong ideas from the last seven days with no existing writing jobs. Use
content_generate_idea for blog and social-pack drafts, preserving the idea IDs.
Report what needs review. If scans failed, report the failure; do not invent ideas
or repeatedly request scans. Never approve or publish.” Choose the cadence and
volume with Kim; setup does not silently enable a drafting routine. The scanner
collects ideas automatically once her subscription is signed in.

## Private office integrations

To include a separately hosted office MCP, add `--office-config /private/path/office.json`
to the USB build command. That private JSON contains `TARDIS_OFFICE_MCP_URL`,
`TARDIS_OFFICE_MCP_TOKEN` and `TARDIS_OFFICE_ADMIN_TOKEN`. Use an HTTPS service root
and distinct agent/admin tokens of at least 32 characters. The builder includes
these credentials in `integrations.json`; keep the entire kit private.
Reruns preserve the installed connection and refuse to mix different office credentials.

The hosted hub stores private memory and tool activity in its own database;
shared brand content remains in RallyPoint. Claude, Codex and Grok receive the
configured agent connection. Their subscription processes do not receive the
separate admin token.

Open **Plugins > Integrations** to connect Gmail, Slack, GoHighLevel, web search,
Railway and Supabase. Gmail first needs a Google OAuth web application: register
the redirect URI shown by the setup form, save its client ID and secret, then
connect each account using Google sign-in. The other integrations need authorized
tokens for the intended accounts. These account connections are not included
in the installer.

Agents prepare external changes for review in the same Integrations screen.
Review the request and choose **Approve & run** or **Decline**. If an action fails
or partially completes, inspect its results and the destination before retrying.
Memory storage works without connecting these external accounts. Without an
explicit office configuration, the optional hub stays disconnected.

## Guided first day

The USB includes `START-HERE.html` and `RECOVERY.txt` for offline instructions.
After installation, TARDIS opens `/setup`: connection checks, explicit subscription
tests, a saved blog/social walkthrough, media settings, a weekday routine and safe
diagnostics. Choose **Open my team on future logins** when ready; the guide remains
available under Plugins. **TARDIS Help** shows local service state without restarting.

The walkthrough tracks saved drafts, edited revisions, approvals and persistence
across a Linux reboot. Editorial review remains a human step. Daily drafting is off
until enabled and runs in the computer's time zone. The scanner uses midnight Eastern.
Image uploads are decoded, stripped of metadata and stored in the public
`draft-images` bucket. Upload only publishing assets. Video footage stays in the
local workspace for Video Editor; uploads are capped at 200 MB. Optional Google
image and fal.ai video credentials are entered on this installation and are never
included in browser status or diagnostic exports. Provider charges are separate.
The AMD preinstalled generation applications are not automatically connected.
