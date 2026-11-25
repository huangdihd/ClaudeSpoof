'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function frameMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function decodeFrames(buf) {
  const results = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = buf.readUInt32BE(offset);
    results.push(JSON.parse(buf.subarray(offset + 4, offset + 4 + len).toString('utf8')));
    offset += 4 + len;
  }
  assert.equal(offset, buf.length, 'should consume all bytes');
  return results;
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claudespoof-win-test-'));
const configPath = path.join(tmpDir, 'config.json');
fs.writeFileSync(configPath, JSON.stringify({
  enabled: true,
  timezone: 'America/New_York',
  language: 'en-US',
  overrideAcceptLanguage: true,
}));
process.env.CLAUDE_SPOOF_CONFIG = configPath;

// Stub real socket connect before loading runtime-probe.js so tests run fully offline.
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function stubConnect() { return this; };

try {
  require('../runtime-probe.js');

  assert.equal(process.env.TZ, 'America/New_York');

  const probeSource = fs.readFileSync(path.join(__dirname, '..', 'runtime-probe.js'), 'utf8');
  assert(!probeSource.includes('net.Socket.prototype.write ='), 'must not globally patch net.Socket.prototype.write');
  assert(!probeSource.includes('/usr/share/zoneinfo/Europe/London'), 'must not hardcode Europe/London');

  // 1. Unrelated socket must NOT be wrapped.
  const normalSock = new net.Socket();
  normalSock.connect(443, 'example.com');
  assert.equal(normalSock.__claudeSpoofCoworkWrapped, undefined);

  // 2. Cowork pipe socket MUST be wrapped and handle fragmented + coalesced JSON-RPC frames.
  const coworkSock = new net.Socket();
  const captured = [];
  coworkSock.write = (buf, cb) => {
    captured.push(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
    if (typeof cb === 'function') cb();
    return true;
  };
  coworkSock.connect('\\\\.\\pipe\\cowork-vm-service');
  assert.equal(coworkSock.__claudeSpoofCoworkWrapped, true);

  const frame1 = frameMessage({ method: 'isRunning' });
  const frame2 = frameMessage({
    method: 'spawn',
    params: { command: '/bin/sh', isResume: false, env: { FOO: 'bar' } },
  });
  const frame3 = frameMessage({
    method: 'spawn',
    params: { command: '/bin/sh', isResume: true },
  });

  // Split frame1 + frame2 across awkward boundaries (2 bytes of header, rest of header + partial body, rest + frame3 coalesced).
  const combined = Buffer.concat([frame1, frame2, frame3]);
  coworkSock.write(combined.subarray(0, 2));
  coworkSock.write(combined.subarray(2, frame1.length + 7));
  coworkSock.write(combined.subarray(frame1.length + 7));

  const decoded = decodeFrames(Buffer.concat(captured));
  assert.equal(decoded.length, 3);
  assert.equal(decoded[0].method, 'isRunning');
  assert.equal(decoded[1].method, 'spawn');
  assert.equal(decoded[1].params.env.FOO, 'bar');
  assert.equal(decoded[1].params.env.TZ, 'America/New_York');
  assert.equal(decoded[2].method, 'spawn');
  assert.equal(decoded[2].params.env.TZ, 'America/New_York');

  console.log('Windows runtime-probe tests passed');
} finally {
  net.Socket.prototype.connect = realConnect;
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
