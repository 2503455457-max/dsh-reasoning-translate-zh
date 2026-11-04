/**
 * Client bundle behaviour: registration shape, the summary-first rendering contract,
 * the cache, and the request scheduler.
 *
 * The bundle is loaded through a fake module loader with a fake React, so these tests
 * exercise the real built artifact rather than the source.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const bundle = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

/* ------------------------------------------------------------- fake platform */

const fakePrimitives = {
  DisclosureRow: function DisclosureRow() {},
  IconThinkOutlineRegular: function Icon() {},
  MarkdownText: function MarkdownText() {},
  TextShimmer: function TextShimmer() {},
};

const fakeReact = {
  Fragment: Symbol('Fragment'),
  memo: (component) => component,
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useReducer: (_reducer, initial) => [initial, () => {}],
  useRef: (value) => ({ current: value }),
  useEffect: () => {},
  useMemo: (factory) => factory(),
  useCallback: (callback) => callback,
};

let captured;
const exported = {};
const loads = [];
const registered = [];

globalThis.window = globalThis;
globalThis.__ModuleLoader__ = {
  mode: 'queue',
  load(spec) {
    loads.push(spec.id);
    captured = spec.factory((id) => {
      if (id === 'react') return fakeReact;
      if (id === 'react-dom/client') return { createRoot: () => ({ render() {}, unmount() {} }) };
      if (id === '@deepseek-ai/dsh-client-ui-primitives') return fakePrimitives;
      throw new Error(`unexpected platform require: ${id}`);
    });
  },
};
globalThis.document = {
  documentElement: { setAttribute() {} },
  head: { appendChild() {} },
  body: { appendChild() {} },
  createElement: () => ({ setAttribute() {}, style: {}, appendChild() {} }),
  querySelector: () => null,
};
globalThis.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ config: { enabled: true } }) });

new Function('window', bundle)(globalThis);
Object.assign(exported, captured ?? {});

assert.deepEqual(loads, ['dsh-think-zh'], 'the bundle must register exactly one module');
assert.equal(typeof captured.apply, 'function', 'the factory must export apply()');
assert.equal(Array.isArray(captured.inject), true, 'the factory must export an inject array');

/* ------------------------------------------------------------- fake slot host */

const BODY_SLOT = 'conversation.chat.reasoning.body';
const IMAGES_SLOT = 'conversation.chat.message.images';
const BUILTIN = function AssistantNodeView() {};
BUILTIN.inject = () => ({ hooks: { presentation: 'seat' } });

const builtinEntry = {
  options: { key: 'assistant-step', priority: 0, children: { [BODY_SLOT]: { kind: 'single' } } },
  component: BUILTIN,
  inject: BUILTIN.inject,
};

const ctx = {
  slots: {
    entries: (key) => (key === 'conversation.chat.node' ? [builtinEntry] : []),
    register: (options, component) => {
      registered.push({ options, component });
      return () => {};
    },
  },
  effect: (factory) => {
    const disposer = factory();
    return typeof disposer === 'function' ? disposer : () => {};
  },
};

captured.apply(ctx);
await new Promise((resolve) => setTimeout(resolve, 300));

assert.equal(registered.length, 1, `expected one registration, got ${registered.length}`);
const shadow = registered[0].component;
assert.equal(registered[0].options.priority, -1, 'the shadow must win the cell by priority');

/* ------------------------------------------------------- summary-first render */

const LONG_HEAD =
  'Alpha beta gamma delta epsilon, which is the first complete sentence of this row. ';
const LONG_TAIL = 'And here comes an unfinished tail that keeps growing without end';
/** The prefix `firstCompleteSummary` actually returns: the sentence, trailing space cut. */
const SUMMARY = LONG_HEAD.trimEnd();

function renderNode(blocks, status = 'settled') {
  const seen = [];
  const original = fakeReact.createElement;
  fakeReact.createElement = (type, props, ...children) => {
    seen.push({ type, props, children });
    return { type, props, children };
  };
  let tree;
  try {
    tree = shadow({ node: { key: 'node-1', data: { status, blocks } }, t: (key) => key });
  } finally {
    fakeReact.createElement = original;
  }
  return { seen, tree };
}

/* With nothing translated the built-in still renders, but it must receive a
   renderSlot: DSH 0.2.1 calls it for the reasoning body and a missing one throws. */
{
  const { seen } = renderNode([{ kind: 'reasoning', text: LONG_HEAD + LONG_TAIL }]);
  const builtin = seen.find((entry) => entry.type === BUILTIN);
  assert.notEqual(builtin, undefined, 'the built-in renderer must be constructed');
  assert.equal(typeof builtin.props.renderSlot, 'function', '0.2.1 needs a renderSlot prop');
  const body = builtin.props.renderSlot(BODY_SLOT, { text: '一些中文', running: false });
  assert.notEqual(body, undefined, 'the body slot must produce an element');
  assert.equal(builtin.props.renderSlot('conversation.chat.message.images', {}), null);
}

