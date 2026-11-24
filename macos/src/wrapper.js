#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { stateHome, readJson, writeJson } = require('./config');
const {
  verifyOfficialSignature,
  assertNotRunning,
} = require('./environment');

const WRAPPER_VERSION = 1;
const MARKER_NAME = 'ClaudeSpoofEnvironment.json';

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

function copyHelpers() {
  fs.mkdirSync(helperDir(), { recursive: true, mode: 0o700 });
  for (const name of ['config.js', 'environment.js']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(helperDir(), name));
  }
  const launcher = `#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const app = process.argv[2];
const extraArguments = process.argv.slice(3);
if (!app) {
  console.error('缺少 Claude.app 路径');
  process.exit(2);
}

// 每次启动先从安装来源刷新 helper，避免仓库更新后 bin 里残留旧代码
try {
  const marker = JSON.parse(fs.readFileSync(path.join(app, 'Contents', 'Resources', '${MARKER_NAME}'), 'utf8'));
  if (marker.helperSource) {
    for (const name of ['config.js', 'environment.js']) {
      fs.copyFileSync(path.join(marker.helperSource, 'src', name), path.join(__dirname, name));
    }
  }
} catch (_) {}

const { startEnvironment } = require('./environment');
startEnvironment({ app, activateIfManaged: true, extraArguments });
`;
  fs.writeFileSync(helperPath(), launcher, { mode: 0o700 });
}

function wrapperShell(realPath) {
  return `#!/bin/zsh
set -euo pipefail
CLAUDE_SPOOF_HOME="\${CLAUDE_SPOOF_HOME:-$HOME/Library/Application Support/ClaudeSpoof}"
HELPER="\$CLAUDE_SPOOF_HOME/bin/launcher.js"
REAL_APP=${JSON.stringify(path.resolve(realPath))}
NODE_BIN=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node \$HOME/.nvm/versions/node/*/bin/node(N) /usr/bin/node; do
  if [[ -x \$candidate ]]; then
    NODE_BIN=\$candidate
    break
  fi
done
if [[ -z \$NODE_BIN ]]; then
  echo "ClaudeSpoof: 未找到 node，请先安装 Node.js 18+" >&2
  /usr/bin/osascript -e 'display dialog "ClaudeSpoof 启动器需要 Node.js（node 18+），请先安装后再打开 Claude。" buttons {"OK"} default button "OK" with icon stop' >/dev/null 2>&1 || true
  exit 1
fi
exec "\$NODE_BIN" "\$HELPER" "\$REAL_APP" "\$@"
`;
}

function wrapperInfoPlist(realPath, iconName) {
  const shortVersion = plistValue(realPath, 'CFBundleShortVersionString') || '0.0.0';
  const version = plistValue(realPath, 'CFBundleVersion') || '0';
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleDisplayName</key><string>Claude</string>
  <key>CFBundleExecutable</key><string>ClaudeSpoof</string>
  <key>CFBundleIconFile</key><string>${xml(iconName || 'Claude')}</string>
  <key>CFBundleIdentifier</key><string>com.anthropic.claudefordesktop</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>Claude</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${xml(shortVersion)}</string>
  <key>CFBundleSignature</key><string>????</string>
  <key>CFBundleVersion</key><string>${xml(version)}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
`;
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

  const iconName = plistValue(realRoot, 'CFBundleIconFile') || 'Claude';
  const iconSource = path.join(realRoot, 'Contents', 'Resources', iconName);
  if (fs.existsSync(iconSource)) fs.copyFileSync(iconSource, path.join(resources, iconName));
  fs.writeFileSync(path.join(contents, 'Info.plist'), wrapperInfoPlist(realRoot, iconName));
  fs.writeFileSync(path.join(macos, 'ClaudeSpoof'), wrapperShell(realRoot), { mode: 0o755 });
  writeJson(path.join(resources, MARKER_NAME), {
    kind: 'ClaudeSpoofEnvironment',
    version: WRAPPER_VERSION,
    appPath: root,
    realPath: realRoot,
    helperPath: helperPath(),
    helperSource: path.resolve(__dirname, '..'),
    createdAt: new Date().toISOString(),
  });
  return temporaryPath;
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
  const temporaryPath = createWrapperApp(root, realPath);
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
    appPath: root,
    realPath,
    helperPath: helperPath(),
    windowName: 'Claude',
  };
}

function removeWrapper(appPath) {
  if (process.platform !== 'darwin') throw new Error('移除原入口接管只能在 macOS 上执行');
  const root = path.resolve(appPath);
  const info = wrapperInfo(root);
  if (!info) throw new Error('该路径不是 ClaudeSpoof 环境启动器');
  const realPath = path.resolve(info.realPath);
  verifyOfficialSignature(realPath);
  assertNotRunning();
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
  wrapperInfo,
  resolveAppPath,
  defaultRealPath,
  installWrapper,
  removeWrapper,
};
