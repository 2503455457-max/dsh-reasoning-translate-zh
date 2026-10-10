/**
 * Translator behaviour test: chunking, caching and the "never pay twice for the
 * same sentence" property, driven by a fake engine that counts its calls.
 */

import assert from 'node:assert/strict';
import { TranslationCache, createTranslator } from '../lib/translator.js';

/** Fake engine that upper-cases and records every fragment it is asked for. */
function fakeEngine() {
  const calls = [];
  return {
    calls,
    id: 'fake',
    label: 'Fake',
    async chat({ user }) {
      calls.push(user);
      return `【${user}】`;
    },
  };
}

const options = { skipChinese: true, enabled: true, minChars: 1 };

/** A memory-only cache: no file argument means nothing is ever written to disk. */
const freshCache = () => new TranslationCache(500);

/** Long enough to fill one batch on its own (BATCH_CHARS is 420). */
const LONG_A = `Alpha ${'a'.repeat(200)} ends here.`;
const LONG_B = `Beta ${'b'.repeat(200)} ends here.`;
const LONG_C = `Gamma ${'c'.repeat(200)} ends here.`;
const LONG_D = `Delta ${'d'.repeat(200)} ends here.`;

// --- complete sentences are translated once and cached ----------------------
{
  const engine = fakeEngine();
  const translator = createTranslator({ engine, systemPrompt: 'x', cache: freshCache(), ...options });
  const first = await translator.translate({ text: `${LONG_A} ${LONG_B} ${LONG_C} Partial tail` });
  assert.equal(first.fragments.length, 3, JSON.stringify(first.fragments.map((f) => f.source.slice(0, 12))));
  assert.equal(first.fragments[0].source, `${LONG_A}${LONG_B}`);
  assert.equal(first.fragments[1].source, LONG_C);
  assert.equal(first.fragments.at(-1).tail, true);
  const callsAfterFirst = engine.calls.length;
  assert.equal(callsAfterFirst, 3, 'two batches plus the tail');

  // The same text again: everything is served from the cache.
  const again = await translator.translate({ text: `${LONG_A} ${LONG_B} ${LONG_C} Partial tail` });
  assert.equal(again.text, first.text);
  assert.equal(engine.calls.length, callsAfterFirst, 'repeating the same text must not call the engine');
}

// --- a growing tail must not re-translate settled sentences -----------------
{
  const engine = fakeEngine();
  const translator = createTranslator({ engine, systemPrompt: 'x', cache: freshCache(), ...options });
  await translator.translate({ text: `${LONG_A} ${LONG_B} ${LONG_C} Partial` });
  const settledCalls = engine.calls.length;
  await translator.translate({ text: `${LONG_A} ${LONG_B} ${LONG_C} ${LONG_D} Partial again` });
  const newCalls = engine.calls.slice(settledCalls);
  assert.deepEqual(
    newCalls,
    [LONG_D, 'Partial again'],
    `expected only the new sentence plus the new tail, got ${JSON.stringify(newCalls.map((c) => c.slice(0, 12)))}`,
  );
}

// --- a Chinese source is skipped entirely ----------------------------------
{
  const engine = fakeEngine();
  const translator = createTranslator({ engine, systemPrompt: 'x', cache: freshCache(), ...options });
  const result = await translator.translate({ text: '这是一段中文推理，不需要翻译。' });
  assert.equal(result.skipped, 'already-chinese');
  assert.equal(engine.calls.length, 0);
}

// --- disabled translation calls nothing ------------------------------------
{
  const engine = fakeEngine();
  const translator = createTranslator({ engine, systemPrompt: 'x', cache: freshCache(), enabled: false, skipChinese: true });
  const result = await translator.translate({ text: 'Translate me please.' });
  assert.equal(result.skipped, 'disabled');
  assert.equal(engine.calls.length, 0);
}

// --- code fences are carried over untouched --------------------------------
{
  const engine = fakeEngine();
  const translator = createTranslator({ engine, systemPrompt: 'x', cache: freshCache(), ...options });
  const result = await translator.translate({ text: 'Run this command.\n```bash\nnpm run build\n```\n' });
  assert.equal(result.text.includes('```bash'), true, `fence lost: ${JSON.stringify(result.text)}`);
  assert.equal(result.text.includes('npm run build'), true, `code lost: ${JSON.stringify(result.text)}`);
}

console.log('translator.test.mjs OK');

// --- omission is NOT retried; it is reported ---------------------------------
{
  // Measured reality: a translation that drops a sentence lands at a unit ratio the
  // engine also produces honestly, so the translator must not "fix" it. It records
  // the ratio instead, and the dropped sentence simply has no Chinese that round.
  const calls = [];
  const logs = [];
  const engine = {
    id: 'omitter',
    label: 'Omitter',
    async chat({ user }) {
      calls.push(user);
      return '用户希望把推理文本翻译成中文。';
    },
  };
  const translator = createTranslator({
    engine,
    systemPrompt: 'x',
    cache: freshCache(),
    log: (message) => logs.push(message),
    ...options,
  });
  const result = await translator.translate({
    text: 'The user wants the reasoning text translated into Chinese. Let me check the slot registry first. The session log must stay untouched.',
  });
  assert.equal(calls.length, 1, 'an omission must not trigger a second model call');
  assert.equal(result.fragments.every((fragment) => fragment.text.trim() !== ''), true);
  assert.equal(
    logs.some((message) => message.includes('low output ratio')),
    true,
    `a suspicious ratio must be logged: ${JSON.stringify(logs)}`,
  );
}

{
  // A healthy translation must not be reported.
  const logs = [];
  const engine = {
    id: 'healthy',
    label: 'Healthy',
    async chat() {
      return '用户希望把推理文本翻译成中文。先检查一下 slot registry。会话日志必须保持原样。';
    },
  };
  const translator = createTranslator({ engine, systemPrompt: 'x', cache: freshCache(), log: (m) => logs.push(m), ...options });
  await translator.translate({
    text: 'The user wants the reasoning text translated into Chinese. Let me check the slot registry first. The session log must stay untouched.',
  });
  assert.deepEqual(logs, [], `a healthy ratio must stay quiet: ${JSON.stringify(logs)}`);
}

console.log('translator ratio reporting OK');
