'use strict';

const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2]);
const expressionPath = process.argv[3];
const outputPath = process.argv[4];
if (!Number.isInteger(port) || port <= 0 || !expressionPath || !outputPath) {
  throw new Error('Usage: node inspect_client.js <port> <expression.js> <result.json>');
}
const expression = fs.readFileSync(expressionPath, 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isAppFrame(frame, resolvedScriptIds) {
  if (!frame || !frame.location) return false;
  if (resolvedScriptIds.has(frame.location.scriptId)) return true;
  const url = String(frame.url || '');
  if (!url) return false;
  if (/^(?:node:|electron\/|node_modules\/)/i.test(url)) return false;
  // Prefer the app's own entrypoint inside app.asar / .vite/build / launcher.js.
  if (/launcher\.js$/i.test(url)) return true;
  if (/[\\/]\.vite[\\/]build[\\/].+\.js$/i.test(url)) return true;
  if (/app\.asar[\\/].+\.js$/i.test(url) && !/node_modules/i.test(url)) return true;
  return false;
}

async function findTarget() {
  let lastError;
  for (let attempt = 0; attempt < 150; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      const target = targets.find((item) => item.webSocketDebuggerUrl);
      if (target) return target;
    } catch (error) {
      lastError = error;
    }
    await delay(200);
  }
  throw new Error(`Inspector target unavailable: ${lastError || 'no target'}`);
}

(async () => {
  const target = await findTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  const pausedWaiters = [];
  const targetScriptIds = new Set();
  let nextId = 1;
  let injected = false;

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Debugger.scriptParsed' && /launcher|index\.pre|\.vite[\\/]build/i.test(message.params.url || '')) {
      console.error('SCRIPT', message.params.url);
    }
    if (message.method === 'Debugger.breakpointResolved') {
      targetScriptIds.add(message.params.location.scriptId);
      console.error('BREAKPOINT_RESOLVED', JSON.stringify(message.params));
    }
    if (message.method === 'Debugger.paused') {
      const frames = message.params.callFrames || [];
      console.error('PAUSED', JSON.stringify(frames.slice(0, 3).map((frame) => ({
        scriptId: frame.location.scriptId,
        url: frame.url,
        line: frame.location.lineNumber,
        column: frame.location.columnNumber,
      }))));
      if (!injected && frames.some((frame) => isAppFrame(frame, targetScriptIds))) {
        while (pausedWaiters.length) pausedWaiters.shift().resolve(message.params);
      } else {
        call('Debugger.resume').catch((error) => console.error('AUTO_RESUME', String(error)));
      }
      return;
    }
    if (!message.id) return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
    else waiter.resolve(message.result);
  });

  function call(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  function waitForAppFrame() {
    return new Promise((resolve, reject) => {
      pausedWaiters.push({ resolve, reject });
    });
  }

  const timeout = setTimeout(() => {
    for (const waiter of pending.values()) waiter.reject(new Error('Inspector request timed out'));
    for (const waiter of pausedWaiters) waiter.reject(new Error('App entry breakpoint timed out'));
    pending.clear();
    pausedWaiters.length = 0;
  }, 30000);

  const result = {
    targetType: target.type,
    officialFileModified: false,
    breakpoint: null,
    evaluation: null,
    resumed: false,
  };

  try {
    await call('Runtime.enable');
    await call('Debugger.enable');
    // Fallback URL breakpoint at line 0 col 0 (no fragile column offset).
    // If --inspect-brk pauses directly in the app entry frame first, we inject there immediately.
    result.breakpoint = await call('Debugger.setBreakpointByUrl', {
      urlRegex: '(?:launcher|index)\\.js$',
      lineNumber: 0,
      columnNumber: 0,
    });
    console.error('BREAKPOINT_SET', JSON.stringify(result.breakpoint));
    const pausedPromise = waitForAppFrame();
    await call('Runtime.runIfWaitingForDebugger');
    const paused = await pausedPromise;
    const frame = paused.callFrames.find((f) => isAppFrame(f, targetScriptIds));
    if (!frame) throw new Error('Application entry call frame not found');
    injected = true;
    result.breakpointUrl = frame.url;
    result.evaluation = await call('Debugger.evaluateOnCallFrame', {
      callFrameId: frame.callFrameId,
      expression,
      returnByValue: true,
      silent: false,
    });
    if (result.evaluation.exceptionDetails) {
      throw new Error(JSON.stringify(result.evaluation.exceptionDetails));
    }
    if (result.breakpoint && result.breakpoint.breakpointId) {
      await call('Debugger.removeBreakpoint', { breakpointId: result.breakpoint.breakpointId });
    }
    await call('Debugger.resume');
    result.resumed = true;
  } finally {
    clearTimeout(timeout);
    try { ws.close(); } catch (_) {}
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const tempPath = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(result, null, 2));
  fs.renameSync(tempPath, outputPath);
  console.log(JSON.stringify(result));
})().catch((error) => {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ error: String(error && error.stack || error) }, null, 2));
  } catch (_) {}
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
