'use strict';

// Minimal CommonJS port of @electron/asar 4.1.0 integrity-digest v1.
// Keep the existing ASAR 3.x dependency unchanged; Electron 41+ only needs
// this additional whole-dictionary digest in Electron Framework.
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const INTEGRITY_DIGEST_SENTINEL = Buffer.from('AGbevlPCksUGKNL8TSn7wGmJEuJsXb2A', 'ascii');
const DIGEST_VERSION = 1;
const DIGEST_SIZE = 32;
const DIGEST_RECORD_SIZE = INTEGRITY_DIGEST_SENTINEL.length + 2 + DIGEST_SIZE;
const LC_SEGMENT_64 = 0x19;

function readAsarIntegrity(plistPath) {
  const output = execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', plistPath,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const integrity = JSON.parse(output).ElectronAsarIntegrity;
  if (!integrity || typeof integrity !== 'object' || Array.isArray(integrity)
      || Object.keys(integrity).length === 0) {
    throw new Error('Info.plist 中的 ElectronAsarIntegrity 无效');
  }
  for (const [key, value] of Object.entries(integrity)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || typeof value.algorithm !== 'string' || typeof value.hash !== 'string') {
      throw new Error(`ElectronAsarIntegrity 条目无效：${key}`);
    }
  }
  return integrity;
}

function calculateIntegrityDigestV1(asarIntegrity) {
  const hash = crypto.createHash('sha256');
  for (const key of Object.keys(asarIntegrity).sort()) {
    const { algorithm, hash: headerHash } = asarIntegrity[key];
    hash.update(key);
    hash.update(algorithm);
    hash.update(headerHash);
  }
  return { used: true, version: DIGEST_VERSION, sha256Digest: hash.digest() };
}

function fixedString(buffer, offset, length = 16) {
  const bytes = buffer.subarray(offset, offset + length);
  const nul = bytes.indexOf(0);
  return bytes.subarray(0, nul === -1 ? length : nul).toString('ascii');
}

function asarIntegritySection(buffer) {
  if (buffer.length < 32) throw new Error('Framework 不是有效的 Mach-O 文件');
  let littleEndian;
  if (buffer.readUInt32LE(0) === 0xfeedfacf) littleEndian = true;
  else if (buffer.readUInt32BE(0) === 0xfeedfacf) littleEndian = false;
  else throw new Error('仅支持 64 位非通用 Mach-O Framework');
  const u32 = (offset) => littleEndian ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
  const u64 = (offset) => {
    const value = littleEndian ? buffer.readBigUInt64LE(offset) : buffer.readBigUInt64BE(offset);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Mach-O 节大小超出安全范围');
    return Number(value);
  };
  const ncmds = u32(16);
  const sizeofcmds = u32(20);
  if (32 + sizeofcmds > buffer.length) throw new Error('Mach-O load commands 越界');
  let cursor = 32;
  const matches = [];
  for (let index = 0; index < ncmds; index += 1) {
    if (cursor + 8 > buffer.length) throw new Error('Mach-O load command 越界');
    const cmd = u32(cursor);
    const cmdsize = u32(cursor + 4);
    if (cmdsize < 8 || cursor + cmdsize > buffer.length) throw new Error('Mach-O cmdsize 无效');
    if (cmd === LC_SEGMENT_64) {
      if (cmdsize < 72) throw new Error('LC_SEGMENT_64 长度无效');
      const nsects = u32(cursor + 64);
      if (72 + nsects * 80 > cmdsize) throw new Error('Mach-O sections 越界');
      for (let sectionIndex = 0; sectionIndex < nsects; sectionIndex += 1) {
        const section = cursor + 72 + sectionIndex * 80;
        if (fixedString(buffer, section) === '__asar_integrity'
            && fixedString(buffer, section + 16) === '__DATA_CONST') {
          const offset = u32(section + 48);
          const size = u64(section + 40);
          if (offset + size > buffer.length || size < DIGEST_RECORD_SIZE) {
            throw new Error('__DATA_CONST,__asar_integrity 节无效');
          }
          matches.push({ offset, size });
        }
      }
    }
    cursor += cmdsize;
  }
  if (matches.length !== 1) {
    throw new Error(`预期一个 __DATA_CONST,__asar_integrity 节，实际为 ${matches.length}`);
  }
  return matches[0];
}

function digestAt(buffer, sentinelIndex) {
  const usedByte = buffer.readUInt8(sentinelIndex + INTEGRITY_DIGEST_SENTINEL.length);
  const version = buffer.readUInt8(sentinelIndex + INTEGRITY_DIGEST_SENTINEL.length + 1);
  if (usedByte === 0) return { used: false };
  if (usedByte !== 1 || version !== DIGEST_VERSION) {
    throw new Error(`不支持的 Framework integrity digest 格式：used=${usedByte}, version=${version}`);
  }
  return {
    used: true,
    version,
    sha256Digest: Buffer.from(buffer.subarray(
      sentinelIndex + INTEGRITY_DIGEST_SENTINEL.length + 2,
      sentinelIndex + INTEGRITY_DIGEST_SENTINEL.length + 2 + DIGEST_SIZE,
    )),
  };
}

