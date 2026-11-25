'use strict';

const assert = require('node:assert/strict');
const {
  verifyProcessDetails,
  decideAction,
  parseSavedWatcherPid,
} = require('../src/watcher');

assert.equal(parseSavedWatcherPid(31375), 31375);
assert.equal(parseSavedWatcherPid({ pid: 31375 }), 31375);
assert.equal(parseSavedWatcherPid(null), null);
assert.equal(parseSavedWatcherPid({}), null);

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

// 手动退出后保持关闭；尤其不能因为 wrapper 正常或不存在而主动拉起。
assert.equal(decideAction({
  config, processes: [], wrapperOverwritten: false,
}), 'idle');
assert.equal(decideAction({
  config, processes: [verifiedProcess], wrapperOverwritten: false,
}), 'verified');
assert.equal(decideAction({
  config, processes: [directProcess], wrapperOverwritten: false,
}), 'restart');
assert.equal(decideAction({
  config, processes: [verifiedProcess], wrapperOverwritten: true,
}), 'restart');
assert.equal(decideAction({
  config, processes: [], wrapperOverwritten: true,
}), 'repair-wrapper');
assert.equal(decideAction({
  config: { ...config, enabled: false }, processes: [directProcess], wrapperOverwritten: true,
}), 'disabled');

console.log('watcher tests passed');
