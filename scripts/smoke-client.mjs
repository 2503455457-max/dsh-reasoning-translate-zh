/**
 * Pre-install smoke gate.
 *
 * The failure this guards against is specific and was observed in the field:
 * a client bundle that the Desktop shell loads but that does NOT register
 * synchronously makes the whole app refuse to start —
 *   `web boot: 1 entry did not activate`
 *   `dsh-think-zh: ... loaded without registering "dsh-think-zh" via _ModuleLoader__.load`
 *
 * So the gate checks the exact contract the shell enforces:
 *   1. registration is a top-level synchronous `_ModuleLoader__.load({...})`;
 *      no polling / deferral machinery;
 *   2. after evaluating the script, the entry is in `pendingQueue` immediately;
 *   3. the factory materialises and exports `install`.
 *
 * Exits non-zero so install-desktop.sh refuses to install a bundle that would
 * break boot.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const bundle = await readFile(path.join(root, 'lib', 'client.js'), 'utf8');
const id = packageJson.name;

const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

/* 1. shape */
check(/^window\.__ModuleLoader__\.load\(\{/m.test(bundle), 'registration is not a top-level synchronous window.__ModuleLoader__.load({...}) call');
check(!/^_ModuleLoader__/m.test(bundle), 'bare _ModuleLoader__ (single underscore) is an undeclared identifier; the loader is window.__ModuleLoader__');
check(!/\bsetInterval\b/.test(bundle), 'bundle contains a polling loop; registration must not be deferred');
check(!/WAIT_TRIES|__dshClientBundleQueue__/.test(bundle), 'bundle still contains deferral machinery');

/* 2. present at the instant the script finishes */
const queue = [];
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = { mode: 'queue', pendingQueue: queue, load: (registration) => queue.push(registration) };
const savedDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
Object.defineProperty(globalThis, 'document', {
  value: { documentElement: { setAttribute: () => {} }, head: { appendChild: () => {} }, createElement: () => ({}) },
  configurable: true,
  writable: true,
});
try {
  new Function(bundle)();
} catch (error) {
  check(false, `evaluating the bundle threw: ${error?.constructor?.name}: ${error?.message}`);
}
if (savedDocument === undefined) delete globalThis.document;
else Object.defineProperty(globalThis, 'document', savedDocument);
delete globalThis.__ModuleLoader__;
delete globalThis.window;
check(queue.length === 1 && queue[0]?.id === id, `expected exactly one registration for ${id} immediately after evaluation, saw ${JSON.stringify(queue.map((r) => r.id))}`);

/* 3. the factory must produce a plugin face */
const MODULES = {
  react: { createElement: () => ({}), Fragment: {}, memo: (c) => c, useState: (i) => [typeof i === 'function' ? i() : i, () => {}], useRef: (v) => ({ current: v }), useEffect: () => {}, useMemo: (f) => f(), useCallback: (c) => c },
  'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
  '@deepseek-ai/dsh-client-ui-primitives': { DisclosureRow: 1, IconThinkOutlineRegular: 1, MarkdownText: 1, TextShimmer: 1 },
};
if (queue.length === 1) {
  try {
    const face = queue[0].factory((name) => {
      if (!(name in MODULES)) throw new Error(`unresolved platform require: ${name}`);
      return MODULES[name];
    });
    /* The cordis plugin contract. Exporting anything else — e.g. `install` — makes
       the shell reject the module with
       `invalid plugin, expect function or object with an "apply" method, received object`
       which is a fatal boot error on Desktop. */
    check(typeof face?.apply === 'function', 'factory must export apply() (the cordis plugin face)');
    check(Array.isArray(face?.inject), 'factory must export an inject array');
    if (typeof face?.apply === 'function') {
      let registered = 0;
      const ctx = {
        slots: { entries: () => [], register: () => { registered += 1; return () => {}; } },
        effect: (fn) => fn(),
      };
      try {
        face.apply(ctx);
      } catch (error) {
        check(false, `apply(ctx) threw: ${error?.constructor?.name}: ${error?.message}`);
      }
    }
  } catch (error) {
    check(false, `factory threw: ${error?.constructor?.name}: ${error?.message}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`smoke-client FAILED for ${id}:\n${failures.map((line) => `  - ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`smoke-client OK: ${id} registers synchronously and exports apply/inject\n`);
