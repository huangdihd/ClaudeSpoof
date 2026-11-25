#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { loadConfig, stateHome, readJson, writeJson } = require('./config');
const {
  executablePath,
  languageEnvironment,
  isPidAlive,
  runtimeStatePath,
  startEnvironment,
} = require('./environment');
const {
  wrapperInfo,
  defaultRealPath,
  resolveAppPath,
  repairWrapper,
} = require('./wrapper');

const POLL_INTERVAL_MS = 5000;
const RETRY_DELAY_MS = 5 * 60 * 1000;
const WATCHER_VERSION = 1;

function watcherPidPath() {
  return path.join(stateHome(), 'watcher.pid');
}

function watcherStatusPath() {
  return path.join(stateHome(), 'watcher-status.json');
}

function findClaudePids() {
  const result = spawnSync('/usr/bin/pgrep', ['-x', 'Claude'], { encoding: 'utf8' });
  if (result.status !== 0) return [];
  return String(result.stdout || '').trim().split('\n')
    .map((value) => Number(value))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

function readProcessDetails(pid) {
  if (!isPidAlive(pid)) return null;
  const executable = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], {
    encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  const environmentAndArguments = spawnSync('/bin/ps', ['eww', '-p', String(pid), '-o', 'command='], {
    encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
  });
  if (executable.status !== 0 || environmentAndArguments.status !== 0) return null;
  const text = environmentAndArguments.stdout || '';
  const environment = {};
  for (const key of ['TZ', 'LANG', 'LC_ALL', 'LANGUAGE']) {
    const match = text.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`));
    environment[key] = match ? match[1] : null;
  }
  const language = text.match(/(?:^|\s)--lang=([^\s]+)/);
  return {
    pid,
    executable: executable.stdout.trim(),
    environment,
    languageArgument: language ? language[1] : null,
  };
}

function verifyProcessDetails(details, expected) {
  if (!details) return { verified: false, reasons: ['process-unavailable'] };
  const reasons = [];
  if (path.resolve(details.executable) !== path.resolve(expected.executable)) reasons.push('executable');
  if (details.environment.TZ !== expected.timezone) reasons.push('TZ');
  if (details.environment.LANG !== languageEnvironment(expected.language)) reasons.push('LANG');
  if (details.environment.LC_ALL !== languageEnvironment(expected.language)) reasons.push('LC_ALL');
  if (details.environment.LANGUAGE !== expected.language) reasons.push('LANGUAGE');
  if (details.languageArgument !== expected.language) reasons.push('--lang');
  return { verified: reasons.length === 0, reasons };
}

function stateMatchesProcess(state, process, appPath, config) {
  return Boolean(state && state.running === true && state.pid === process.pid
    && path.resolve(state.appPath || '') === path.resolve(appPath)
    && state.timezone === config.timezone && state.language === config.language
    && state.launchedVia === 'open');
}

function inspectInstallation(appPath = '/Applications/Claude.app') {
  const root = path.resolve(appPath);
  const info = wrapperInfo(root);
  const hiddenRealPath = defaultRealPath(root);
  const realPath = info ? path.resolve(info.realPath) : (fs.existsSync(hiddenRealPath) ? hiddenRealPath : root);
  const config = loadConfig();
  const state = readJson(runtimeStatePath(), null);
  const expectedExecutable = executablePath(realPath);
  const processes = findClaudePids().map((pid) => {
    const details = readProcessDetails(pid);
    const verification = verifyProcessDetails(details, {
      executable: expectedExecutable,
      timezone: config.timezone,
      language: config.language,
    });
    return {
      pid,
      executable: details ? details.executable : null,
      environment: details ? details.environment : null,
      languageArgument: details ? details.languageArgument : null,
      stateMatch: details ? stateMatchesProcess(state, details, realPath, config) : false,
      ...verification,
    };
  });
  const wrapperOverwritten = !info && fs.existsSync(hiddenRealPath) && fs.existsSync(root);
  const snapshot = {
    appPath: root,
    realPath,
    wrapperInstalled: Boolean(info),
    wrapperOverwritten,
    config,
    processes,
  };
  snapshot.action = decideAction(snapshot);
  return snapshot;
}

function decideAction(snapshot) {
  if (!snapshot.config.enabled) return 'disabled';
  const running = snapshot.processes.length > 0;
  const allVerified = running && snapshot.processes.every((process) => process.verified);
  if (!running) return snapshot.wrapperOverwritten ? 'repair-wrapper' : 'idle';
  if (allVerified && !snapshot.wrapperOverwritten) return 'verified';
  return 'restart';
}

function assertWatcherStartSafe(appPath) {
  const snapshot = inspectInstallation(appPath);
  if (snapshot.action === 'restart') {
    const error = new Error('当前存在未经 ClaudeSpoof 验证的 Claude 进程；为避免重启当前客户端，尚未启动自动修复守护。');
    error.code = 'UNVERIFIED_CLAUDE_RUNNING';
    error.snapshot = snapshot;
    throw error;
  }
  return snapshot;
}

function isWatcherAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); } catch (_) { return false; }
  const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
  return result.status === 0 && /(?:^|\s|\/)watcher\.js(?:\s|$)/.test(result.stdout || '');
}

function parseSavedWatcherPid(saved) {
  // PID 文件历史上是纯数字，也兼容 { "pid": ... }，避免守护存活却被重复启动。
  const pid = Number(typeof saved === 'number' ? saved : saved && saved.pid);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function currentWatcherPid() {
  const pid = parseSavedWatcherPid(readJson(watcherPidPath(), null));
  return isWatcherAlive(pid) ? pid : null;
}

function ensureUpdateWatcher(options = {}) {
  if (process.platform !== 'darwin') throw new Error('更新守护只能在 macOS 上执行');
  const existing = currentWatcherPid();
  if (existing) return { started: false, pid: existing, statusFile: watcherStatusPath() };
  try { fs.unlinkSync(watcherPidPath()); } catch (_) {}
  const child = spawn(process.execPath, [
    path.join(__dirname, 'watcher.js'), '--run', '--app', path.resolve(options.app || '/Applications/Claude.app'),
  ], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_SPOOF_HOME: stateHome() },
  });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const pid = currentWatcherPid();
    if (pid) return { started: true, pid, statusFile: watcherStatusPath() };
    if (child.exitCode !== null) break;
    spawnSync('/bin/sleep', ['0.1'], { stdio: 'ignore' });
  }
  throw new Error('更新守护未能启动');
}

function stopUpdateWatcher() {
  const pid = currentWatcherPid();
  if (!pid) {
    try { fs.unlinkSync(watcherPidPath()); } catch (_) {}
    return { stopped: false, pid: null };
  }
  try { process.kill(pid, 'SIGTERM'); } catch (_) {}
  try { fs.unlinkSync(watcherPidPath()); } catch (_) {}
  return { stopped: true, pid };
}

function quitClaudeProcesses() {
  const result = spawnSync('/usr/bin/osascript', [
    '-e', 'tell application id "com.anthropic.claudefordesktop" to quit',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`无法要求 Claude 正常退出：${(result.stderr || '').trim()}`);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (findClaudePids().length === 0) return;
    spawnSync('/bin/sleep', ['0.5'], { stdio: 'ignore' });
  }
  throw new Error('Claude 未在 20 秒内正常退出；不会强制结束进程，请手动处理后重试');
}

function recoverLaunchState(snapshot) {
  if (snapshot.processes.length !== 1 || !snapshot.processes[0].verified) return;
  const process = snapshot.processes[0];
  if (process.stateMatch) return;
  const previous = readJson(runtimeStatePath(), {});
  writeJson(runtimeStatePath(), {
    ...previous,
    running: true,
    pid: process.pid,
    appPath: snapshot.realPath,
    timezone: snapshot.config.timezone,
    language: snapshot.config.language,
    mode: 'official-signature-environment',
    launchedVia: 'open',
    recoveredByWatcherAt: new Date().toISOString(),
  });
}

function repairInstallation(snapshot) {
  if (snapshot.processes.length > 0) quitClaudeProcesses();
  let realPath = snapshot.realPath;
  let backupPath = null;
  if (snapshot.wrapperOverwritten) {
    const repaired = repairWrapper(snapshot.appPath);
    realPath = repaired.realPath;
    backupPath = repaired.backupPath;
  } else {
    realPath = resolveAppPath(snapshot.appPath);
  }
  const result = startEnvironment({ app: realPath, watcherApp: snapshot.appPath });
  const details = readProcessDetails(result.pid);
  const verification = verifyProcessDetails(details, {
    executable: executablePath(realPath),
    timezone: snapshot.config.timezone,
    language: snapshot.config.language,
  });
  if (!verification.verified) {
    // 环境继承行为若被新版改变，关闭这次未验证实例并退避，绝不循环重启。
    quitClaudeProcesses();
    throw new Error(`重开后的环境校验失败：${verification.reasons.join(', ')}`);
  }
  return { pid: result.pid, backupPath };
}

function writeStatus(value) {
  writeJson(watcherStatusPath(), {
    watcherVersion: WATCHER_VERSION,
    watcherPid: process.pid,
    checkedAt: new Date().toISOString(),
    ...value,
  });
}

function runWatcher(appPath) {
  fs.mkdirSync(stateHome(), { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(watcherPidPath(), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code === 'EEXIST' && currentWatcherPid()) process.exit(0);
    try { fs.unlinkSync(watcherPidPath()); } catch (_) {}
    fs.writeFileSync(watcherPidPath(), `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
  }

  let stopped = false;
  const stop = () => {
    stopped = true;
    try {
      const saved = readJson(watcherPidPath(), null);
      if (parseSavedWatcherPid(saved) === process.pid) fs.unlinkSync(watcherPidPath());
    } catch (_) {}
    writeStatus({ running: false, action: 'stopped', appPath: path.resolve(appPath) });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  let pending = null;
  let errorCount = 0;
  let nextRepairAt = 0;

  const check = () => {
    if (stopped) return;
    try {
      const snapshot = inspectInstallation(appPath);
      const base = {
        running: true,
        appPath: snapshot.appPath,
        realPath: snapshot.realPath,
        wrapperInstalled: snapshot.wrapperInstalled,
        claudePids: snapshot.processes.map((process) => process.pid),
        verified: snapshot.action === 'verified',
        action: snapshot.action,
        processes: snapshot.processes,
        errorCount,
      };
      if (snapshot.action === 'verified') {
        recoverLaunchState(snapshot);
        pending = null;
        nextRepairAt = 0;
        return writeStatus({ ...base, nextRepairAt: null });
      }
      if (snapshot.action === 'idle' || snapshot.action === 'disabled') {
        pending = null;
        nextRepairAt = 0;
        return writeStatus({ ...base, nextRepairAt: null });
      }
      if (Date.now() < nextRepairAt) {
        return writeStatus({ ...base, action: 'backoff', nextRepairAt: new Date(nextRepairAt).toISOString() });
      }
      const key = JSON.stringify({ action: snapshot.action, pids: base.claudePids, realPath: snapshot.realPath });
      if (snapshot.action === 'restart' && pending !== key) {
        pending = key;
        return writeStatus({ ...base, action: 'pending-restart', nextRepairAt: null });
      }
      pending = null;
      const repaired = repairInstallation(snapshot);
      errorCount = 0;
      nextRepairAt = 0;
      return writeStatus({
        ...base,
        claudePids: [repaired.pid],
        verified: true,
        action: snapshot.action === 'repair-wrapper' ? 'wrapper-repaired' : 'restarted',
        backupPath: repaired.backupPath,
        errorCount,
        nextRepairAt: null,
      });
    } catch (error) {
      errorCount += 1;
      nextRepairAt = Date.now() + RETRY_DELAY_MS;
      pending = null;
      return writeStatus({
        running: true,
        appPath: path.resolve(appPath),
        verified: false,
        action: 'error',
        errorCount,
        lastError: error.message,
        nextRepairAt: new Date(nextRepairAt).toISOString(),
      });
    }
  };

  check();
  // 定时器是守护进程唯一的持久句柄，必须保持事件循环存活。
  setInterval(check, POLL_INTERVAL_MS);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] !== '--run') throw new Error('watcher.js 由启动器内部调用');
  const appIndex = args.indexOf('--app');
  const appPath = appIndex >= 0 && args[appIndex + 1] ? args[appIndex + 1] : '/Applications/Claude.app';
  runWatcher(appPath);
}

module.exports = {
  POLL_INTERVAL_MS,
  RETRY_DELAY_MS,
  watcherPidPath,
  watcherStatusPath,
  findClaudePids,
  readProcessDetails,
  verifyProcessDetails,
  inspectInstallation,
  decideAction,
  assertWatcherStartSafe,
  ensureUpdateWatcher,
  stopUpdateWatcher,
  parseSavedWatcherPid,
  currentWatcherPid,
  runWatcher,
};

if (require.main === module) main();
