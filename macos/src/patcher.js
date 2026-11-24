'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const {
  readArchive,
  rewriteArchive,
  verifyArchive,
  sha256,
  contentMatchesIntegrity,
} = require('./asar-rewrite');
const {
  INJECTION_VERSION,
  applyInjection,
  injectionVersion,
} = require('./injection');
const {
  stateHome,
  statePath,
  ensureHome,
  readJson,
  writeJson,
  configPath,
} = require('./config');
const {
  readAsarIntegrity,
  calculateIntegrityDigestV1,
  writeFrameworkIntegrityDigest,
  frameworkIntegrityStatus,
} = require('./integrity-digest');
const {
  helperLayout,
  helperFiles,
  assertOriginalHelpers,
  supplementHelpersBackup,
  codesignHelpers,
} = require('./helper-signing');
const {
  localSigningIdentity,
  normalizeRequirements,
  combinedRequirements,
} = require('./local-signing');

const FRAMEWORK_RELATIVE = 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework';
const FRAMEWORK_CODE_RESOURCES_RELATIVE = 'Contents/Frameworks/Electron Framework.framework/Versions/A/_CodeSignature/CodeResources';
const FRAMEWORK_BACKUP_FILES = Object.freeze([
  FRAMEWORK_RELATIVE,
  FRAMEWORK_CODE_RESOURCES_RELATIVE,
]);

function appLayout(appPath) {
  const root = path.resolve(appPath);
  const contents = path.join(root, 'Contents');
  return {
    root,
    contents,
    resources: path.join(contents, 'Resources'),
    asar: path.join(contents, 'Resources', 'app.asar'),
    plist: path.join(contents, 'Info.plist'),
    frameworkRoot: path.join(contents, 'Frameworks', 'Electron Framework.framework'),
    framework: path.join(root, FRAMEWORK_RELATIVE),
    frameworkCodeResources: path.join(root, FRAMEWORK_CODE_RESOURCES_RELATIVE),
  };
}

function modifiedNestedSignatures(layout) {
  return [
    { path: layout.frameworkRoot, bundleIdentifier: 'com.github.Electron.framework' },
    ...helperLayout(layout.root).map((helper) => ({
      path: helper.root,
      bundleIdentifier: helper.bundleIdentifier,
    })),
  ];
}

function xmlPlistString(plistPath, key) {
  const xml = fs.readFileSync(plistPath, 'utf8');
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = xml.match(new RegExp(`<key>${escaped}</key>\\s*<string>([^<]+)</string>`));
  return match ? match[1] : null;
}

function plistString(plistPath, key) {
  if (process.platform === 'darwin') {
    try {
      return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plistPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch (_) { return null; }
  }
  return xmlPlistString(plistPath, key);
}

function plistAsarHash(plistPath) {
  if (process.platform === 'darwin') {
    return plistString(plistPath, 'ElectronAsarIntegrity:Resources/app.asar:hash');
  }
  const xml = fs.readFileSync(plistPath, 'utf8');
  const match = xml.match(/<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>([0-9a-fA-F]{64})<\/string>/);
  return match ? match[1] : null;
}

function updatePlistHash({ source, destination, expectedHash, newHash }) {
  fs.copyFileSync(source, destination);
  if (process.platform === 'darwin') {
    const key = ':ElectronAsarIntegrity:Resources/app.asar:hash';
    const oldHash = execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print ${key}`, destination], {
      encoding: 'utf8',
    }).trim();
    if (oldHash.toLowerCase() !== expectedHash.toLowerCase()) {
      throw new Error(`Info.plist ASAR hash mismatch: ${oldHash} != ${expectedHash}`);
    }
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set ${key} ${newHash}`, destination]);
    return;
  }

  const xml = fs.readFileSync(destination, 'utf8');
  const pattern = /(<key>Resources\/app\.asar<\/key>\s*<dict>[\s\S]*?<key>hash<\/key>\s*<string>)([0-9a-fA-F]{64})(<\/string>)/;
  const match = xml.match(pattern);
  if (!match) throw new Error('Cannot locate ElectronAsarIntegrity app.asar hash in XML plist');
  if (match[2].toLowerCase() !== expectedHash.toLowerCase()) {
    throw new Error(`Info.plist ASAR hash mismatch: ${match[2]} != ${expectedHash}`);
  }
  fs.writeFileSync(destination, xml.replace(pattern, `$1${newHash}$3`));
}

