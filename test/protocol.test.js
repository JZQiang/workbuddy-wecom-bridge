'use strict';
/**
 * Tests for the pure protocol helpers.
 *
 * These run without the WorkBuddy app: they cover the pieces that are easy to
 * get subtly wrong and hard to debug over a live socket (the HMAC transcript
 * encoding, the ticket id derivation, and the A2A envelope shape).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const wbipc = require('../lib/wbipc');

const TICKET = 'test-ticket-value';
const ENDPOINT = '\\\\.\\pipe\\wbipc-test';
const CLIENT_NONCE = 'client-nonce';
const SERVER_NONCE = 'server-nonce';

const transcript = {
  protocol: 1,
  endpoint: ENDPOINT,
  clientNonce: CLIENT_NONCE,
  serverNonce: SERVER_NONCE,
};

test('encodeTranscript length-prefixes every part in order', () => {
  const buf = wbipc.encodeTranscript('client', transcript);
  const parts = ['wbipc-c', '1', ENDPOINT, CLIENT_NONCE, SERVER_NONCE];

  let offset = 0;
  for (const part of parts) {
    const len = buf.readUInt32BE(offset);
    offset += 4;
    assert.strictEqual(len, Buffer.byteLength(part, 'utf8'), `length of ${part}`);
    assert.strictEqual(buf.subarray(offset, offset + len).toString('utf8'), part, `content of ${part}`);
    offset += len;
  }
  assert.strictEqual(offset, buf.length, 'no trailing bytes');
});

test('encodeTranscript uses a distinct domain per role', () => {
  const client = wbipc.encodeTranscript('client', transcript);
  const server = wbipc.encodeTranscript('server', transcript);
  assert.notStrictEqual(client.toString('hex'), server.toString('hex'));

  // The domain is the first length-prefixed part.
  const len = client.readUInt32BE(0);
  assert.strictEqual(client.subarray(4, 4 + len).toString('utf8'), 'wbipc-c');
  const slen = server.readUInt32BE(0);
  assert.strictEqual(server.subarray(4, 4 + slen).toString('utf8'), 'wbipc-s');
});

test('computeProof matches an independent HMAC-SHA256 implementation', () => {
  const message = wbipc.encodeTranscript('client', transcript);
  const expected = crypto
    .createHmac('sha256', Buffer.from(TICKET, 'utf8'))
    .update(message)
    .digest('base64url');

  assert.strictEqual(wbipc.computeProof(TICKET, 'client', transcript), expected);
});

test('computeProof is base64url (no padding, no + or /)', () => {
  const proof = wbipc.computeProof(TICKET, 'client', transcript);
  assert.match(proof, /^[A-Za-z0-9_-]+$/);
  assert.ok(!proof.includes('='), 'no base64 padding');
});

test('computeProof changes when any transcript field changes', () => {
  const base = wbipc.computeProof(TICKET, 'client', transcript);
  const mutations = [
    { ...transcript, protocol: 2 },
    { ...transcript, endpoint: ENDPOINT + 'x' },
    { ...transcript, clientNonce: 'other' },
    { ...transcript, serverNonce: 'other' },
  ];
  for (const mutated of mutations) {
    assert.notStrictEqual(wbipc.computeProof(TICKET, 'client', mutated), base);
  }
});

test('computeProof changes when the ticket changes', () => {
  assert.notStrictEqual(
    wbipc.computeProof(TICKET, 'client', transcript),
    wbipc.computeProof('other-ticket', 'client', transcript),
  );
});

test('ticketIdOf is the first 16 hex chars of sha256(ticket)', () => {
  const expected = crypto.createHash('sha256').update(TICKET, 'utf8').digest('hex').slice(0, 16);
  assert.strictEqual(wbipc.ticketIdOf(TICKET), expected);
  assert.match(wbipc.ticketIdOf(TICKET), /^[0-9a-f]{16}$/);
});

test('discoveryPath honours WORKBUDDY_CONFIG_DIR', () => {
  const previous = process.env.WORKBUDDY_CONFIG_DIR;
  try {
    process.env.WORKBUDDY_CONFIG_DIR = '/tmp/custom-wb';
    assert.strictEqual(
      wbipc.discoveryPath(),
      require('node:path').join('/tmp/custom-wb', 'wbipc', 'endpoint.json'),
    );
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previous;
  }
});

test('readDiscovery returns undefined when the file is missing', () => {
  const previous = process.env.WORKBUDDY_CONFIG_DIR;
  try {
    process.env.WORKBUDDY_CONFIG_DIR = '/nonexistent-workbuddy-dir';
    assert.strictEqual(wbipc.readDiscovery(), undefined);
  } finally {
    if (previous === undefined) delete process.env.WORKBUDDY_CONFIG_DIR;
    else process.env.WORKBUDDY_CONFIG_DIR = previous;
  }
});

test('mintToken rejects an unknown credential kind before any I/O', async () => {
  await assert.rejects(
    () => wbipc.mintToken('not-a-real-kind'),
    /unknown credential kind/,
  );
});

test('CREDENTIAL_KINDS lists both supported kinds', () => {
  assert.deepStrictEqual([...wbipc.CREDENTIAL_KINDS].sort(), ['wecom-a2a', 'wecom-cli']);
});
