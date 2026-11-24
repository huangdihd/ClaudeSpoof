'use strict';

const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LOCAL_SIGNING_IDENTITY = 'ClaudeSpoof Local Code Signing';

function localSigningIdentity() {
  if (process.platform !== 'darwin') return null;
  const identities = spawnSync('/usr/bin/security', ['find-identity', '-p', 'codesigning'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (identities.status !== 0 || !identities.stdout.includes(`"${LOCAL_SIGNING_IDENTITY}"`)) return null;
  const loginKeychain = path.join(os.homedir(), 'Library', 'Keychains', 'login.keychain-db');
  const certificate = spawnSync('/usr/bin/security', [
    'find-certificate', '-c', LOCAL_SIGNING_IDENTITY, '-Z', loginKeychain,
  ], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const match = certificate.status === 0
    ? certificate.stdout.match(/SHA-1 hash: ([A-F0-9]{40})/i)
    : null;
  if (!match) return null;
  return { name: LOCAL_SIGNING_IDENTITY, sha1: match[1].toLowerCase() };
}

function normalizeRequirements(value) {
  return String(value).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').trim();
}

function combinedRequirements(originalRequirements, bundleIdentifier, identity) {
  if (!identity || !/^[a-f0-9]{40}$/.test(identity.sha1)) {
    throw new Error('本机签名证书指纹无效');
  }
  if (!/^[A-Za-z0-9.-]+$/.test(bundleIdentifier)) {
    throw new Error(`bundle identifier 无效：${bundleIdentifier}`);
  }
  const match = String(originalRequirements).match(/designated\s*=>\s*([\s\S]+)/);
  if (!match) throw new Error('无法解析原 designated requirement');
  let official = normalizeRequirements(match[1]);
  const generated = official.match(/^identifier "([^"]+)" and certificate root = H"([a-f0-9]{40})" or (identifier ".*)$/);
  if (generated) {
    if (generated[1] !== bundleIdentifier) throw new Error('已有本机 requirement 的 identifier 异常');
    official = generated[3];
  }
  if (!official.includes(`identifier "${bundleIdentifier}"`)
      || !official.includes('anchor apple generic')
      || !official.includes('certificate leaf[subject.OU] = Q6L2SF6YDW')) {
    throw new Error('原 designated requirement 不是预期的 Anthropic 要求，拒绝修改');
  }
  const local = `identifier "${bundleIdentifier}" and certificate root = H"${identity.sha1}"`;
  return `designated => ${local} or ${official}\n`;
}

module.exports = {
  LOCAL_SIGNING_IDENTITY,
  localSigningIdentity,
  normalizeRequirements,
  combinedRequirements,
};
