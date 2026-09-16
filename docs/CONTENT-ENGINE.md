# Subscription content gateway

RallyPoint runs as a headless content engine. Its model requests go through
TARDIS so agents and content jobs use the same three subscription choices:
Claude Code, Codex with ChatGPT, and Grok with SuperGrok OAuth.

Sign into the native Claude Code and Codex CLIs on the server. Connect Grok
using `/xai-oauth`. Metered API keys and provider fallback are disabled. Existing
agents saved with a retired engine migrate to Claude with a new brain revision;
their identity and durable conversations are retained.

Set a long random `RIVENDELL_CONTENT_TOKEN` on TARDIS and configure the same
dedicated token in the content engine. It is a server secret, never frontend
configuration. The gateway is disabled until this value is configured. Keep
both services on loopback or behind the existing trusted private network.

`POST /internal/content/v1/chat/completions` requires
`Authorization: Bearer <content-token>` and JSON:

```json
{
  "model": "claude",
  "messages": [{ "role": "user", "content": "Draft a product announcement." }],
  "stream": false
}
```

Models are `claude`, `codex`, `xai`, or `engine/model-id`. The default model is
the corresponding agent engine's default. Optional inputs include
`reasoning_effort`, `response_format`, `max_tokens`, `temperature`, function
`tools`, and `tool_choice` (`auto`, `none`, `required`, or a named function).
Only text chat messages are supported, including assistant tool-call records
and tool-result messages. CLI adapters treat output-format and length requests
as instructions; callers must validate their domain JSON before saving it.

Responses use the OpenAI nonstreaming `choices[0].message` shape. Function calls
are returned in `message.tool_calls`; only RallyPoint's deterministic dispatcher
may execute them. Claude uses safe mode without tools or MCP. Codex runs in an
empty directory with a read-only sandbox and a local transport that removes
all native tool definitions before sending to the fixed ChatGPT endpoint.
Native CLI login and token refresh still handle authentication. The gateway
does not create conversational agent turns or expose desktop/shell tools.

The gateway accepts two concurrent generations, rejects additional requests
with 429 and `Retry-After`, limits request JSON to 2 MB, and aborts work after
four minutes or client disconnect. CLI child processes and temporary files
are cleaned up. Authentication errors return 401, invalid requests 400,
upstream failures 502, and generation timeouts 504. Subscription limits and
model access still apply; failures never switch to a paid API-key provider.

Use current Claude Code and Codex versions supporting safe mode and
`codex exec --ignore-user-config`. If Codex is not directly executable from
the server's PATH, set `RIVENDELL_CODEX_BIN` to its native executable.

## Publishing account setup

Content → Connections uses Ayrshare for social account linking. Administrator
setup accepts an API key and a separate brand Profile Key, or creates a new
profile under the existing Ayrshare plan. Credentials stay in the engine's
private `~/.rallypoint/ayrshare.json`; browsers receive only status and account
names. `RALLYPOINT_AYRSHARE_PATH` overrides this file for isolated testing.

Connect accounts requests a short-lived URL from Ayrshare's
`POST /profiles/link-sessions`, opens it in a separate browser tab and refreshes
verified account status when the user returns. No private signing key or email
delivery is required. The supported publishing destinations remain Facebook,
Instagram, LinkedIn and X. X needs developer credentials. An Ayrshare profile
takes precedence over legacy GHL social settings, without silently falling back
to another provider. GHL blogs remain a separate connection; email is draft-only.

Provider reference: [Ayrshare link sessions](https://www.ayrshare.com/docs/apis/profiles/create-link-session),
[profile creation](https://www.ayrshare.com/docs/apis/profiles/create-profile),
[verified account details](https://www.ayrshare.com/docs/apis/user/profile-details).
