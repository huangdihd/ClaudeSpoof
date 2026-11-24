'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {
  INTEGRITY_DIGEST_SENTINEL,
  calculateIntegrityDigestV1,
  inspectFrameworkBuffer,
  writeFrameworkIntegrityDigest,
} = require('../src/integrity-digest');

function fixture() {
  const data = Buffer.alloc(2048, 0x5a);
  data.writeUInt32LE(0xfeedfacf, 0);
  data.writeUInt32LE(1, 16);
  data.writeUInt32LE(152, 20);
  data.writeUInt32LE(0x19, 32);
  data.writeUInt32LE(152, 36);
  data.writeUInt32LE(1, 96);
  const section = 104;
  data.fill(0, section, section + 32);
  data.write('__asar_integrity', section, 16, 'ascii');
  data.write('__DATA_CONST', section + 16, 16, 'ascii');
  data.writeBigUInt64LE(66n, section + 40);
  data.writeUInt32LE(1024, section + 48);
  INTEGRITY_DIGEST_SENTINEL.copy(data, 1024);
  data.writeUInt8(1, 1024 + INTEGRITY_DIGEST_SENTINEL.length);
  data.writeUInt8(1, 1024 + INTEGRITY_DIGEST_SENTINEL.length + 1);
  Buffer.alloc(32, 0x11).copy(data, 1024 + INTEGRITY_DIGEST_SENTINEL.length + 2);
  return data;
}

const integrity = {
  'Resources/ion-dist.asar': { algorithm: 'SHA256', hash: 'b'.repeat(64) },
  'Resources/app.asar': { algorithm: 'SHA256', hash: 'a'.repeat(64) },
};
const independent = crypto.createHash('sha256');
for (const key of Object.keys(integrity).sort()) {
  independent.update(key);
  independent.update(integrity[key].algorithm);
  independent.update(integrity[key].hash);
}
const expectedHex = independent.digest('hex');
const digest = calculateIntegrityDigestV1(integrity);
assert.equal(digest.sha256Digest.toString('hex'), expectedHex);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-digest-test-'));
try {
  const input = path.join(directory, 'Framework');
  const output = path.join(directory, 'Framework.patched');
  const original = fixture();
  fs.writeFileSync(input, original);
  const first = writeFrameworkIntegrityDigest({ input, output, digest });
  assert.equal(first.changed, true);
  const patched = fs.readFileSync(output);
  assert.equal(inspectFrameworkBuffer(patched).digest.sha256Digest.toString('hex'), expectedHex);
  assert.equal(patched.length, original.length);
  assert.deepEqual(patched.subarray(0, 1024), original.subarray(0, 1024));
  assert.deepEqual(patched.subarray(1090), original.subarray(1090));
  const second = writeFrameworkIntegrityDigest({ input: output, output: `${output}.again`, digest });
  assert.equal(second.changed, false);
  assert.equal(fs.existsSync(`${output}.again`), false);
  console.log(`integrity-digest tests passed: ${expectedHex}`);
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
