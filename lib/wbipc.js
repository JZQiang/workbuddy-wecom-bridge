'use strict';
/**
 * WBIPC client — talks to the WorkBuddy desktop app's local IPC broker.
 *
 * The WorkBuddy desktop app exposes a local, per-user IPC endpoint (a Windows
 * named pipe, or a Unix domain socket on macOS/Linux). A small set of "pipes"
 * are published on it; the one this library uses is `wb.request`, whose
 * `http.fetch` method proxies an HTTP request through the app's own
 * authenticated backend session.
 *
 * That is the whole point: the WeCom credentials live only in the running app's
 * memory, so a local IPC hop is the supported way for a sibling process to
 * borrow them.
 *
 * Wire format: newline-delimited JSON over the socket. Each request carries a
 * `mode` field ("call" or "stream").
 *
 * This module has no dependencies beyond the Node standard library.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const PROTOCOL_VERSION = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 3000;
const DEFAULT_CALL_TIMEOUT_MS = 30000;

const REQUEST_PIPE = 'wb.request';
const HTTP_FETCH = 'http.fetch';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** Root of the WorkBuddy config dir (holds wbipc/endpoint.json). */
function configDir() {
  const fromEnv = (process.env.WORKBUDDY_CONFIG_DIR || '').trim();
  if (fromEnv) return fromEnv;
  return path.join(os.homedir() || process.env.HOME || '', '.workbuddy');
}

/** Path to the discovery file that advertises the endpoint + ticket. */
function discoveryPath(dir = configDir()) {
  return path.join(dir, 'wbipc', 'endpoint.json');
}

/**
 * Read {endpoint, ticket} from the discovery file.
 * Returns undefined when the app isn't running or the file is unreadable.
 */
