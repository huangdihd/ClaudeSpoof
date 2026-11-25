#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { stateHome, readJson, writeJson } = require('./config');
const {
  verifyOfficialSignature,
  assertNotRunning,
} = require('./environment');

const WRAPPER_VERSION = 3;
const WRAPPER_BUNDLE_ID = 'com.arin.claudespoof.launcher';
const MARKER_NAME = 'ClaudeSpoofEnvironment.json';
const HELPER_MODULES = ['config.js', 'environment.js', 'wrapper.js', 'watcher.js'];

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function wrapperInfo(appPath) {
  const marker = path.join(path.resolve(appPath), 'Contents', 'Resources', MARKER_NAME);
  if (!fs.existsSync(marker)) return null;
  const info = readJson(marker, null);
  if (!info || info.kind !== 'ClaudeSpoofEnvironment' || !info.realPath) {
    throw new Error(`启动器标记无效：${marker}`);
  }
  return info;
}

function resolveAppPath(appPath) {
  const root = path.resolve(appPath);
  const info = wrapperInfo(root);
  return info ? path.resolve(info.realPath) : root;
}

function defaultRealPath(appPath) {
  const root = path.resolve(appPath);
  const base = path.basename(root).replace(/\.app$/i, '');
  return path.join(path.dirname(root), '.ClaudeSpoof', `${base}.app`);
}

function helperDir() {
  return path.join(stateHome(), 'bin');
}

function helperPath() {
  return path.join(helperDir(), 'launcher.js');
}

