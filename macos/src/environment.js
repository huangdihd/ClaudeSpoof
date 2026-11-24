#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { loadConfig, stateHome, writeJson } = require('./config');

const ANTHROPIC_TEAM_ID = 'Q6L2SF6YDW';
const HARDWARE_KEY_GROUP = `${ANTHROPIC_TEAM_ID}.com.anthropic.claude.hwkey`;

function errorMessage(error) {
  return String(error && error.message || error);
}

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

function launchArguments(config) {
  return [`--lang=${config.language}`];
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

function assertNotRunning() {
  const result = spawnSync('/usr/bin/pgrep', ['-x', 'Claude'], { stdio: 'ignore' });
  if (result.status === 0) {
    const error = new Error('Claude 已在运行，无法确认它是否继承英国环境。请先完全退出，再由本启动器打开。');
    error.code = 'CLAUDE_RUNNING';
    throw error;
  }
  if (result.status !== 1) throw new Error('无法检查 Claude 是否正在运行');
}

function runtimeStatePath() {
  return path.join(stateHome(), 'environment-launch.json');
}

function startEnvironment(options = {}) {
  if (process.platform !== 'darwin') throw new Error('官方环境启动器只能在 macOS 上使用');
  const config = loadConfig();
  if (!config.enabled) throw new Error('ClaudeSpoof 配置已停用，拒绝未伪装启动');
  const appPath = path.resolve(options.app || '/Applications/Claude.app');
  const signature = verifyOfficialSignature(appPath);
  if (!options.skipProcessCheck) assertNotRunning();
  const executable = executablePath(appPath);
  const stateFile = runtimeStatePath();
  const child = spawn(executable, launchArguments(config), {
    cwd: path.dirname(executable),
    env: launchEnvironment(config),
    stdio: 'inherit',
  });
  writeJson(stateFile, {
    running: true,
    pid: child.pid,
    appPath,
    timezone: config.timezone,
    language: config.language,
    mode: 'official-signature-environment',
    signature,
    startedAt: new Date().toISOString(),
  });
  child.once('error', (error) => {
    console.error(`[ClaudeSpoof] Claude 启动失败：${errorMessage(error)}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    writeJson(stateFile, {
      running: false,
      pid: child.pid,
      appPath,
      timezone: config.timezone,
      language: config.language,
      mode: 'official-signature-environment',
      startedAt: new Date().toISOString(),
      exitedAt: new Date().toISOString(),
      exitCode: code,
      signal,
    });
    console.log(`[ClaudeSpoof] Claude 已退出（code=${code}, signal=${signal}）`);
  });
  console.log(`[ClaudeSpoof] 官方签名环境已启动：${config.timezone} / ${config.language}`);
  return { child, config, signature, stateFile };
}

module.exports = {
  ANTHROPIC_TEAM_ID,
  HARDWARE_KEY_GROUP,
  executablePath,
  languageEnvironment,
  launchArguments,
  launchEnvironment,
  verifyOfficialSignature,
  assertNotRunning,
  runtimeStatePath,
  startEnvironment,
};