function sameDigest(left, right) {
  if (left.used !== right.used) return false;
  if (!left.used) return true;
  return left.version === right.version && left.sha256Digest.equals(right.sha256Digest);
}

function inspectFrameworkBuffer(buffer) {
  const section = asarIntegritySection(buffer);
  const occurrences = [];
  let cursor = section.offset;
  const end = section.offset + section.size;
  while (cursor < end) {
    const index = buffer.indexOf(INTEGRITY_DIGEST_SENTINEL, cursor);
    if (index === -1 || index >= end) break;
    if (index + DIGEST_RECORD_SIZE > end) throw new Error('Framework digest 记录越过节边界');
    occurrences.push(index);
    cursor = index + INTEGRITY_DIGEST_SENTINEL.length;
  }
  if (occurrences.length === 0) throw new Error('Framework 中找不到 integrity digest 哨兵');
  const allOccurrences = [];
  cursor = 0;
  while (cursor < buffer.length) {
    const index = buffer.indexOf(INTEGRITY_DIGEST_SENTINEL, cursor);
    if (index === -1) break;
    allOccurrences.push(index);
    cursor = index + INTEGRITY_DIGEST_SENTINEL.length;
  }
  if (allOccurrences.length !== occurrences.length
      || allOccurrences.some((offset, index) => offset !== occurrences[index])) {
    throw new Error('integrity digest 哨兵位于 __DATA_CONST,__asar_integrity 之外，已停止');
  }
  const digest = digestAt(buffer, occurrences[0]);
  for (const offset of occurrences.slice(1)) {
    if (!sameDigest(digest, digestAt(buffer, offset))) {
      throw new Error('Framework 中存在多个不同的 integrity digest');
    }
  }
  return { digest, occurrences, section };
}

function getStoredIntegrityDigest(frameworkPath) {
  const result = inspectFrameworkBuffer(fs.readFileSync(frameworkPath));
  return {
    ...result.digest,
    digestHex: result.digest.used ? result.digest.sha256Digest.toString('hex') : null,
    occurrences: result.occurrences,
    section: result.section,
  };
}

function writeFrameworkIntegrityDigest({ input, output, digest }) {
  if (!digest || digest.used !== true || digest.version !== DIGEST_VERSION
      || !Buffer.isBuffer(digest.sha256Digest) || digest.sha256Digest.length !== DIGEST_SIZE) {
    throw new Error('仅支持写入已启用的 v1 SHA-256 integrity digest');
  }
  const source = fs.readFileSync(input);
  const { digest: previous, occurrences } = inspectFrameworkBuffer(source);
  if (sameDigest(previous, digest)) {
    return { changed: false, occurrences, digestHex: digest.sha256Digest.toString('hex') };
  }
  const updated = Buffer.from(source);
  for (const offset of occurrences) {
    const record = offset + INTEGRITY_DIGEST_SENTINEL.length;
    updated.writeUInt8(1, record);
    updated.writeUInt8(DIGEST_VERSION, record + 1);
    updated.fill(0, record + 2, record + 2 + DIGEST_SIZE);
    digest.sha256Digest.copy(updated, record + 2);
  }
  const verification = inspectFrameworkBuffer(updated);
  if (!sameDigest(verification.digest, digest)) throw new Error('写入后的 Framework digest 验证失败');
  if (output) {
    fs.writeFileSync(output, updated);
    const written = inspectFrameworkBuffer(fs.readFileSync(output));
    if (!sameDigest(written.digest, digest)) throw new Error('Framework 临时文件 digest 验证失败');
  }
  return {
    changed: true,
    occurrences,
    previousDigestHex: previous.used ? previous.sha256Digest.toString('hex') : null,
    digestHex: digest.sha256Digest.toString('hex'),
    size: source.length,
    output,
  };
}

function frameworkIntegrityStatus(plistPath, frameworkPath) {
  const expected = calculateIntegrityDigestV1(readAsarIntegrity(plistPath));
  const stored = getStoredIntegrityDigest(frameworkPath);
  return {
    expectedDigestHex: expected.sha256Digest.toString('hex'),
    storedDigestHex: stored.digestHex,
    frameworkIntegrityMatches: stored.used && sameDigest(stored, expected),
    section: stored.section,
    occurrences: stored.occurrences,
    expected,
  };
}

module.exports = {
  INTEGRITY_DIGEST_SENTINEL,
  DIGEST_RECORD_SIZE,
  readAsarIntegrity,
  calculateIntegrityDigestV1,
  asarIntegritySection,
  inspectFrameworkBuffer,
  getStoredIntegrityDigest,
  writeFrameworkIntegrityDigest,
  frameworkIntegrityStatus,
};
