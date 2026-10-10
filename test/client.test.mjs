/**
 * Bundle-level test: evaluate the generated `lib/client.js` against a fake module
 * loader and a fake slot context. This is what proves the browser half is
 * syntactically loadable, exports the Cordis plugin face, resolves the built-in
 * renderer and registers the shadow — without needing a browser.
 *
 * It also exercises the pure block-substitution logic the renderer relies on.
 */

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, '..', 'lib', 'client.js');
const bundle = await readFile(bundlePath, 'utf8');

/* ------------------------------------------------- fake platform modules -- */

/** Minimal React stand-in: enough for module evaluation, not for rendering. */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  memo: (component) => component,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
};

const exported = {};
const fakePrimitives = {
  DisclosureRow: 'DisclosureRow',
  IconThinkOutlineRegular: 'IconThinkOutlineRegular',
  MarkdownText: 'MarkdownText',
  TextShimmer: 'TextShimmer',
};

const modules = {
  react: fakeReact,
  // The bundle does `require('react-dom/client').createRoot`, so the stub must be
  // the module object, not the function.
  'react-dom/client': { createRoot: () => ({ render: () => {}, unmount: () => {} }) },
  '@deepseek-ai/dsh-client-ui-primitives': fakePrimitives,
};

/* ------------------------------------------------------ fake module loader */

let captured;
const registered = [];
const loads = [];

/* The bundle registers through `window.__ModuleLoader__` (double underscore), the
   shape all 57 shipped client bundles use; Node has no `window`, so alias it. */
globalThis.window = globalThis;
globalThis.__ModuleLoader__ = {
  load(spec) {
    loads.push(spec.id);
    captured = spec.factory((id) => {
      if (!(id in modules)) throw new Error(`unexpected platform require: ${id}`);
      return modules[id];
    });
  },
};

new Function('window', bundle)(globalThis);
/* The bundle's published face, captured as it registers. */
Object.assign(exported, captured ?? {});

assert.deepEqual(loads, ['dsh-think-zh'], 'the bundle must register exactly one module');
assert.equal(typeof captured.apply, 'function', 'the factory must export apply()');
assert.equal(Array.isArray(captured.inject), true, 'the factory must export an inject array');
assert.equal(typeof captured.substituteTranslatedBlocks, 'function');

/* ----------------------------------------------------------- the fake host */

const BUILTIN = function Builtin() {};
const registeredEntries = [
  { options: { key: 'user' }, component: function User() {} },
  { options: { key: 'assistant-step' }, component: BUILTIN, inject: () => ({ hooks: { presentation: 'seat' } }) },
];

const ctx = {
  slots: {
    entries: (key) => (key === 'conversation.chat.node' ? registeredEntries : []),
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
  // cordis owns teardown; the plugin registers its disposer through ctx.effect.
  effect: (factory) => {
    const disposer = factory();
    return typeof disposer === 'function' ? disposer : () => {};
  },
};

/* ------------------------------------------------------------------- checks */

captured.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 300));

assert.equal(registered.length, 1, `expected exactly one shadow registration, got ${registered.length}`);
const [shadow] = registered;
assert.equal(shadow.options.name, 'conversation.chat.node');
assert.equal(shadow.options.key, 'assistant-step');
assert.equal(shadow.options.priority, -1, 'the shadow must win the cell by priority');

// The built-in's private hooks must be forwarded or the shadow throws on render.
const injected = shadow.options.inject('binding-key', 'actions');
assert.deepEqual(injected, { hooks: { presentation: 'seat' } });

// An unknown platform require must be impossible: apply() already ran clean.

/* ------------------------------- the shadow component must actually render --- */

/* Constructing the registered component once is what catches "wrong module shape"
   bugs: an earlier builder emitted `var React = require("react").React`, which is
   undefined, so the shadow threw "cannot read properties of undefined (reading
   'useMemo')" and the chat slot reported `slot entry crashed`. A render-level
   failure never shows up in a registration-only test. */
{
  const shadow = registered[0]?.component;
  assert.equal(typeof shadow, 'function', 'the shadow must be registered as a component');
  const props = {
    node: { key: 'assistant-1', data: { status: 'settled', blocks: [{ kind: 'reasoning', text: 'Some reasoning text for the shadow to render.' }] } },
    t: (key) => key,
  };
  let out;
  try {
    out = shadow(props);
  } catch (error) {
    assert.fail(`the shadow component threw when constructed: ${error?.constructor?.name}: ${error?.message}`);
  }
  assert.notEqual(out, undefined, 'the shadow must return an element');
  /* With no translation cached it must defer to the built-in renderer. */
  /* With nothing translated the shadow renders the fetchers alongside the built-in,
     so the transcript keeps working while a request is in flight. */
  assert.equal(out.type, fakeReact.Fragment, 'the untranslated shadow must render a Fragment');
}

