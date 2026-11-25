'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  executablePath,
  appleLocaleValue,
  languageEnvironment,
  launchArguments,
  launchEnvironment,
} = require('../src/environment');

const config = { timezone: 'Europe/London', language: 'en-GB' };
assert.equal(languageEnvironment('en-GB'), 'en_GB.UTF-8');
assert.equal(languageEnvironment('zh-Hans'), 'zh_CN.UTF-8');
assert.equal(languageEnvironment('zh-Hant'), 'zh_TW.UTF-8');
assert.equal(languageEnvironment('zh-Hans-CN'), 'zh_CN.UTF-8');
assert.equal(languageEnvironment('zh-Hans-SG'), 'zh_SG.UTF-8');
assert.equal(languageEnvironment('en'), 'en_US.UTF-8');
assert.equal(appleLocaleValue('en-GB'), 'en_GB');
assert.equal(appleLocaleValue('zh-Hans'), 'zh_CN');

assert.deepEqual(launchArguments(config), [
  '--lang=en-GB',
  '-AppleLanguages', '("en-GB")',
  '-AppleLocale', 'en_GB',
]);
for (const arg of launchArguments(config)) {
  assert(!/remote-debugging|ignore-certificate|host-resolver|disable-web-security|ssl-key-log/i.test(arg));
}
const environment = launchEnvironment(config, {
  HOME: '/tmp/test-home',
  ELECTRON_RUN_AS_NODE: '1',
  TZ: 'Asia/Shanghai',
  LANG: 'zh_CN.UTF-8',
});
assert.equal(environment.HOME, '/tmp/test-home');
assert.equal(environment.TZ, 'Europe/London');
assert.equal(environment.LANG, 'en_GB.UTF-8');
assert.equal(environment.LC_ALL, 'en_GB.UTF-8');
assert.equal(environment.LANGUAGE, 'en-GB');
assert.equal(environment.ELECTRON_RUN_AS_NODE, undefined);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-environment-test-'));
const executable = path.join(dir, 'Contents', 'MacOS', 'Claude');
fs.mkdirSync(path.dirname(executable), { recursive: true });
fs.writeFileSync(executable, '');
assert.equal(executablePath(dir), executable);
fs.rmSync(dir, { recursive: true, force: true });
console.log('official environment tests passed');
