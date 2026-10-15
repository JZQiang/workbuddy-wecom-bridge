---
name: workbuddy-wecom-bridge
description: Use when 借 WorkBuddy 企微登录态发消息/查聊天文档。
version: 1.0.0
author: workbuddy-wecom-bridge contributors
license: MIT
metadata:
  hermes:
    tags:
      - wecom
      - wechat-work
      - enterprise-wechat
      - workbuddy
      - a2a
      - bridge
    related_skills:
      - tencent-messaging-integration
---

# WorkBuddy WeCom Bridge

## When to Use

Use this skill when you need WeCom (企业微信 / Enterprise WeChat) capabilities
from an agent process and one of these is true:

- The user is signed in to the **WorkBuddy desktop app** with a WeCom account,
  and you want to reuse that session instead of provisioning a separate bot.
- You have a stale `~/.config/wecom/*.enc` credential set whose bot subscription
  fails with **`853000 invalid bot_id or secret`** (the secret was rotated or
  the bot was deleted; the cached `Status: authorized` is a historical snapshot
  and must not be trusted).
- You need **contacts / documents / sheets / smart sheets / smart docs / PPT /
  calendar / meetings / todos / WeDrive / mail** operations.
- You need to **search or send WeCom chat messages**, which go through the
  WeCom message agent over A2A.

Do **not** use this skill to scrape a credential file. See "How it works" —
the credential is never on disk.

## Setup

Requirements:

- **Node.js >= 18** (uses the built-in `fetch` and `node:test`).
- The **WorkBuddy desktop app installed and signed in** to WeCom.
- Nothing else. There are no npm dependencies.

```bash
git clone https://github.com/OWNER/workbuddy-wecom-bridge.git
cd workbuddy-wecom-bridge

# 1. Verify the IPC endpoint is reachable
node scripts/pipes.js

# 2. Verify the WeCom identity the app is holding
node scripts/wecom.js identity whoami

# 3. Verify the chat agent is reachable
node scripts/a2a.js card
```

All three should succeed. If step 1 fails, the app is not running or not signed
in — see Troubleshooting.

Optionally install the CLIs on your PATH:

```bash
npm link          # exposes: wbipc, wbipc-pipes, wecom, wecom-a2a
```

## How it works

This is the part worth understanding before you debug anything.

**The credential is not on disk.** The WorkBuddy app holds your WeCom session
in memory and mints short-lived tokens (~2 hours) on demand. Static files like
`bot.enc`, `credentials.enc`, or `connector-states*.json` contain either
encrypted-at-rest material or already-expired tokens. Reading them does not
produce a usable credential, and a token cached by a CLI will return
`853004 cli token expired`.

**The supported path is the app's local IPC broker.** The app publishes a
per-user endpoint (Windows named pipe; Unix domain socket elsewhere) and writes
its location plus a shared ticket to `~/.workbuddy/wbipc/endpoint.json`. A
sibling process connects, performs a mutual HMAC handshake, and can then call
the published pipes. One of them, `wb.request`, exposes `http.fetch`, which
proxies an HTTP request through the app's authenticated backend session.

So the flow is:

```
your process
   │  local IPC (named pipe) + ticket handshake
   ▼
WorkBuddy app  ──►  POST /a2a/credentials/<kind>/tickets
   │                      │
   │                      ▼
   │              short-lived WeCom access token
   ▼
wecom-cli (subprocess)  or  WeCom A2A message agent
```

Two credential kinds are available:

| Kind | Drives | Capabilities |
|---|---|---|
| `wecom-cli` | the bundled `wecom-cli` binary | contacts, docs, sheets, smart sheets, smart docs, PPT, calendar, meetings, todos, WeDrive, mail, media |
| `wecom-a2a` | the WeCom message agent over A2A | chat search/read (1:1 and group), history search, unread triage, shared files, contact/group lookup, group creation, sending text/link/image/file |

## Usage

### Enumerate what's available

```bash
node scripts/pipes.js
```

Typical output:

```
=== wb.entitlement ===
  channel: c:wb.entitlement
  methods: subscription.check
=== wb.request ===
  channel: c:wb.request
  methods: http.fetch
=== wb.wecom-a2a ===
  channel: c:wb.wecom-a2a
  methods: authorize
```

### Call the WeCom CLI

```bash
node scripts/wecom.js identity whoami
node scripts/wecom.js contact users search --keywords "someone"
node scripts/wecom.js doc search --help
```

