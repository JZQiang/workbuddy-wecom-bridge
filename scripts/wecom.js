#!/usr/bin/env node
'use strict';
/**
 * wecom-cli wrapper — mint a live token, then run the bundled wecom-cli.
 *
 * The bundled CLI reads its credential from the environment, so all this does
 * is mint a fresh token, point the CLI at a throwaway config dir, and exec it
 * with the remaining arguments.
 *
 * Usage:
 *   node scripts/wecom.js identity whoami
 *   node scripts/wecom.js contact users search --keywords "someone"
 *   node scripts/wecom.js todo list --help
 *
 * Anything after the script name is passed straight through to wecom-cli.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wbipc = require('../lib/wbipc');

async function main() {
  const cliArgs = process.argv.slice(2);
  if (cliArgs.length === 0 || cliArgs[0] === '-h' || cliArgs[0] === '--help') {
    process.stdout.write(
      'Usage: node scripts/wecom.js <wecom-cli args...>\n' +
      '\n' +
      'Examples:\n' +
      '  node scripts/wecom.js identity whoami\n' +
      '  node scripts/wecom.js contact users search --keywords "someone"\n' +
      '  node scripts/wecom.js doc search --help\n' +
      '\n' +
      'The bundled wecom-cli is located automatically. Override with WECOM_CLI_BIN.\n',
    );
    return;
  }

  const bin = wbipc.findWecomCli();
  if (!bin) {
    process.stderr.write(
      'Could not locate the bundled wecom-cli binary.\n' +
      'Set WECOM_CLI_BIN to its full path, e.g.\n' +
      '  export WECOM_CLI_BIN="/path/to/WorkBuddy/resources/app.asar.unpacked/cli/vendor/wecom-cli/wecom-cli"\n',
    );
    process.exit(127);
  }

  const { token, expiresIn } = await wbipc.mintToken('wecom-cli');

  // A throwaway config dir keeps this away from any stale on-disk CLI cache.
  const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-cli-bridge-'));

  const env = {
    ...process.env,
    WECOM_CLI_ACCESS_TOKEN: token,
    WECOM_CLI_CONFIG_DIR: cfgDir,
  };

  const child = spawn(bin, cliArgs, { env, stdio: 'inherit' });

  child.on('error', (err) => {
    process.stderr.write(`failed to run wecom-cli: ${err.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch { /* best effort */ }
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });

  if (process.env.WBIPC_DEBUG) {
    process.stderr.write(`[wbipc] token minted (expires in ~${Math.round(expiresIn / 60)} min)\n`);
  }
}

main().catch((err) => {
  process.stderr.write(`ERR ${err.message}\n`);
  process.exit(1);
});
