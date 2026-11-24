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

const LEGACY_AGENT_LABEL = 'com.arin.claudespoof.watch';

function usage() {
  console.log(`ClaudeSpoof macOS 官方签名环境启动器

用法：
  node src/cli.js start [--app /Applications/Claude.app]
  node src/cli.js verify [--app /Applications/Claude.app]
  node src/cli.js status [--app /Applications/Claude.app]
  node src/cli.js config [--timezone Europe/London] [--language en-GB] [--enabled true|false]
  node src/cli.js uninstall-agent

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

function main() {
  const { command, options } = parse(process.argv.slice(2));
  if (command === 'help' || command === '--help' || command === '-h') return usage();

  if (command === 'config') {
    const patch = {};
    if (options.timezone !== undefined) patch.timezone = options.timezone;
    if (options.language !== undefined) patch.language = options.language;
    if (options.enabled !== undefined) patch.enabled = bool(options.enabled);
    const config = Object.keys(patch).length ? updateConfig(patch) : loadConfig();
    console.log(`配置已保存到 ${configPath()}；完全退出并由启动器重新打开 Claude 后生效。`);
    return printResult(config);
  }

  if (command === 'verify') {
    return printResult(verifyOfficialSignature(options.app));
  }

  if (command === 'status') {
    return printResult({
      config: loadConfig(),
      official: verifyOfficialSignature(options.app),
      launch: readJson(runtimeStatePath(), null),
    });
  }

  if (command === 'start' || command === 'start-official') {
    const result = startEnvironment({
      app: options.app,
      skipProcessCheck: options.skipProcessCheck,
    });
    return printResult({
      mode: 'official-signature-environment',
      pid: result.child.pid,
      timezone: result.config.timezone,
      language: result.config.language,
      signature: result.signature,
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