The wrapper mints a token, points the CLI at a throwaway config dir, and execs
the bundled binary with your arguments. `wecom-cli` is located automatically;
override with `WECOM_CLI_BIN` if you have it somewhere unusual.

The identity model is worth knowing: CLI calls execute **as a bot on behalf of
the authorized human**. Reading the human's data is allowed. Writing is allowed
cross-identity only for the four document types (`doc`, `sheet`, `smartsheet`,
`smartpage`); every other domain can only write data the bot itself created.

### Talk to the chat agent

```bash
# Agent card
node scripts/a2a.js card

# Ask something (read-only)
node scripts/a2a.js send "list my 5 most recent chats"

# Send a message
node scripts/a2a.js send "send 'build is green' to the release group"

# Submit without waiting, then poll later
node scripts/a2a.js send "summarize unread messages" --no-wait
node scripts/a2a.js get task_20260101_1
```

### Use it as a library

```js
const wbipc = require('workbuddy-wecom-bridge');

const { token } = await wbipc.mintToken('wecom-cli');
// ... or ...
const { token: a2aToken } = await wbipc.mintToken('wecom-a2a');

// Arbitrary request through the app's authenticated backend
const res = await wbipc.httpFetch({ method: 'GET', path: '/a2a/cards/self' });
console.log(res.status, res.json);
```

## Protocol reference

Included for debugging and for porting this bridge to other languages.

### Discovery

`~/.workbuddy/wbipc/endpoint.json` (override the root with
`WORKBUDDY_CONFIG_DIR`):

```json
{ "endpoint": "\\\\.\\pipe\\wbipc-<id>", "ticket": "<opaque secret>" }
```

On Windows the endpoint is a named pipe path; elsewhere it is a socket path.
The ticket rotates when the app restarts, so **re-read the file each run**
rather than caching it.

### Handshake

Newline-delimited JSON, one frame per line. The server proves possession of the
ticket *before* the client does, so a process squatting on the endpoint path is
detected rather than trusted.

1. Client → `session_hello`

   ```json
   {
     "type": "session_hello",
     "protocol_min": 1,
     "protocol_max": 1,
     "client_nonce": "<16 random bytes, base64url>",
     "ticket_id": "<sha256(ticket) hex, first 16 chars>",
     "client": { "kind": "plugin", "id": "<any label>" }
   }
   ```

2. Server → `session_challenge` with `server_nonce` and `server_proof`.
   Verify `server_proof` against the transcript below; abort if it mismatches.

3. Client → `session_prove` with `client_proof` → server replies
   `session_hello_ack`.

Proof algorithm — HMAC-SHA256 keyed by the raw ticket string, over a
length-prefixed transcript, base64url-encoded:

```
domain   = 'wbipc-s'  (server)  |  'wbipc-c'  (client)
parts    = [domain, protocol, endpoint, clientNonce, serverNonce]
message  = concat( for p in parts: uint32BE(len(p)) + p )
proof    = base64url( HMAC-SHA256(ticket, message) )
```

### Calls

```json
{ "jsonrpc": "2.0", "id": 1, "method": "<method>", "params": {}, "mode": "call" }
```

**`mode` is mandatory for channel calls.** Omitting it returns
`E_BAD_REQUEST: channel calls require mode: 'call' | 'stream'`. Reserved
`broker/*` methods ignore it, so it is safe to always send.

Reserved methods:

| Method | Params | Returns |
|---|---|---|
| `broker/ListPipes` | `{}` | `{ pipes: [...] }` |
| `broker/GetPipe` | `{ pipe }` | `{ channel, methods }` |

A channel call is `"<channel>/<method>"` — e.g. `c:wb.request/http.fetch`.
The channel handle comes from `broker/GetPipe`; do not guess it.

### `wb.request` / `http.fetch`

| Field | Notes |
|---|---|
| `method` | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE` |
| `path` | Must be relative, start with `/`, contain no `..`, no query string |
| `query` | Object of string values |
| `headers` | Only `content-type` and `accept` are permitted |
| `body_b64` | Standard base64; rejected on `GET`/`HEAD` |

Constraints: responses are capped at 655,360 bytes, and each call times out
after 50 seconds. The response body comes back **base64-encoded** in
`body_b64` — decode it before parsing.

### Credential exchange

```
POST /a2a/credentials/<wecom-cli|wecom-a2a>/tickets   body: {}
→ { "code": 0, "data": { "access_token": "uat1-...", "expires_in": 7098 } }
```

Append `?force_refresh=true` to bypass the app's cache. Tokens last roughly two
hours; re-mint rather than trying to extend.

### A2A (chat agent)

Base URL: `https://qyapi.weixin.qq.com/cgi-bin/a2a/api`