/* ------------------- the fetch must happen even with an empty cache ---------- */

/* The first implementation only called useTranslation from inside
   TranslatedReasoningRow, which renders only when a translation is already cached.
   Nothing ever issued a request, so the chat showed English forever with no error.
   This walks the rendered tree and requires the fetching component to be mounted
   even though nothing is translated yet. */
{
  const originalCreateElement = fakeReact.createElement;
  const seen = [];
  let tree;
  fakeReact.createElement = (type, props, ...children) => {
    seen.push({ type, props, children });
    return { type, props, children };
  };
  try {
    const shadow = registered[0].component;
    tree = shadow({
      node: {
        key: 'node-42',
        data: {
          status: 'settled',
          blocks: [
            { kind: 'reasoning', text: 'A reasoning block long enough to be translated by the plugin.' },
            { kind: 'text', text: 'The answer.' },
          ],
        },
      },
      t: (key) => key,
    });
  } finally {
    fakeReact.createElement = originalCreateElement;
  }

  /* The fetcher must be part of the RETURNED tree, not merely constructed:
     createElement arguments are evaluated eagerly, so a fetcher that is built but
     not passed as a child would still show up in `seen` — that is precisely the
     deadlock this guards against. */
  const fragment = seen.find((entry) => entry.type === fakeReact.Fragment && Array.isArray(entry.children));
  assert.notEqual(fragment, undefined, 'the untranslated shadow must construct a Fragment');
  const children = fragment.children.flat(Infinity).filter(Boolean);
  const fetchers = children.filter((child) => typeof child.type === 'function' && child.type.name === 'TranslationFetcher');
  assert.equal(fetchers.length, 1, `the Fragment must contain exactly one fetcher, saw ${fetchers.length}`);
  assert.equal(
    children.some((child) => child.type === BUILTIN),
    true,
    'the built-in renderer must still be a child while untranslated',
  );
  assert.equal(
    fetchers[0].props.block.identity,
    'node-42#0',
    'the fetcher must use the same identity the substitution looks up',
  );
  assert.match(
    fetchers[0].props.block.english,
    /A reasoning block long enough/,
    'the fetcher must receive the English source to translate',
  );
  assert.equal(
    fetchers[0].props.block.identity,
    `node-42#${0}`,
    'identity must be `<nodeKey>#<blockIndex>`, matching substituteTranslatedBlocks',
  );

  /* And with an empty cache the shadow must still render the built-in renderer,
     so the transcript keeps working while the first translation is in flight. */
  assert.notEqual(tree, undefined, 'the shadow must render something while untranslated');
}

/* ------------------------------------------- pure substitution behaviour --- */

const lookupWith = (map) => (identity, length) => map[`${identity}@${length}`];

{
  const blocks = [
    { kind: 'reasoning', text: 'First think about the slot registry.' },
    { kind: 'tool-call', name: 'Read' },
    { kind: 'text', text: 'Here is the answer.' },
  ];
  const source = 'First think about the slot registry.';
  const swap = captured.substituteTranslatedBlocks(blocks, 'assistant-1', lookupWith({
    [`assistant-1#0@${source.length}`]: '先想想 slot registry。',
  }));
  assert.notEqual(swap, null, 'a translated reasoning block must be substituted');
  assert.equal(swap.blocks.length, 3, 'block count must be preserved');
  assert.equal(swap.blocks[0].text, '先想想 slot registry。', 'the built-in summary reads the Chinese text');
  assert.equal(swap.blocks[0].english, source);
  assert.equal(swap.blocks[0].translated, true);
  assert.equal(swap.blocks[1], blocks[1], 'non-reasoning blocks must be passed through by identity');
  assert.equal(swap.blocks[2], blocks[2]);
  assert.equal(swap.translated.length, 1);
}

{
  // No translation yet: nothing is swapped, so the built-in keeps rendering English.
  const blocks = [{ kind: 'reasoning', text: 'Nothing translated yet.' }];
  assert.equal(captured.substituteTranslatedBlocks(blocks, 'n', lookupWith({})), null);
  assert.equal(captured.substituteTranslatedBlocks([], 'n', lookupWith({})), null);
  assert.equal(captured.substituteTranslatedBlocks(undefined, 'n', lookupWith({})), null);
}

