/**
 * Incremental reasoning translator for dsh-think-zh.
 *
 * The unit of work is a sentence: complete sentences are translated once and
 * cached by source text, while the trailing partial sentence is translated on
 * every round so the Chinese keeps up with the stream. Because the cache is
 * keyed by source text and sentences never change once terminated, an earlier
 * prefix of the reasoning is never paid for twice — that is what makes
 * streaming translation affordable.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { contentUnits, isMarkerOnly, joinTranslations, looksChinese, sanitizeTranslation, splitUnits } from './text.js';

/** Batch complete sentences so one round costs roughly one model call. */
const BATCH_CHARS = 420;
const BATCH_UNITS = 3;

/**
 * Merge threshold for a stable sentence boundary. Kept small on purpose: the
 * boundary decides the cache key, so merging sentences would make every later
 * sentence a fresh cache miss each time the prefix changes. Fragments this short
 * are rare in reasoning text; the batch stage joins units for the model call.
 */
const MIN_UNIT_CHARS = 8;

/** Never send an unbounded tail to the translator. */
const MAX_TAIL_CHARS = 1000;

/** Concurrency ceiling for translator calls. */
const MAX_INFLIGHT = 2;

/**
 * Circuit breaker.
 *
 * When the engine is slow or failing (a loaded machine, an unloaded model, a wedged
 * Ollama), every queued translation adds latency to all the others: the queue grows
 * faster than it drains and the whole transcript stalls. After this many consecutive
 * failures the translator stops calling the engine for a cooldown period and answers
 * `skipped: 'circuit-open'` immediately, so the client keeps showing English instead
 * of piling up work.
 */
const BREAK_THRESHOLD = 3;
const BREAK_COOLDOWN_MS = 30_000;

/**
 * Observability only — deliberately NOT an omission detector.
 *
 * Measured on real output: Chinese renders run 1.33–1.76 content units per English
 * source unit, while dropping an entire sentence out of a three-sentence batch only
 * moves that ratio to ~0.82 — above the lowest *legitimate* ratio observed (0.71).
 * The two populations overlap, so no threshold separates them; a retry keyed on this
 * number would fire on honest back-references and still miss a dropped clause.
 * Omission is therefore handled by engine selection, and this ratio is logged so a
 * bad engine can be spotted in real traffic instead of guessed at.
 */
const RATIO_LOG_FLOOR = 1.0;

class Limiter {
  constructor(limit) {
    this.limit = limit;
    this.active = 0;
    this.queue = [];
  }

  async run(task) {
    if (this.active >= this.limit) await new Promise((resolve) => this.queue.push(resolve));
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.queue.shift();
      if (next !== undefined) next();
    }
  }
}

/** Bounded LRU memo of `source -> translation`. */
export class TranslationCache {
  /**
   * @param limit - maximum retained entries
   * @param file - optional JSON persistence path
   */
  constructor(limit, file) {
    this.limit = limit;
    this.file = file;
    this.map = new Map();
    this.dirty = false;
    this.saveTimer = undefined;
    this.loaded = false;
    this.stats = { hits: 0, misses: 0 };
  }

  async load() {
    if (this.loaded || this.file === undefined) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const parsed = JSON.parse(raw);
      for (const [key, value] of Object.entries(parsed?.entries ?? {})) {
        if (typeof value === 'string') this.map.set(key, value);
      }
    } catch {
      /* first run — nothing to load */
    }
  }

  get(key) {
    const value = this.map.get(key);
    if (value === undefined) {
      this.stats.misses += 1;
      return undefined;
    }
    this.stats.hits += 1;
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.limit) this.map.delete(this.map.keys().next().value);
    this.dirty = true;
    this.scheduleSave();
  }

  scheduleSave() {
    if (this.file === undefined || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, 5000);
    this.saveTimer.unref?.();
  }

  async save() {
    if (this.file === undefined || !this.dirty) return;
    this.dirty = false;
    try {
      const entries = {};
      let count = 0;
      for (const [key, value] of this.map) {
        if (count >= this.limit) break;
        entries[key] = value;
        count += 1;
      }
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify({ version: 1, entries }), 'utf8');
    } catch {
      this.dirty = true;
    }
  }
}

/**
 * Create the translator.
 * @param options.engine - engine adapter with `chat({ system, user, signal })`
 * @param options.systemPrompt - translator instruction
 * @param options.cache - {@link TranslationCache}
 * @param options.enabled - whether translation is switched on
 * @param options.skipChinese - skip fragments that are already Chinese
 * @param options.log - logger
 */
