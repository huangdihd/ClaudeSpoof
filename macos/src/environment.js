#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { loadConfig, stateHome, readJson, writeJson } = require('./config');

const ANTHROPIC_TEAM_ID = 'Q6L2SF6YDW';
const HARDWARE_KEY_GROUP = `${ANTHROPIC_TEAM_ID}.com.anthropic.claude.hwkey`;

const SCRIPT_OR_LANG_TO_POSIX = Object.freeze({
  'zh-hans': 'zh_CN',
  'zh-hant': 'zh_TW',
  zh: 'zh_CN',
  en: 'en_US',
  ja: 'ja_JP',
  ko: 'ko_KR',
  fr: 'fr_FR',
  de: 'de_DE',
  es: 'es_ES',
  pt: 'pt_BR',
  it: 'it_IT',
  nl: 'nl_NL',
  ru: 'ru_RU',
});

function executablePath(appPath) {
  const root = path.resolve(appPath);
  const plist = path.join(root, 'Contents', 'Info.plist');
  let executable = 'Claude';
  if (process.platform === 'darwin' && fs.existsSync(plist)) {
    executable = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleExecutable', plist], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  const result = path.join(root, 'Contents', 'MacOS', executable);
  if (!fs.existsSync(result)) throw new Error(`找不到 Claude 主程序：${result}`);
  return result;
}

function appleLocaleValue(language) {
  const clean = String(language || '').trim();
  const lower = clean.toLowerCase();
  if (SCRIPT_OR_LANG_TO_POSIX[lower]) {
    return SCRIPT_OR_LANG_TO_POSIX[lower];
  }
  const parts = clean.split('-').filter(Boolean);
  if (parts.length >= 2) {
    const lang = parts[0].toLowerCase();
    const region = parts.slice(1).find((part) => /^[A-Za-z]{2}$/.test(part));
    if (region) {
      return `${lang}_${region.toUpperCase()}`;
    }
    const langScript = `${lang}-${parts[1].toLowerCase()}`;
    if (SCRIPT_OR_LANG_TO_POSIX[langScript]) {
      return SCRIPT_OR_LANG_TO_POSIX[langScript];
    }
  }
  return clean.replace(/-/g, '_');
}

function languageEnvironment(language) {
  return `${appleLocaleValue(language)}.UTF-8`;
}

function launchArguments(config, extraArguments = []) {
  const filtered = [];
  for (let i = 0; i < extraArguments.length; i += 1) {
    const arg = String(extraArguments[i]);
    if (/^--lang=/i.test(arg)) continue;
    if (arg === '-AppleLanguages' || arg === '-AppleLocale') {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  return [
    `--lang=${config.language}`,
    '-AppleLanguages', `("${config.language}")`,
    '-AppleLocale', appleLocaleValue(config.language),
    ...filtered,
  ];
}

function openEnvironmentArgs(config) {
  const posix = languageEnvironment(config.language);
  return [
    '--env', `TZ=${config.timezone}`,
    '--env', `LANG=${posix}`,
    '--env', `LC_ALL=${posix}`,
    '--env', `LANGUAGE=${config.language}`,
  ];
}

function launchEnvironment(config, source = process.env) {
  const posix = languageEnvironment(config.language);
  const environment = {
    ...source,
    TZ: config.timezone,
    LANG: posix,
    LC_ALL: posix,
    LANGUAGE: config.language,
  };
  delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function codesign(args) {
  const result = spawnSync('/usr/bin/codesign', args, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const output = `${result.stdout || ''}${result.stderr || ''}`.trim();
  if (result.status !== 0) throw new Error(`codesign 检查失败：${output || `exit ${result.status}`}`);
  return output;
}

function verifyOfficialSignature(appPath) {
  if (process.platform !== 'darwin') throw new Error('官方签名检查只能在 macOS 上执行');
  const root = path.resolve(appPath);
  codesign(['--verify', '--deep', '--strict', root]);
  const details = codesign(['-dv', '--verbose=4', root]);
  const team = details.match(/^TeamIdentifier=(.*)$/m);
  if (!team || team[1].trim() !== ANTHROPIC_TEAM_ID) {
    throw new Error(`Claude 不是 Anthropic 官方签名（TeamIdentifier=${team ? team[1].trim() : 'missing'}）`);
  }
  const entitlements = codesign(['-d', '--entitlements', ':-', '--xml', root]);
  if (!entitlements.includes(`<string>${HARDWARE_KEY_GROUP}</string>`)) {
    throw new Error(`Claude 缺少硬件密钥访问组：${HARDWARE_KEY_GROUP}`);
  }
  return {
    appPath: root,
    teamIdentifier: ANTHROPIC_TEAM_ID,
    hardwareKeyGroup: HARDWARE_KEY_GROUP,
    officialSignature: true,
  };
}

function pgrepUserArgs() {
  const args = [];
  if (typeof process.getuid === 'function') {
    args.push('-u', String(process.getuid()));
  }
  args.push('-x', 'Claude');
  return args;
}

function listClaudePids() {
  const result = spawnSync('/usr/bin/pgrep', pgrepUserArgs(), { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return String(result.stdout || '').trim().split('\n')
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function isClaudeRunning() {
  return listClaudePids().length > 0;
}

function processExecutable(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function isPidAlive(pid) {
  const comm = processExecutable(pid);
  return Boolean(comm && comm.endsWith('/Claude'));
}

function assertNotRunning() {
  if (isClaudeRunning()) {
    const error = new Error('Claude 已在运行，无法确认它是否继承配置的环境。请先完全退出，再由本启动器打开。');
    error.code = 'CLAUDE_RUNNING';
    throw error;
  }
}

function runtimeStatePath() {
  return path.join(stateHome(), 'environment-launch.json');
}

function ensureWatcher(watcherApp) {
  // 延迟加载，避免 environment / watcher / wrapper 之间形成初始化循环。
  const { ensureUpdateWatcher } = require('./watcher');
  return ensureUpdateWatcher({ app: watcherApp || '/Applications/Claude.app' });
}

function activatePid(pid) {
  const result = spawnSync('/usr/bin/osascript', [
    '-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return result.status === 0;
}

function activateManagedRunning(appPath, extraArguments = []) {
  const state = readJson(runtimeStatePath(), null);
  const root = path.resolve(appPath);
  if (!state || state.running !== true || state.appPath !== root || !isPidAlive(state.pid)) return false;
  if (!activatePid(state.pid)) {
    // Fallback to open -a <realPath> which routes cleanly to the specific bundle path.
    const fallback = spawnSync('/usr/bin/open', ['-a', root], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (fallback.status !== 0) throw new Error('Claude 已在运行，但激活现有窗口失败');
  }
  const urlArgs = extraArguments.filter((arg) => /^claude:\/\//i.test(String(arg)));
  if (urlArgs.length > 0) {
    spawnSync('/usr/bin/open', ['-a', root, ...urlArgs], { stdio: 'ignore' });
  }
  const watcher = ensureWatcher(state.watcherApp);
  console.log(`[ClaudeSpoof] 已激活由启动器管理的 Claude（pid=${state.pid}）`);
  return { activated: true, watcher };
}

function findClaudePid(expectedExecutable = null, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  const resolvedExpected = expectedExecutable ? path.resolve(expectedExecutable) : null;
  while (Date.now() < deadline) {
    const pids = listClaudePids();
    for (const pid of pids) {
      if (!resolvedExpected) return pid;
      const comm = processExecutable(pid);
      if (comm && path.resolve(comm) === resolvedExpected) return pid;
    }
    spawnSync('/bin/sleep', ['0.5'], { stdio: 'ignore' });
  }
  return null;
}

function startEnvironment(options = {}) {
  if (process.platform !== 'darwin') throw new Error('官方环境启动器只能在 macOS 上使用');
  const config = loadConfig();
  if (!config.enabled) {
    const error = new Error('ClaudeSpoof 配置已停用（enabled=false）。如需临时使用真实环境，请先启用或移除原入口接管。');
    error.code = 'CLAUDE_SPOOF_DISABLED';
    throw error;
  }
  const appPath = path.resolve(options.app || '/Applications/Claude.app');
  const watcherApp = path.resolve(options.watcherApp || '/Applications/Claude.app');
  const signature = verifyOfficialSignature(appPath);
  const expectedExec = executablePath(appPath);
  const extraArguments = options.extraArguments || [];
  if (!options.skipProcessCheck) {
    if (isClaudeRunning()) {
      if (options.activateIfManaged) {
        const activated = activateManagedRunning(appPath, extraArguments);
        if (activated) {
          const state = readJson(runtimeStatePath(), null);
          return {
            pid: state ? state.pid : null,
            activated: true,
            config,
            signature,
            stateFile: runtimeStatePath(),
            watcher: activated.watcher,
          };
        }
      }
      assertNotRunning();
    }
  }
  const stateFile = runtimeStatePath();
  const urlArgs = extraArguments.filter((arg) => /^claude:\/\//i.test(String(arg)));
  const nonUrlArgs = extraArguments.filter((arg) => !/^claude:\/\//i.test(String(arg)));
  const args = [
    ...openEnvironmentArgs(config),
    appPath,
    ...urlArgs,
    '--args',
    ...launchArguments(config, nonUrlArgs),
  ];
  const opened = spawnSync('/usr/bin/open', args, { stdio: 'inherit' });
  if (opened.error) throw opened.error;
  if (opened.status !== 0) throw new Error(`open 启动失败（exit ${opened.status}）`);
  const pid = findClaudePid(expectedExec);
  if (!pid) throw new Error('Claude 未能通过 LaunchServices 启动');
  writeJson(stateFile, {
    running: true,
    pid,
    appPath,
    watcherApp,
    timezone: config.timezone,
    language: config.language,
    mode: 'official-signature-environment',
    launchedVia: 'open',
    signature,
    startedAt: new Date().toISOString(),
  });
  const watcher = ensureWatcher(watcherApp);
  console.log(`[ClaudeSpoof] 官方签名环境已启动：${config.timezone} / ${config.language}（pid=${pid}）`);
  return { pid, activated: false, config, signature, stateFile, watcher };
}

module.exports = {
  ANTHROPIC_TEAM_ID,
  HARDWARE_KEY_GROUP,
  executablePath,
  appleLocaleValue,
  languageEnvironment,
  launchArguments,
  launchEnvironment,
  openEnvironmentArgs,
  verifyOfficialSignature,
  listClaudePids,
  isClaudeRunning,
  isPidAlive,
  findClaudePid,
  activateManagedRunning,
  assertNotRunning,
  runtimeStatePath,
  startEnvironment,
};
