/**
 * Translation-engine shoot-out for dsh-think-zh.
 *
 * Drives a *running* dsh host over the plugin's own HTTP route, so it measures
 * exactly what the plugin will experience: latency, prompt adherence, Markdown
 * preservation, identifier preservation, and whether fragment responses come back
 * in a shape the sanitizer accepts.
 *
 * Usage:
 *   node scripts/bench-engine.mjs --url http://127.0.0.1:19399 [--runs 3] [--json out.json]
 *
 * The host must have the candidate engine selected in its saved plugin config.
 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};

const base = String(argOf('--url', 'http://127.0.0.1:19399')).replace(/\/+$/, '');
const stamp = `bench-${Date.now().toString(36)}`;
let nonceCounter = 0;
const nonce = () => ` [probe-${stamp}-${(nonceCounter += 1)}]`;
const runs = Number(argOf('--runs', '3'));
const jsonPath = argOf('--json', undefined);

/** Samples shaped like real reasoning: prose, Markdown structure, and identifiers. */
const SAMPLES = [
  {
    id: 'prose',
    text: 'The user wants the reasoning text translated into Chinese while streaming. Let me check the slot registry first. I need to shadow the assistant-step entry at a lower priority so the built-in renderer can be wrapped. The session log must stay untouched.',
    expect: { identifiers: ['slot registry', 'assistant-step'], markers: [] },
  },
  {
    id: 'markdown',
    text: '- Step 1: read the config file.\n- Step 2: patch the loader so the new row is inserted.\n\nNow I should verify the tree rebuilds without touching the desktop profile.',
    expect: { identifiers: [], markers: ['- '] },
  },
  {
    id: 'code',
    text: 'The failure comes from an empty provider name. Run this to confirm:\n```bash\ndsh plugin --profile desktop add file:/tmp/dsh-think-zh\n```\nIf that prints MODULE_NOT_FOUND the bundle was never built.',
    expect: { identifiers: ['dsh plugin --profile desktop add', 'MODULE_NOT_FOUND'], markers: ['```'] },
  },
  {
    id: 'tail',
    text: 'I think the cleanest approach is to reuse the existing disclosure state so the row does not',
    expect: { identifiers: [], markers: [] },
  },
];

const cjkRatio = (text) => {
  const stripped = text.replace(/\s+/g, '');
  if (stripped === '') return 0;
  let count = 0;
  for (const ch of stripped) {
    const code = ch.codePointAt(0);
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)) count += 1;
  }
  return count / stripped.length;
};

const post = async (path, body, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
};

const status = await fetch(`${base}/dsh-think-zh/config`).then((r) => r.json());
const engine = status?.engine?.label ?? '(unavailable)';
const defaults = status?.config?.engines?.[status?.config?.engine] ?? {};
console.log(`engine: ${engine}`);
console.log(`config: ${JSON.stringify(defaults)}`);
if (status?.error) console.log(`engine error: ${status.error}`);
console.log('');

const rows = [];
for (const sample of SAMPLES) {
  const timings = [];
  let last = null;
  for (let attempt = 0; attempt < runs; attempt += 1) {
    const started = Date.now();
    let payload;
    try {
      payload = await post(
        '/dsh-think-zh/translate',
        { key: `${stamp}-${sample.id}#${attempt}`, text: `${sample.text}${nonce()}` },
        600000,
      );
    } catch (error) {
      console.log(`${sample.id}: FAILED after ${Date.now() - started}ms — ${String(error.message ?? error)}`);
      rows.push({ sample: sample.id, failed: true, error: String(error.message ?? error) });
      payload = null;
    }
    if (payload === null) break;
    const elapsed = Date.now() - started;
    timings.push(elapsed);
    last = { payload, elapsed };
  }
  if (last === null) continue;

  const output = String(last.payload.text ?? '');
  const proseOnly = output.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const ratio = cjkRatio(proseOnly);
  const missingIdentifiers = sample.expect.identifiers.filter((token) => !output.includes(token));
  const missingMarkers = sample.expect.markers.filter((token) => !output.includes(token));
  const leaked = /^(好的|当然|以下是|译文[:：]|Here is|Sure[,，])/u.test(output.trim());

  const verdict = [];
  if (output.trim() === '') verdict.push('空输出');
  if (ratio < 0.3) verdict.push(`中文占比偏低 ${(ratio * 100).toFixed(0)}%`);
  if (missingIdentifiers.length > 0) verdict.push(`丢失标识符 ${missingIdentifiers.join(', ')}`);
  if (missingMarkers.length > 0) verdict.push(`丢失 Markdown ${missingMarkers.join(' ')}`);
  if (leaked) verdict.push('开头有客套话/前缀');

  const sorted = [...timings].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  rows.push({
    sample: sample.id,
    firstMs: timings[0],
    medianMs: median,
    runs: timings.length,
    cjkRatio: Number(ratio.toFixed(3)),
    missingIdentifiers,
    missingMarkers,
    leaked,
    output,
    verdict: verdict.length === 0 ? ['OK'] : verdict,
  });

  console.log(`[${sample.id}] 首次 ${timings[0]}ms · 中位 ${median}ms · 中文占比 ${(ratio * 100).toFixed(0)}%`);
  console.log(`  判定: ${verdict.length === 0 ? 'OK' : verdict.join(' / ')}`);
  console.log(`  输出: ${output.replace(/\n/g, ' ⏎ ').slice(0, 220)}`);
  console.log('');
}

const failed = rows.filter((row) => row.failed === true || (row.verdict && row.verdict[0] !== 'OK'));
console.log(`合计 ${rows.length} 个样本，${failed.length} 个有问题`);
if (jsonPath !== undefined) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(jsonPath, JSON.stringify({ engine, defaults, rows }, null, 2), 'utf8');
  console.log(`明细已写入 ${jsonPath}`);
}
