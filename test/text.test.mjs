import assert from 'node:assert/strict';
import { splitUnits, isSentenceEnd, isMarkerOnly, looksChinese, joinTranslations, maskCode } from '../lib/text.js';

// --- sentence splitting -----------------------------------------------------
{
  const { complete, tail } = splitUnits('The user wants a plugin. Let me check `ctx.llm.stream` first. Then I will');
  assert.equal(complete.length, 2, JSON.stringify(complete));
  assert.equal(complete[0], 'The user wants a plugin.');
  assert.equal(complete[1], 'Let me check `ctx.llm.stream` first.');
  assert.equal(tail, 'Then I will');
}

// abbreviations, initials and decimals do not split
{
  const { complete } = splitUnits('Use e.g. npm or pnpm 1.5 times. Then stop.');
  assert.equal(complete.length, 2, JSON.stringify(complete));
  assert.equal(complete[0], 'Use e.g. npm or pnpm 1.5 times.');
  assert.equal(complete[1], 'Then stop.');
}
{
  const { complete } = splitUnits('Written by J. R. R. Tolkien. Read it.');
  assert.equal(complete.length, 2, JSON.stringify(complete));
  assert.equal(complete[0], 'Written by J. R. R. Tolkien.');
}

// markdown list structure survives: markers stay with their item
{
  const src = '- Step 1: read the config file.\n- Step 2: patch the loader.\n\nNow the tree';
  const { complete, tail } = splitUnits(src);
  assert.deepEqual(complete, ['- Step 1: read the config file.', '- Step 2: patch the loader.'], JSON.stringify(complete));
  assert.equal(tail, 'Now the tree');
}

// a list with no sentence-ending punctuation stays one unfinished unit
{
  const src = '- read the config file\n- patch the loader';
  const { complete, tail } = splitUnits(src);
  assert.deepEqual(complete, []);
  assert.equal(tail, '- read the config file\n- patch the loader');
}

// code fence content is not treated as prose
{
  const src = 'Run this:\n```js\nconst a = 1. It works.\n```\nThen verify. And continue';
  const { complete, tail } = splitUnits(src);
  assert.equal(complete.length, 1, JSON.stringify(complete));
  assert.equal(tail, 'And continue');
  assert.equal(complete[0].includes('```js'), true);
}

// short sentences merge with the next one
{
  const { complete } = splitUnits('OK. Now we need to inspect the loader tree carefully.', { minLength: 24 });
  assert.equal(complete.length, 1, JSON.stringify(complete));
}

// question and exclamation
{
  const { complete } = splitUnits('Why does it fail? Because the route is gone! Try again');
  assert.equal(complete.length, 2, JSON.stringify(complete));
}

// --- language sniffing ------------------------------------------------------
assert.equal(looksChinese('这是一个中文句子，不需要翻译。'), true);
assert.equal(looksChinese('This is an English sentence that needs translation.'), false);
assert.equal(looksChinese('DSH 插件把思考翻译成中文显示'), true);

// --- masking preserves offsets ---------------------------------------------
{
  const src = 'a `b.c` d';
  assert.equal(maskCode(src).length, src.length);
  assert.equal(maskCode(src).includes('b.c'), false);
}

// --- join / markers ---------------------------------------------------------
assert.equal(joinTranslations(['第一句。', '', '  ', '第二句。']), '第一句。\n第二句。');
assert.equal(joinTranslations([]), '');

// structural markers are recognised so they can be copied through untranslated
assert.equal(isMarkerOnly('-'), true);
assert.equal(isMarkerOnly('---'), true);
assert.equal(isMarkerOnly('1.'), true);
assert.equal(isMarkerOnly('prose here'), false);
assert.equal(isMarkerOnly('第 1 步'), false);

console.log('text.test.mjs OK');
