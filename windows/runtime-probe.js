const claudeSpoofConfigPath = process.env.CLAUDE_SPOOF_CONFIG || require('node:path').join(
  process.env.LOCALAPPDATA || process.cwd(), 'ClaudeSpoofRuntime', 'config.json'
);
/* CLAUDE_SPOOF_BEGIN v4 */
(function bootstrap(configPath) {
  const fs = require('node:fs');
  const path = require('node:path');
  const net = require('node:net');

  let config = {
    enabled: true,
    timezone: 'Europe/London',
    language: 'en-GB',
    overrideAcceptLanguage: true,
    requireCoworkVm: false,
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

  function formatAcceptLanguage(language) {
    const clean = String(language || '').trim();
    if (!clean) return 'en-GB,en;q=0.9';
    const dash = clean.indexOf('-');
    if (dash > 0) {
      const base = clean.slice(0, dash);
      if (base && base.toLowerCase() !== clean.toLowerCase()) {
        return `${clean},${base};q=0.9`;
      }
    }
    return clean;
  }

  // CDP Network.setUserAgentOverride expects plain comma-separated BCP-47 tags
  // without ;q= weights (Chromium populates navigator.languages from these tags
  // and generates ;q= weights automatically for HTTP Accept-Language).
  function formatCdpAcceptLanguage(language) {
    const clean = String(language || '').trim();
    if (!clean) return 'en-GB,en';
    const dash = clean.indexOf('-');
    if (dash > 0) {
      const base = clean.slice(0, dash);
      if (base && base.toLowerCase() !== clean.toLowerCase()) {
        return `${clean},${base}`;
      }
    }
    return clean;
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isSafeIanaTimezone(tz) {
    return /^[A-Za-z0-9_/+.-]{1,100}$/.test(String(tz || '')) && !String(tz).includes('..');
  }

  const acceptLanguageHeader = formatAcceptLanguage(config.language);
  const cdpAcceptLanguage = formatCdpAcceptLanguage(config.language);
  const runtimeDir = path.dirname(configPath);
  const verificationPath = path.join(runtimeDir, 'runtime-verification.json');
  const vmServiceVerificationPath = path.join(runtimeDir, 'vm-service-verification.json');

  const verification = {
    main: null,
    renderers: [],
    errors: [],
    warnings: [],
    vmSpawnOverrides: { count: 0, lastAtUtc: null },
  };

  let writeQueue = Promise.resolve();
  function writeJsonAtomic(filePath, data) {
    const body = JSON.stringify(data, null, 2) + '\n';
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    return fs.promises.writeFile(tempPath, body, { mode: 0o600 }).then(() =>
      fs.promises.rename(tempPath, filePath)
    ).catch(async () => {
      try { await fs.promises.unlink(tempPath); } catch (_) {}
      await fs.promises.writeFile(filePath, body, { mode: 0o600 });
    });
  }

  function saveVerification() {
    writeQueue = writeQueue.catch(() => {}).then(() =>
      writeJsonAtomic(verificationPath, verification)
    ).catch(() => {});
  }

  function pushWarning(entry) {
    verification.warnings.push({ atUtc: new Date().toISOString(), ...entry });
    if (verification.warnings.length > 50) {
      verification.warnings = verification.warnings.slice(-50);
    }
    saveVerification();
  }

  // Targeted interception for the Cowork VM named pipe only.
  // Avoids monkey-patching net.Socket.prototype.write globally and properly handles
  // fragmented or coalesced length-prefixed JSON-RPC frames.
  const COWORK_PIPE = '\\\\.\\pipe\\cowork-vm-service';
  const COWORK_PIPE_LOWER = COWORK_PIPE.toLowerCase();

  function isCoworkPipeConnectArgs(args) {
    if (!args || args.length === 0) return false;
    const first = args[0];
    if (typeof first === 'string') {
      return first.toLowerCase() === COWORK_PIPE_LOWER;
    }
    if (first && typeof first === 'object' && typeof first.path === 'string') {
      return first.path.toLowerCase() === COWORK_PIPE_LOWER;
    }
    return false;
  }

  function rewriteSpawnFrame(payloadBuffer) {
    try {
      const message = JSON.parse(payloadBuffer.toString('utf8'));
      const params = message && message.params;
      if (
        message &&
        message.method === 'spawn' &&
        params &&
        typeof params.command === 'string' &&
        Object.hasOwn(params, 'isResume')
      ) {
        params.env = { ...(params.env || {}), TZ: config.timezone };
        verification.vmSpawnOverrides.count += 1;
        verification.vmSpawnOverrides.lastAtUtc = new Date().toISOString();
        saveVerification();
        return Buffer.from(JSON.stringify(message), 'utf8');
      }
    } catch (_) {}
    return payloadBuffer;
  }

  function instrumentCoworkSocket(socket) {
    if (!socket || socket.__claudeSpoofCoworkWrapped) return;
    socket.__claudeSpoofCoworkWrapped = true;
    const originalWrite = socket.write.bind(socket);
    let pending = Buffer.alloc(0);

    socket.write = function (chunk, encoding, callback) {
      let cb = callback;
      let enc = encoding;
      if (typeof enc === 'function') {
        cb = enc;
        enc = undefined;
      }
      try {
        const incoming = Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(String(chunk), typeof enc === 'string' ? enc : 'utf8');
        pending = pending.length === 0 ? incoming : Buffer.concat([pending, incoming]);

        const outFrames = [];
        while (pending.length >= 4) {
          const frameLen = pending.readUInt32BE(0);
          // Guard against non-framed traffic (>64 MiB frame length).
          if (frameLen > 64 * 1024 * 1024) {
            const raw = pending;
            pending = Buffer.alloc(0);
            return originalWrite(raw, cb);
          }
          if (pending.length < 4 + frameLen) break;
          const payload = pending.subarray(4, 4 + frameLen);
          pending = pending.subarray(4 + frameLen);
          const nextPayload = rewriteSpawnFrame(payload);
          const header = Buffer.allocUnsafe(4);
          header.writeUInt32BE(nextPayload.length, 0);
          outFrames.push(header, nextPayload);
        }

        if (outFrames.length === 0) {
          if (typeof cb === 'function') process.nextTick(cb);
          return true;
        }
        return originalWrite(Buffer.concat(outFrames), cb);
      } catch (_) {
        const flush = pending;
        pending = Buffer.alloc(0);
        if (flush.length > 0) return originalWrite(flush, cb);
        return originalWrite(chunk, encoding, callback);
      }
    };
  }

  if (!net.Socket.prototype.__claudeSpoofConnectWrapped) {
    net.Socket.prototype.__claudeSpoofConnectWrapped = true;
    const originalSocketConnect = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function (...args) {
      try {
        // net.Socket.prototype.connect may receive normalized [options, cb] or raw args.
        const checkArgs = Array.isArray(args[0]) ? args[0] : args;
        if (isCoworkPipeConnectArgs(checkArgs)) {
          instrumentCoworkSocket(this);
        }
      } catch (_) {}
      return originalSocketConnect.apply(this, args);
    };
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

  function resolveBuildDir() {
    const candidates = [];
    try {
      if (typeof __dirname === 'string' && __dirname) candidates.push(__dirname);
    } catch (_) {}
    if (require.main && require.main.filename) {
      candidates.push(path.dirname(require.main.filename));
    }
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'app.asar', '.vite', 'build'));
    }
    for (const dir of candidates) {
      try {
        if (dir && fs.existsSync(dir)) return dir;
      } catch (_) {}
    }
    return candidates[0] || process.cwd();
  }

  // Discover implementation modules by behavior, never by Vite hash names or
  // minified export aliases. Those names change on ordinary official updates.
  function findUniqueBuildModule(predicate, description) {
    const buildDir = resolveBuildDir();
    const matches = [];
    for (const name of fs.readdirSync(buildDir)) {
      if (!name.endsWith('.js')) continue;
      const filename = path.join(buildDir, name);
      let source = '';
      try { source = fs.readFileSync(filename, 'utf8'); } catch (_) { continue; }
      if (predicate(source, null, filename)) matches.push(filename);
    }
    if (matches.length !== 1) {
      throw new Error(`${description}: expected one source module in ${buildDir}, found ${matches.length}`);
    }
    return matches[0];
  }

  function findUniqueExport(predicate, description, scanDisk = true, modulePredicate = predicate) {
    const matches = [];
    for (const [filename, mod] of Object.entries(require.cache)) {
      if (!filename.includes(`${path.sep}.vite${path.sep}build${path.sep}`)) continue;
      for (const [exportName, value] of Object.entries(mod.exports || {})) {
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
      const socket = net.createConnection(COWORK_PIPE);
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
    verification.main = {
      processId: process.pid,
      officialExe: process.execPath,
      envTZ: process.env.TZ,
      ...dateSample(),
    };
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

  // Ensure Accept-Language is covered across ALL requests (including initial
  // navigations before CDP attaches, service workers, and background fetches).
  const hookedSessions = new WeakSet();
  function installSessionHeaderOverride(ses) {
    if (!config.overrideAcceptLanguage || !ses || hookedSessions.has(ses)) return;
    hookedSessions.add(ses);
    try {
      ses.webRequest.onBeforeSendHeaders((details, callback) => {
        const headers = Object.assign({}, details.requestHeaders);
        let replaced = false;
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === 'accept-language') {
            headers[key] = acceptLanguageHeader;
            replaced = true;
          }
        }
        if (!replaced) headers['Accept-Language'] = acceptLanguageHeader;
        callback({ requestHeaders: headers });
      });
    } catch (error) {
      pushWarning({ scope: 'session', message: String(error && error.message || error) });
    }
  }

  app.on('session-created', (ses) => {
    installSessionHeaderOverride(ses);
  });

  app.whenReady().then(() => {
    if (electron.session && electron.session.defaultSession) {
      installSessionHeaderOverride(electron.session.defaultSession);
    }
    try {
      verification.main = {
        ...verification.main,
        processId: process.pid,
        officialExe: process.execPath,
        envTZ: process.env.TZ,
        ...dateSample(),
        electronLocale: app.getLocale(),
        preferredSystemLanguages: app.getPreferredSystemLanguages(),
        acceptLanguageHeader,
      };
      const provider = timezoneProvider();
      verification.sharedTimezoneProvider = {
        module: path.basename(provider.module),
        exportName: provider.exportName,
        consumers: ['Code', 'Cowork', 'Computer Use'],
        resolvedTimeZone: provider.fn(),
      };
      try {
        verification.coworkApi = describeApi(coworkApi());
      } catch (coworkErr) {
        if (config.requireCoworkVm) throw coworkErr;
        pushWarning({ scope: 'coworkApi', message: String(coworkErr && coworkErr.message || coworkErr) });
      }
    } catch (error) {
      verification.errors.push({ scope: 'electron', message: String(error && error.message || error) });
    }
    saveVerification();
  }).catch(() => {});

  // Verify Cowork's package-identity check from the official Claude.exe process.
  (async () => {
    const result = {
      client: 'official Claude.exe via in-memory inspector',
      serviceAvailable: true,
      isRunning: null,
      isGuestConnected: null,
      errors: [],
    };
    for (const [key, method] of [['isRunning', 'isRunning'], ['isGuestConnected', 'isGuestConnected']]) {
      try {
        result[key] = await vmServiceCall(method);
      } catch (error) {
        const msg = String(error && error.message || error);
        if (/ENOENT|ECONNREFUSED|pipe/i.test(msg)) result.serviceAvailable = false;
        result.errors.push({ method, message: msg });
      }
    }
    await writeJsonAtomic(vmServiceVerificationPath, result);
  })().catch((error) => {
    try {
      fs.writeFileSync(vmServiceVerificationPath, JSON.stringify({
        serviceAvailable: false,
        errors: [{ message: String(error && error.stack || error) }],
      }, null, 2));
    } catch (_) {}
  });

  // One-shot, explicitly enabled local verification.
  if (config.verifyCoworkVm) {
    app.whenReady().then(async () => {
      const outputPath = path.join(runtimeDir, 'vm-internal-verification.json');
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
          if (!isSafeIanaTimezone(config.timezone)) {
            throw new Error(`Refusing unsafe timezone for VM shell: ${config.timezone}`);
          }
          const tz = config.timezone;
          result.configureExecution = await api.oneShot.fn({
            processName: 'tz-config',
            command: '/bin/sh',
            args: ['-c', `set -eu; id; test -e "/usr/share/zoneinfo/${tz}"; sudo -n ln -sf "/usr/share/zoneinfo/${tz}" /etc/localtime; printf "%s\\n" "${tz}" | sudo -n tee /etc/timezone >/dev/null; sync; printf "CONFIGURED="; readlink /etc/localtime; date "+DATE=%Y-%m-%d %H:%M:%S %Z %z"`],
            cwd: '/',
            additionalMounts: {},
            isResume: false,
            oneShot: true,
          }, 30000);
          save();
        }
        result.execution = await runDefault('tz-default');
        save();
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
        fs.writeFileSync(path.join(runtimeDir, 'vm-internal-verification.json'), JSON.stringify({
          requested: true,
          completed: false,
          error: String(error && error.stack || error),
        }, null, 2));
      } catch (_) {}
    });
  }

  // Verify each VM connection without starting the VM ourselves.
  app.whenReady().then(() => {
    const outputPath = path.join(runtimeDir, 'vm-auto-verification.json');
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
          new RegExp(`^DATE=.* ${escapeRegex(offset)}$`, 'm').test(result.output);
        if (!result.success) result.error = 'The default VM process did not report the configured time zone and current offset.';
      } catch (error) {
        result.error = String(error && error.stack || error);
      }
      try {
        await writeJsonAtomic(outputPath, result);
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
  const detachHooked = new WeakSet();

  function isTransientContentsError(error) {
    const msg = String(error && error.message || error);
    return /destroyed|detached|target closed|no target with given id|cannot inspect/i.test(msg);
  }

  async function emulate(contents) {
    if (!contents || contents.isDestroyed()) return;
    const url = typeof contents.getURL === 'function' ? contents.getURL() : '';
    if (url.startsWith('devtools://')) return;

    const dbg = contents.debugger;
    if (!detachHooked.has(contents)) {
      detachHooked.add(contents);
      dbg.on('detach', (_event, reason) => {
        if (!contents || contents.isDestroyed()) return;
        pushWarning({ scope: 'renderer-detach', rendererId: contents.id, reason: String(reason || '') });
        if (reason !== 'replaced_with_devtools' && reason !== 'target closed') {
          setTimeout(() => {
            if (!contents.isDestroyed()) schedule(contents);
          }, 500);
        }
      });
    }

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
      if (!/Another locale override is already in effect/i.test(String(error && error.message || error))) {
        throw error;
      }
      overrideNotes.push('Locale was already overridden; verified the resulting values instead.');
    }

    if (config.overrideAcceptLanguage) {
      await dbg.sendCommand('Network.enable');
      await dbg.sendCommand('Network.setUserAgentOverride', {
        userAgent: contents.getUserAgent(),
        acceptLanguage: cdpAcceptLanguage,
      });
    }

    if (contents.isDestroyed()) return;
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
      if (!contents || contents.isDestroyed() || isTransientContentsError(error)) {
        pushWarning({
          scope: 'renderer-transient',
          rendererId: contents ? contents.id : null,
          message: String(error && error.message || error),
        });
        return;
      }
      // Only record mismatch errors as fatal if we haven't verified any renderer yet
      // or if an actual timezone/locale mismatch occurred.
      const msg = String(error && error.message || error);
      if (/mismatch/i.test(msg) || verification.renderers.length === 0) {
        verification.errors.push({
          scope: 'renderer',
          rendererId: contents.id,
          message: msg,
        });
        saveVerification();
      } else {
        pushWarning({ scope: 'renderer', rendererId: contents.id, message: msg });
      }
      if (!warned.has(contents)) {
        warned.add(contents);
        console.warn('[ClaudeSpoof] Renderer override warning:', msg);
      }
    });
    queues.set(contents, next);
  }

  app.on('web-contents-created', (_event, contents) => {
    const id = contents.id;
    schedule(contents);
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) schedule(contents);
    });
    contents.on('destroyed', () => {
      const before = verification.renderers.length;
      verification.renderers = verification.renderers.filter((row) => row.rendererId !== id);
      if (verification.renderers.length !== before) saveVerification();
    });
  });

  console.warn(`[ClaudeSpoof] active: TZ=${config.timezone}, locale=${config.language}, Accept-Language=${acceptLanguageHeader}`);
})(claudeSpoofConfigPath);
/* CLAUDE_SPOOF_END */

setImmediate(() => {
  try { require('node:inspector').close(); } catch (_) {}
});
