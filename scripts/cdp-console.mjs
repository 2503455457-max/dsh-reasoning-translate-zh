/**
 * CDP console collector for the DSH desktop shell.
 *
 * Why this exists: the desktop renderer's console goes nowhere. The crash report
 * only says "import failed (see console for the import error)", and
 * ELECTRON_ENABLE_LOGGING=1 prints nothing for this app. The only way to read that
 * error is to attach over the Chrome DevTools Protocol.
 *
 * It attaches at the BROWSER level and auto-attaches to every new page target with
 * waitForDebuggerOnStart, so a boot failure that happens before a page-level client
 * could attach is still captured: the renderer waits for us first.
 *
 * Usage — start the app with an open port in one terminal:
 *   "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
 *     --remote-debugging-port=9222 --remote-allow-origins='*'
 * then run this in another:
 *   node scripts/cdp-console.mjs --port 9222 --out /tmp/dsh-renderer.log
 *
 * Options: --port N | --out PATH | --reload | --seconds N
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const port = Number(argOf('--port', '9222'));
const outPath = argOf('--out', '/tmp/dsh-renderer.log');
const seconds = Number(argOf('--seconds', '0'));
const doReload = args.includes('--reload');

const { appendFileSync, writeFileSync } = await import('node:fs');
writeFileSync(outPath, '');
const emit = (line) => {
  const stamped = `[${new Date().toISOString().slice(11, 23)}] ${line}`;
  appendFileSync(outPath, stamped + '\n');
  process.stdout.write(stamped + '\n');
};

/* ------------------------------------------- browser-level endpoint discovery */

const waitForVersion = async (deadline) => {
  let lastError;
  while (Date.now() < deadline) {
    try {
      const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json());
      if (typeof version.webSocketDebuggerUrl === 'string') return version;
      lastError = new Error('no webSocketDebuggerUrl in /json/version');
    } catch (error) {
      lastError = error;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw lastError ?? new Error('DevTools endpoint never appeared');
};

emit(`waiting for the DevTools endpoint on 127.0.0.1:${port} …`);
const version = await waitForVersion(Date.now() + 30_000);
emit(`attached to browser: ${version.Browser ?? 'unknown'}`);

/* --------------------------------------------------------- browser connection */

const socket = new WebSocket(version.webSocketDebuggerUrl);
let nextId = 1;
const pending = new Map();
/** sessionId -> label, so interleaved renderer output stays attributable. */
const sessions = new Map();
const requestUrls = new Map();

const send = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, method });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
  });

/** Render a CDP remote object as a short literal. */
function describe(remote) {
  if (remote === undefined || remote === null) return '';
  if (typeof remote.value === 'string') return JSON.stringify(remote.value);
  if ('value' in remote) return JSON.stringify(remote.value);
  if (remote.unserializableValue !== undefined) return remote.unserializableValue;
  if (remote.description !== undefined) return remote.description;
  if (remote.preview?.properties !== undefined) {
    return `{${remote.preview.properties.map((p) => `${p.name}: ${p.value}`).join(', ')}}`;
  }
  return remote.className ?? remote.type ?? '';
}

const sourceOf = (sessionId) => (sessionId === undefined ? 'browser' : (sessions.get(sessionId) ?? sessionId));

function handleEvent(message) {
  const { method, params = {}, sessionId } = message;
  const where = sourceOf(sessionId);
  switch (method) {
    case 'Runtime.consoleAPICalled':
      emit(`[${where}] console.${params.type}: ${(params.args ?? []).map(describe).join(' ')}`);
      break;
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails ?? {};
      emit(`[${where}] !!! UNCAUGHT ${d.exception?.className ?? ''}: ${d.exception?.description ?? d.text ?? ''}`);
      if (d.url !== undefined) emit(`[${where}]     at ${d.url}:${d.lineNumber ?? '?'}:${d.columnNumber ?? '?'}`);
      break;
    }
    case 'Log.entryAdded': {
      const e = params.entry ?? {};
      emit(`[${where}] log.${e.level} (${e.source}): ${e.text}${e.url === undefined ? '' : ` — ${e.url}`}`);
      break;
    }
    case 'Network.requestWillBeSent':
      if (/plugins|think-zh/.test(params.request?.url ?? '')) emit(`[${where}] -> ${params.request.url}`);
      break;
    case 'Network.responseReceived':
      if (/plugins|think-zh/.test(params.response?.url ?? '')) {
        emit(`[${where}] <- HTTP ${params.response.status} ${params.response.url}`);
      }
      break;
    case 'Network.loadingFailed':
      emit(`[${where}] !!! REQUEST FAILED: ${params.errorText ?? ''} ${params.blockedReason ?? ''}`.trim());
      break;
    case 'Target.attachedToTarget':
      emit(`[${where}] target attached: ${params.targetInfo?.type} ${params.targetInfo?.url}`);
      break;
    case 'Target.detachedFromTarget':
      emit(`[${where}] target detached`);
      break;
    default:
      break;
  }
}

