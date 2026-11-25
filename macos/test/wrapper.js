'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchArguments } = require('../src/environment');
const {
  WRAPPER_BUNDLE_ID,
  defaultRealPath,
  wrapperInfo,
  resolveIconFile,
  wrapperInfoPlist,
} = require('../src/wrapper');

assert.deepEqual(
  launchArguments({ language: 'en-GB' }, ['claude://example', '--lang=en-US', '-AppleLocale', 'zh_CN']),
  ['--lang=en-GB', '-AppleLanguages', '("en-GB")', '-AppleLocale', 'en_GB', 'claude://example'],
);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wrapper-test-'));
const app = path.join(dir, 'Claude.app');
const real = defaultRealPath(app);
assert.equal(real, path.join(dir, '.ClaudeSpoof', 'Claude.app'));
assert.equal(wrapperInfo(app), null);

// Test icon resolution when CFBundleIconFile omits .icns suffix.
const realRes = path.join(real, 'Contents', 'Resources');
fs.mkdirSync(realRes, { recursive: true });
fs.writeFileSync(path.join(realRes, 'electron.icns'), 'fake-icns');
const icon = resolveIconFile(real, 'electron');
assert.equal(icon.fileName, 'electron.icns');

// Test wrapper Info.plist uses independent bundle ID and declares claude:// URL scheme.
const plist = wrapperInfoPlist(real, icon.fileName, 'AppIcon');
assert(plist.includes(`<string>${WRAPPER_BUNDLE_ID}</string>`));
assert(!plist.includes('<string>com.anthropic.claudefordesktop</string>'));
assert(plist.includes('<key>CFBundleURLTypes</key>'));
assert(plist.includes('<string>claude</string>'));
assert(plist.includes('<key>CFBundleIconName</key><string>AppIcon</string>'));

fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'ClaudeSpoofEnvironment.json'), JSON.stringify({
  kind: 'ClaudeSpoofEnvironment', realPath: real,
}));
assert.equal(wrapperInfo(app).realPath, real);
fs.rmSync(dir, { recursive: true, force: true });
console.log('wrapper tests passed');