function plistValue(appPath, key) {
  try {
    return execFileSync('/usr/libexec/PlistBuddy', [
      '-c', `Print :${key}`, path.join(path.resolve(appPath), 'Contents', 'Info.plist'),
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (_) {
    return '';
  }
}

function resolveIconFile(realRoot, iconName) {
  const resourcesDir = path.join(realRoot, 'Contents', 'Resources');
  const candidates = [];
  if (iconName) {
    candidates.push(iconName);
    if (!iconName.toLowerCase().endsWith('.icns')) {
      candidates.push(`${iconName}.icns`);
    }
  }
  candidates.push('Claude.icns', 'electron.icns', 'icon.icns');
  for (const name of candidates) {
    const full = path.join(resourcesDir, name);
    if (fs.existsSync(full)) return { fileName: name, sourcePath: full };
  }
  return null;
}

function copyHelpers() {
  fs.mkdirSync(helperDir(), { recursive: true, mode: 0o700 });
  for (const name of HELPER_MODULES) {
    fs.copyFileSync(path.join(__dirname, name), path.join(helperDir(), name));
  }
  const launcher = `#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const app = process.argv[2];
const extraArguments = process.argv.slice(3);
if (!app) {
  console.error('缺少 Claude.app 路径');
  process.exit(2);
}

const watcherApp = process.env.CLAUDE_SPOOF_WATCHER_APP || '/Applications/Claude.app';
const helperSource = process.env.CLAUDE_SPOOF_HELPER_SOURCE;
if (helperSource) {
  try {
    for (const name of ${JSON.stringify(HELPER_MODULES)}) {
      require('node:fs').copyFileSync(path.join(helperSource, 'src', name), path.join(__dirname, name));
    }
  } catch (_) {}
}

function showErrorDialog(message) {
  const safe = String(message || '未知错误').replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
  spawnSync('/usr/bin/osascript', [
    '-e', \`display dialog "ClaudeSpoof 启动失败：\\n\${safe}" buttons {"好"} default button "好" with icon stop\`,
  ], { stdio: 'ignore' });
}

try {
  const { startEnvironment } = require('./environment');
  startEnvironment({ app, watcherApp, activateIfManaged: true, extraArguments });
} catch (error) {
  console.error(error && error.stack ? error.stack : String(error));
  showErrorDialog(error && error.message ? error.message : String(error));
  process.exit(1);
}
`;
  fs.writeFileSync(helperPath(), launcher, { mode: 0o700 });
}

function tryBuildNativeLauncher(targetExecutablePath) {
  if (process.platform !== 'darwin') return false;
  const swiftSource = path.resolve(__dirname, '..', 'native', 'ClaudeSpoofLauncher.swift');
  if (!fs.existsSync(swiftSource)) return false;
  const check = spawnSync('/usr/bin/xcrun', ['--find', 'swiftc'], { encoding: 'utf8' });
  if (check.status !== 0) return false;
  const compile = spawnSync('/usr/bin/swiftc', [
    '-O',
    '-framework', 'AppKit',
    swiftSource,
    '-o', targetExecutablePath,
  ], { encoding: 'utf8' });
  if (compile.status !== 0) return false;
  fs.chmodSync(targetExecutablePath, 0o755);
  return true;
}

function wrapperShell(realPath, appPath, helperSource) {
  return `#!/bin/zsh
set -euo pipefail
CLAUDE_SPOOF_HOME="\${CLAUDE_SPOOF_HOME:-$HOME/Library/Application Support/ClaudeSpoof}"
HELPER="\$CLAUDE_SPOOF_HOME/bin/launcher.js"
REAL_APP=${JSON.stringify(path.resolve(realPath))}
export CLAUDE_SPOOF_WATCHER_APP=${JSON.stringify(path.resolve(appPath))}
export CLAUDE_SPOOF_HELPER_SOURCE=${JSON.stringify(path.resolve(helperSource))}
NODE_BIN=""
for candidate in \\
  /opt/homebrew/bin/node \\
  /usr/local/bin/node \\
  /opt/local/bin/node \\
  "\$HOME/.volta/bin/node" \\
  "\$HOME/.asdf/shims/node" \\
  "\$HOME/.local/share/mise/shims/node" \\
  "\$HOME/.local/share/fnm/aliases/default/bin/node" \\
  "\$HOME"/.nvm/versions/node/*/bin/node(NOn) \\
  /usr/bin/node; do
  if [[ -x \$candidate ]]; then
    NODE_BIN=\$candidate
    break
  fi
done
if [[ -z \$NODE_BIN ]]; then
  echo "ClaudeSpoof: 未找到 node，请先安装 Node.js 18+" >&2
  /usr/bin/osascript -e 'display dialog "ClaudeSpoof 启动器需要 Node.js（node 18+）或 Xcode 命令行工具（swiftc），请先安装后再打开 Claude。" buttons {"OK"} default button "OK" with icon stop' >/dev/null 2>&1 || true
  exit 1
fi
exec "\$NODE_BIN" "\$HELPER" "\$REAL_APP" "\$@"
`;
}

function wrapperInfoPlist(realPath, iconFileName, iconName) {
  const shortVersion = plistValue(realPath, 'CFBundleShortVersionString') || '0.0.0';
  const version = plistValue(realPath, 'CFBundleVersion') || '0';
  const iconNameEntry = iconName
    ? `  <key>CFBundleIconName</key><string>${xml(iconName)}</string>\n`
    : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Claude</string>
  <key>CFBundleExecutable</key><string>ClaudeSpoof</string>
  <key>CFBundleIconFile</key><string>${xml(iconFileName || 'Claude.icns')}</string>
${iconNameEntry}  <key>CFBundleIdentifier</key><string>${WRAPPER_BUNDLE_ID}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Claude</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(shortVersion)}</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>${xml(version)}</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key><string>Claude URL</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>claude</string>
      </array>
    </dict>
  </array>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
}

function writeWrapperExecutable(execFile, realPath, appPath, helperSource) {
  if (tryBuildNativeLauncher(execFile)) {
    return 'native-swift';
  }
  fs.writeFileSync(execFile, wrapperShell(realPath, appPath, helperSource), { mode: 0o755 });
  return 'zsh-node';
}

function refreshWrapper(appPath) {
  const root = path.resolve(appPath);
  const info = wrapperInfo(root);
  if (!info) throw new Error('该路径不是 ClaudeSpoof 环境启动器');
  const realPath = path.resolve(info.realPath);
  const helperSource = path.resolve(__dirname, '..');
  verifyOfficialSignature(realPath);
  copyHelpers();
  const execFile = path.join(root, 'Contents', 'MacOS', 'ClaudeSpoof');
  const launcherKind = writeWrapperExecutable(execFile, realPath, root, helperSource);
  const iconFile = resolveIconFile(realPath, plistValue(realPath, 'CFBundleIconFile'));
  const iconName = plistValue(realPath, 'CFBundleIconName');
  fs.writeFileSync(
    path.join(root, 'Contents', 'Info.plist'),
    wrapperInfoPlist(realPath, iconFile ? iconFile.fileName : 'Claude.icns', iconName),
  );
  writeJson(path.join(root, 'Contents', 'Resources', MARKER_NAME), {
    ...info,
    version: WRAPPER_VERSION,
    launcherKind,
    appPath: root,
    realPath,
    helperPath: helperPath(),
    helperSource,
    refreshedAt: new Date().toISOString(),
  });
  return { status: 'refreshed', launcherKind, appPath: root, realPath, helperPath: helperPath() };
}

function createWrapperApp(appPath, realPath) {
  const root = path.resolve(appPath);
  const realRoot = path.resolve(realPath);
  const temporaryPath = path.join(path.dirname(root), `.ClaudeSpoof-wrapper-${process.pid}.app`);
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  const contents = path.join(temporaryPath, 'Contents');
  const resources = path.join(contents, 'Resources');
  const macos = path.join(contents, 'MacOS');
  fs.mkdirSync(resources, { recursive: true });
  fs.mkdirSync(macos, { recursive: true });

  const iconFile = resolveIconFile(realRoot, plistValue(realRoot, 'CFBundleIconFile'));
  if (iconFile) {
    fs.copyFileSync(iconFile.sourcePath, path.join(resources, iconFile.fileName));
  }
  const assetsCar = path.join(realRoot, 'Contents', 'Resources', 'Assets.car');
  if (fs.existsSync(assetsCar)) {
    fs.copyFileSync(assetsCar, path.join(resources, 'Assets.car'));
  }
  const iconName = plistValue(realRoot, 'CFBundleIconName');

  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    wrapperInfoPlist(realRoot, iconFile ? iconFile.fileName : 'Claude.icns', iconName),
  );
  const helperSource = path.resolve(__dirname, '..');
  const launcherKind = writeWrapperExecutable(
    path.join(macos, 'ClaudeSpoof'),
    realRoot,
    root,
    helperSource,
  );
  writeJson(path.join(resources, MARKER_NAME), {
    kind: 'ClaudeSpoofEnvironment',
    version: WRAPPER_VERSION,
    launcherKind,
    appPath: root,
    realPath: realRoot,
    helperPath: helperPath(),
    helperSource,
    createdAt: new Date().toISOString(),
  });
  return { temporaryPath, launcherKind };
}

function installWrapper(appPath) {
  if (process.platform !== 'darwin') throw new Error('接管原入口只能在 macOS 上执行');
  const root = path.resolve(appPath);
  if (wrapperInfo(root)) throw new Error('该路径已经由 ClaudeSpoof 环境启动器接管');
  const realPath = defaultRealPath(root);
  if (fs.existsSync(realPath)) throw new Error(`保留官方 App 的目标路径已存在：${realPath}`);
  verifyOfficialSignature(root);
  assertNotRunning();
  fs.mkdirSync(path.dirname(realPath), { recursive: true });
  fs.renameSync(root, realPath);
  const { temporaryPath, launcherKind } = createWrapperApp(root, realPath);
  try {
    copyHelpers();
    fs.renameSync(temporaryPath, root);
  } catch (error) {
    fs.rmSync(temporaryPath, { recursive: true, force: true });
    if (!fs.existsSync(root) && fs.existsSync(realPath)) fs.renameSync(realPath, root);
    throw error;
  }
  return {
    status: 'installed',
    launcherKind,
    appPath: root,
    realPath,
    helperPath: helperPath(),
    windowName: 'Claude',
  };
}

function repairWrapper(appPath) {
  if (process.platform !== 'darwin') throw new Error('修复原入口只能在 macOS 上执行');
  const root = path.resolve(appPath);
  if (wrapperInfo(root)) throw new Error('该路径仍是 ClaudeSpoof 环境启动器，无需修复');
  const realPath = defaultRealPath(root);
  if (!fs.existsSync(realPath)) throw new Error(`未找到更新前的官方 App：${realPath}`);
  verifyOfficialSignature(root);
  assertNotRunning();

  const backupDir = path.join(path.dirname(realPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `Claude-${Date.now()}-${process.pid}.app`);
  fs.renameSync(realPath, backupPath);
  let movedOfficial = false;
  let temporaryPath = null;
  let launcherKind = 'zsh-node';
  try {
    fs.renameSync(root, realPath);
    movedOfficial = true;
    const built = createWrapperApp(root, realPath);
    temporaryPath = built.temporaryPath;
    launcherKind = built.launcherKind;
    copyHelpers();
    fs.renameSync(temporaryPath, root);
  } catch (error) {
    if (temporaryPath) fs.rmSync(temporaryPath, { recursive: true, force: true });
    if (movedOfficial && !fs.existsSync(root) && fs.existsSync(realPath)) fs.renameSync(realPath, root);
    if (!fs.existsSync(realPath) && fs.existsSync(backupPath)) fs.renameSync(backupPath, realPath);
    throw error;
  }
  return { status: 'repaired', launcherKind, appPath: root, realPath, backupPath, helperPath: helperPath() };
}

function removeWrapper(appPath) {
  if (process.platform !== 'darwin') throw new Error('移除原入口接管只能在 macOS 上执行');
  const root = path.resolve(appPath);
  const info = wrapperInfo(root);
  if (!info) throw new Error('该路径不是 ClaudeSpoof 环境启动器');
  const realPath = path.resolve(info.realPath);
  verifyOfficialSignature(realPath);
  assertNotRunning();
  const { stopUpdateWatcher, uninstallWatcherAgent } = require('./watcher');
  uninstallWatcherAgent();
  stopUpdateWatcher();
  const temporaryPath = path.join(path.dirname(root), `.ClaudeSpoof-remove-${process.pid}.app`);
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  fs.renameSync(root, temporaryPath);
  try {
    fs.renameSync(realPath, root);
  } catch (error) {
    fs.renameSync(temporaryPath, root);
    throw error;
  }
  fs.rmSync(temporaryPath, { recursive: true, force: true });
  try { fs.rmdirSync(path.dirname(realPath)); } catch (_) {}
  return { status: 'removed', appPath: root, realPath };
}

module.exports = {
  WRAPPER_VERSION,
  WRAPPER_BUNDLE_ID,
  wrapperInfo,
  resolveAppPath,
  resolveIconFile,
  wrapperInfoPlist,
  defaultRealPath,
  installWrapper,
  refreshWrapper,
  repairWrapper,
  removeWrapper,
};
