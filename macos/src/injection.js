'use strict';

const INJECTION_VERSION = 3;
const BEGIN = `/* CLAUDE_SPOOF_BEGIN v${INJECTION_VERSION} */`;
const END = '/* CLAUDE_SPOOF_END */';

// This function is serialized into Claude's main-process entry point. It must
// remain self-contained: no variables or imports from the patcher are visible.
function bootstrap(configPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  let config = {
    enabled: true,
    timezone: 'Europe/London',
    language: 'en-GB',
    overrideAcceptLanguage: true,
  };
  try {
    const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    config = Object.assign(config, saved);
  } catch (_) {}

  if (!config.enabled) return;
  if (typeof config.timezone !== 'string' || !config.timezone) return;
  if (typeof config.language !== 'string' || !config.language) return;

  // Read by Cowork, local shell commands and Node's Intl/Date APIs.
  process.env.TZ = config.timezone;

  const verificationPath = path.join(path.dirname(configPath), 'runtime-verification.json');
  const verification = { main: null, renderers: [], errors: [] };
  let writeQueue = Promise.resolve();
  function saveVerification() {
    const body = JSON.stringify(verification, null, 2) + '\n';
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await fs.promises.writeFile(verificationPath, body, { mode: 0o600 });
    }).catch(() => {});
  }
  function dateSample() {
    const sampleUtc = '2026-11-08T12:34:56.000Z';
    const date = new Date(sampleUtc);
    return {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      sampleUtc,
      sampleOffsetMinutes: date.getTimezoneOffset(),
      sampleLocalTime: date.toString(),
    };
  }
  try {
    verification.main = { envTZ: process.env.TZ, ...dateSample() };
    saveVerification();
  } catch (error) {
    verification.errors.push({ scope: 'main', message: String(error && error.message || error) });
    saveVerification();
  }

  let electron;
  try {
    electron = require('electron');
  } catch (error) {
    console.warn('[ClaudeSpoof] Electron is unavailable:', error);
    return;
  }
  const app = electron && electron.app;
  if (!app) return;

  // These are read before the managed config is sent to the remote main view.
  try { app.getPreferredSystemLanguages = () => [config.language]; } catch (_) {}
  try { app.getLocale = () => config.language; } catch (_) {}
  try {
    if (typeof app.getSystemLocale === 'function') {
      app.getSystemLocale = () => config.language;
    }
  } catch (_) {}
  try { app.commandLine.appendSwitch('lang', config.language); } catch (_) {}

  app.whenReady().then(() => {
    try {
      verification.main = {
        ...verification.main,
        envTZ: process.env.TZ,
        ...dateSample(),
        electronLocale: app.getLocale(),
        preferredSystemLanguages: app.getPreferredSystemLanguages(),
      };
    } catch (error) {
      verification.errors.push({ scope: 'electron', message: String(error && error.message || error) });
    }
    saveVerification();
  }).catch(() => {});

  const queues = new WeakMap();
  const warned = new WeakSet();

  async function emulate(contents) {
    if (!contents || contents.isDestroyed()) return;
    const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (url.startsWith('devtools://')) return;

    const dbg = contents.debugger;
    if (!dbg.isAttached()) dbg.attach('1.3');
    await dbg.sendCommand('Emulation.setTimezoneOverride', {
      timezoneId: config.timezone,
    });
    const overrideNotes = [];
    try {
      await dbg.sendCommand('Emulation.setLocaleOverride', {
        locale: config.language,
      });
    } catch (error) {
      // Claude may install its own locale override when an account session starts.
      // Accept that conflict only if the measured values match our configuration.
      if (!/Another locale override is already in effect/i.test(String(error && error.message || error))) {
        throw error;
      }
      overrideNotes.push('Locale was already overridden; verified the resulting values instead.');
    }

    if (config.overrideAcceptLanguage) {
      await dbg.sendCommand('Network.enable');
      await dbg.sendCommand('Network.setUserAgentOverride', {
        userAgent: contents.getUserAgent(),
        acceptLanguage: config.language,
      });
    }

    const probe = await dbg.sendCommand('Runtime.evaluate', {
      expression: `(() => { const sampleUtc = '2026-11-08T12:34:56.000Z'; const date = new Date(sampleUtc); return { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, language: navigator.language, languages: navigator.languages, sampleUtc, sampleOffsetMinutes: date.getTimezoneOffset(), sampleLocalTime: date.toString() }; })()`,
      returnByValue: true,
    });
    if (probe.exceptionDetails) throw new Error('Renderer time-zone probe failed');
    const actual = probe.result.value;
    if (actual.timeZone !== config.timezone) {
      throw new Error(`Renderer time zone mismatch: ${JSON.stringify(actual)}`);
    }
    if (actual.locale !== config.language || actual.language !== config.language) {
      throw new Error(`Renderer locale mismatch: ${JSON.stringify(actual)}`);
    }
    verification.renderers = verification.renderers.filter((row) => row.rendererId !== contents.id);
    verification.renderers.push({
      rendererId: contents.id,
      targetType: typeof contents.getType === 'function' ? contents.getType() : 'unknown',
      ...actual,
      overrideNotes,
    });
    saveVerification();
  }

  function schedule(contents) {
    if (!contents || contents.isDestroyed()) return;
    const previous = queues.get(contents) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => emulate(contents)).catch((error) => {
      verification.errors.push({
        scope: 'renderer',
        rendererId: contents.id,
        message: String(error && error.message || error),
      });
      saveVerification();
      if (!warned.has(contents)) {
        warned.add(contents);
        console.warn('[ClaudeSpoof] Renderer override failed:', error && error.message);
      }
    });
    queues.set(contents, next);
  }

  app.on('web-contents-created', (_event, contents) => {
    schedule(contents);
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) schedule(contents);
    });
  });

  console.warn(`[ClaudeSpoof] active: TZ=${config.timezone}, locale=${config.language}`);
}

function makeInjection(configPath) {
  return `${BEGIN}\n(${bootstrap.toString()})(${JSON.stringify(configPath)});\n${END}\n`;
}

function stripInjection(source) {
  return source.replace(/\n?\/\* CLAUDE_SPOOF_BEGIN v\d+ \*\/[\s\S]*?\/\* CLAUDE_SPOOF_END \*\/\n?/, '');
}

function applyInjection(source, configPath) {
  const clean = stripInjection(source);
  const strict = clean.startsWith('"use strict";') ? '"use strict";' : '';
  const body = strict ? clean.slice(strict.length) : clean;
  return strict + '\n' + makeInjection(configPath) + body;
}

function injectionVersion(source) {
  const match = source.match(/\/\* CLAUDE_SPOOF_BEGIN v(\d+) \*\//);
  return match ? Number(match[1]) : null;
}

module.exports = {
  INJECTION_VERSION,
  BEGIN,
  END,
  makeInjection,
  stripInjection,
  applyInjection,
  injectionVersion,
};