| Operation | Request |
|---|---|
| Agent card | `GET /.well-known/agent-card.json` |
| Submit | `POST /message:send` |
| Fetch | `GET /tasks/{id}` |

Submit envelope — **copy this shape exactly**:

```json
{
  "message": {
    "message_id": "<unique string>",
    "role": "ROLE_USER",
    "parts": [{ "kind": "text", "text": "..." }]
  }
}
```

Three traps, all of which produce misleading errors:

- **`role` must be `ROLE_USER`.** Not `USER`, not `user`, not `ROLE_AGENT`.
  Anything else returns `role must be USER`, which reads like a casing problem
  and sends you chasing the wrong fix.
- **`message_id` goes inside `message`**, not at the top level and not in
  `params`.
- **Fetch with `GET /tasks/{id}`.** `POST /tasks/get`, `POST /tasks:get`, and
  `GET /tasks:get` all return 404 or 405.

The response carries a task object under `task` with an id like
`task_20260101_1`. Poll until `status.state` is `TASK_STATE_COMPLETED`
(typically 30–60 seconds); the reply is in `status.message.parts[].text` as
Markdown. Terminal states are `TASK_STATE_COMPLETED`, `TASK_STATE_FAILED`, and
`TASK_STATE_CANCELED`.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `WorkBuddy IPC endpoint not found` | App not running or not signed in. Start it and sign in, then re-run. |
| `handshake rejected: <code>` | Stale ticket — the app restarted. Re-read `endpoint.json` (the scripts do this every run). |
| `endpoint failed to prove ticket possession` | Another process owns the endpoint, or you cached an old ticket. |
| `E_BAD_REQUEST: channel calls require mode` | The RPC frame is missing `mode: "call"`. |
| `unknown pipe: <name>` | That pipe is not visible to this session. Run `node scripts/pipes.js` to see what is. |
| `853000 invalid bot_id or secret` | A stale `bot.enc` credential, not this bridge. Use the IPC path instead. |
| `853004 cli token expired` | You used a CLI's cached token. Re-mint via `scripts/wecom.js`, which isolates the config dir. |
| `role must be USER` | Send `ROLE_USER`, not `USER`. |
| `message_id must not be empty` | `message_id` is not inside the `message` object. |
| `upstream timed out after 50000ms` | `http.fetch` caps at 50s per call. |
| `Could not locate the bundled wecom-cli binary` | Set `WECOM_CLI_BIN` to its full path. |
| `identity whoami` returns `853004` | The token was not picked up. Check `WECOM_CLI_ACCESS_TOKEN` is exported into the CLI's environment. |

## Security

Read this before deploying.

- A minted token **is the signed-in user's identity**. It can read their chat
  history, documents, and contacts. Treat it like a session cookie: never log
  it, never commit it, never paste it into a screenshot or an issue.
- The scripts print tokens only under `WBIPC_DEBUG`, and never write them to
  disk. Keep it that way in any fork.
- **Confirm the recipient with a human before sending any message.** The chat
  agent will happily send to whoever you name.
- The bridge runs as your user account and talks to a local endpoint that is
  protected by a per-user ticket. Do not widen access to it, and do not proxy
  the endpoint over a network interface.
- This project is **unofficial** and relies on the app's internal IPC contract,
  which may change without notice. Pin a version you have tested.

## Platform notes

Verified on Windows with git-bash. Notes for other setups:

- **Native binaries do not accept MSYS-style paths.** `node` and
  `wecom-cli.exe` are native Windows programs; a path like `/c/Users/...` will
  not resolve for them. Convert with `cygpath -w` (the shell wrapper in older
  revisions did this; the Node scripts sidestep it entirely by using
  `path.join` on `os.homedir()`).
- **macOS / Linux** should work through the same protocol — the endpoint is a
  Unix domain socket instead of a named pipe, and `lib/wbipc.js` already builds
  platform-appropriate paths for locating the CLI. It has not been tested
  there; reports welcome.
- `wecom-cli` has **no `auth` subcommand**. Use `identity whoami` to confirm
  the session.

## License

MIT — see [LICENSE](LICENSE).
