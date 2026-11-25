'use strict';

const assert = require('node:assert/strict');
const {
  parseProcessCommandAndEnv,
  verifyProcessDetails,
  decideAction,
  repairInstallation,
  parseSavedWatcherPid,
} = require('../src/watcher');

assert.equal(parseSavedWatcherPid(31375), 31375);
assert.equal(parseSavedWatcherPid({ pid: 31375 }), 31375);
assert.equal(parseSavedWatcherPid(null), null);
assert.equal(parseSavedWatcherPid({}), null);

// Ensure env parsing takes the last occurrence when duplicate keys appear in ps eww output.
const parsed = parseProcessCommandAndEnv(
  '/Applications/.ClaudeSpoof/Claude.app/Contents/MacOS/Claude --lang=en-US --lang=en-GB TZ=Asia/Shanghai TZ=Europe/London LANG=en_GB.UTF-8 LC_ALL=en_GB.UTF-8 LANGUAGE=en-GB',
);
assert.equal(parsed.environment.TZ, 'Europe/London');
assert.equal(parsed.languageArgument, 'en-GB');

const expected = {
  executable: '/Applications/.ClaudeSpoof/Claude.app/Contents/MacOS/Claude',
  timezone: 'Europe/London',
  language: 'en-GB',
};
const validDetails = {
  pid: 123,
  executable: expected.executable,
  environment: {
    TZ: 'Europe/London',
    LANG: 'en_GB.UTF-8',
    LC_ALL: 'en_GB.UTF-8',
    LANGUAGE: 'en-GB',
  },
  languageArgument: 'en-GB',
};
assert.deepEqual(verifyProcessDetails(validDetails, expected), { verified: true, reasons: [] });
assert.deepEqual(verifyProcessDetails({
  ...validDetails,
  environment: { ...validDetails.environment, TZ: 'Asia/Shanghai', LANG: 'zh_CN.UTF-8' },
}, expected), { verified: false, reasons: ['TZ', 'LANG'] });
assert.deepEqual(verifyProcessDetails({ ...validDetails, languageArgument: null }, expected), {
  verified: false,
  reasons: ['--lang'],
});
assert.deepEqual(verifyProcessDetails(null, expected), {
  verified: false,
  reasons: ['process-unavailable'],
});

const config = { enabled: true, timezone: 'Europe/London', language: 'en-GB' };
const verifiedProcess = { ...validDetails, verified: true };
const directProcess = { ...validDetails, environment: { ...validDetails.environment, TZ: 'Asia/Shanghai' }, verified: false };

assert.equal(decideAction({ config, processes: [], wrapperOverwritten: false }), 'idle');
assert.equal(decideAction({ config, processes: [verifiedProcess], wrapperOverwritten: false }), 'verified');
assert.equal(decideAction({ config, processes: [directProcess], wrapperOverwritten: false }), 'restart');
assert.equal(decideAction({ config, processes: [verifiedProcess], wrapperOverwritten: true }), 'restart');
assert.equal(decideAction({ config, processes: [], wrapperOverwritten: true }), 'repair-wrapper');
assert.equal(decideAction({ config: { ...config, enabled: false }, processes: [directProcess], wrapperOverwritten: true }), 'disabled');

// Regression test: repair-wrapper when Claude is NOT running must NOT launch Claude.
let startCalled = false;
let repairCalled = false;
const repairResult = repairInstallation(
  {
    appPath: '/Applications/Claude.app',
    realPath: '/Applications/.ClaudeSpoof/Claude.app',
    wrapperOverwritten: true,
    action: 'repair-wrapper',
    config,
    processes: [],
  },
  {
    repairWrapper: () => {
      repairCalled = true;
      return { realPath: '/Applications/.ClaudeSpoof/Claude.app', backupPath: '/tmp/backup.app' };
    },
    startEnvironment: () => {
      startCalled = true;
      return { pid: 999 };
    },
  },
);
assert.equal(repairCalled, true);
assert.equal(startCalled, false, 'repair-wrapper must not launch Claude when it was closed');
assert.equal(repairResult.launched, false);
assert.equal(repairResult.pid, null);

console.log('watcher tests passed');
