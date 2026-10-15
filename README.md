# workbuddy-wecom-bridge

Use a local **WorkBuddy desktop** session to call **WeCom (企业微信 / Enterprise WeChat)** APIs from any agent or script — no separate bot registration, no credential files, no QR-code auth flow.

If you're signed in to WorkBuddy with a WeCom account, this bridge lets a sibling process borrow that session for:

- **Contacts** — search people by name, pinyin, English name, or alias
- **Documents** — docs, sheets, smart sheets, smart docs, online PPT
- **Calendar & meetings** — events, availability, rooms, online meetings, transcripts
- **Todos** — create, query, update, complete
- **WeDrive** — list, search, upload, download, rename
- **Mail** — send, reply, forward, search, read
- **Chat** — search and read 1:1 and group chats, triage unread, find shared files, send messages

> **Unofficial.** This relies on the WorkBuddy app's internal IPC contract, which may change without notice. Pin a version you have tested.

## Why this exists

The obvious approach — reading `~/.config/wecom/*.enc` and subscribing a bot directly — does not work, and it fails in a way that wastes a lot of time:

- The credential files hold either encrypted-at-rest material or **already-expired** tokens. A file that reports `Status: authorized` is a historical snapshot.
- Subscribing with the credentials from those files returns `853000 invalid bot_id or secret`. That error code cannot distinguish "wrong secret" from "bot deleted", so it reads like a bug in your code.
- A CLI that caches its own token returns `853004 cli token expired`, and refreshing it does not help.

The real credential only ever lives in the running app's memory. It mints short-lived tokens (~2 hours) on demand. So the supported way for another process to use it is to ask the app — over the local IPC endpoint the app already publishes for its own plugins.

That's all this project does. It implements the app's IPC handshake, mints a token, and hands it to the tools that can use it.

## Requirements

- **Node.js >= 18** (built-in `fetch`, `node:test`) — no npm dependencies
- **WorkBuddy desktop app**, installed and signed in to WeCom

## Install

```bash
git clone https://github.com/OWNER/workbuddy-wecom-bridge.git
cd workbuddy-wecom-bridge
```

Verify all three layers:

```bash
node scripts/pipes.js                  # 1. IPC endpoint reachable
node scripts/wecom.js identity whoami  # 2. WeCom identity the app holds
node scripts/a2a.js card               # 3. Chat agent reachable
```

Or install the commands on your PATH:

```bash
npm link    # provides: wbipc, wbipc-pipes, wecom, wecom-a2a
```

## Quick start

```bash
# Who am I, according to WeCom?
node scripts/wecom.js identity whoami

# Find a colleague
node scripts/wecom.js contact users search --keywords "Zhang Wei"

# What's on my plate?
node scripts/wecom.js todo list --help

# Read-only chat query — ask the message agent
node scripts/a2a.js send "list my 5 most recent chats"

# Send a message
node scripts/a2a.js send "send 'deploy finished' to the release group"
```

## Commands

| Command | Purpose |
|---|---|
| `node scripts/pipes.js` | List every IPC pipe and its callable methods |
| `node scripts/wbipc.js <pipe> [method] [params]` | Raw IPC call — the escape hatch for anything else |
| `node scripts/wecom.js <args...>` | Mint a token and run the bundled `wecom-cli` with those args |
| `node scripts/a2a.js card` | Fetch the message agent's card |
| `node scripts/a2a.js send "<instruction>"` | Submit a task and wait for the reply |
| `node scripts/a2a.js get <taskId>` | Fetch one task by id |

`send` supports `--no-wait` (print the task id and exit) and `--timeout <seconds>`.

## As a library

```js
const wbipc = require('workbuddy-wecom-bridge');

const { token, expiresIn } = await wbipc.mintToken('wecom-cli');
const { token: a2a } = await wbipc.mintToken('wecom-a2a');

// Arbitrary request through the app's authenticated backend session
const res = await wbipc.httpFetch({ method: 'GET', path: '/a2a/cards/self' });
console.log(res.status, res.json);

// Locate the bundled CLI
console.log(wbipc.findWecomCli());
```

Two credential kinds are available:

| Kind | Drives | Covers |
|---|---|---|
| `wecom-cli` | the bundled `wecom-cli` binary | contacts, docs, sheets, smart sheets, smart docs, PPT, calendar, meetings, todos, WeDrive, mail, media |
| `wecom-a2a` | the WeCom message agent | chat search/read, history, unread triage, shared files, group creation, sending messages |

## Use as an agent skill

`SKILL.md` is written for AI coding agents and carries the full protocol reference, the failure-mode table, and the payload shapes. Drop the repository into your agent's skills directory and it will load on demand:

```bash
# Hermes Agent
cp -r workbuddy-wecom-bridge ~/AppData/Local/hermes/skills/integration/   # Windows
cp -r workbuddy-wecom-bridge ~/.hermes/skills/integration/                # macOS / Linux
```

Any agent that reads `SKILL.md` gets the same content.

## How it works

```
your process
   │  local IPC (named pipe / unix socket) + ticket handshake
   ▼
WorkBuddy app  ──►  POST /a2a/credentials/<kind>/tickets
   │                      │
   │                      ▼
   │              short-lived WeCom access token
   ▼
wecom-cli (subprocess)  or  WeCom message agent (A2A)
```

The app publishes its endpoint and a rotating ticket to `~/.workbuddy/wbipc/endpoint.json`. The handshake is **mutual** — the server proves it holds the ticket before the client does, so a process squatting on the endpoint path is detected rather than trusted.

Full protocol details (handshake frames, HMAC transcript, `http.fetch` constraints, the A2A envelope, every error code) are in **[SKILL.md](SKILL.md)**.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `WorkBuddy IPC endpoint not found` | Start the app and sign in |
| `handshake rejected` / `failed to prove ticket possession` | Stale ticket — the app restarted. Re-read `endpoint.json` (the scripts do this every run) |
| `853000 invalid bot_id or secret` | You're using a stale `bot.enc`, not this bridge |
| `853004 cli token expired` | Re-mint via `scripts/wecom.js`, which isolates the config dir |
| `role must be USER` | Send `ROLE_USER` (see SKILL.md — this error is misleading) |
| `Could not locate the bundled wecom-cli binary` | Set `WECOM_CLI_BIN` to its full path |
| `E_BAD_REQUEST: channel calls require mode` | RPC frame missing `mode: "call"` |

## Security

- A minted token **is the signed-in user's identity.** It can read their chat history, documents, and contacts. Treat it like a session cookie.
- Tokens are never written to disk and only printed under `WBIPC_DEBUG`. Keep it that way in forks.
- **Confirm the recipient with a human before sending any message.**
- The IPC endpoint is protected by a per-user ticket. Don't widen access to it or expose it over a network interface.

## Platform support

Verified on **Windows** (git-bash and native). The protocol is platform-neutral — macOS and Linux use a Unix domain socket instead of a named pipe, and `lib/wbipc.js` already resolves platform-appropriate CLI paths. Untested there; reports welcome.

## Contributing

Issues and PRs welcome. Useful things to know:

- The protocol notes in `SKILL.md` were reverse-engineered from observed behavior. If you find a cleaner explanation for any error code, that's a valuable PR.
- Run `npm test` before submitting — it covers the pure protocol helpers without needing the app running.
- **Never commit a token, a ticket, or real chat content** in a test fixture or issue report.

## License

MIT — see [LICENSE](LICENSE).