/* Only the summary prefix may be requested — never the whole row. */
{
  const seen = [];
  const original = fakeReact.createElement;
  fakeReact.createElement = (type, props, ...children) => {
    seen.push({ type, props, children });
    return { type, props, children };
  };
  try {
    shadow({ node: { key: 'node-7', data: { status: 'running', blocks: [{ kind: 'reasoning', text: LONG_HEAD + LONG_TAIL }] } }, t: (k) => k });
  } finally {
    fakeReact.createElement = original;
  }
  const fetchers = seen.filter((entry) => typeof entry.type === 'function' && entry.type.name === 'TranslationFetcher');
  assert.equal(fetchers.length, 1, 'one summary fetcher per reasoning block');
  const block = fetchers[0].props.block;
  assert.equal(block.identity, 'node-7#0#sum', 'summary identity must be its own key');
  assert.equal(block.english, SUMMARY, 'the fetch must cover only the completed prefix');
  assert.equal(block.english.includes('unfinished tail'), false, 'the tail must never be requested');
  assert.equal(fetchers[0].props.streaming, true, 'streaming state must be forwarded');
}

/* ------------------------------------------------ summary substitution rules */

{
  const source = `${LONG_HEAD}${LONG_TAIL}`;
  const summaryLen = SUMMARY.length;
  const substitute = exported.substituteSummaries;
  assert.equal(typeof substitute, 'function', 'substituteSummaries must be exported');

  const warm = substitute([{ kind: 'reasoning', text: source }], 'n1', (identity, length) =>
    identity === 'n1#0#sum' && length === summaryLen ? '阿尔法贝塔伽马。' : undefined,
  );
  assert.notEqual(warm, null, 'a warm summary must substitute');
  assert.equal(warm.translated[0].text, '阿尔法贝塔伽马。', 'block.text becomes the Chinese summary');
  assert.equal(warm.translated[0].english, source, 'the full English source is kept for the body');
  assert.equal(warm.translated[0].identity, 'n1#0', 'the body cache identity is the original one');

  const cold = substitute([{ kind: 'reasoning', text: source }], 'n1', () => undefined);
  assert.equal(cold, null, 'nothing translated means no substitution');
  assert.equal(substitute([], 'n1', () => 'x'), null);
  assert.equal(substitute(undefined, 'n1', () => 'x'), null);

  /* A row with no complete sentence yet has no summary to translate. */
  const running = substitute([{ kind: 'reasoning', text: 'a half sentence that never ends' }], 'n1', () => 'x');
  assert.equal(running, null, 'an unfinished first sentence yields no summary');
}

/* ------------------------------------------------------------ summary helper */

{
  const first = exported.firstCompleteSummary;
  assert.equal(typeof first, 'function', 'firstCompleteSummary must be exported');
  const longSentence = 'This first sentence is long enough to be worth translating on its own. And a second one follows.';
  assert.equal(first(longSentence), longSentence.split(' And ')[0], 'stops after the first complete sentence');
  assert.equal(first('Short. Tiny.'), '', 'sentences below the minimum length are not summarised yet');
  assert.equal(first('No terminator at all'), '', 'never returns an unfinished tail');
  assert.equal(first('a'.repeat(60)), '', 'a single long unfinished sentence is not a summary');
  assert.equal(first(`${'x'.repeat(30)}. ${'y'.repeat(30)}.`).endsWith('.'), true);
}

/* ----------------------------------------------------- cache and subscription */

{
  const remember = exported.rememberTranslation;
  const lookup = exported.lookupTranslation;
  const subscribe = exported.subscribeTranslations;

  remember('cov', 86, '中文');
  assert.deepEqual(lookup('cov', 127), { text: '中文', size: 86 }, 'lookup reports coverage');
  assert.equal(lookup('cov', 40), undefined);

  const heard = [];
  const off = subscribe((identity) => heard.push(identity));
  remember('wake-a', 5, '甲');
  off();
  remember('wake-b', 5, '乙');
  assert.deepEqual(heard, ['wake-a'], 'subscribers hear arrivals until they unsubscribe');
}

/* ------------------------------------------------------- scheduler invariants */

