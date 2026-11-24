'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { assertClaudeNotRunning } = require('./patcher');
const { statePath, readJson, writeJson } = require('./config');

const MARKER_NAME = 'ClaudeSpoofLauncher.json';

function markerPath(appPath) {
  return path.join(path.resolve(appPath), 'Contents', 'Resources', MARKER_NAME);
}

function launcherInfo(appPath) {
  const marker = markerPath(appPath);
  if (!fs.existsSync(marker)) return null;
  const info = readJson(marker, null);
  if (!info || info.kind !== 'ClaudeSpoofLauncher' || !info.realPath) {
    throw new Error(`启动器标记无效：${marker}`);
  }
  return info;
}

function resolveAppPath(appPath) {
  const resolved = path.resolve(appPath);
  const info = launcherInfo(resolved);
  if (!info) return resolved;
  if (!fs.existsSync(path.join(info.realPath, 'Contents', 'Resources', 'app.asar'))) {
    throw new Error(`启动器找不到真正的 Claude：${info.realPath}`);
  }
  return path.resolve(info.realPath);
}

function defaultRealPath(appPath) {
  const root = path.resolve(appPath);
  return path.join(path.dirname(root), '.Claude 原版.app');
}

function setStateAppPath(oldPath, newPath) {
  const state = readJson(statePath(), {});
  if (state.appPath && path.resolve(state.appPath) === path.resolve(oldPath)) {
    state.appPath = path.resolve(newPath);
    writeJson(statePath(), state);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;
}

function plistSet(plistPath, key, type, value) {
  try {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plistPath], { stdio: 'ignore' });
  } catch (_) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} ${type} ${value}`, plistPath]);
  }
}

function createApplet({ temporaryPath, appPath, realPath }) {
  const cliPath = path.resolve(__dirname, 'cli.js');
  const command = [process.execPath, cliPath, 'start', '--app', realPath]
    .map(shellQuote).join(' ');
  const lines = [
    `set shellCommand to ${appleScriptString(command)}`,
    'try',
    '  do shell script shellCommand',
    'on error errMsg',
    '  display dialog "Claude 自动补丁启动失败：" & errMsg buttons {"好"} default button "好" with icon stop',
    'end try',
  ];
  execFileSync('/usr/bin/osacompile', ['-o', temporaryPath, ...lines.flatMap((line) => ['-e', line])]);
  const contents = path.join(temporaryPath, 'Contents');
  const resources = path.join(contents, 'Resources');
  const plist = path.join(contents, 'Info.plist');
  plistSet(plist, 'CFBundleIdentifier', 'string', 'com.arin.claudespoof.launcher');
  plistSet(plist, 'CFBundleDisplayName', 'string', 'Claude');
  plistSet(plist, 'CFBundleName', 'string', 'Claude');
  plistSet(plist, 'LSUIElement', 'bool', 'true');

  const realPlist = path.join(realPath, 'Contents', 'Info.plist');
  let iconName = null;
  try {
    iconName = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIconFile', realPlist], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (_) {}
  if (iconName) {
    const source = path.join(realPath, 'Contents', 'Resources', iconName);
    const destination = path.join(resources, 'applet.icns');
    if (fs.existsSync(source)) fs.copyFileSync(source, destination);
  }

  fs.writeFileSync(path.join(resources, MARKER_NAME), `${JSON.stringify({
    kind: 'ClaudeSpoofLauncher',
    version: 1,
    realPath: path.resolve(realPath),
    replacedPath: path.resolve(appPath),
    cliPath,
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', temporaryPath], { stdio: 'inherit' });
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', temporaryPath], { stdio: 'inherit' });
}

function installLauncher(appPath, requestedRealPath) {
  if (process.platform !== 'darwin') throw new Error('接管 App 图标只能在 macOS 上安装');
  const root = path.resolve(appPath);
  const realPath = path.resolve(requestedRealPath || defaultRealPath(root));
  if (launcherInfo(root)) return { status: 'already-installed', appPath: root, realPath: launcherInfo(root).realPath };
  if (path.dirname(root) !== path.dirname(realPath)) {
    throw new Error('真正的 Claude 必须与启动器位于同一目录');
  }
  if (root === realPath) throw new Error('启动器与真实 App 路径不能相同');
  if (!fs.existsSync(path.join(root, 'Contents', 'Resources', 'app.asar'))) {
    throw new Error(`目标不是真正的 Claude.app：${root}`);
  }
  if (fs.existsSync(realPath)) throw new Error(`保留原版的目标路径已存在：${realPath}`);
  assertClaudeNotRunning();

  const temporaryPath = path.join(path.dirname(root), `.ClaudeSpoof-launcher-${process.pid}.app`);
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  fs.renameSync(root, realPath);
  const stateMoved = Boolean(readJson(statePath(), {}).appPath);
  try {
    setStateAppPath(root, realPath);
    createApplet({ temporaryPath, appPath: root, realPath });
    fs.renameSync(temporaryPath, root);
    return { status: 'installed', appPath: root, realPath };
  } catch (error) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true });
    fs.renameSync(realPath, root);
    try { if (stateMoved) setStateAppPath(realPath, root); }
    catch (stateError) { error.message += `；状态路径回滚失败：${stateError.message}`; }
    throw error;
  }
}

function removeLauncher(appPath, options = {}) {
  if (process.platform !== 'darwin') throw new Error('恢复 App 图标只能在 macOS 上执行');
  const root = path.resolve(appPath);
  const info = launcherInfo(root);
  if (!info) return { status: 'not-installed', appPath: root };
  const realPath = path.resolve(info.realPath);
  if (!fs.existsSync(path.join(realPath, 'Contents', 'Resources', 'app.asar'))) {
    throw new Error(`找不到启动器对应的真实 Claude，已拒绝删除启动器：${realPath}`);
  }
  if (!options.skipProcessCheck) assertClaudeNotRunning();

  const temporaryPath = path.join(path.dirname(root), `.ClaudeSpoof-launcher-remove-${process.pid}.app`);
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  fs.renameSync(root, temporaryPath);
  let realMoved = false;
  try {
    fs.renameSync(realPath, root);
    realMoved = true;
    setStateAppPath(realPath, root);
  } catch (error) {
    if (realMoved) fs.renameSync(root, realPath);
    fs.renameSync(temporaryPath, root);
    throw error;
  }
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  return { status: 'removed', appPath: root, realPath };
}

module.exports = {
  launcherInfo,
  resolveAppPath,
  defaultRealPath,
  installLauncher,
  removeLauncher,
};