function readDiscovery(dir = configDir()) {
  let raw;
  try {
    raw = fs.readFileSync(discoveryPath(dir), 'utf8');
  } catch {
    return undefined;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    parsed &&
    typeof parsed.endpoint === 'string' && parsed.endpoint &&
    typeof parsed.ticket === 'string' && parsed.ticket
  ) {
    return { endpoint: parsed.endpoint, ticket: parsed.ticket };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Ticket proof (HMAC-SHA256 over a length-prefixed transcript)
// ---------------------------------------------------------------------------

function encodeTranscript(role, t) {
  const domain = role === 'server' ? 'wbipc-s' : 'wbipc-c';
  const parts = [domain, String(t.protocol), t.endpoint, t.clientNonce, t.serverNonce];
  const chunks = [];
  for (const part of parts) {
    const buf = Buffer.from(part, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(buf.length, 0);
    chunks.push(len, buf);
  }
  return Buffer.concat(chunks);
}

function computeProof(ticket, role, transcript) {
  return crypto
    .createHmac('sha256', Buffer.from(ticket, 'utf8'))
    .update(encodeTranscript(role, transcript))
    .digest('base64url');
}

function ticketIdOf(ticket) {
  return crypto.createHash('sha256').update(ticket, 'utf8').digest('hex').slice(0, 16);
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ab.length !== bb.length || ab.length === 0) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

/**
 * Open a session against the broker and resolve once the handshake completes.
 *
 * Resolves to { call(method, params, timeoutMs), close() }.
 * The handshake is mutual: the server proves it holds the ticket before the
 * client does, so a squatter on the endpoint path is detected.
 */
function connect({ endpoint, ticket, clientId = 'wbipc-client' }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ path: endpoint });
    let buffer = Buffer.alloc(0);
    let settled = false;
    let handleFrame = () => {};
    let handleFailure = (err) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      for (;;) {
        const nl = buffer.indexOf(0x0a);
        if (nl < 0) {
          if (buffer.length > MAX_FRAME_BYTES) handleFailure(new Error('frame exceeds limit'));
          return;
        }
        if (nl > MAX_FRAME_BYTES) {
          handleFailure(new Error('frame exceeds limit'));
          return;
        }
        const line = buffer.subarray(0, nl);
        buffer = buffer.subarray(nl + 1);
        if (line.length === 0) continue;
        let parsed;
        try {
          parsed = JSON.parse(line.toString('utf8'));
        } catch {
          handleFailure(new Error('malformed frame'));
          return;
        }
        handleFrame(parsed);
      }
    });

    socket.on('error', (err) => handleFailure(err instanceof Error ? err : new Error(String(err))));

    const send = (frame) => socket.write(`${JSON.stringify(frame)}\n`);

    const clientNonce = crypto.randomBytes(16).toString('base64url');
    const handshakeTimer = setTimeout(
      () => handleFailure(new Error('handshake timeout')),
      HANDSHAKE_TIMEOUT_MS,
    );

    socket.once('connect', () => {
      send({
        type: 'session_hello',
        protocol_min: PROTOCOL_VERSION,
        protocol_max: PROTOCOL_VERSION,
        client_nonce: clientNonce,
        ticket_id: ticketIdOf(ticket),
        client: { kind: 'plugin', id: clientId },
      });
    });

    handleFrame = (f) => {
      if (f.type === 'session_hello_error') {
        handleFailure(new Error(`handshake rejected: ${String(f.code ?? '?')}`));
        return;
      }
      if (f.type === 'session_challenge') {
        const serverNonce = typeof f.server_nonce === 'string' ? f.server_nonce : '';
        const transcript = { protocol: PROTOCOL_VERSION, endpoint, clientNonce, serverNonce };
        if (!serverNonce || !safeEqual(computeProof(ticket, 'server', transcript), f.server_proof)) {
          handleFailure(new Error('endpoint failed to prove ticket possession'));
          return;
        }
        send({ type: 'session_prove', client_proof: computeProof(ticket, 'client', transcript) });
        return;
      }
      if (f.type === 'session_hello_ack') {
        clearTimeout(handshakeTimer);
        const pending = new Map();
        let nextId = 1;

        handleFrame = (frame) => {
          if (frame.id === undefined) return; // notification frame
          const entry = pending.get(frame.id);
          if (!entry) return;
          pending.delete(frame.id);
          clearTimeout(entry.timer);
          if (frame.error) {
            const err = new Error(String(frame.error.message ?? 'request failed'));
            err.code = frame.error.code;
            err.data = frame.error.data;
            entry.reject(err);
            return;
          }
          entry.resolve(frame.result);
        };

        handleFailure = (err) => {
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(err);
          }
          pending.clear();
          socket.destroy();
        };

        settled = true;
        resolve({
          call: (method, params, timeoutMs = DEFAULT_CALL_TIMEOUT_MS) =>
            new Promise((res, rej) => {
              const id = nextId++;
              const timer = setTimeout(() => {
                if (pending.delete(id)) rej(new Error(`call timeout: ${method}`));
              }, timeoutMs);
              pending.set(id, { resolve: res, reject: rej, timer });
              // `mode` is mandatory for channel calls; broker/* methods ignore it.
              send({ jsonrpc: '2.0', id, method, params, mode: 'call' });
            }),
          close: () => {
            for (const entry of pending.values()) {
              clearTimeout(entry.timer);
              entry.reject(new Error('closed'));
            }
            pending.clear();
            socket.destroy();
          },
        });
        return;
      }
      handleFailure(new Error(`unexpected handshake frame: ${String(f.type)}`));
    };
  });
}

/** Connect using the discovery file. Throws a helpful error if absent. */
async function connectDefault(clientId) {
  const discovery = readDiscovery();
  if (!discovery) {
    throw new Error(
      `WorkBuddy IPC endpoint not found at ${discoveryPath()}.\n` +
      'Is the WorkBuddy desktop app running and signed in?',
    );
  }
  return connect({ ...discovery, clientId });
}

// ---------------------------------------------------------------------------
// Pipes
// ---------------------------------------------------------------------------

/** List the pipes this user is allowed to see. */
async function listPipes(client) {
  const res = await client.call('broker/ListPipes', {});
  return (res && res.pipes) || [];
}

/** Resolve a pipe name to its channel handle + callable method names. */
async function getPipe(client, pipe) {
  return client.call('broker/GetPipe', { pipe });
}

/**
 * Open a named pipe and return a callable facade.
 * Resolves to { channel, methods, call(method, params, timeoutMs), close() }.
 */
