#!/usr/bin/env node
'use strict';
/**
 * pipes — list every IPC pipe this user can see, with its callable methods.
 *
 * Usage: node scripts/pipes.js
 */

const wbipc = require('../lib/wbipc');

async function main() {
  const client = await wbipc.connectDefault('wbipc-pipes');
  try {
    const pipes = await wbipc.listPipes(client);
    if (pipes.length === 0) {
      process.stdout.write('No pipes visible.\n');
      return;
    }
    for (const name of pipes) {
      try {
        const info = await wbipc.getPipe(client, name);
        process.stdout.write(`=== ${name} ===\n`);
        process.stdout.write(`  channel: ${info.channel}\n`);
        process.stdout.write(`  methods: ${(info.methods || []).join(', ') || '(none)'}\n`);
      } catch (err) {
        process.stdout.write(`=== ${name} === ERR ${err.message}\n`);
      }
    }
  } finally {
    client.close();
  }
}

main().catch((err) => {
  process.stderr.write(`ERR ${err.message}\n`);
  process.exit(1);
});
