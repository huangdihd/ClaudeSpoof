#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  inspectApp,
  patchApp,
  repairFrameworkIntegrity,
  repairSignature,
  restoreApp,
} = require('./patcher');
const {
  launcherInfo,
  resolveAppPath,
  defaultRealPath,
  installLauncher,
  removeLauncher,
} = require('./launcher');
const { INJECTION_VERSION } = require('./injection');
const {
  stateHome,
  ensureHome,
  loadConfig,
  updateConfig,
  configPath,
  readJson,
  writeJson,
  statePath,
} = require('./config');

const LABEL = 'com.arin.claudespoof.watch';

function usage() {
  console.log(`ClaudeSpoof macOS 自动补丁器

用法：
  node src/cli.js install [--app /Applications/Claude.app]
  node src/cli.js start [--app /Applications/Claude.app]
  node src/cli.js check [--app /Applications/Claude.app]
  node src/cli.js patch [--app /Applications/Claude.app] [--force]
  node src/cli.js repair-integrity [--app /Applications/Claude.app]
  node src/cli.js repair-sign [--app /Applications/Claude.app]
  node src/cli.js config [--timezone Europe/London] [--language en-GB]
                         [--enabled true|false] [--accept-language true|false]
  node src/cli.js install-launcher [--app /Applications/Claude.app]
  node src/cli.js uninstall-launcher [--app /Applications/Claude.app]
  node src/cli.js uninstall [--app /Applications/Claude.app]
  node src/cli.js restore [--app /Applications/Claude.app]
  node src/cli.js uninstall-agent

配置文件：${configPath()}
状态目录：${stateHome()}

install 会立即补丁，并安装“文件变化监听 + 每 5 分钟检查”的 LaunchAgent。
start 会在启动 Claude 前再检查一次。官方更新后若 Claude 正在运行，会等其退出再补丁。
--no-sign 与 --skip-process-check 仅用于非 macOS 静态测试，不要用于日常安装。
`);
}

function parse(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { app: '/Applications/Claude.app' };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--no-sign') options.sign = false;
    else if (arg === '--skip-process-check') options.skipProcessCheck = true;
    else if (arg === '--force') options.force = true;
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

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function agentPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

function installAgent(appPath) {
  if (process.platform !== 'darwin') throw new Error('LaunchAgent 只能安装在 macOS 上');
  ensureHome();
  const plistPath = agentPlistPath();
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });
  const cliPath = path.resolve(__dirname, 'cli.js');
  const nodePath = process.execPath;
  const stdout = path.join(stateHome(), 'agent.stdout.log');
  const stderr = path.join(stateHome(), 'agent.stderr.log');
  const asarPath = path.join(appPath, 'Contents', 'Resources', 'app.asar');
  const infoPath = path.join(appPath, 'Contents', 'Info.plist');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(cliPath)}</string>
    <string>agent-run</string>
    <string>--app</string>
    <string>${xml(path.resolve(appPath))}</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(path.resolve(__dirname, '..'))}</string>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>300</integer>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>WatchPaths</key>
  <array><string>${xml(asarPath)}</string><string>${xml(infoPath)}</string></array>
  <key>StandardOutPath</key><string>${xml(stdout)}</string>
  <key>StandardErrorPath</key><string>${xml(stderr)}</string>
