const claudeSpoofConfigPath = process.env.CLAUDE_SPOOF_CONFIG || require('node:path').join(
  process.env.LOCALAPPDATA || process.cwd(), 'ClaudeSpoofRuntime', 'config.json'
);
/* CLAUDE_SPOOF_BEGIN v3 */
(function bootstrap(configPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  let config = {
    enabled: true,
    timezone: 'Asia/Tokyo',
    language: 'en-US',
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
  const verification = {
    main: null,
    renderers: [],
    errors: [],
    vmSpawnOverrides: { count: 0, lastAtUtc: null },
  };

  // The VM does not inherit Windows' process TZ. Cover every process spawned by
  // Claude's VM client, including one-shot commands that otherwise omit env.
  // Unknown traffic and all non-spawn RPC calls pass through byte-for-byte.
  const net = require('node:net');
  const originalSocketWrite = net.Socket.prototype.write;
  net.Socket.prototype.write = function (chunk, encoding, callback) {
    try {
      if (Buffer.isBuffer(chunk) && chunk.length >= 5) {
        const length = chunk.readUInt32BE(0);
        if (length === chunk.length - 4) {
          const message = JSON.parse(chunk.subarray(4).toString('utf8'));
          const params = message && message.params;
          if (
            message.method === 'spawn' &&
            params &&
            typeof params.command === 'string' &&
            Object.hasOwn(params, 'isResume')
          ) {
            params.env = { ...(params.env || {}), TZ: config.timezone };
            const body = Buffer.from(JSON.stringify(message), 'utf8');
            const framed = Buffer.allocUnsafe(body.length + 4);
            framed.writeUInt32BE(body.length, 0);
            body.copy(framed, 4);
            chunk = framed;
            verification.vmSpawnOverrides.count += 1;
            verification.vmSpawnOverrides.lastAtUtc = new Date().toISOString();
            saveVerification();
          }
        }
      }
    } catch (_) {
      // A non-VM or fragmented frame must never be blocked by this override.
    }
    return originalSocketWrite.call(this, chunk, encoding, callback);
  };

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
    verification.main = { processId: process.pid, envTZ: process.env.TZ, ...dateSample() };
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
        processId: process.pid, envTZ: process.env.TZ,
        ...dateSample(),
        electronLocale: app.getLocale(),
        preferredSystemLanguages: app.getPreferredSystemLanguages(),
      };
      // Latest Code, Cowork and Computer Use all import this exact provider.
      const provider = require('./index.chunk-DCLV6e70.js');
      verification.sharedTimezoneProvider = {
        module: 'index.chunk-DCLV6e70.js',
        consumers: ['Code', 'Cowork', 'Computer Use'],
        resolvedTimeZone: provider.t(),
      };
      const core = require('./index.chunk-CCkEi--u.js');
      verification.vmApiExports = Object.keys(core).filter((key) => /vm|cowork/i.test(key)).sort();
    } catch (error) {
      verification.errors.push({ scope: 'electron', message: String(error && error.message || error) });
    }
    saveVerification();
  }).catch(() => {});

  // One-shot, explicitly enabled local verification. This starts Cowork through
  // the client's own implementation but never creates a model/chat request.
  if (config.verifyCoworkVm) {
    app.whenReady().then(async () => {
      const outputPath = path.join(path.dirname(configPath), 'vm-internal-verification.json');
      const result = {
        requested: true,
        startReturned: false,
        completed: false,
        bundleExistedBefore: null,
        configureExecution: null,
        execution: null,
        clientEquivalentExecution: null,
        postRestartExecution: null,
        error: null,
      };
      const save = () => fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
      save();
      try {
        const core = require('./index.chunk-CCkEi--u.js');
        if (typeof core.nA !== 'function' || typeof core.dA !== 'function') {
          throw new Error('This Claude build does not expose the verified VM start/one-shot aliases.');
        }
        const runDefault = (processName) => core.dA({
          processName,
          command: '/bin/sh',
          args: ['-c', 'printf "TZ=%s\\n" "${TZ-<unset>}"; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"; if [ -r /etc/timezone ]; then printf "ETC_TIMEZONE="; tr -d "\\r\\n" </etc/timezone; printf "\\n"; fi'],
          cwd: '/',
          additionalMounts: {},
          isResume: false,
          oneShot: true,
        }, 30000);
        result.bundleExistedBefore = fs.existsSync(path.join(app.getPath('userData'), 'vm_bundles', 'claudevm.bundle'));
        await core.nA(void 0, void 0, { autoReinstall: false, caller: 'timezone_verification' });
        result.startReturned = true;
        save();
        if (config.configureCoworkVm) {
          result.configureExecution = await core.dA({
            processName: 'tz-config',
            command: '/bin/sh',
            args: ['-c', 'set -eu; id; test -e /usr/share/zoneinfo/Europe/London; sudo -n ln -sf /usr/share/zoneinfo/Europe/London /etc/localtime; printf "Europe/London\\n" | sudo -n tee /etc/timezone >/dev/null; sync; printf "CONFIGURED="; readlink /etc/localtime; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"'],
            cwd: '/',
            additionalMounts: {},
            isResume: false,
            oneShot: true,
          }, 30000);
          save();
        }
        result.execution = await runDefault('tz-default');
        save();
        // This is the exact environment override used by Cowork's Claude Code
        // launcher and VM Bash tool: { TZ: sharedTimezoneProvider.t() }.
        const provider = require('./index.chunk-DCLV6e70.js');
        result.clientEquivalentExecution = await core.dA({
          processName: 'tz-cowork-env',
          command: '/bin/sh',
          args: ['-c', 'printf "TZ=%s\\n" "${TZ-<unset>}"; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"'],
          cwd: '/',
          env: { TZ: provider.t() },
          additionalMounts: {},
          isResume: false,
          oneShot: true,
        }, 30000);
        save();
        if (config.restartCoworkVm) {
          if (typeof core.rA !== 'function' || typeof core.cA !== 'function') {
            throw new Error('This Claude build does not expose the verified VM stop/status aliases.');
          }
          await core.rA(1);
          const deadline = Date.now() + 30000;
          while (await core.cA()) {
            if (Date.now() > deadline) throw new Error('VM remained connected after the requested restart.');
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          await core.nA(void 0, void 0, { autoReinstall: false, caller: 'timezone_restart_verification' });
          result.postRestartExecution = await runDefault('tz-after-restart');
        }
        result.completed = true;
      } catch (error) {
        result.error = String(error && error.stack || error);
      }
      result.finishedAtUtc = new Date().toISOString();
      save();
    }).catch((error) => {
      try {
        fs.writeFileSync(path.join(path.dirname(configPath), 'vm-internal-verification.json'), JSON.stringify({ requested: true, completed: false, error: String(error && error.stack || error) }, null, 2));
      } catch (_) {}
    });
  }

  // Verify each VM connection without starting the VM ourselves. The one-shot
  // command deliberately omits env, so a London result proves the spawn hook
  // covered a process that the client would otherwise leave as UTC.
  app.whenReady().then(() => {
    const core = require('./index.chunk-CCkEi--u.js');
    if (typeof core.cA !== 'function' || typeof core.dA !== 'function') return;
    const outputPath = path.join(path.dirname(configPath), 'vm-auto-verification.json');
    let wasConnected = false;
    let verifiedThisConnection = false;
    let running = false;
    let retryAfter = 0;

    async function poll() {
      if (running) return;
      let connected = false;
      try {
        const status = await core.cA();
        connected = status === true || Boolean(status && status.connected === true);
      } catch (_) {
        connected = false;
      }
      if (!connected) {
        wasConnected = false;
        verifiedThisConnection = false;
        return;
      }
      if (!wasConnected) {
        wasConnected = true;
        verifiedThisConnection = false;
      }
      if (verifiedThisConnection || Date.now() < retryAfter) return;

      running = true;
      const result = {
        success: false,
        output: '',
        exitCode: null,
        error: null,
        checkedAtUtc: new Date().toISOString(),
        note: 'Runtime process environment only; VM system files were not modified.',
      };
      try {
        const execution = await core.dA({
          processName: 'tz-auto',
          command: '/bin/sh',
          args: ['-c', 'printf "TZ=%s\\n" "${TZ-<unset>}"; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"; if [ -r /etc/timezone ]; then printf "ETC_TIMEZONE="; tr -d "\\r\\n" </etc/timezone; printf "\\n"; fi'],
          cwd: '/',
          additionalMounts: {},
          isResume: false,
          oneShot: true,
        }, 30000);
        result.output = String(execution && (execution.output ?? execution.stdout) || '');
        result.exitCode = execution && (execution.exitCode ?? execution.code ?? null);
        const expectedOffset = -new Date().getTimezoneOffset();
        const sign = expectedOffset < 0 ? '-' : '+';
        const absolute = Math.abs(expectedOffset);
        const offset = sign + String(Math.floor(absolute / 60)).padStart(2, '0') + String(absolute % 60).padStart(2, '0');
        result.success = result.output.includes(`TZ=${config.timezone}\n`) &&
          new RegExp(`^DATE=.* \\${offset}$`, 'm').test(result.output);
        if (!result.success) result.error = 'The default VM process did not report the configured time zone and current offset.';
      } catch (error) {
        result.error = String(error && error.stack || error);
      }
      try {
        fs.writeFileSync(outputPath, JSON.stringify(result, null, 2), { mode: 0o600 });
      } catch (_) {}
      verifiedThisConnection = result.success;
      retryAfter = result.success ? 0 : Date.now() + 30000;
      running = false;
    }

    poll().catch(() => { running = false; });
    setInterval(() => { poll().catch(() => { running = false; }); }, 5000);
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
      // The actual renderer values below are authoritative; a conflicting override
      // is acceptable only when the measured locale and language both match.
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
})(claudeSpoofConfigPath);
/* CLAUDE_SPOOF_END */

// Verify Cowork's package-identity check from the official Claude.exe process.
(() => {
  const net = require('node:net');
  const fs = require('node:fs');
  const outputPath = require('node:path').join(
    require('node:path').dirname(claudeSpoofConfigPath), 'vm-service-verification.json'
  );
  function call(method) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection('\\\\.\\pipe\\cowork-vm-service');
      let buffer = Buffer.alloc(0);
      let settled = false;
      const timer = setTimeout(() => finish(new Error(`Timeout: ${method}`)), 10000);
      function finish(error, result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        if (error) reject(error); else resolve(result);
      }
      socket.on('connect', () => {
        const body = Buffer.from(JSON.stringify({ method }), 'utf8');
        const header = Buffer.alloc(4);
        header.writeUInt32BE(body.length, 0);
        socket.write(Buffer.concat([header, body]));
      });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        if (buffer.length < 4) return;
        const length = buffer.readUInt32BE(0);
        if (buffer.length < length + 4) return;
        try {
          const response = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
          if (response.success) finish(null, response.result);
          else finish(new Error(response.error || 'Request failed'));
        } catch (error) { finish(error); }
      });
      socket.on('error', (error) => finish(error));
      socket.on('end', () => { if (!settled) finish(new Error(`Connection ended: ${method}`)); });
    });
  }
  (async () => {
    const result = { client: 'official Claude.exe via in-memory inspector', isRunning: null, isGuestConnected: null, errors: [] };
    for (const [key, method] of [['isRunning', 'isRunning'], ['isGuestConnected', 'isGuestConnected']]) {
      try { result[key] = await call(method); }
      catch (error) { result.errors.push({ method, message: String(error && error.message || error) }); }
    }
    fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  })().catch((error) => {
    fs.writeFileSync(outputPath, JSON.stringify({ errors: [{ message: String(error && error.stack || error) }] }, null, 2));
  });
})();
setImmediate(() => {
  try { require('node:inspector').close(); } catch (_) {}
});
