'use strict';

const assert = require('node:assert/strict');
const { combinedRequirements, normalizeRequirements } = require('../src/local-signing');

const original = `designated => identifier "com.anthropic.claudefordesktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = Q6L2SF6YDW\n`;
const identity = { sha1: 'b544e1f6021eb92c17f0c377bb31cf5a60e45d21' };
const combined = combinedRequirements(original, 'com.anthropic.claudefordesktop', identity);
assert.match(combined, /^designated => identifier "com\.anthropic\.claudefordesktop" and certificate root = H"b544e1f6021eb92c17f0c377bb31cf5a60e45d21" or identifier "com\.anthropic\.claudefordesktop"/);
assert.ok(normalizeRequirements(combined).includes(normalizeRequirements(original).replace(/^designated => /, '')));
assert.equal(combinedRequirements(combined, 'com.anthropic.claudefordesktop', identity), combined);
const rotated = combinedRequirements(combined, 'com.anthropic.claudefordesktop', { sha1: 'a'.repeat(40) });
assert.ok(rotated.includes(`certificate root = H"${'a'.repeat(40)}"`));
assert.equal(rotated.match(/anchor apple generic/g).length, 1);
assert.equal(rotated.match(/certificate root = H"/g).length, 1);
assert.throws(() => combinedRequirements(original, 'other.bundle', identity), /原 designated requirement/);
assert.throws(() => combinedRequirements(original, 'com.anthropic.claudefordesktop', { sha1: 'bad' }), /指纹无效/);
console.log('local-signing tests passed');
