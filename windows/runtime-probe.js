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

  // Discover implementation modules by behavior, never by Vite hash names or
  // minified export aliases. Those names change on ordinary official updates.
  function findUniqueBuildModule(predicate, description) {
    const matches = [];
    for (const name of fs.readdirSync(__dirname)) {
      if (!name.endsWith('.js')) continue;
      const filename = path.join(__dirname, name);
      let source = '';
      try { source = fs.readFileSync(filename, 'utf8'); } catch (_) { continue; }
      if (predicate(source, null, filename)) matches.push(filename);
    }
    if (matches.length !== 1) {
      throw new Error(`${description}: expected one source module, found ${matches.length}`);
    }
    return matches[0];
  }
  function findUniqueExport(predicate, description, scanDisk = true, modulePredicate = predicate) {
    const matches = [];
    for (const [filename, module] of Object.entries(require.cache)) {
      if (!filename.includes(`${path.sep}.vite${path.sep}build${path.sep}`)) continue;
      for (const [exportName, value] of Object.entries(module.exports || {})) {
        if (typeof value !== 'function') continue;
        let source = '';
        try { source = Function.prototype.toString.call(value); } catch (_) { continue; }
        if (predicate(source, exportName, filename)) {
          matches.push({ fn: value, module: filename, exportName });
        }
      }
    }
    const unique = [...new Map(matches.map((row) => [row.fn, row])).values()];
    if (unique.length === 0 && scanDisk) {
      // Some shared providers are lazy-loaded after app.ready. Locate the one
      // matching implementation inside the official ASAR and load it ourselves.
      require(findUniqueBuildModule(modulePredicate, description));
      return findUniqueExport(predicate, description, false, modulePredicate);
    }
    if (unique.length !== 1) {
      throw new Error(`${description}: expected one behavioral match, found ${unique.length}`);
    }
    return unique[0];
  }
  function timezoneProvider() {
    return findUniqueExport((source) =>
      source.includes('Etc/Unknown') && (
        (source.includes('resolvedOptions') && source.includes('timeZone')) ||
        source.includes('TimeZoneKeyName')
      ),
    'shared timezone provider', true, (source) =>
      source.includes('resolvedOptions') && source.includes('TimeZoneKeyName'));
  }
  function coworkApi() {
    return {
      oneShot: findUniqueExport((source) =>
        source.includes('VM is not available.') && source.includes('VM guest is not connected.'),
      'Cowork one-shot execution'),
      start: findUniqueExport((source) => source.includes('[startVM] VM startup already in progress'),
        'Cowork VM start'),
    };
  }
  function describeApi(api) {
    return Object.fromEntries(Object.entries(api).map(([name, row]) => [name, {
      module: path.basename(row.module), exportName: row.exportName,
    }]));
  }
  function vmServiceCall(method) {
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
      // Code, Cowork and Computer Use share this provider. Resolve it from
      // loaded exports by behavior so hashed chunk names can change freely.
      const provider = timezoneProvider();
      verification.sharedTimezoneProvider = {
        module: path.basename(provider.module),
        exportName: provider.exportName,
        consumers: ['Code', 'Cowork', 'Computer Use'],
        resolvedTimeZone: provider.fn(),
      };
      verification.coworkApi = describeApi(coworkApi());
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
        const api = coworkApi();
        const runDefault = (processName) => api.oneShot.fn({
          processName,
          command: '/bin/sh',
          args: ['-c', 'printf "TZ=%s\\n" "${TZ-<unset>}"; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"; if [ -r /etc/timezone ]; then printf "ETC_TIMEZONE="; tr -d "\\r\\n" </etc/timezone; printf "\\n"; fi'],
          cwd: '/',
          additionalMounts: {},
          isResume: false,
          oneShot: true,
        }, 30000);
        result.bundleExistedBefore = fs.existsSync(path.join(app.getPath('userData'), 'vm_bundles', 'claudevm.bundle'));
        await api.start.fn(void 0, void 0, { autoReinstall: false, caller: 'timezone_verification' });
        result.startReturned = true;
        save();
        if (config.configureCoworkVm) {
          result.configureExecution = await api.oneShot.fn({
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
        const provider = timezoneProvider();
        result.clientEquivalentExecution = await api.oneShot.fn({
          processName: 'tz-cowork-env',
          command: '/bin/sh',
          args: ['-c', 'printf "TZ=%s\\n" "${TZ-<unset>}"; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"'],
          cwd: '/',
          env: { TZ: provider.fn() },
          additionalMounts: {},
          isResume: false,
          oneShot: true,
        }, 30000);
        save();
        if (config.restartCoworkVm) {
          await vmServiceCall('stopVM');
          const deadline = Date.now() + 30000;
          while ((await vmServiceCall('isGuestConnected')).connected === true) {
            if (Date.now() > deadline) throw new Error('VM remained connected after the requested restart.');
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          await api.start.fn(void 0, void 0, { autoReinstall: false, caller: 'timezone_restart_verification' });
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
    const outputPath = path.join(path.dirname(configPath), 'vm-auto-verification.json');
    let oneShot;
    try { oneShot = coworkApi().oneShot; } catch (_) { return; }
    let wasConnected = false;
    let verifiedThisConnection = false;
    let running = false;
    let retryAfter = 0;

    async function poll() {
      if (running) return;
      let connected = false;
      try {
        const status = await vmServiceCall('isGuestConnected');
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
        const execution = await oneShot.fn({
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