function inspectApp(appPath) {
  const layout = appLayout(appPath);
  if (!fs.existsSync(layout.asar) || !fs.existsSync(layout.plist)) {
    throw new Error(`不是完整的 Claude.app：${layout.root}`);
  }
  const archive = readArchive(layout.asar);
  const packageRow = archive.rows.find((row) => row.path === 'package.json');
  if (!packageRow || !packageRow.content) throw new Error('ASAR 中找不到 package.json');
  const packageJson = JSON.parse(packageRow.content.toString('utf8'));
  const main = String(packageJson.main || '').replace(/^\.\//, '');
  if (!main) throw new Error('package.json 中没有 main 入口');
  const mainRow = archive.rows.find((row) => row.path === main);
  if (!mainRow || !mainRow.content) throw new Error(`ASAR 中找不到主入口：${main}`);
  const source = mainRow.content.toString('utf8');
  const headerHash = sha256(archive.headerString);
  const expectedHash = plistAsarHash(layout.plist);
  const framework = frameworkIntegrityStatus(layout.plist, layout.framework);
  return {
    appPath: layout.root,
    version: plistString(layout.plist, 'CFBundleShortVersionString') || 'unknown',
    executable: plistString(layout.plist, 'CFBundleExecutable') || 'Claude',
    bundleIdentifier: plistString(layout.plist, 'CFBundleIdentifier') || 'com.anthropic.claudefordesktop',
    main,
    injectionVersion: injectionVersion(source),
    mainIntegrityMatches: contentMatchesIntegrity(mainRow.content, mainRow.entry.integrity),
    headerHash,
    expectedHash,
    integrityMatches: Boolean(expectedHash && headerHash.toLowerCase() === expectedHash.toLowerCase()),
    archiveSha256: sha256(fs.readFileSync(layout.asar)),
    expectedFrameworkDigest: framework.expectedDigestHex,
    storedFrameworkDigest: framework.storedDigestHex,
    frameworkIntegrityMatches: framework.frameworkIntegrityMatches,
    frameworkIntegritySection: framework.section,
  };
}

function assertClaudeNotRunning() {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('/usr/bin/pgrep', ['-x', 'Claude'], { stdio: 'ignore' });
    const error = new Error('Claude 正在运行。请先完全退出，补丁器会在退出后自动重试。');
    error.code = 'CLAUDE_RUNNING';
    throw error;
  } catch (error) {
    if (error.code === 'CLAUDE_RUNNING') throw error;
    if (error.status !== 1) throw error;
  }
}

function assertOriginalFrameworkSignature(layout) {
  if (process.platform !== 'darwin') throw new Error('Framework 原签名校验只能在 macOS 上执行');
  if (!fs.existsSync(layout.framework) || !fs.existsSync(layout.frameworkCodeResources)) {
    throw new Error('Framework 二进制或签名数据缺失，拒绝修改');
  }
  const inspection = spawnSync('/usr/bin/codesign', [
    '-dv', '--verbose=4', layout.framework,
  ], { encoding: 'utf8' });
  const details = `${inspection.stdout || ''}\n${inspection.stderr || ''}`;
  if (inspection.status !== 0) throw new Error(`无法读取 Framework 签名：${details.trim()}`);
  if (!details.includes('Authority=Developer ID Application: Anthropic PBC (Q6L2SF6YDW)')
      || !details.includes('TeamIdentifier=Q6L2SF6YDW')
      || details.includes('Signature=adhoc')) {
    throw new Error('当前 Framework 不是可确认的 Anthropic 原签名，拒绝补充或覆盖官方备份');
  }
  execFileSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', layout.frameworkRoot,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return {
    authority: 'Developer ID Application: Anthropic PBC (Q6L2SF6YDW)',
    frameworkSha256: sha256(fs.readFileSync(layout.framework)),
    codeResourcesSha256: sha256(fs.readFileSync(layout.frameworkCodeResources)),
  };
}