{
  assert.equal(
    (bundle.match(/useTranslation\(/g) ?? []).length,
    3,
    'only the definition, the summary fetcher and the lazy body may call the hook',
  );
  assert.equal(/streaming:\s*streamingRef\.current/.test(bundle), true, 'requests carry the streaming flag');
  assert.equal(/coveredLength/.test(bundle), true, 'the client keys its cache by covered length');
  assert.equal(/if \(inFlightRef\.current\) return;/.test(bundle), true, 'single-flight per row');
  assert.equal(
    /textRef\.current\.length - sentRef\.current >= MIN_GROWTH\) arm\(\)/.test(bundle),
    true,
    'the scheduler re-arms while the source grows',
  );
  /* The shadow passes a locally built `renderSlot` (short-hand property) to the
     built-in, and supplies one in the disabled branch as well. */
  assert.equal(/const renderSlot = \(key, owner\)/.test(bundle), true, 'the shadow builds its own renderSlot');
  assert.equal(/renderSlot,/.test(bundle), true, 'the built-in is given that renderSlot');
  assert.equal(/renderSlot: plainSlot/.test(bundle), true, 'the disabled branch keeps the built-in renderable');
}

/* ------------------- assistant images must not be dropped ---------------- */

/* We replace the node's renderSlot, so the built-in image slot no longer runs by
   itself. The standard kit hands every entry a renderFactorySlot binding; delegating
   to the official gallery factory is what keeps assistant image blocks visible. */
{
  const seen = [];
  const original = fakeReact.createElement;
  let tree;
  let capturedFactory = null;
  fakeReact.createElement = (type, props, ...children) => {
    seen.push({ type, props, children });
    return { type, props, children };
  };
  try {
    tree = shadow({
      node: {
        key: 'img-1',
        data: { status: 'settled', blocks: [{ kind: 'reasoning', text: LONG_HEAD }] },
      },
      t: (k) => k,
      renderFactorySlot: (name, props) => {
        capturedFactory = { name, props };
        return { type: 'FactoryOutlet', props, children: [] };
      },
    });
  } finally {
    fakeReact.createElement = original;
  }
  const builtin = seen.find((entry) => entry.type === BUILTIN);
  assert.notEqual(builtin, undefined, 'built-in must render');
  const images = builtin.props.renderSlot(IMAGES_SLOT, {
    images: [{ attachment: { id: 'a1' } }],
    loadImage: () => 'blob:x',
    align: 'start',
  });
  assert.notEqual(images, undefined, 'assistant images must render something, not null');
  assert.equal(capturedFactory?.name, 'conversation.images.content', 'must use the official gallery factory');
  assert.deepEqual(capturedFactory?.props?.images, [{ attachment: { id: 'a1' } }], 'image data must be forwarded');
}

/* ------------------- failures must be visible in the row ----------------- */

{
  const note = exported.noteTranslationError;
  const errorOf = exported.translationErrorOf;
  const subscribe = exported.subscribeTranslationErrors;
  assert.equal(typeof note, 'function');
  assert.equal(typeof subscribe, 'function');

  const heard = [];
  const off = subscribe((identity) => heard.push(identity));
  note('fail-1#0#sum', '翻译暂停（引擎连续失败）');
  note('fail-1#0#sum', '翻译暂停（引擎连续失败）'); // 去重
  assert.deepEqual(heard, ['fail-1#0#sum'], 'state changes notify once');
  assert.equal(errorOf('fail-1#0#sum'), '翻译暂停（引擎连续失败）');
  note('fail-1#0#sum', null);
  assert.equal(errorOf('fail-1#0#sum'), undefined, 'clearing removes the state');
  off();

  /* A failing row must show the marker in the text the built-in renders. */
  const seen = [];
  const original = fakeReact.createElement;
  note('row-x#0#sum', '翻译暂停（引擎连续失败）');
  fakeReact.createElement = (type, props, ...children) => {
    seen.push({ type, props, children });
    return { type, props, children };
  };
  try {
    shadow({
      node: { key: 'row-x', data: { status: 'settled', blocks: [{ kind: 'reasoning', text: LONG_HEAD }] } },
      t: (k) => k,
    });
  } finally {
    fakeReact.createElement = original;
    note('row-x#0#sum', null);
  }
  const builtin = seen.find((entry) => entry.type === BUILTIN);
  const text = String(builtin?.props?.node?.data?.blocks?.[0]?.text ?? '');
  assert.equal(text.includes('翻译暂停'), true, 'the failing row must be marked: ' + text.slice(0, 60));
}

/* ------------------- subscription identity must match the fetch key ------------ */

/* 2026-11-04 regression: the shadow subscribed with `<node>#<index>` while summaries
   are stored under `<node>#<index>#sum`, so a collapsed row never re-rendered when its
   translation arrived — the expanded body was Chinese, the summary stayed English. */
{
  assert.equal(
    /identities\.add\(`\$\{node\?\.key \?\? 'node'\}#\$\{index\}#sum`\)/.test(bundle),
    true,
    'the subscription identity must include the #sum suffix used by the summary fetcher',
  );
  assert.equal(
    /translationErrorOf\(`\$\{identity\}#sum`\)/.test(bundle),
    true,
    'failure markers must use the same summary identity',
  );
}

console.log('client.test.mjs OK');
