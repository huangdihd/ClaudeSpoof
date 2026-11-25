#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { loadConfig, stateHome, readJson, writeJson } = require('./config');

const ANTHROPIC_TEAM_ID = 'Q6L2SF6YDW';
const HARDWARE_KEY_GROUP = `${ANTHROPIC_TEAM_ID}.com.anthropic.claude.hwkey`;

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

function languageEnvironment(language) {
  return `${language.replace('-', '_')}.UTF-8`;
}

function launchArguments(config, extraArguments = []) {
  return [
    `--lang=${config.language}`,
    ...extraArguments.filter((arg) => !/^--lang=/i.test(String(arg))),
  ];
}

function openEnvironmentArgs(config) {
  return [
    '--env', `TZ=${config.timezone}`,
    '--env', `LANG=${languageEnvironment(config.language)}`,
    '--env', `LC_ALL=${languageEnvironment(config.language)}`,
    '--env', `LANGUAGE=${config.language}`,
  ];
}

function launchEnvironment(config, source = process.env) {
  const environment = {
    ...source,
    TZ: config.timezone,
    LANG: languageEnvironment(config.language),
    LC_ALL: languageEnvironment(config.language),
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

function isClaudeRunning() {
  const result = spawnSync('/usr/bin/pgrep', ['-x', 'Claude'], { stdio: 'ignore' });
  return result.status === 0;
}

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
  return result.status === 0 && result.stdout.trim().endsWith('/Claude');
}

function assertNotRunning() {
  if (isClaudeRunning()) {
    const error = new Error('Claude 已在运行，无法确认它是否继承英国环境。请先完全退出，再由本启动器打开。');
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

function activateManagedRunning(appPath) {
  const state = readJson(runtimeStatePath(), null);
  const root = path.resolve(appPath);
  if (!state || state.running !== true || state.appPath !== root || !isPidAlive(state.pid)) return false;
  const result = spawnSync('/usr/bin/osascript', [
    '-e', 'tell application id "com.anthropic.claudefordesktop" to activate',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error('Claude 已在运行，但激活现有窗口失败');
  const watcher = ensureWatcher(state.watcherApp);
  console.log(`[ClaudeSpoof] 已激活由启动器管理的 Claude（pid=${state.pid}）`);
  return { activated: true, watcher };
}

function findClaudePid(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = spawnSync('/usr/bin/pgrep', ['-x', 'Claude'], { encoding: 'utf8' });
    if (result.status === 0) {
      const pid = Number(String(result.stdout).trim().split('\n')[0]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    spawnSync('/bin/sleep', ['0.5'], { stdio: 'ignore' });
  }
  return null;
}

function startEnvironment(options = {}) {
  if (process.platform !== 'darwin') throw new Error('官方环境启动器只能在 macOS 上使用');
  const config = loadConfig();
  if (!config.enabled) throw new Error('ClaudeSpoof 配置已停用，拒绝未伪装启动');
  const appPath = path.resolve(options.app || '/Applications/Claude.app');
  const watcherApp = path.resolve(options.watcherApp || '/Applications/Claude.app');
  const signature = verifyOfficialSignature(appPath);
  if (!options.skipProcessCheck) {
    if (isClaudeRunning()) {
      if (options.activateIfManaged) {
        const activated = activateManagedRunning(appPath);
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
  const args = [
    ...openEnvironmentArgs(config),
    appPath,
    '--args',
    ...launchArguments(config, options.extraArguments || []),
  ];
  const opened = spawnSync('/usr/bin/open', args, { stdio: 'inherit' });
  if (opened.error) throw opened.error;
  if (opened.status !== 0) throw new Error(`open 启动失败（exit ${opened.status}）`);
  const pid = findClaudePid();
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
  languageEnvironment,
  launchArguments,
  launchEnvironment,
  openEnvironmentArgs,
  verifyOfficialSignature,
  isClaudeRunning,
  isPidAlive,
  findClaudePid,
  activateManagedRunning,
  assertNotRunning,
  runtimeStatePath,
  startEnvironment,
};