</dict>
</plist>
`;
  fs.writeFileSync(plistPath, plist);
  const domain = `gui/${process.getuid()}`;
  try { execFileSync('/bin/launchctl', ['bootout', domain, plistPath], { stdio: 'ignore' }); }
  catch (_) {}
  execFileSync('/bin/launchctl', ['bootstrap', domain, plistPath], { stdio: 'inherit' });
  execFileSync('/bin/launchctl', ['kickstart', '-k', `${domain}/${LABEL}`], { stdio: 'inherit' });
  return plistPath;
}

function uninstallAgent() {
  if (process.platform !== 'darwin') return null;
  const plistPath = agentPlistPath();
  if (fs.existsSync(plistPath)) {
    try {
      execFileSync('/bin/launchctl', ['bootout', `gui/${process.getuid()}`, plistPath], { stdio: 'ignore' });
    } catch (_) {}
    fs.rmSync(plistPath, { force: true });
  }
  return plistPath;
}

function notify(message) {
  if (process.platform !== 'darwin') return;
  const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    execFileSync('/usr/bin/osascript', ['-e', `display notification "${escaped}" with title "ClaudeSpoof"`], {
      stdio: 'ignore',
    });
  } catch (_) {}
}

function agentRun(options) {
  try {
    const current = inspectApp(options.app);
    if (current.injectionVersion === INJECTION_VERSION && current.integrityMatches
        && current.mainIntegrityMatches && current.frameworkIntegrityMatches) {
      console.log(`[${new Date().toISOString()}] 当前版本已补丁：${current.version}`);
      return;
    }
    const result = patchApp(options.app, options);
    console.log(`[${new Date().toISOString()}] ${result.status}: ${result.version}`);
    if (result.status === 'patched' || result.status === 'framework-repaired') {
      notify(`Claude ${result.version} 已自动补丁；下次启动生效。`);
    }
    const state = readJson(statePath(), {});
    if (state.notifiedAsarSha256) {
      delete state.notifiedAsarSha256;
      writeJson(statePath(), state);
    }
  } catch (error) {
    if (error.code === 'OPERATION_IN_PROGRESS') {
      console.log(`[${new Date().toISOString()}] ${error.message}`);
      return;
    }
    if (error.code === 'CLAUDE_RUNNING') {
      const state = readJson(statePath(), {});
      let fingerprint = 'unknown';
      try { fingerprint = inspectApp(options.app).archiveSha256; } catch (_) {}
      if (state.notifiedAsarSha256 !== fingerprint) {
        notify('检测到需要补丁的新版本。完全退出 Claude 后会自动处理，不会强制关闭。');
        writeJson(statePath(), Object.assign(state, { notifiedAsarSha256: fingerprint }));
      }
      console.log(`[${new Date().toISOString()}] ${error.message}`);
      return;
    }
    console.error(`[${new Date().toISOString()}] ${error.stack || error.message}`);
    notify(`自动补丁失败：${error.message}`);
    process.exitCode = 1;
  }
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') return usage();

  if (command === 'config') {
    const patch = {};
    if (options.timezone !== undefined) patch.timezone = options.timezone;
    if (options.language !== undefined) patch.language = options.language;
    if (options.enabled !== undefined) patch.enabled = bool(options.enabled);
    if (options['accept-language'] !== undefined) {
      patch.overrideAcceptLanguage = bool(options['accept-language']);
    }
    const config = Object.keys(patch).length ? updateConfig(patch) : loadConfig();
    console.log(`配置已保存到 ${configPath()}；完全退出并重开 Claude 后生效。`);
    return printResult(config);
  }

  if (command === 'install-launcher') {
    if (process.platform !== 'darwin') throw new Error('接管 App 图标只能在 macOS 上安装');
    const requestedPath = path.resolve(options.app);
    const existing = launcherInfo(requestedPath);
    if (existing) {
      const patched = patchApp(existing.realPath, options);
      const plist = installAgent(path.resolve(existing.realPath));
      return printResult({ status: 'already-installed', appPath: requestedPath, realPath: existing.realPath, patch: patched.status, agent: plist });
    }
    printResult(patchApp(requestedPath, options));
    const realPath = defaultRealPath(requestedPath);
    const installed = installLauncher(requestedPath, realPath);
    try {
      const plist = installAgent(realPath);
      return printResult({ ...installed, agent: plist });
    } catch (error) {
      try {
        removeLauncher(requestedPath, { skipProcessCheck: true });
        installAgent(requestedPath);
      } catch (rollbackError) {
        error.message += `；启动器回滚失败：${rollbackError.message}`;
      }
      throw error;
    }
  }

  if (command === 'uninstall-launcher') {
    const requestedPath = path.resolve(options.app);
    uninstallAgent();
    const removed = removeLauncher(requestedPath, options);
    const plist = installAgent(removed.appPath);
    return printResult({ ...removed, agent: plist });
  }

  if (command === 'uninstall-agent') {
    uninstallAgent();
    return console.log('自动补丁看门狗已卸载；Claude 当前文件未改动。');
  }

  const outerAppPath = path.resolve(options.app);
  const outerLauncher = launcherInfo(outerAppPath);
  options.app = resolveAppPath(options.app);

  if (command === 'check') return printResult(inspectApp(options.app));
  if (command === 'patch') return printResult(patchApp(options.app, options));
  if (command === 'repair-integrity') return printResult(repairFrameworkIntegrity(options.app, options));
  if (command === 'repair-sign') return printResult(repairSignature(options.app, options));
  if (command === 'restore') return printResult(restoreApp(options.app, options));
  if (command === 'agent-run') return agentRun(options);

  if (command === 'install') {
    const result = patchApp(options.app, options);
    printResult(result);
    const plist = installAgent(path.resolve(options.app));
    console.log(`自动补丁看门狗已安装：${plist}`);
    console.log('以后可以从“启动 Claude.command”启动，以便启动前再检查一次。');
    return;
  }

  if (command === 'install-agent') {
    return console.log(installAgent(path.resolve(options.app)));
  }

  if (command === 'start') {
    const result = patchApp(options.app, options);
    printResult(result);
    if (process.platform === 'darwin') {
      execFileSync('/usr/bin/open', [path.resolve(options.app)], { stdio: 'inherit' });
    } else {
      console.log('非 macOS 测试环境：跳过 open。');
    }
    return;
  }

  if (command === 'uninstall') {
    uninstallAgent();
    const result = restoreApp(options.app, options);
    printResult(result);
    if (outerLauncher) {
      printResult(removeLauncher(outerAppPath, { skipProcessCheck: true }));
    }
    return console.log('看门狗已移除，并已还原当前版本备份的官方文件、签名与原 App 图标。');
  }

  throw new Error(`未知命令：${command}`);
}

main().catch((error) => {
  console.error(`错误：${error.message}`);
  process.exitCode = 1;
});
