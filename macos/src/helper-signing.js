'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { readJson, writeJson } = require('./config');

const HELPER_NAMES = Object.freeze([
  'Claude Helper',
  'Claude Helper (Renderer)',
  'Claude Helper (GPU)',
  'Claude Helper (Plugin)',
]);
const AUTHORITY = 'Developer ID Application: Anthropic PBC (Q6L2SF6YDW)';

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function plistString(file, key) {
  return execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, file], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function helperLayout(appRoot) {
  return HELPER_NAMES.map((name) => {
    const relativeRoot = `Contents/Frameworks/${name}.app`;
    const root = path.join(appRoot, relativeRoot);
    const info = path.join(root, 'Contents', 'Info.plist');
    const executable = plistString(info, 'CFBundleExecutable');
    return {
      name,
      appRoot,
      root,
      relativeRoot,
      bundleIdentifier: plistString(info, 'CFBundleIdentifier'),
      executableRelative: `${relativeRoot}/Contents/MacOS/${executable}`,
      codeResourcesRelative: `${relativeRoot}/Contents/_CodeSignature/CodeResources`,
    };
  });
}

function helperFiles(appRoot) {
  return helperLayout(appRoot).flatMap((helper) => [
    helper.executableRelative,
    helper.codeResourcesRelative,
  ]);
}

function assertOriginalHelper(helper) {
  const inspected = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', helper.root], {
    encoding: 'utf8',
  });
  const details = `${inspected.stdout || ''}\n${inspected.stderr || ''}`;
  if (inspected.status !== 0 || !details.includes(`Authority=${AUTHORITY}`)
      || !details.includes('TeamIdentifier=Q6L2SF6YDW') || details.includes('Signature=adhoc')) {
    throw new Error(`${helper.name} 不是可确认的 Anthropic 原签名，拒绝补充或覆盖官方备份`);
  }
  execFileSync('/usr/bin/codesign', [
    '--verify', '--deep', '--strict', '--verbose=2', helper.root,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return {
    authority: AUTHORITY,
    executableSha256: sha256(path.join(helper.appRoot, helper.executableRelative)),
    codeResourcesSha256: sha256(path.join(helper.appRoot, helper.codeResourcesRelative)),
  };
}

function assertOriginalHelpers(appRoot) {
  const result = {};
  for (const helper of helperLayout(appRoot)) result[helper.name] = assertOriginalHelper(helper);
  return result;
}

function supplementHelpersBackup(appRoot, backupDir) {
  const manifestPath = path.join(backupDir, 'manifest.json');
  const manifest = readJson(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('官方还原备份清单无效');
  if (!manifest.helpers) manifest.helpers = {};
  const created = [];
  try {
    for (const helper of helperLayout(appRoot)) {
      const existing = manifest.helpers[helper.name];
      const executableBackup = path.join(backupDir, helper.executableRelative);
      const resourcesBackup = path.join(backupDir, helper.codeResourcesRelative);
      if (existing) {
        if (!manifest.files.includes(helper.executableRelative)
            || !manifest.files.includes(helper.codeResourcesRelative)
            || !fs.existsSync(executableBackup) || !fs.existsSync(resourcesBackup)
            || sha256(executableBackup) !== existing.executableSha256
            || sha256(resourcesBackup) !== existing.codeResourcesSha256) {
          throw new Error(`${helper.name} 官方备份校验失败，拒绝覆盖`);
        }
        continue;
      }
      const original = assertOriginalHelper(helper);
      for (const relative of [helper.executableRelative, helper.codeResourcesRelative]) {
        const source = path.join(appRoot, relative);
        const destination = path.join(backupDir, relative);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        if (fs.existsSync(destination)) throw new Error(`备份已存在但清单未登记，拒绝覆盖：${relative}`);
        created.push(destination);
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        manifest.files.push(relative);
      }
      manifest.helpers[helper.name] = original;
    }
    writeJson(manifestPath, manifest);
    return manifest.helpers;
  } catch (error) {
    for (const file of created) fs.rmSync(file, { force: true });
    throw error;
  }
}

function codesignHelpers(appRoot, codesignTarget) {
  const results = [];
  for (const helper of helperLayout(appRoot)) {
    results.push({
      name: helper.name,
      signing: codesignTarget(helper.root, helper.bundleIdentifier, {
        addDisableLibraryValidation: true,
      }),
    });
  }
  return results;
}

module.exports = {
  HELPER_NAMES,
  helperLayout,
  helperFiles,
  assertOriginalHelpers,
  supplementHelpersBackup,
  codesignHelpers,
};
