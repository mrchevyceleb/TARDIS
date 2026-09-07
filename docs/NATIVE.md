# Native apps

TARDIS ships two native shells over the same server: a desktop app for Windows, macOS, and Linux, and an Android app you sideload. Both are thin windows onto one always-on TARDIS server. The server keeps every thread, file, agent, and setting; the shells remember only where the ship is. Install as many as you like, and they all show the same console.

## Download

Every tagged release on the GitHub **Releases** page carries:

| File | For |
| --- | --- |
| `TARDIS-Setup-<version>.exe` | Windows 10 and 11 |
| `TARDIS-<version>-mac-arm64.dmg` | Apple silicon Macs |
| `TARDIS-<version>-mac-x64.dmg` | Intel Macs |
| `TARDIS-<version>-linux-x64.AppImage` | Linux |
| `TARDIS-<version>-android.apk` | Android 10 and later |

The `.zip`, `.blockmap`, and `latest*.yml` files next to them feed the desktop auto-updater. You never need to download those by hand.

## First run

The shell asks **Where is the ship?** Enter the address of the machine that runs your TARDIS server. That is normally the HTTPS address printed by `tailscale serve status` on that machine, such as `https://your-server.your-tailnet.ts.net`. On the server itself, `http://127.0.0.1:8091` works too. The shell checks `/api/health`, then remembers the address.

An address typed without a scheme gets `https://`; only `localhost` defaults to plain HTTP. TARDIS has no login of its own, so plain HTTP across a network hands the whole console to anyone on the path. The desktop app accepts an explicit `http://` address if you insist; the Android app allows plain HTTP to the phone itself only.

Requirements for the address to work:

- The device must reach the server. With Tailscale that means the Tailscale app is installed and signed in on the phone or PC, on the same tailnet.
- The server's `RIVENDELL_ALLOWED_ORIGINS` must include that exact origin, as described in [Home server deployment](DEPLOYMENT.md#private-remote-access-with-tailscale). Without it the console loads but the live connection is refused.

To change the address later:

- **Desktop:** menu *Ship → Change Server Address…* (`Ctrl`/`Cmd` + `Shift` + `,`), or the *Change address* button on the **Dematerialised** screen that appears when the server is unreachable.
- **Android:** long-press the TARDIS icon and choose *Change address*, or use the button on the Dematerialised screen.

Start the desktop app with `--server=https://…` or `TARDIS_URL=https://…` to override the saved address for one launch.

## Windows

Run the installer. It installs per user, needs no administrator rights, and adds a Start menu entry. Builds are not code-signed, so SmartScreen may show *Windows protected your PC*: choose **More info → Run anyway**. Updates download in the background from GitHub Releases and install when you quit.

Workspace links keep using the `rivendell://` handler installed by the Windows helper, exactly as they do in a browser tab.

## macOS

Open the `.dmg` and drag TARDIS to Applications. Builds are not signed or notarized, so the first launch needs **right-click → Open**, or:

```bash
xattr -dr com.apple.quarantine /Applications/TARDIS.app
```

In-place updates need a signed build, so *Help → Releases* opens the download page instead.

## Linux

```bash
chmod +x TARDIS-*.AppImage
./TARDIS-*.AppImage
```

The AppImage updates itself from GitHub Releases.

## Android

1. Download the `.apk` on the phone (or copy it over) and open it.
2. Allow installs from that source when asked (**Settings → Apps → Special access → Install unknown apps**).
3. Open TARDIS and enter the server address.

To update, install the newer APK over the old one. The release workflow signs every APK with the same key, so settings survive updates. An APK signed with a different key (for example a local build) needs an uninstall first.

The app asks for the microphone the first time a voice feature needs it. Files you attach come from the Android picker, downloads land in **Downloads**, and web notifications are not available inside the Android shell.

## Files and links on the desktop

The desktop app owns the local side of the workspace, so agent links open real files on that computer and files move to the ship without path gymnastics:

- **Workspace links open locally.** A `ASSISTANT-HUB/…` link opens the file or folder from the local copy of the workspace with that machine's own apps. The app finds the copy on its own (`C:\ASSISTANT-HUB`, a OneDrive folder, or `~/ASSISTANT-HUB`) and you can point it elsewhere with *Ship → Local Workspace Folder…*. No PowerShell helper is needed.
- **Unsynced files still open.** When a file is not on this machine, the app fetches a copy from the ship and opens that. The copy is kept and reused, so edits to it survive; *Ship → Clear Fetched Copies* forgets them all and the next click fetches fresh. Files over 512 MB open in the browser instead.
- **Displayed paths match this machine.** Links show the path as it exists here, whatever the folder is called.
- **Drop a file, it is on the ship.** Drop any file onto the console and it is uploaded to the workspace `inbox/` folder; its workspace path is added to your draft so you can tell a companion about it. Images dropped on the composer stay attachments, as before. This part also works in a browser.