{
  // A render can arrive after several characters of growth: the newest translation
  // at or below the current length must still be found, and a stale length must not
  // masquerade as one.
  captured.rememberTranslation('assistant-2#0', 36, '先想想 slot registry。');
  assert.equal(captured.newestTranslation('assistant-2#0', 36), '先想想 slot registry。');
  assert.equal(captured.newestTranslation('assistant-2#0', 44), '先想想 slot registry。', 'growth is covered');
  assert.equal(captured.newestTranslation('assistant-2#0', 35), undefined, 'a shorter source has no translation yet');
  assert.equal(captured.newestTranslation('other-node#0', 44), undefined, 'identities must not leak');

  const blocks = [{ kind: 'reasoning', text: 'First think about the slot registry. And then more.' }];
  const swap = captured.substituteTranslatedBlocks(blocks, 'assistant-2', captured.newestTranslation);
  assert.notEqual(swap, null, 'the cached translation must be reused for a grown source');
  assert.equal(swap.blocks[0].text, '先想想 slot registry。');
}

/* ------------- the fetcher's write key must be the substitution's read key ----- */

/* The two halves live in different components: the fetcher writes
   `<identity>@<sourceLength>` from the props it receives, while the substitution reads
   `<nodeKey>#<index>@<block.text.length>` off the node. If those ever diverge the
   plugin goes silent — requests go out, nothing is ever displayed, and no error is
   raised anywhere. This pins both the identity wiring and the cache round-trip. */
{
  const nodeKey = 'node-77';
  const english = 'The fetcher and the substitution must agree on the cache key.';
  let captured;
  const originalCreateElement = fakeReact.createElement;
  fakeReact.createElement = (type, props, ...children) => {
    if (typeof type === 'function' && type.name === 'TranslationFetcher') {
      /* The module's exported helpers, reached through the same object the bundle
         publishes, so this stays a real round-trip rather than a re-implementation. */
      captured = {
        ...props.block,
        remember: exported.rememberTranslation,
        newest: exported.newestTranslation,
        substitute: exported.substituteTranslatedBlocks,
      };
    }
    return { type, props, children };
  };
  try {
    registered[0].component({
      node: { key: nodeKey, data: { status: 'settled', blocks: [{ kind: 'reasoning', text: english }] } },
      t: (key) => key,
    });
  } finally {
    fakeReact.createElement = originalCreateElement;
  }

  assert.notEqual(captured, undefined, 'the fetcher must have been constructed');
  assert.equal(captured.identity, `${nodeKey}#0`, 'fetcher identity must match the substitution identity');
  assert.equal(captured.english, english, 'fetcher must receive the exact block text');

  /* Round-trip through the real cache helpers: what the fetcher's identity and
     source length produce must be exactly what the substitution's lookup finds. */
  const length = captured.english.length;
  captured.remember(captured.identity, length, '中文译文。');
  assert.equal(captured.newest(captured.identity, length), '中文译文。', 'write key must be readable by the substitution');
  assert.equal(captured.newest(captured.identity, length + 8), '中文译文。', 'a grown source must still find it');
  assert.equal(captured.newest('some-other-node#0', length), undefined, 'identities must not leak');

  /* And the substitution must actually swap when the cache is warm. */
  const swap = captured.substitute(
    [{ kind: 'reasoning', text: english }],
    nodeKey,
    captured.newest,
  );
  assert.notEqual(swap, null, 'a warm cache must produce a substitution');
  assert.equal(swap.translated.length, 1);
  assert.equal(swap.translated[0].text, '中文译文。', 'the swapped block must carry the Chinese as its text');
  assert.equal(swap.translated[0].english, english, 'the swapped block must keep the English source');
}

/* ------------------- the scheduler must not starve under streaming ------------- */

/* Field measurement that motivates this block: a translation call took ~1.5s on an
   idle host but 50–85s while the transcript was streaming. Cause: the effect set its
   timer once and then returned early on every later render, so during a continuous
   stream a request either waited for a pause or was throttled against the length of
   the last *completed* response.
   The fix is a trailing-edge debounce that always sends the text present when it
   fires and re-arms while text keeps growing. These are the shapes that pin it. */
{
  assert.equal(
    /\btextRef\.current\b[\s\S]{0,500}?post\('\/translate'/.test(bundle),
    true,
    'the send path must read the newest text (textRef.current) rather than a captured snapshot',
  );
  assert.equal(
    /timerRef\.current = setTimeout\(\(\) => \{[\s\S]{0,300}?send\(\)/.test(bundle),
    true,
    'the timer callback must call send()',
  );
  assert.equal(
    /send\(\);[\s\S]{0,200}?textRef\.current\.length[\s\S]{0,80}?arm\(\)/.test(bundle),
    true,
    'the timer must re-arm while the source keeps growing, otherwise a long stream starves',
  );
  /* The old starvation shape: a render that finds a pending timer must not also be
     the only place a timer is ever created. */
  assert.equal(
    /if \(timerRef\.current !== null\) return undefined;[\s\S]{0,120}timerRef\.current = setTimeout/.test(bundle),
    false,
    'a pending timer must not be the only scheduling point (that shape starves during streaming)',
  );
}

console.log('client.test.mjs OK');