function supplementFrameworkBackup(layout, backupDir) {
  const signature = assertOriginalFrameworkSignature(layout);
  const backupsRoot = path.join(stateHome(), 'backups');
  if (path.dirname(path.resolve(backupDir)) !== path.resolve(backupsRoot)) {
    throw new Error('官方 Framework 只能补充到 ClaudeSpoof 的版本化还原备份');
  }
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('官方还原备份清单无效');
  const frameworkManifest = {
    authority: signature.authority,
    frameworkSha256: signature.frameworkSha256,
    codeResourcesSha256: signature.codeResourcesSha256,
  };
  if (manifest.framework && !isDeepStrictEqual(manifest.framework, frameworkManifest)) {
    throw new Error('现有备份的 Framework 清单与当前原签名文件不一致，拒绝覆盖');
  }
  const created = [];
  try {
    for (const relative of FRAMEWORK_BACKUP_FILES) {
      const source = path.join(layout.root, relative);
      const destination = path.join(backupDir, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      if (fs.existsSync(destination)) {
        if (sha256(fs.readFileSync(source)) !== sha256(fs.readFileSync(destination))) {
          throw new Error(`备份已存在但内容不同，拒绝覆盖：${relative}`);
        }
      } else {
        created.push(destination);
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      }
      if (!manifest.files.includes(relative)) manifest.files.push(relative);
    }
    manifest.framework = frameworkManifest;
    writeJson(manifestPath, manifest);
    return { backupDir, ...frameworkManifest };
  } catch (error) {
    for (const file of created) fs.rmSync(file, { force: true });
    throw error;
  }
}

function backupCurrent(layout, inspection, options = {}) {
  const includeFramework = options.includeFramework !== false;
  const includeHelpers = options.includeHelpers === undefined ? includeFramework : options.includeHelpers;
  const framework = includeFramework && options.requireOriginalFramework !== false
    ? assertOriginalFrameworkSignature(layout) : null;
  const helpers = includeHelpers && options.requireOriginalHelpers !== false
    ? assertOriginalHelpers(layout.root) : null;
  ensureHome();
  const backupDir = path.join(
    stateHome(),
    'backups',
    `${inspection.version.replace(/[^A-Za-z0-9._-]/g, '_')}-${Date.now()}`,
  );
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });

  const candidates = [
    { relative: 'Contents/Resources/app.asar', required: true },
    { relative: 'Contents/Info.plist', required: true },
    { relative: `Contents/MacOS/${inspection.executable}`, required: false },
    { relative: 'Contents/CodeResources', required: false },
    { relative: 'Contents/_CodeSignature', required: false, directory: true },
  ];
  if (includeFramework) {
    candidates.push(
      { relative: FRAMEWORK_RELATIVE, required: true },
      { relative: FRAMEWORK_CODE_RESOURCES_RELATIVE, required: true },
    );
  }
  if (includeHelpers) {
    for (const relative of helperFiles(layout.root)) candidates.push({ relative, required: true });
  }
  const files = [];
  for (const item of candidates) {
    const source = path.join(layout.root, item.relative);
    if (!fs.existsSync(source)) {
      if (item.required) throw new Error(`备份失败，缺少：${item.relative}`);
      continue;
    }
    const destination = path.join(backupDir, item.relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: Boolean(item.directory) });
    files.push(item.relative);
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    version: inspection.version,
    executable: inspection.executable,
    originalAsarSha256: inspection.archiveSha256,
    originalHeaderHash: inspection.headerHash,
    files,
  };
  if (framework) manifest.framework = framework;
  if (helpers) manifest.helpers = helpers;
  fs.writeFileSync(path.join(backupDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { backupDir, manifest };
}

function restoreFiles(layout, backupDir, onlyFiles = null) {
  const manifest = readJson(path.join(backupDir, 'manifest.json'), null);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('备份清单无效');
  const filter = onlyFiles ? new Set(onlyFiles) : null;
  for (const relative of manifest.files) {
    if (filter && !filter.has(relative)) continue;
    const source = path.join(backupDir, relative);
    const destination = path.join(layout.root, relative);
    if (!fs.existsSync(source)) throw new Error(`备份缺少：${relative}`);
    fs.rmSync(destination, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.cpSync(source, destination, { recursive: fs.statSync(source).isDirectory() });
  }
  return manifest;
}

const AD_HOC_TEAM_ENTITLEMENTS = Object.freeze([
  'com.apple.application-identifier',
  'com.apple.developer.team-identifier',
  'keychain-access-groups',
]);
const DISABLE_LIBRARY_VALIDATION = 'com.apple.security.cs.disable-library-validation';

function adHocEntitlementPlan(original, addDisableLibraryValidation = true) {
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new Error('原 entitlements 不是有效的 plist 字典');
  }
  const expected = { ...original };
  const removed = [];
  for (const key of AD_HOC_TEAM_ENTITLEMENTS) {
    if (Object.prototype.hasOwnProperty.call(expected, key)) {
      delete expected[key];
      removed.push(key);
    }
  }
  const added = [];
  if (addDisableLibraryValidation && expected[DISABLE_LIBRARY_VALIDATION] !== true) {
    expected[DISABLE_LIBRARY_VALIDATION] = true;
    added.push(DISABLE_LIBRARY_VALIDATION);
  }
  return { expected, removed, added };
}

function readEntitlementsXml(appPath) {
  return execFileSync('/usr/bin/codesign', [
    '--display', '--entitlements', '-', '--xml', appPath,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readPlistJson(plistPath) {
  const output = execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', plistPath,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(output);
}

function prepareAdHocEntitlements(appPath, temporaryDirectory, addDisableLibraryValidation = true) {
  const xml = readEntitlementsXml(appPath);
  const originalPath = path.join(temporaryDirectory, 'original-entitlements.plist');
  const filteredPath = path.join(temporaryDirectory, 'ad-hoc-entitlements.plist');
  const emptyPlist = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict/></plist>\n';
  fs.writeFileSync(originalPath, xml.trim() ? xml : emptyPlist, { mode: 0o600 });
  const original = readPlistJson(originalPath);
  const { expected, removed, added } = adHocEntitlementPlan(original, addDisableLibraryValidation);
  if (!xml.trim() && Object.keys(expected).length === 0) {
    return { path: null, expected: null, removed, added };
  }
  fs.copyFileSync(originalPath, filteredPath);
  for (const key of removed) {
    execFileSync('/usr/libexec/PlistBuddy', ['-c', `Delete :${key}`, filteredPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  for (const key of added) {
    const exists = Object.prototype.hasOwnProperty.call(original, key);
    const command = exists ? `Set :${key} true` : `Add :${key} bool true`;
    execFileSync('/usr/libexec/PlistBuddy', ['-c', command, filteredPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
  }
  const actual = readPlistJson(filteredPath);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('调整 entitlements 时出现了预期之外的变化，已停止重签');
  }
  return { path: filteredPath, expected, removed, added };
}

function verifyWrittenEntitlements(appPath, temporaryDirectory, expected) {
  const xml = readEntitlementsXml(appPath);
  if (expected === null) {
    if (xml.trim()) throw new Error('重签后出现了预期之外的 entitlements');
    return;
  }
  const writtenPath = path.join(temporaryDirectory, 'written-entitlements.plist');
  fs.writeFileSync(writtenPath, xml, { mode: 0o600 });
  const actual = readPlistJson(writtenPath);
  if (!isDeepStrictEqual(actual, expected)) {
    throw new Error('重签后的 entitlements 与预期不一致，已自动还原');
  }
}

function codesignApp(appPath, bundleIdentifier, options = {}) {
  const readRequirements = (target = appPath) => execFileSync('/usr/bin/codesign', [
    '--display', '--requirements', '-', target,
  ], { encoding: 'utf8' }).trim();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spoof-sign-'));
  let stageRoot = null;
  try {
    const originalRequirements = readRequirements();
    if (!originalRequirements.includes('designated =>')) {
      throw new Error('无法读取原 App 的 designated requirement，已停止重签');
    }
    const identity = localSigningIdentity();
    const expectedRequirements = identity
      ? combinedRequirements(originalRequirements, bundleIdentifier, identity)
      : originalRequirements;
    const requirementsPath = path.join(temporaryDirectory, 'requirements.txt');
    if (identity) fs.writeFileSync(requirementsPath, expectedRequirements, { mode: 0o600 });
    const entitlements = prepareAdHocEntitlements(
      appPath,
      temporaryDirectory,
      options.addDisableLibraryValidation !== false,
    );
    if (identity && normalizeRequirements(originalRequirements) === normalizeRequirements(expectedRequirements)) {
      const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', appPath], {
        encoding: 'utf8',
      });
      const details = `${inspected.stdout || ''}\n${inspected.stderr || ''}`;
      if (inspected.status === 0 && details.includes(`Authority=${identity.name}`)
          && !details.includes('Signature=adhoc')) {
        verifyWrittenEntitlements(appPath, temporaryDirectory, entitlements.expected);
        verifyAdHocSignature(appPath, bundleIdentifier, {
          modifiedFrameworkPath: options.modifiedFrameworkPath,
          modifiedNestedPaths: options.modifiedNestedPaths,
        });
        return {
          status: 'already-signed',
          signingIdentity: identity.name,
          localCertificateSha1: identity.sha1,
          officialUpdateRequirementPreserved: true,
          stagedAtomicReplace: false,
          removedEntitlements: entitlements.removed,
          addedEntitlements: entitlements.added,
          preservedEntitlements: Object.keys(entitlements.expected || {}).sort(),
        };
      }
    }

    // codesign can fail when replacing a large CMS signature in /Applications.
    // For a stable identity, sign and verify an APFS clone in the system temp
    // directory first, then atomically swap it in on the same APFS volume.
    // The original bundle remains untouched on failure.
    let signingPath = appPath;
    if (identity) {
      stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-spoof-stage-'));
      signingPath = path.join(stageRoot, path.basename(appPath));
      execFileSync('/bin/cp', ['-c', '-R', appPath, signingPath], { stdio: 'inherit' });
    }

    // The pinned local-certificate branch lets Keychain recognize this build.
    // Anthropic's exact original branch remains, so an official update must
    // still satisfy Anthropic's requirement. No arbitrary-signature branch is
    // accepted. Re-signing is idempotent and preserves hardened runtime.
    const args = [
      '--force', '--sign', identity ? identity.name : '-',
      '--preserve-metadata=flags,runtime',
    ];
    if (identity) args.push('--requirements', requirementsPath);
    else args.push('--preserve-metadata=requirements');
    if (entitlements.path) args.push('--entitlements', entitlements.path);
    args.push(signingPath);
    // The imported private key is ACL'd to /usr/bin/codesign. On this macOS
    // build, invoking it through the shell preserves that authorization when
    // the patcher itself is running under Node. "$@" avoids shell interpolation.
    const command = identity ? '/bin/bash' : '/usr/bin/codesign';
    const commandArgs = identity
      ? ['-c', 'exec "$@"', 'claude-spoof-codesign', '/usr/bin/codesign', ...args]
      : args;
    execFileSync(command, commandArgs, { stdio: 'inherit' });
    const writtenRequirements = readRequirements(signingPath);
    if (normalizeRequirements(writtenRequirements) !== normalizeRequirements(expectedRequirements)) {
      throw new Error('重签后 designated requirement 出现预期之外的变化，已自动还原');
    }

    const verificationOptions = {
      modifiedFrameworkPath: options.modifiedFrameworkPath,
      modifiedNestedPaths: options.modifiedNestedPaths,
    };
    verifyWrittenEntitlements(signingPath, temporaryDirectory, entitlements.expected);
    verifyAdHocSignature(signingPath, bundleIdentifier, verificationOptions);
    if (stageRoot) {
      const originalPath = path.join(stageRoot, '.original');
      fs.renameSync(appPath, originalPath);
      try { fs.renameSync(signingPath, appPath); }
      catch (error) {
        fs.renameSync(originalPath, appPath);
        throw error;
      }
      verifyWrittenEntitlements(appPath, temporaryDirectory, entitlements.expected);
      verifyAdHocSignature(appPath, bundleIdentifier, verificationOptions);
    }
    if (entitlements.removed.length) {
      console.log(`entitlements：已移除本机重签无法兑现的团队绑定项：${entitlements.removed.join('、')}`);
      console.log('其余原 entitlements（包括 JIT 与 virtualization）均已保留。');
    }
    if (entitlements.added.length) {
      console.log('entitlements：已为修改版进程启用 disable-library-validation。');
      console.log('注意：hardened runtime、SIP、Gatekeeper 与 Anthropic 官方更新 requirement 分支均未关闭。');
    }
    return {
      signingIdentity: identity ? identity.name : 'ad-hoc',
      localCertificateSha1: identity ? identity.sha1 : null,
      officialUpdateRequirementPreserved: true,
      stagedAtomicReplace: Boolean(stageRoot),
      removedEntitlements: entitlements.removed,
      addedEntitlements: entitlements.added,
      preservedEntitlements: Object.keys(entitlements.expected || {}).sort(),
    };
  } finally {
    if (stageRoot) fs.rmSync(stageRoot, { recursive: true, force: true });
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function verifyAdHocSignature(appPath, bundleIdentifier, options = {}) {
  const run = (extraArgs) => {
    let output = '';
    let failed = null;
    try {
      const result = execFileSync('/usr/bin/codesign', [
        ...extraArgs, '-R', `=identifier "${bundleIdentifier}"`, appPath,
      ], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      output = String(result || '');
    } catch (error) {
      failed = error;
      output = [error.stdout, error.stderr].filter(Boolean).join('\n');
    }
    return { failed, output };
  };
  const linesOf = (output) => output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const onlyExpected = (output, expected) => {
    const lines = linesOf(output);
    const present = lines.filter((line) => expected.has(line));
    const unexpected = lines.filter((line) => (
      !line.startsWith('Executable=')
      && !line.startsWith('--prepared:')
      && !line.startsWith('--validated:')
      && !expected.has(line)
    ));
    return present.length === expected.size && unexpected.length === 0;
  };

  // codesign checks both the explicit -R requirement AND the preserved DR.
  // Accept only the exact Anthropic DR warning, never structural corruption.
  const full = run(['--verify', '--deep', '--strict', '--verbose=2']);
  if (!full.failed) return;
  const expected = new Set([
    `${appPath}: valid on disk`,
    `${appPath}: does not satisfy its designated Requirement`,
    `${appPath}: explicit requirement satisfied`,
  ]);
  if (onlyExpected(full.output, expected)) {
    console.log('codesign：结构、嵌套代码与显式 requirement 均通过；ad-hoc 签名不满足 Anthropic 原 DR 属预期。');
    return;
  }

  // Ad-hoc nested bundles retain Anthropic's DR. Accept only their exact
  // diagnostics, independently verify every one, and additionally verify the
  // main Mach-O. --ignore-resources is additive, not a replacement for the
  // full resource-envelope check above.
  const framework = options.modifiedFrameworkPath;
  const nested = options.modifiedNestedPaths || (framework ? [{
    path: framework,
    bundleIdentifier: 'com.github.Electron.framework',
  }] : []);
  const nestedExpected = new Set([
    ...nested.map((item) => `file modified: ${item.path}`),
    `${appPath}: nested code is modified or invalid`,
  ]);
  if (nested.length && onlyExpected(full.output, nestedExpected)) {
    for (const item of nested) verifyAdHocSignature(item.path, item.bundleIdentifier);
    const main = run(['--verify', '--strict', '--ignore-resources', '--verbose=2']);
    const mainExpected = new Set([
      `${appPath}: valid on disk (not all contents verified)`,
      `${appPath}: does not satisfy its designated Requirement`,
      `${appPath}: explicit requirement satisfied`,
    ]);
    if (onlyExpected(main.output, mainExpected)) {
      console.log('codesign：主 Mach-O、完整资源封套及全部修改过的嵌套 bundle 分别通过；仅保留原 DR 的诊断。');
      return;
    }
  }
  const failure = new Error(`codesign 验证失败，且不只是预期的 designated requirement 警告：\n${full.output}`);
  failure.cause = full.failed;
  throw failure;
}

function pruneBackups(keep = 2) {
  const root = path.join(stateHome(), 'backups');
  if (!fs.existsSync(root)) return;
  const directories = fs.readdirSync(root)
    .map((name) => path.join(root, name))
    .filter((item) => fs.statSync(item).isDirectory())
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  for (const old of directories.slice(keep)) fs.rmSync(old, { recursive: true, force: true });
}

function acquireOperationLock() {
  ensureHome();
  const lockPath = path.join(stateHome(), 'operation.lock');
  function acquire() {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
      fs.closeSync(fd);
      return;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    const lock = readJson(lockPath, {});
    let alive = Boolean(lock.pid);
    if (alive) {
      try { process.kill(lock.pid, 0); }
      catch (error) { if (error.code === 'ESRCH') alive = false; }
    }
    if (alive) {
      const error = new Error('另一个补丁／还原操作正在进行，请稍后重试');
      error.code = 'OPERATION_IN_PROGRESS';
      throw error;
    }
    fs.rmSync(lockPath, { force: true });
    acquire();
  }
  acquire();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(lockPath, { force: true });
  };
}

function prepareFrameworkTemp(layout) {
  const output = `${layout.framework}.claude-spoof-${process.pid}.tmp`;
  const digest = calculateIntegrityDigestV1(readAsarIntegrity(layout.plist));
  const result = writeFrameworkIntegrityDigest({ input: layout.framework, output, digest });
  if (!result.changed) fs.rmSync(output, { force: true });
  return { output, ...result };
}

function repairFrameworkIntegrity(appPath, options = {}) {
  const release = acquireOperationLock();
  try {
    if (!options.skipProcessCheck) assertClaudeNotRunning();
    return repairFrameworkIntegrityLocked(appPath, options);
  } finally { release(); }
}

function repairFrameworkIntegrityLocked(appPath, options = {}) {
  if (process.platform !== 'darwin') throw new Error('Framework 完整性修复只能在 macOS 上执行');
  const layout = appLayout(appPath);
  const before = inspectApp(layout.root);
  if (before.frameworkIntegrityMatches) return { status: 'already-patched', ...before };
  if (before.injectionVersion !== INJECTION_VERSION || !before.integrityMatches || !before.mainIntegrityMatches) {
    throw new Error('ASAR 补丁或其完整性尚未通过验证，不能只修 Framework 摘要');
  }
  const state = readJson(statePath(), null);
  if (!state || !state.lastBackup) throw new Error('没有可补充 Framework 的官方还原备份');
  if (path.resolve(state.appPath || layout.root) !== layout.root) {
    throw new Error('最近官方备份属于另一个 App 路径');
  }
  const manifest = readJson(path.join(state.lastBackup, 'manifest.json'), null);
  if (!manifest || manifest.version !== before.version) {
    throw new Error('官方备份版本与当前 App 不一致，拒绝修改 Framework');
  }

  const frameworkTemp = `${layout.framework}.claude-spoof-${process.pid}.tmp`;
  let touched = false;
  try {
    // The existing backup predates Framework support. Supplement it only after
    // Anthropic's signature and all signed nested code validate successfully.
    supplementFrameworkBackup(layout, state.lastBackup);
    supplementHelpersBackup(layout.root, state.lastBackup);
    const digest = calculateIntegrityDigestV1(readAsarIntegrity(layout.plist));
    const written = writeFrameworkIntegrityDigest({
      input: layout.framework,
      output: frameworkTemp,
      digest,
    });
    if (!written.changed) throw new Error('Framework 摘要在修复前发生变化，请重新检查');
    const mode = fs.statSync(layout.framework).mode;
    fs.renameSync(frameworkTemp, layout.framework);
    touched = true;
    fs.chmodSync(layout.framework, mode);

    // Nested code first, then the outer App. Never relax the preserved DR.
    codesignApp(layout.frameworkRoot, 'com.github.Electron.framework', {
      addDisableLibraryValidation: false,
    });
    codesignHelpers(layout.root, codesignApp);
    codesignApp(layout.root, before.bundleIdentifier, {
      modifiedNestedPaths: modifiedNestedSignatures(layout),
    });

    const after = inspectApp(layout.root);
    if (after.injectionVersion !== INJECTION_VERSION || !after.integrityMatches
        || !after.mainIntegrityMatches || !after.frameworkIntegrityMatches) {
      throw new Error('Framework 修复后的最终完整性验证失败');
    }
    writeJson(statePath(), Object.assign(state, {
      patchedFrameworkDigest: after.storedFrameworkDigest,
      updatedAt: new Date().toISOString(),
    }));
    return { status: 'framework-repaired', backup: state.lastBackup, ...after };
  } catch (error) {
    fs.rmSync(frameworkTemp, { force: true });
    if (touched) {
      try {
        restoreFiles(layout, state.lastBackup, [...FRAMEWORK_BACKUP_FILES, ...helperFiles(layout.root)]);
      } catch (restoreError) {
        error.message += `；嵌套代码自动还原也失败：${restoreError.message}。备份位于 ${state.lastBackup}`;
      }
    }
    throw error;
  }
}

function patchApp(appPath, options = {}) {
  const release = acquireOperationLock();
  try { return patchAppLocked(appPath, options); }
  finally { release(); }
}

function patchAppLocked(appPath, options = {}) {
  const layout = appLayout(appPath);
  const before = inspectApp(layout.root);

  if (before.injectionVersion === INJECTION_VERSION && before.integrityMatches
      && before.mainIntegrityMatches && before.frameworkIntegrityMatches && !options.force) {
    return { status: 'already-patched', ...before };
  }
  if (!options.skipProcessCheck) assertClaudeNotRunning();
  if (!before.mainIntegrityMatches) {
    throw new Error('主入口的逐文件 ASAR 完整性校验失败；为避免破坏其他修改，已停止。');
  }
  if (!before.integrityMatches) {
    throw new Error('当前 app.asar 与 Info.plist 完整性哈希不一致；为避免破坏其他修改，已停止。');
  }
  if (before.injectionVersion === INJECTION_VERSION && !before.frameworkIntegrityMatches && !options.force) {
    return repairFrameworkIntegrityLocked(layout.root, options);
  }

  ensureHome();
  const asarTemp = `${layout.asar}.claude-spoof-${process.pid}.tmp`;
  const plistTemp = `${layout.plist}.claude-spoof-${process.pid}.tmp`;
  const frameworkTemp = `${layout.framework}.claude-spoof-${process.pid}.tmp`;
  let backup = null;
  let touched = false;

  try {
    const rewritten = rewriteArchive({
      input: layout.asar,
      output: asarTemp,
      transform(filePath, content) {
        if (filePath !== before.main) return undefined;
        const injected = applyInjection(content.toString('utf8'), configPath());
        return Buffer.from(injected, 'utf8');
      },
    });
    if (rewritten.changed.length !== 1 || rewritten.changed[0] !== before.main) {
      throw new Error(`补丁入口异常：${rewritten.changed.join(', ')}`);
    }
    verifyArchive(asarTemp, before.main);
    const verification = inspectAppFromArchive(asarTemp, layout.plist, false);
    if (verification.injectionVersion !== INJECTION_VERSION) {
      throw new Error('写入后的 ASAR 未通过补丁标记验证');
    }
    updatePlistHash({
      source: layout.plist,
      destination: plistTemp,
      expectedHash: rewritten.originalHeaderHash,
      newHash: rewritten.headerHash,
    });

    backup = backupCurrent(layout, before);
    const asarMode = fs.statSync(layout.asar).mode;
    const plistMode = fs.statSync(layout.plist).mode;
    fs.renameSync(asarTemp, layout.asar);
    touched = true;
    fs.chmodSync(layout.asar, asarMode);
    try {
      fs.renameSync(plistTemp, layout.plist);
      fs.chmodSync(layout.plist, plistMode);
    } catch (error) {
      fs.copyFileSync(path.join(backup.backupDir, 'Contents/Resources/app.asar'), layout.asar);
      throw error;
    }

    const frameworkWrite = prepareFrameworkTemp(layout);
    if (frameworkWrite.changed) {
      const frameworkMode = fs.statSync(layout.framework).mode;
      fs.renameSync(frameworkTemp, layout.framework);
      fs.chmodSync(layout.framework, frameworkMode);
    }

    if (options.sign !== false && process.platform === 'darwin') {
      if (frameworkWrite.changed) {
        codesignApp(layout.frameworkRoot, 'com.github.Electron.framework', {
          addDisableLibraryValidation: false,
        });
      }
      codesignHelpers(layout.root, codesignApp);
      codesignApp(layout.root, before.bundleIdentifier, {
        modifiedNestedPaths: modifiedNestedSignatures(layout),
      });
    }

    const after = inspectApp(layout.root);
    if (after.injectionVersion !== INJECTION_VERSION || !after.integrityMatches
        || !after.mainIntegrityMatches || !after.frameworkIntegrityMatches) {
      throw new Error('补丁后的最终验证失败');
    }
    const state = Object.assign(readJson(statePath(), {}), {
      appPath: layout.root,
      lastBackup: backup.backupDir,
      patchedVersion: after.version,
      patchedAsarSha256: after.archiveSha256,
      patchedHeaderHash: after.headerHash,
      patchedFrameworkDigest: after.storedFrameworkDigest,
      injectionVersion: INJECTION_VERSION,
      updatedAt: new Date().toISOString(),
    });
    writeJson(statePath(), state);
    pruneBackups(2);
    return { status: 'patched', backup: backup.backupDir, ...after };
  } catch (error) {
    fs.rmSync(asarTemp, { force: true });
    fs.rmSync(plistTemp, { force: true });
    fs.rmSync(frameworkTemp, { force: true });
    if (touched && backup) {
      try { restoreFiles(layout, backup.backupDir); }
      catch (restoreError) {
        error.message += `；自动还原也失败：${restoreError.message}。备份位于 ${backup.backupDir}`;
      }
    }
    throw error;
  }
}

// Used to inspect a temporary ASAR before it replaces the app's original file.
function inspectAppFromArchive(asarPath, plistPath, requireIntegrity = true) {
  const archive = readArchive(asarPath);
  const pkg = archive.rows.find((row) => row.path === 'package.json');
  const main = JSON.parse(pkg.content.toString('utf8')).main.replace(/^\.\//, '');
  const entry = archive.rows.find((row) => row.path === main);
  const headerHash = sha256(archive.headerString);
  const expectedHash = plistAsarHash(plistPath);
  return {
    main,
    injectionVersion: injectionVersion(entry.content.toString('utf8')),
    integrityMatches: requireIntegrity ? headerHash === expectedHash : true,
  };
}

function repairSignature(appPath, options = {}) {
  const release = acquireOperationLock();
  try {
    if (process.platform !== 'darwin') throw new Error('签名修复只能在 macOS 上执行');
    if (!options.skipProcessCheck) assertClaudeNotRunning();
    const layout = appLayout(appPath);
    const before = inspectApp(layout.root);
    if (!before.injectionVersion || !before.integrityMatches
        || !before.mainIntegrityMatches || !before.frameworkIntegrityMatches) {
      throw new Error('当前 App 没有通过验证的完整补丁，不能用签名修复代替重新补丁');
    }
    const state = readJson(statePath(), null);
    if (!state || !state.lastBackup) throw new Error('没有官方还原备份，拒绝重签 Helper');
    const officialManifest = readJson(path.join(state.lastBackup, 'manifest.json'), null);
    if (!officialManifest || officialManifest.version !== before.version) {
      throw new Error('官方备份版本与当前 App 不一致，拒绝重签 Helper');
    }
    if (!officialManifest.framework) throw new Error('官方备份缺少 Framework，拒绝统一重签');
    for (const [relative, expected] of [
      [FRAMEWORK_RELATIVE, officialManifest.framework.frameworkSha256],
      [FRAMEWORK_CODE_RESOURCES_RELATIVE, officialManifest.framework.codeResourcesSha256],
    ]) {
      if (sha256(fs.readFileSync(path.join(state.lastBackup, relative))) !== expected) {
        throw new Error(`官方 Framework 备份校验失败：${relative}`);
      }
    }
    supplementHelpersBackup(layout.root, state.lastBackup);

    // Temporary safety copies may contain ad-hoc or local-signed files; they
    // never replace the pristine official backup or its manifest.
    const safetyBackup = backupCurrent(layout, before, {
      includeFramework: true,
      requireOriginalFramework: false,
      includeHelpers: true,
      requireOriginalHelpers: false,
    });
    let keepSafetyBackup = false;
    try {
      const frameworkSigning = codesignApp(layout.frameworkRoot, 'com.github.Electron.framework', {
        addDisableLibraryValidation: false,
      });
      const helperSigning = codesignHelpers(layout.root, codesignApp);
      const signing = codesignApp(layout.root, before.bundleIdentifier, {
        modifiedNestedPaths: modifiedNestedSignatures(layout),
      });
      const after = inspectApp(layout.root);
      if (after.injectionVersion !== before.injectionVersion || !after.integrityMatches
          || !after.mainIntegrityMatches || !after.frameworkIntegrityMatches) {
        throw new Error('签名修复后的补丁完整性验证失败');
      }
      return { status: 'signature-repaired', frameworkSigning, helperSigning, ...signing, ...after };
    } catch (error) {
      try { restoreFiles(layout, safetyBackup.backupDir); }
      catch (restoreError) {
        keepSafetyBackup = true;
        error.message += `；签名修复回滚失败，安全副本位于 ${safetyBackup.backupDir}：${restoreError.message}`;
      }
      throw error;
    } finally {
      if (!keepSafetyBackup) fs.rmSync(safetyBackup.backupDir, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}

function restoreApp(appPath, options = {}) {
  const release = acquireOperationLock();
  try { return restoreAppLocked(appPath, options); }
  finally { release(); }
}

function restoreAppLocked(appPath, options = {}) {
  if (!options.skipProcessCheck) assertClaudeNotRunning();
  const layout = appLayout(appPath);
  const state = readJson(statePath(), null);
  if (!state || !state.lastBackup) throw new Error('没有可恢复的备份');
  if (path.resolve(state.appPath || layout.root) !== layout.root) {
    throw new Error('最近备份属于另一个 App 路径');
  }
  const manifest = readJson(path.join(state.lastBackup, 'manifest.json'), null);
  if (!manifest) throw new Error('备份清单不存在');
  const current = inspectApp(layout.root);
  if (!options.force && current.version !== manifest.version) {
    throw new Error(`当前版本 ${current.version} 与备份版本 ${manifest.version} 不同，拒绝混合还原`);
  }
  const currentSha = sha256(fs.readFileSync(layout.asar));
  if (!options.force && state.patchedAsarSha256 && currentSha !== state.patchedAsarSha256) {
    throw new Error('当前 app.asar 不是本工具最后写入的版本，拒绝覆盖');
  }
  if (manifest.framework) {
    const expected = new Map([
      [FRAMEWORK_RELATIVE, manifest.framework.frameworkSha256],
      [FRAMEWORK_CODE_RESOURCES_RELATIVE, manifest.framework.codeResourcesSha256],
    ]);
    for (const [relative, hash] of expected) {
      if (!manifest.files.includes(relative)
          || sha256(fs.readFileSync(path.join(state.lastBackup, relative))) !== hash) {
        throw new Error(`官方 Framework 备份校验失败：${relative}`);
      }
    }
  }
  if (manifest.helpers) {
    for (const helper of helperLayout(layout.root)) {
      const expected = manifest.helpers[helper.name];
      if (!expected
          || sha256(fs.readFileSync(path.join(state.lastBackup, helper.executableRelative))) !== expected.executableSha256
          || sha256(fs.readFileSync(path.join(state.lastBackup, helper.codeResourcesRelative))) !== expected.codeResourcesSha256) {
        throw new Error(`官方 Helper 备份校验失败：${helper.name}`);
      }
    }
  }
  restoreFiles(layout, state.lastBackup);
  const restoredSha = sha256(fs.readFileSync(layout.asar));
  if (restoredSha !== manifest.originalAsarSha256) throw new Error('还原后的 ASAR 校验失败');
  if (manifest.framework) assertOriginalFrameworkSignature(layout);
  if (manifest.helpers) assertOriginalHelpers(layout.root);
  writeJson(statePath(), Object.assign(state, {
    restoredAt: new Date().toISOString(),
    patchedAsarSha256: null,
    patchedFrameworkDigest: null,
  }));
  return { status: 'restored', backup: state.lastBackup, ...inspectApp(layout.root) };
}

module.exports = {
  appLayout,
  inspectApp,
  patchApp,
  repairFrameworkIntegrity,
  repairSignature,
  restoreApp,
  assertClaudeNotRunning,
  assertOriginalFrameworkSignature,
  supplementFrameworkBackup,
  codesignApp,
  verifyAdHocSignature,
  adHocEntitlementPlan,
  AD_HOC_TEAM_ENTITLEMENTS,
  DISABLE_LIBRARY_VALIDATION,
  FRAMEWORK_BACKUP_FILES,
};
