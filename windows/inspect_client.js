'use strict';

const fs = require('node:fs');
const path = require('node:path');

const port = Number(process.argv[2]);
const expressionPath = process.argv[3];
const outputPath = process.argv[4];
if (!Number.isInteger(port) || !expressionPath || !outputPath) {
  throw new Error('Usage: node inspect_client.js <port> <expression.js> <result.json>');
}
const expression = fs.readFileSync(expressionPath, 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const isLauncherFrame = (frame) =>
    targetScriptIds.has(frame.location.scriptId) || /launcher\.js$/i.test(frame.url);
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data));
    if (message.method === 'Debugger.scriptParsed' && /launcher|index\.pre/i.test(message.params.url)) {
      console.error('SCRIPT', message.params.url);
    }
    if (message.method === 'Debugger.breakpointResolved') {
      targetScriptIds.add(message.params.location.scriptId);
      console.error('BREAKPOINT_RESOLVED', JSON.stringify(message.params));
    }
    if (message.method === 'Debugger.paused') {
      const frames = message.params.callFrames || [];
      console.error('PAUSED', JSON.stringify(frames.slice(0, 3).map((frame) => ({ scriptId: frame.location.scriptId, url: frame.url, line: frame.location.lineNumber, column: frame.location.columnNumber }))));
      if (frames.some(isLauncherFrame)) {
        while (pausedWaiters.length) pausedWaiters.shift().resolve(message.params);
      } else {
        call('Debugger.resume').catch((error) => console.error('INITIAL_RESUME', String(error)));
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
  function waitForLauncher() {
    return new Promise((resolve, reject) => {
      pausedWaiters.push({ resolve, reject });
    });
  }
  const timeout = setTimeout(() => {
    for (const waiter of pending.values()) waiter.reject(new Error('Inspector request timed out'));
    for (const waiter of pausedWaiters) waiter.reject(new Error('Launcher breakpoint timed out'));
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
    result.breakpoint = await call('Debugger.setBreakpointByUrl', {
      urlRegex: 'launcher\\.js$',
      lineNumber: 0,
      columnNumber: 13,
    });
    console.error('BREAKPOINT_SET', JSON.stringify(result.breakpoint));
    const pausedPromise = waitForLauncher();
    await call('Runtime.runIfWaitingForDebugger');
    const paused = await pausedPromise;
    const frame = paused.callFrames.find(isLauncherFrame);
    if (!frame) throw new Error('Launcher call frame not found');
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
    if (result.breakpoint.breakpointId) {
      await call('Debugger.removeBreakpoint', { breakpointId: result.breakpoint.breakpointId });
    }
    await call('Debugger.resume');
    result.resumed = true;
  } finally {
    clearTimeout(timeout);
    try { ws.close(); } catch (_) {}
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
})().catch((error) => {
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, JSON.stringify({ error: String(error && error.stack || error) }, null, 2));
  } catch (_) {}
  console.error(String(error && error.stack || error));
  process.exitCode = 1;
});
