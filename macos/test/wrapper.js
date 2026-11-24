'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchArguments } = require('../src/environment');
const { defaultRealPath, wrapperInfo } = require('../src/wrapper');

assert.deepEqual(
  launchArguments({ language: 'en-GB' }, ['claude://example', '--lang=en-US']),
  ['--lang=en-GB', 'claude://example'],
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wrapper-test-'));
const app = path.join(dir, 'Claude.app');
const real = defaultRealPath(app);
assert.equal(real, path.join(dir, '.ClaudeSpoof', 'Claude.app'));
assert.equal(wrapperInfo(app), null);
fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'ClaudeSpoofEnvironment.json'), JSON.stringify({
  kind: 'ClaudeSpoofEnvironment', realPath: real,
}));
assert.equal(wrapperInfo(app).realPath, real);
fs.rmSync(dir, { recursive: true, force: true });
console.log('wrapper tests passed');
