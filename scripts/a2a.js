#!/usr/bin/env node
'use strict';
/**
 * a2a — talk to the WeCom message agent (A2A) through the app's live session.
 *
 * Usage:
 *   node scripts/a2a.js card
 *   node scripts/a2a.js send "list my 5 most recent chats"
 *   node scripts/a2a.js send "send hello to the team group"
 *   node scripts/a2a.js get <taskId>
 *
 * `send` submits a task and polls until it reaches a terminal state, then
 * prints the agent's reply. Use --no-wait to return the task id immediately.
 */

const crypto = require('node:crypto');

const wbipc = require('../lib/wbipc');

const A2A_BASE = 'https://qyapi.weixin.qq.com/cgi-bin/a2a/api';
const TERMINAL_STATES = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED']);
const POLL_INTERVAL_MS = 4000;
const POLL_TIMEOUT_MS = 180000;

function usage() {
  process.stdout.write(
    'Usage: node scripts/a2a.js <command> [args]\n' +
    '\n' +
    'Commands:\n' +
    '  card                       Fetch the agent card\n' +
    '  send "<instruction>"       Submit a task and wait for the reply\n' +
    '  get <taskId>               Fetch one task by id\n' +
    '\n' +
    'Options for send:\n' +
    '  --no-wait                  Return the task id without polling\n' +
    '  --timeout <seconds>        Poll timeout (default 180)\n',
  );
}

async function call(token, method, path, body) {
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(`${A2A_BASE}${path}`, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { /* leave undefined */ }
  if (!res.ok) {
    const message = (json && json.error && json.error.message) || text.slice(0, 300);
    throw new Error(`HTTP ${res.status}: ${message}`);
  }
  return json;
}

/**
 * Build the message envelope.
 *
 * Two details are load-bearing and easy to get wrong:
 *   - `role` must be the proto enum value `ROLE_USER` (not "USER"/"user").
 *   - `message_id` belongs INSIDE the message object.
 */
function buildEnvelope(text, messageId) {
  return {
    message: {
      message_id: messageId,
      role: 'ROLE_USER',
      parts: [{ kind: 'text', text }],
    },
  };
}

function extractReply(task) {
  const msg = task && task.status && task.status.message;
  const parts = (msg && msg.parts) || [];
  return parts.map((p) => p.text).filter(Boolean).join('\n\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '-h' || command === '--help') {
    usage();
    process.exit(command ? 0 : 1);
  }

  const { token } = await wbipc.mintToken('wecom-a2a');

  if (command === 'card') {
    const card = await call(token, 'GET', '/.well-known/agent-card.json');
    process.stdout.write(`${JSON.stringify(card, null, 2)}\n`);
    return;
  }

  if (command === 'get') {
    const id = rest[0];
    if (!id) throw new Error('get requires a task id');
    const task = await call(token, 'GET', `/tasks/${encodeURIComponent(id)}`);
    process.stdout.write(`${JSON.stringify(task, null, 2)}\n`);
    return;
  }

  if (command === 'send') {
    const noWait = rest.includes('--no-wait');
    const timeoutIdx = rest.indexOf('--timeout');
    let timeoutMs = POLL_TIMEOUT_MS;
    if (timeoutIdx >= 0 && rest[timeoutIdx + 1]) {
      timeoutMs = Number(rest[timeoutIdx + 1]) * 1000;
    }
    const instruction = rest
      .filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1] === '--timeout'))
      .join(' ')
      .trim();
    if (!instruction) throw new Error('send requires an instruction');

    const messageId = `wbipc-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const submitted = await call(token, 'POST', '/message:send', buildEnvelope(instruction, messageId));
    const taskId = submitted && submitted.task && submitted.task.id;
    if (!taskId) throw new Error(`no task id in response: ${JSON.stringify(submitted).slice(0, 300)}`);

    if (noWait) {
      process.stdout.write(`${taskId}\n`);
      return;
    }

    process.stderr.write(`[a2a] task ${taskId} submitted, waiting...\n`);
    const deadline = Date.now() + timeoutMs;
    let task;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      task = await call(token, 'GET', `/tasks/${encodeURIComponent(taskId)}`);
      const state = task && task.status && task.status.state;
      if (TERMINAL_STATES.has(state)) break;
    }

    const state = task && task.status && task.status.state;
    if (!TERMINAL_STATES.has(state)) {
      throw new Error(`timed out waiting for ${taskId} (last state: ${state})`);
    }
    if (state !== 'TASK_STATE_COMPLETED') {
      throw new Error(`task ${taskId} ended in ${state}`);
    }
    const reply = extractReply(task);
    process.stdout.write(reply ? `${reply}\n` : `${JSON.stringify(task, null, 2)}\n`);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
  process.stderr.write(`ERR ${err.message}\n`);
  process.exit(1);
});
