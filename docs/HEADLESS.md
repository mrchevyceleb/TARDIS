# Headless browsers per lane

Web-only work should not queue behind whoever holds the desktop. Every lane
gets its own headless Chromium on the TARDIS host, running in parallel.

## Routing rule (injected into every lane's computer block each turn)

Headless first for web pages, previews, dashboards and form checks. Use the
desktop (`computer_*`) only for native apps, sites that block headless (Google
sign-in, Meta Ads), MFA or human handoff, or when the person wants to watch.

## How it works

- `server/src/headless/pool.ts` owns the browsers inside the TARDIS server (one
  process, so the cap is global). A lane is a Playwright persistent context on
  `~/.rivendell/headless/<lane>/profile` (0700), so logins survive idle closes
  and restarts. Session cookies are kept as 14-day cookies for the same reason.
- Cap: `RIVENDELL_HEADLESS_MAX_LANES` (default 6). A new lane evicts the least
  recently used lane that has been idle for a minute; if every lane is busy it
  says the pool is full. Idle lanes close after `RIVENDELL_HEADLESS_IDLE_MINUTES`
  (default 10) and reopen on the next call. TARDIS closes lanes gracefully on
  shutdown so a fresh login reaches disk.
- `server/scripts/headless-mcp.mjs` is the `rivendell-headless` MCP every lane
  gets (`headless_navigate`, `snapshot`, `click`, `type`, `press`, `select`,
  `screenshot`, `text`, `wait`, `tabs`, `console`, `session`). It calls
  `/api/headless/<op>` with a per-boot token, like the computer MCP.
- Max 8 tabs per lane. `file:` and other non-http URLs are refused. Page text is
  untrusted data.

## Session import

`headless_session { action: "import", domains: ["app.example.com"] }` copies one
site's login from the desktop browser profile (default: snap Chromium on Moria,
override with `RIVENDELL_DESKTOP_PROFILE`) into the calling lane's profile.

- Cookies: read from a copy of the desktop `Cookies` db (v10 and keyring v11
  values decrypted in memory) and added to the lane context.
- localStorage: read from a copy of the desktop `Local Storage/leveldb` by a
  throwaway Chromium, then written into the lane at the site's origin.
- Not copied: sessionStorage, IndexedDB, partitioned third-party cookies.
- Explicit domains only (max 5). Values are never returned or logged; the lane
  sees counts and host names. Every import is appended to
  `~/.rivendell/headless/audit.jsonl` (agent, domains, counts). The person must
  already be signed in on the desktop browser.
- Sites that sign in with Google or require MFA still need the desktop.
