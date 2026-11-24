'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const asar = require('@electron/asar');
const { Pickle } = require('@electron/asar/lib/pickle');

function entriesOf(header) {
  const rows = [];
  function walk(node, prefix) {
    for (const [name, child] of Object.entries(node.files || {})) {
      const filePath = prefix ? `${prefix}/${name}` : name;
      if (child.files) walk(child, filePath);
      else rows.push({ path: filePath, entry: child });
    }
  }
  walk(header, '');
  return rows;
}

function findEntry(header, filePath) {
  return entriesOf(header).find((row) => row.path === filePath);
}

function readArchive(archivePath) {
  const raw = asar.getRawHeader(archivePath);
  const rows = entriesOf(raw.header);
  const fd = fs.openSync(archivePath, 'r');
  try {
    for (const row of rows) {
      const { entry } = row;
      if (entry.unpacked || entry.offset === undefined) {
        row.content = null;
        continue;
      }
      const size = Number(entry.size);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error(`Invalid ASAR entry size: ${row.path}`);
      }
      const content = Buffer.alloc(size);
      if (size > 0) {
        const offset = 8 + raw.headerSize + Number(entry.offset);
        const read = fs.readSync(fd, content, 0, size, offset);
        if (read !== size) throw new Error(`Short read: ${row.path}`);
      }
      row.content = content;
    }
  } finally {
    fs.closeSync(fd);
  }
  return { ...raw, rows };
}

function readEntry(archivePath, filePath) {
  const archive = readArchive(archivePath);
  const row = archive.rows.find((item) => item.path === filePath);
  if (!row || row.content === null) throw new Error(`ASAR entry not found or unpacked: ${filePath}`);
  return row.content;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function integrityForBuffer(content, previous = {}) {
  const algorithm = String(previous.algorithm || 'SHA256').toUpperCase();
  if (algorithm !== 'SHA256') throw new Error(`Unsupported ASAR integrity algorithm: ${algorithm}`);
  const blockSize = Number(previous.blockSize || 4 * 1024 * 1024);
  if (!Number.isSafeInteger(blockSize) || blockSize <= 0) throw new Error('Invalid ASAR integrity blockSize');
  const blocks = [];
  let offset = 0;
  while (offset + blockSize <= content.length) {
    blocks.push(sha256(content.subarray(offset, offset + blockSize)));
    offset += blockSize;
  }
  // @electron/asar always emits a final block, including an empty final block
  // when the file length is an exact multiple of blockSize.
  blocks.push(sha256(content.subarray(offset)));
  return { algorithm: 'SHA256', hash: sha256(content), blockSize, blocks };
}

function contentMatchesIntegrity(content, integrity) {
  if (!integrity) return true;
  const actual = integrityForBuffer(content, integrity);
  return actual.hash === integrity.hash
    && actual.blockSize === integrity.blockSize
    && JSON.stringify(actual.blocks) === JSON.stringify(integrity.blocks);
}

function rewriteArchive({ input, output, transform }) {
  const archive = readArchive(input);
  const changed = [];

  for (const row of archive.rows) {
    if (row.content === null) continue;
    const replacement = transform(row.path, row.content);
    if (replacement !== undefined) {
      if (!Buffer.isBuffer(replacement)) throw new Error(`Transform must return Buffer: ${row.path}`);
      row.content = replacement;
      changed.push(row.path);
    }
  }

  const changedSet = new Set(changed);
  let offset = 0;
  for (const row of archive.rows) {
    if (row.content === null) continue;
    row.entry.offset = String(offset);
    row.entry.size = row.content.length;
    if (changedSet.has(row.path) && row.entry.integrity) {
      row.entry.integrity = integrityForBuffer(row.content, row.entry.integrity);
    }
    offset += row.content.length;
  }

  const headerString = JSON.stringify(archive.header);
  const headerPickle = Pickle.createEmpty();
  headerPickle.writeString(headerString);
  const headerBuffer = headerPickle.toBuffer();
  const sizePickle = Pickle.createEmpty();
  sizePickle.writeUInt32(headerBuffer.length);

  const fd = fs.openSync(output, 'w');
  try {
    fs.writeSync(fd, sizePickle.toBuffer());
    fs.writeSync(fd, headerBuffer);
    for (const row of archive.rows) {
      if (row.content !== null && row.content.length > 0) fs.writeSync(fd, row.content);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  return {
    changed,
    headerHash: sha256(headerString),
    outputSha256: sha256(fs.readFileSync(output)),
    inputSha256: sha256(fs.readFileSync(input)),
    originalHeaderHash: sha256(archive.headerString),
  };
}

function verifyArchive(archivePath, expectedMain) {
  const archive = readArchive(archivePath);
  for (const row of archive.rows) {
    if (row.content !== null && !contentMatchesIntegrity(row.content, row.entry.integrity)) {
      throw new Error(`ASAR file integrity mismatch after rewrite: ${row.path}`);
    }
  }
  const packageRow = archive.rows.find((row) => row.path === 'package.json');
  const mainPackage = JSON.parse(packageRow.content.toString('utf8'));
  if (expectedMain && mainPackage.main !== expectedMain) {
    throw new Error(`Unexpected main entry after rewrite: ${mainPackage.main}`);
  }
  return {
    headerHash: sha256(archive.headerString),
    archiveSha256: sha256(fs.readFileSync(archivePath)),
    main: mainPackage.main,
  };
}

module.exports = {
  entriesOf,
  findEntry,
  readArchive,
  readEntry,
  rewriteArchive,
  verifyArchive,
  sha256,
  integrityForBuffer,
  contentMatchesIntegrity,
};