export function createTranslator(options) {
  const engine = options.engine;
  const systemPrompt = options.systemPrompt;
  const cache = options.cache;
  const log = options.log ?? (() => {});
  const limiter = new Limiter(MAX_INFLIGHT);
  const circuit = { failures: 0, openUntil: 0 };

  /**
   * Translate one fragment through the cache, guarding against silent omission.
   * @param fragment - source text
   * @param signal - cancellation signal
   */
  async function translateFragment(fragment, signal) {
    const cached = cache?.get(fragment);
    if (cached !== undefined) return { text: cached, cached: true };

    if (Date.now() < circuit.openUntil) return { text: '', cached: false, skipped: 'circuit-open' };

    const ask = async (user) => {
      try {
        const raw = await limiter.run(() => engine.chat({ system: systemPrompt, user, signal }));
        circuit.failures = 0;
        return sanitizeTranslation(raw, fragment);
      } catch (error) {
        circuit.failures += 1;
        if (circuit.failures >= BREAK_THRESHOLD && Date.now() >= circuit.openUntil) {
          circuit.openUntil = Date.now() + BREAK_COOLDOWN_MS;
          log(`circuit opened after ${circuit.failures} consecutive engine failures: ${String(error?.message ?? error)}`);
        }
        throw error;
      }
    };

    const clean = await ask(fragment);
    if (clean === null) return { text: '', cached: false, dropped: true };
    cache?.set(fragment, clean);
    const source = contentUnits(fragment);
    const produced = contentUnits(clean);
    const ratio = source === 0 ? 1 : produced / source;
    if (source >= 8 && ratio < RATIO_LOG_FLOOR) {
      log(`low output ratio ${ratio.toFixed(2)} (${produced}/${source} units) — possible omission: ${clean.slice(0, 60)}`);
    }
    return { text: clean, cached: false, ratio };
  }

  /**
   * Group consecutive sentences for one model call. Cached sentences are dropped
   * first, so a batch never re-sends text that was already translated — batching
   * stays an efficiency measure rather than a cache-coherency hazard.
   */
  function batch(units) {
    const batches = [];
    let current = [];
    let length = 0;
    for (const unit of units) {
      if (cache?.get(unit) !== undefined) {
        if (current.length > 0) {
          batches.push(current);
          current = [];
          length = 0;
        }
        batches.push([unit]);
        continue;
      }
      current.push(unit);
      length += unit.length;
      if (length >= BATCH_CHARS || current.length >= BATCH_UNITS) {
        batches.push(current);
        current = [];
        length = 0;
      }
    }
    if (current.length > 0) batches.push(current);
    return batches;
  }

  return {
    engineId: engine.id,
    engineLabel: engine.label,
    stats: () => ({ ...(cache?.stats ?? { hits: 0, misses: 0 }), size: cache?.map.size ?? 0 }),
    /** Snapshot of the breaker for diagnostics (`/config` exposes it). */
    circuitState: () => ({
      failures: circuit.failures,
      open: Date.now() < circuit.openUntil,
      retryInMs: Math.max(0, circuit.openUntil - Date.now()),
    }),

    /**
     * Translate the reasoning text received so far.
     * @param request.text - full reasoning text of the row
     * @param request.signal - cancellation signal
     * @returns fragments, each with the source it covers
     */
    async translate(request) {
      const text = typeof request.text === 'string' ? request.text : '';
      const signal = request.signal;
      if (text.trim() === '') return { fragments: [], skipped: 'empty' };
      if (options.enabled === false) return { fragments: [], skipped: 'disabled' };
      if (options.skipChinese !== false && looksChinese(text)) return { fragments: [], skipped: 'already-chinese' };

      const { complete, tail, tailStart } = splitUnits(text, { minLength: MIN_UNIT_CHARS });
      /* While the row is still streaming, the unfinished sentence changes on every
         tick, so translating it re-does a full model call each time (measured: one
         engine call per tick, keeping a local model at ~95% GPU). Completed sentences
         are cached and nearly free, so during streaming only those are translated;
         the tail waits until the row stops growing. */
      const streaming = request.streaming === true;
      const fragments = [];

      for (const units of batch(complete)) {
        const source = units.join('');
        const result = await translateFragment(source, signal);
        if (result.text === '') {
          if (isMarkerOnly(source)) fragments.push({ source, text: source, markerOnly: true });
          else log(`translator dropped fragment of ${source.length} chars`);
          continue;
        }
        fragments.push({ source, text: result.text, cached: result.cached === true });
      }

      const tailText = tail.length > MAX_TAIL_CHARS ? tail.slice(-MAX_TAIL_CHARS) : tail;
      const translateTail = !streaming && tailText.trim() !== '';
      if (translateTail) {
        const result = await translateFragment(tailText, signal);
        if (result.text !== '') fragments.push({ source: tailText, text: result.text, tail: true, cached: result.cached === true });
      }

      /* How many source characters the returned translation actually covers. While
         streaming that stops at the unfinished sentence; once settled it is the whole
         row. The client keys its cache by this, so a partial translation is never
         reused as if it covered the whole text. */
      const coveredLength = translateTail || tailText === '' ? text.length : Math.min(tailStart ?? text.length, text.length);

      return {
        fragments,
        text: joinTranslations(fragments.map((fragment) => fragment.text)),
        completeCount: complete.length,
        sourceLength: text.length,
        coveredLength,
        streaming,
        /* Surfaced so the client can show "translation paused" instead of silently
           rendering English when the breaker is open. */
        circuitOpen: Date.now() < circuit.openUntil,
      };
    },
  };
}