## Letting agents use this computer

**Full desktop control** is also available on Windows and GNOME X11: agents
can see monitors and operate native apps with mouse and keyboard through the
same outbound link. The Computer section above the composer selects the target.
A separate native warning grants five minutes of broad desktop access; use the
floating Stop control window, Ship menu, or Ctrl/Command + Alt + Shift + Escape
to revoke. GUI control is **not** confined by the structured file rules below.
See [Computer use](COMPUTER-USE.md) for host setup, model/vision support,
permissions, unsupported platforms and screenshot privacy.

While the desktop app is open, your companions can work on that machine: run a command, read or write a file, list a folder, or open something in its normal app. The app dials the server, so nothing listens for connections on your PC, and the machine appears to agents only while the app is running.

**For the structured command tool, you approve every command on the machine itself.** Each one shows a dialog with the exact command line and the folder it will run in, and the only answers are *Run once* and *No*. There is deliberately no "always allow this command": the same words run different code once a script or a package file changes, and an agent that has read a poisoned web page should never inherit a standing licence on your PC. A refusal is a normal answer, and companions are told to report it rather than work around it.

**Files are gentler.** Reading and writing inside your workspace folder needs no prompt. Anything outside asks first, and you can allow a folder for one kind of access: allowing reads in a folder never also allows writes or launches there. Writing a file your computer would run always asks, even inside the workspace.

**Some things are never shared, approved or not.** Credential stores are refused outright: SSH, GPG, AWS, Azure, gcloud, Kubernetes, Docker, keyrings and browser profiles, along with files such as `.npmrc`, `.netrc`, `.git-credentials`, `.env*`, and private keys or certificates. Opening a file the system would run is refused too, so an agent cannot write a script and then launch it without a command ever appearing on screen.

Controls live in the *Ship* menu:

- **Allow Agents on This Computer** turns the whole thing off and on. It is on by default.
- **Forget Approvals** clears every "always allow" you have granted.

Remember that TARDIS has no login of its own, so anyone who can reach your server can ask your computer to do these things, and so can an agent that has been talked into it by something it read. The approval prompts are what stand in the way; treat a command you did not expect as a reason to say no.

Two limits worth knowing. A path is checked after resolving symlinks and opened without following one, but no operating system lets an app hold a folder still while a person reads a dialog, so this is a strong guard rather than a sealed box. And a command you approve runs as you, with everything you can reach; the prompt is a decision about trust, not a sandbox.

## What the shells handle

- Links to other sites open in the default browser; the console stays in the app.
- The window and system bars follow the console theme (Console room or Classic console).
- When the server is unreachable, a **Dematerialised** screen retries on its own and offers to change the address.
- Microphone access, file pickers, clipboard, and fullscreen work for the server origin only.

## Building locally

Desktop (any OS with Node 22+):

```bash
cd desktop
npm install
npm start                       # runs the shell; TARDIS_URL=https://… skips the connect screen
npm run dist                    # installers for the current OS in desktop/out/
```

Android (JDK 17 and an Android SDK; set `ANDROID_HOME`):

```bash
cd android
./gradlew :app:assembleDebug    # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease  # signed with android/keystore.properties when present
```

`android/keystore.properties` (never committed) holds `storeFile`, `storePassword`, `keyAlias`, and `keyPassword`. Without it, release builds are signed with the debug key.

## Releasing

Versions come from the root `package.json`; the desktop package and the Android `versionName` follow it. To cut a release:

```bash
npm version minor          # bumps package.json, syncs desktop/, commits, tags v<version>
git push --follow-tags
```

The **Release** workflow builds the Windows, macOS, Linux, and Android artifacts and publishes them on the matching GitHub Release. The Android signing key comes from the repository secrets `ANDROID_KEYSTORE_B64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. A tagged release fails without them, on purpose: a runner-generated debug key changes every build, and phones refuse updates signed by a different key. Keep a copy of the keystore somewhere safe, because a lost key means every phone has to uninstall before the next update.

Run the workflow manually from the Actions tab to build artifacts from any branch without publishing a release. Manual builds without the secrets are signed with a debug key.
