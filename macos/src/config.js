'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULTS = Object.freeze({
  enabled: true,
  timezone: 'Europe/London',
  language: 'en-GB',
});

function stateHome() {
  return process.env.CLAUDE_SPOOF_HOME || path.join(os.homedir(), 'Library', 'Application Support', 'ClaudeSpoof');
}

function configPath() {
  return path.join(stateHome(), 'config.json');
}

function statePath() {
  return path.join(stateHome(), 'state.json');
}

function ensureHome() {
  fs.mkdirSync(stateHome(), { recursive: true, mode: 0o700 });
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { return fallback; }
}

function writeJson(file, value) {
  ensureHome();
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

function validateTimezone(timezone) {
  if (typeof timezone !== 'string' || !timezone || timezone.length > 100) {
    throw new Error('时区必须是非空 IANA 时区名称，例如 Asia/Tokyo');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); }
  catch (_) { throw new Error(`无效时区：${timezone}`); }
}

function validateLanguage(language) {
  if (typeof language !== 'string' || !/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language)) {
    throw new Error('语言必须是 BCP 47 标签，例如 en-US 或 zh-Hans');
  }
}

function loadConfig() {
  const saved = readJson(configPath(), {});
  const config = Object.assign({}, DEFAULTS, saved);
  delete config.overrideAcceptLanguage; // 1.x 遗留字段；2.x 由 --lang 统一处理
  return config;
}

function updateConfig(patch) {
  const current = loadConfig();
  const next = Object.assign({}, current);
  if (patch.timezone !== undefined) {
    validateTimezone(patch.timezone);
    next.timezone = patch.timezone;
  }
  if (patch.language !== undefined) {
    validateLanguage(patch.language);
    next.language = patch.language;
  }
  if (patch.enabled !== undefined) next.enabled = Boolean(patch.enabled);
  writeJson(configPath(), next);
  return next;
}

module.exports = {
  DEFAULTS,
  stateHome,
  configPath,
  statePath,
  ensureHome,
  readJson,
  writeJson,
  loadConfig,
  updateConfig,
};