async function openPipe(pipe, { clientId = 'wbipc-client', client } = {}) {
  const owned = !client;
  const conn = client || (await connectDefault(clientId));
  let info;
  try {
    info = await getPipe(conn, pipe);
  } catch (err) {
    if (owned) conn.close();
    throw err;
  }
  if (!info || typeof info.channel !== 'string' || !info.channel) {
    if (owned) conn.close();
    throw new Error(`pipe unavailable: ${pipe}`);
  }
  return {
    channel: info.channel,
    methods: info.methods || [],
    call: (method, params, timeoutMs) => conn.call(`${info.channel}/${method}`, params, timeoutMs),
    close: () => { if (owned) conn.close(); },
  };
}

// ---------------------------------------------------------------------------
// http.fetch convenience
// ---------------------------------------------------------------------------

/**
 * Issue an HTTP request through the app's authenticated backend session.
 * Returns { status, headers, body (Buffer), text, json }.
 */
async function httpFetch(req, { clientId = 'wbipc-client' } = {}) {
  const pipe = await openPipe(REQUEST_PIPE, { clientId });
  try {
    const params = { method: (req.method || 'GET').toUpperCase(), path: req.path };
    if (req.query) params.query = req.query;
    if (req.headers) params.headers = req.headers;
    if (req.body !== undefined) {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body, 'utf8');
      params.body_b64 = buf.toString('base64');
    }
    const res = await pipe.call(HTTP_FETCH, params, req.timeoutMs || 50000);
    const body = Buffer.from(res.body_b64 || '', 'base64');
    let json;
    try { json = JSON.parse(body.toString('utf8')); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers || {}, body, text: body.toString('utf8'), json };
  } finally {
    pipe.close();
  }
}

// ---------------------------------------------------------------------------
// WeCom credential exchange
// ---------------------------------------------------------------------------

const CREDENTIAL_KINDS = ['wecom-cli', 'wecom-a2a'];

/**
 * Mint a short-lived WeCom access token from the app's live session.
 *
 * kind: 'wecom-cli' (contact/doc/sheet/todo/disk/calendar/meeting/mail) or
 *       'wecom-a2a' (chat retrieval and sending).
 *
 * Returns { token, expiresIn, expiresAt, raw }.
 */
async function mintToken(kind = 'wecom-cli', opts = {}) {
  if (!CREDENTIAL_KINDS.includes(kind)) {
    throw new Error(`unknown credential kind: ${kind} (expected ${CREDENTIAL_KINDS.join(' | ')})`);
  }
  const res = await httpFetch(
    {
      method: 'POST',
      path: `/a2a/credentials/${encodeURIComponent(kind)}/tickets`,
      body: '{}',
      timeoutMs: opts.timeoutMs || 50000,
    },
    opts,
  );
  if (res.status !== 200) {
    throw new Error(`credential exchange failed: HTTP ${res.status} ${res.text.slice(0, 300)}`);
  }
  const data = (res.json && res.json.data) || {};
  const token = data.access_token || data.accessToken || data.ticket || '';
  if (!token) {
    throw new Error(`credential exchange returned no token: ${res.text.slice(0, 300)}`);
  }
  const expiresIn = Number(data.expires_in ?? data.expiresIn ?? 0) || 0;
  return {
    token,
    expiresIn,
    expiresAt: expiresIn ? Date.now() + expiresIn * 1000 : 0,
    raw: res.json,
  };
}

// ---------------------------------------------------------------------------
// Bundled wecom-cli discovery
// ---------------------------------------------------------------------------

/**
 * Locate the `wecom-cli` binary that ships with WorkBuddy.
 *
 * Prefer the build bundled inside the app (`app.asar.unpacked/cli/vendor/...`).
 * That build is tagged `workbuddy-local` and carries its own base URL, so it
 * runs standalone. The copy under `plugins/cache/...` is tagged plain
 * `workbuddy` and expects the app to inject a loopback proxy URL
 * (`WECOM_CLI_BASE_URL` etc.) that only exists while the app is driving it —
 * invoked directly it fails with `893101 NetworkError` against
 * `wecom-a2a.agent-gateway.auth-proxy.local`.
 *
 * Never fall back to a public npm install; the bundled builds carry the custom
 * auth path this bridge depends on.
 */
function findWecomCli() {
  const exe = process.platform === 'win32' ? 'wecom-cli.exe' : 'wecom-cli';

  // Explicit override always wins.
  const override = (process.env.WECOM_CLI_BIN || '').trim();
  if (override && isFile(override)) return override;

  // 1. The standalone build shipped inside the app bundle.
  for (const candidate of bundledCliCandidates(exe)) {
    if (isFile(candidate)) return candidate;
  }

  // 2. Last resort: the plugin-cache copy (needs app-injected proxy env).
  for (const candidate of pluginCacheCliCandidates(exe)) {
    if (isFile(candidate)) return candidate;
  }
  return undefined;
}

