#!/usr/bin/env node
'use strict';
/**
 * wbipc — drive the WorkBuddy local IPC broker from the shell.
 *
 * Usage:
 *   node scripts/wbipc.js broker/ListPipes
 *   node scripts/wbipc.js broker/GetPipe '{"pipe":"wb.request"}'
 *   node scripts/wbipc.js wb.request http.fetch '{"method":"GET","path":"/a2a/cards/self"}'
 *
 * The first form calls a reserved broker method directly. The second form
 * (pipe + method) resolves the pipe to its channel first, then calls it.
 */

const wbipc = require('../lib/wbipc');

function usage() {
  process.stderr.write(
    'Usage: node scripts/wbipc.js <pipe> [method] [paramsJson]\n' +
    '\n' +
    'Examples:\n' +
    '  node scripts/wbipc.js broker/ListPipes\n' +
    '  node scripts/wbipc.js broker/GetPipe \'{"pipe":"wb.request"}\'\n' +
    '  node scripts/wbipc.js wb.request http.fetch \'{"method":"GET","path":"/a2a/cards/self"}\'\n',
  );
}

async function main() {
  const pipe = process.argv[2];
  if (!pipe || pipe === '-h' || pipe === '--help') {
    usage();
    process.exit(pipe ? 0 : 1);
  }
  const method = process.argv[3] || '';
  let params = {};
  if (process.argv[4]) {
    try {
      params = JSON.parse(process.argv[4]);
    } catch (err) {
      process.stderr.write(`params must be valid JSON: ${err.message}\n`);
      process.exit(2);
    }
  }

  const client = await wbipc.connectDefault('wbipc-cli');
  try {
    let target = pipe;
    let args = params;
    if (method) {
      const info = await wbipc.getPipe(client, pipe);
      target = `${info.channel}/${method}`;
    }
    const result = await client.call(target, args);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally {
    client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`ERR ${err.message}${err.code ? ` (code=${err.code})` : ''}\n`);
  process.exit(1);
});
