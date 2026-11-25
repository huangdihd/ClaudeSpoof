#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  configPath,
  loadConfig,
  updateConfig,
  readJson,
} = require('./config');
const {
  startEnvironment,
  verifyOfficialSignature,
  runtimeStatePath,
} = require('./environment');
const {
  installWrapper,
  refreshWrapper,
  removeWrapper,
  resolveAppPath,
} = require('./wrapper');
const {
  watcherStatusPath,
  inspectInstallation,
  assertWatcherStartSafe,
  ensureUpdateWatcher,
  stopUpdateWatcher,
  currentWatcherPid,
} = require('./watcher');

const LEGACY_AGENT_LABEL = 'com.arin.claudespoof.watch';

function usage() {
  console.log(`ClaudeSpoof macOS 官方签名环境启动器

用法：
  node src/cli.js install-wrapper [--app /Applications/Claude.app]
  node src/cli.js remove-wrapper [--app /Applications/Claude.app]
  node src/cli.js refresh [--app /Applications/Claude.app]
  node src/cli.js start [--app /Applications/Claude.app]
  node src/cli.js start-watcher [--app /Applications/Claude.app]
  node src/cli.js stop-watcher
  node src/cli.js verify [--app /Applications/Claude.app]
  node src/cli.js status [--app /Applications/Claude.app]
  node src/cli.js config [--timezone Europe/London] [--language en-GB] [--enabled true|false]
  node src/cli.js uninstall-agent

install-wrapper 会把官方 App 移到隐藏的 .ClaudeSpoof 目录，并在原路径保留同名、
同图标的 Claude 启动入口；运行进程与窗口名称仍来自真正的官方 App。
refresh 只刷新 helper 并启动／重载更新守护，不重启已经验证的 Claude。

配置文件：${configPath()}
`);
}

function parse(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { app: '/Applications/Claude.app' };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--skip-process-check') options.skipProcessCheck = true;
    else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = rest[i + 1];
      if (value === undefined || value.startsWith('--')) throw new Error(`缺少参数值：${arg}`);
      options[key] = value;
      i += 1;
    } else throw new Error(`未知参数：${arg}`);
  }
  return { command, options };
}

function bool(value) {
  if (value === true || value === 'true' || value === '1' || value === 'yes') return true;
  if (value === false || value === 'false' || value === '0' || value === 'no') return false;
  throw new Error(`无效布尔值：${value}`);
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

function legacyAgentPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LEGACY_AGENT_LABEL}.plist`);
}

function uninstallLegacyAgent() {
  if (process.platform !== 'darwin') return { removed: false, path: legacyAgentPath() };
  const plistPath = legacyAgentPath();
  if (!fs.existsSync(plistPath)) return { removed: false, path: plistPath };
  try {
    spawnSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], { stdio: 'ignore' });
  } catch (_) {}
  fs.rmSync(plistPath, { force: true });
  return { removed: true, path: plistPath };
}

function startWatcherSafely(appPath) {
  const snapshot = assertWatcherStartSafe(appPath);
  const watcher = ensureUpdateWatcher({ app: appPath });
  return { snapshot, watcher };
}

function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') return usage();

  if (command === 'config') {
    const patch = {};
    if (options.timezone !== undefined) patch.timezone = options.timezone;
    if (options.language !== undefined) patch.language = options.language;
    if (options.enabled !== undefined) patch.enabled = bool(options.enabled);
    const config = Object.keys(patch).length ? updateConfig(patch) : loadConfig();
    console.log(`配置已保存到 ${configPath()}；完全退出并由原 Claude 入口重新打开后生效。运行中的旧配置若不匹配，守护会请求正常退出并重开。`);
    return printResult(config);
  }

  if (command === 'install-wrapper') return printResult(installWrapper(options.app));
  if (command === 'remove-wrapper') return printResult(removeWrapper(options.app));
  if (command === 'stop-watcher') return printResult(stopUpdateWatcher());

  if (command === 'refresh') {
    const refreshed = refreshWrapper(options.app);
    const safe = assertWatcherStartSafe(options.app);
    stopUpdateWatcher();
    const watcher = ensureUpdateWatcher({ app: options.app });
    return printResult({ ...refreshed, claudeAction: safe.action, watcher });
  }

  if (command === 'start-watcher') return printResult(startWatcherSafely(options.app));

  const appPath = resolveAppPath(options.app);

  if (command === 'verify') {
    return printResult(verifyOfficialSignature(appPath));
  }

  if (command === 'status') {
    return printResult({
      config: loadConfig(),
      official: verifyOfficialSignature(appPath),
      launch: readJson(runtimeStatePath(), null),
      watcher: {
        pid: currentWatcherPid(),
        status: readJson(watcherStatusPath(), null),
      },
      inspection: inspectInstallation(options.app),
    });
  }

  if (command === 'start' || command === 'start-official') {
    const result = startEnvironment({
      app: appPath,
      watcherApp: options.app,
      skipProcessCheck: options.skipProcessCheck,
    });
    return printResult({
      mode: 'official-signature-environment',
      pid: result.pid,
      activated: result.activated === true,
      timezone: result.config.timezone,
      language: result.config.language,
      signature: result.signature,
      watcher: result.watcher,
    });
  }

  if (command === 'uninstall-agent') {
    const result = uninstallLegacyAgent();
    console.log(result.removed ? '旧版自动补丁看门狗已移除。' : '未发现旧版自动补丁看门狗。');
    return printResult(result);
  }

  throw new Error(`未知命令：${command}`);
}

main();