function isFile(p) {
  try { return Boolean(p) && fs.statSync(p).isFile(); } catch { return false; }
}

/** App-bundle locations, most specific first. */
function bundledCliCandidates(exe) {
  const out = [];
  const seen = new Set();
  const add = (root) => {
    if (!root) return;
    for (const candidate of [
      path.join(root, 'app.asar.unpacked', 'cli', 'vendor', 'wecom-cli', exe),
      path.join(root, 'resources', 'app.asar.unpacked', 'cli', 'vendor', 'wecom-cli', exe),
    ]) {
      if (!seen.has(candidate)) { seen.add(candidate); out.push(candidate); }
    }
  };

  if (process.platform === 'win32') {
    // Env vars first — but note that a MSYS/git-bash shell does not always
    // export ProgramFiles, so never rely on them alone.
    for (const base of [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']]) {
      if (base) add(path.join(base, 'WorkBuddy'));
    }
    if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'Programs', 'WorkBuddy'));

    // Probe the usual install roots on every drive.
    for (const drive of listWindowsDrives()) {
      for (const dir of ['Program Files', 'Program Files (x86)', 'Programs']) {
        add(`${drive}:\\${dir}\\WorkBuddy`);
      }
    }

    // Definitive answer: ask Windows where the running app lives. The bridge
    // cannot work unless the app is running, so this is always available.
    const running = runningWorkBuddyDir();
    if (running) add(running);
  } else if (process.platform === 'darwin') {
    add('/Applications/WorkBuddy.app/Contents/Resources');
    add(path.join(os.homedir(), 'Applications', 'WorkBuddy.app', 'Contents', 'Resources'));
  }
  return out;
}

/** Drive letters that currently exist, e.g. ['C', 'D']. */
function listWindowsDrives() {
  const drives = [];
  for (let i = 65; i <= 90; i++) {
    const letter = String.fromCharCode(i);
    try {
      fs.accessSync(`${letter}:\\`);
      drives.push(letter);
    } catch { /* not mounted */ }
  }
  return drives;
}

/** Directory containing the running WorkBuddy executable, or undefined. */
function runningWorkBuddyDir() {
  const exeName = 'WorkBuddy.exe';
  const script =
    `$p = Get-Process -Name WorkBuddy -ErrorAction SilentlyContinue | ` +
    `Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path; ` +
    `if ($p) { [Console]::Out.Write((Split-Path $p -Parent)) }`;
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const out = require('node:child_process').execFileSync(
        shell,
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      if (out && !out.includes(exeName) && isFile(path.join(out, exeName))) return out;
      if (out && isFile(path.join(out, exeName))) return out;
    } catch { /* try the next shell */ }
  }
  return undefined;
}

/** Plugin-cache locations (versioned directories under the config dir). */
function pluginCacheCliCandidates(exe) {
  const platformDir = {
    win32: 'win32-x64',
    darwin: process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64',
    linux: process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64',
  }[process.platform];
  if (!platformDir) return [];

  const roots = [
    path.join(configDir(), 'plugins', 'cache'),
    path.join(configDir(), 'plugins', 'marketplaces'),
  ];
  const out = [];
  for (const root of roots) out.push(...scanForCli(root, platformDir, exe));
  return out;
}

/** Shallow recursive scan for <...>/bin/<platformDir>/<exe>. */
function scanForCli(root, platformDir, exe) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'bin') {
          const candidate = path.join(full, platformDir, exe);
          if (isFile(candidate)) found.push(candidate);
          continue;
        }
        walk(full, depth + 1);
      }
    }
  };
  walk(root, 0);
  return found;
}

module.exports = {
  PROTOCOL_VERSION,
  REQUEST_PIPE,
  HTTP_FETCH,
  CREDENTIAL_KINDS,
  configDir,
  discoveryPath,
  readDiscovery,
  connect,
  connectDefault,
  listPipes,
  getPipe,
  openPipe,
  httpFetch,
  mintToken,
  findWecomCli,
  // exported for tests
  computeProof,
  ticketIdOf,
  encodeTranscript,
};
