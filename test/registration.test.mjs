/**
 * Registration-shape regression test.
 *
 * Field evidence (Desktop crash reports, probes A–F): the shell loads a combo and
 * then SYNCHRONOUSLY checks that every entry registered via `_ModuleLoader__.load`.
 * A bundle that defers registration — even by one interval tick — is reported as
 * `loaded without registering "<id>" via _ModuleLoader__.load`, which becomes
 * `web boot: N entries did not activate` and stops the app from starting.
 *
 * Probe D (a bare synchronous top-level `_ModuleLoader__.load({...})`) was the only
 * probe that activated, so that exact shape is what this test pins.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = await readFile(path.join(here, '..', 'lib', 'client.js'), 'utf8');

/* 1. the shape itself */
/* The global is `window.__ModuleLoader__` — double underscore, exactly as all 57
   shipped client bundles write it. A near-miss spelling is an undeclared
   identifier: the bundle throws ReferenceError and the shell reports only
   "import failed (see console for the import error)". */
assert.equal(/^window\.__ModuleLoader__\.load\(\{/m.test(bundle), true, 'the bundle must open with a synchronous top-level window.__ModuleLoader__.load() call');
assert.equal(/^_ModuleLoader__/m.test(bundle), false, 'bare _ModuleLoader__ (single underscore) is an undeclared identifier — must be window.__ModuleLoader__');
assert.equal(/\bsetInterval\b/.test(bundle), false, 'no polling: registration may not be deferred');
assert.equal(/WAIT_TRIES|__dshClientBundleQueue__/.test(bundle), false, 'no deferral machinery');

/* 2. registration must be visible at the exact moment the script finishes */
const queue = [];
let evaluated = false;
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = { mode: 'queue', pendingQueue: queue, load: (registration) => queue.push(registration) };
globalThis.document = { documentElement: { setAttribute: () => {} }, head: { appendChild: () => {} }, createElement: () => ({}) };
try {
  new Function(bundle)();
  evaluated = true;
} finally {
  delete globalThis.__ModuleLoader__;
  delete globalThis.document;
  delete globalThis.window;
}
assert.equal(evaluated, true, 'evaluating the bundle must not throw when the loader is present');
assert.deepEqual(queue.map((r) => r.id), ['dsh-think-zh'], 'the entry must be in the queue immediately after evaluation');

/* 3. the factory must still produce the plugin face */
const MODULES = {
  react: { createElement: () => ({}), Fragment: {}, memo: (c) => c, useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useMemo: (f) => f(), useCallback: (c) => c },
  'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
  '@deepseek-ai/dsh-client-ui-primitives': { DisclosureRow: 1, IconThinkOutlineRegular: 1, MarkdownText: 1, TextShimmer: 1 },
};
const face = queue[0].factory((id) => {
  if (!(id in MODULES)) throw new Error(`unexpected platform require: ${id}`);
  return MODULES[id];
});
/* The cordis plugin contract: apply + inject. `install` is rejected by the shell
   with `invalid plugin, expect function or object with an "apply" method`. */
assert.equal(typeof face.apply, 'function', 'the factory must export apply()');
assert.equal(Array.isArray(face.inject), true, 'the factory must export an inject array');

/* 4. a missing loader is a hard error, not a silent deferral */
let threw = false;
try {
  new Function(bundle)();
} catch (error) {
  threw = error instanceof ReferenceError || /ModuleLoader/.test(String(error?.message));
}
assert.equal(threw, true, 'with no loader the bundle must fail loudly instead of deferring');

console.log('registration.test.mjs OK');