socket.addEventListener('message', (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    if (entry === undefined) return;
    pending.delete(message.id);
    if (message.error !== undefined) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
    else entry.resolve(message.result);
    return;
  }
  if (message.sessionId !== undefined) {
    if (message.method === 'Network.requestWillBeSent') {
      requestUrls.set(`${message.sessionId}:${message.params.requestId}`, message.params.request?.url);
    }
    if (message.method === 'Network.loadingFailed') {
      const url = requestUrls.get(`${message.sessionId}:${message.params.requestId}`);
      if (url !== undefined) emit(`[${sourceOf(message.sessionId)}]     URL: ${url}`);
    }
  }
  handleEvent(message);
});

socket.addEventListener('close', () => emit('browser websocket closed (app exited?)'));
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});
emit('browser websocket open');

/* ---------------------------- auto-attach to every new page, paused on start --- */

try {
  await send('Target.setDiscoverTargets', { discover: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  emit('auto-attach armed (new renderers wait for us before running the boot)');
} catch (error) {
  emit(`could not arm auto-attach: ${error.message}`);
}

/* When a paused page target attaches: enable domains, then release it. */
socket.addEventListener('message', async (event) => {
  let message;
  try {
    message = JSON.parse(event.data);
  } catch {
    return;
  }
  if (message.method !== 'Target.attachedToTarget') return;
  const sessionId = message.params.sessionId;
  const info = message.params.targetInfo ?? {};
  if (info.type !== 'page') {
    try {
      await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    } catch {
      /* not a script target */
    }
    return;
  }
  sessions.set(sessionId, info.url?.startsWith('dsh-app://app') ? 'app' : 'page');
  emit(`new page target — enabling domains before it runs: ${info.url}`);
  for (const domain of ['Runtime', 'Log', 'Network', 'Page']) {
    try {
      await send(`${domain}.enable`, {}, sessionId);
    } catch (error) {
      emit(`  could not enable ${domain}: ${error.message}`);
    }
  }
  try {
    await send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    emit('  renderer released');
  } catch (error) {
    emit(`  could not resume: ${error.message}`);
  }
});

/* Attach to anything already running, so a dialog-blocked app is still readable. */
try {
  const { targetInfos } = await send('Target.getTargets');
  for (const info of targetInfos.filter((t) => t.type === 'page')) {
    emit(`existing target: ${info.url}`);
    try {
      const { sessionId } = await send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
      sessions.set(sessionId, info.url.startsWith('dsh-app://app') ? 'app' : 'page');
      for (const domain of ['Runtime', 'Log', 'Network']) await send(`${domain}.enable`, {}, sessionId);
      emit(`  domains enabled on existing target`);
    } catch (error) {
      emit(`  attach failed: ${error.message}`);
    }
  }
} catch (error) {
  emit(`could not list targets: ${error.message}`);
}

if (doReload) {
  await new Promise((r) => setTimeout(r, 2500));
  for (const [sessionId, label] of sessions) {
    try {
      emit(`reloading ${label} to re-run the boot deterministically`);
      await send('Page.reload', { ignoreCache: true }, sessionId);
    } catch (error) {
      emit(`reload failed: ${error.message}`);
    }
  }
}

emit('--- collecting; boot failures appear as UNCAUGHT / REQUEST FAILED / log.error ---');

if (seconds > 0) {
  await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  emit(`collected for ${seconds}s; exiting. log: ${outPath}`);
  process.exit(0);
}

process.on('SIGINT', () => {
  emit(`interrupted. log: ${outPath}`);
  process.exit(0);
});
