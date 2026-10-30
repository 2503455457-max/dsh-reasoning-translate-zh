/**
 * Pure text helpers for dsh-think-zh: sentence splitting, language sniffing and
 * Markdown-safe masking. No DOM, no network — unit-testable on its own.
 */

/** Common English abbreviations whose trailing period is not a sentence end. */
const ABBREVIATIONS = new Set([
  'e.g', 'i.e', 'etc', 'vs', 'cf', 'al', 'approx', 'resp', 'fig', 'no', 'nos',
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'inc', 'ltd', 'co', 'corp', 'dept',
  'est', 'min', 'max', 'avg', 'std', 'ref', 'eq', 'sec', 'ch', 'vol', 'pp',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

function isDigit(ch) {
  return ch >= '0' && ch <= '9';
}

function isLower(ch) {
  return ch >= 'a' && ch <= 'z';
}

function isUpper(ch) {
  return ch >= 'A' && ch <= 'Z';
}

/** The last word token before `index` (letters, digits, dots), lowercased. */
function wordBefore(text, index) {
  let i = index;
  while (i > 0) {
    const ch = text[i - 1];
    if (isLower(ch) || isDigit(ch) || ch === '.') i -= 1;
    else break;
  }
  return text.slice(i, index).toLowerCase();
}

/**
 * A single letter acting as an initial, e.g. the `D` in `K. D. Smith`.
 * A lone letter before whitespace is rare outside names, so this stays
 * deliberately permissive: it covers `J. R. R. Tolkien` and `K. D. Smith`
 * without needing a name list.
 * @param text - full source text
 * @param index - offset of the period
 */
/**
 * A single uppercase letter acting as an initial, e.g. the `J` and `R` in
 * `J. R. R. Tolkien`. A lone capital before a period only continues the sentence
 * when another capital follows on the same line, which keeps `K. Smith` and
 * `J. R. R.` together without swallowing the numbered list `file\n- Step 2:`.
 * @param text - full source text
 * @param index - offset of the period
 */
function isInitial(text, index) {
  if (!isUpper(text[index - 1] ?? '')) return false;
  const before = text[index - 2];
  if (!(before === undefined || /[\s([{"'`*_>|-]/.test(before))) return false;
  const next = text[index + 1];
  if (next === undefined) return true;
  if (next === ' ' || next === '\t') return isUpper(text[index + 2] ?? '');
  return false;
}

/**
 * Whether the `.` / `!` / `?` at `index` terminates a sentence.
 * @param text - full source text
 * @param index - offset of the punctuation character
 */
export function isSentenceEnd(text, index) {
  const ch = text[index];
  if (ch !== '.' && ch !== '!' && ch !== '?') return false;

  let j = index + 1;
  while (j < text.length && (text[j] === '"' || text[j] === "'" || text[j] === ')' || text[j] === ']' || text[j] === '`')) j += 1;

  if (ch === '.') {
    // 3.14 / 1.5 — a period between digits never ends a sentence.
    if (isDigit(text[index - 1] ?? '') && isDigit(text[j] ?? '')) return false;
    if (isInitial(text, index)) return false;
    const word = wordBefore(text, index);
    if (ABBREVIATIONS.has(word)) return false;
    if (word.length === 1 && !isDigit(word)) return false;
  }

  // A sentence continues when the next non-space character is lower case.
  const next = text[j];
  if (next === undefined) return true;
  if (!/\s/.test(next)) return true;
  let k = j;
  while (k < text.length && /\s/.test(text[k])) k += 1;
  const after = text[k];
  if (after === undefined) return false;
  return !isLower(after);
}

/**
 * Mask fenced code blocks, inline code and URLs so sentence detection never
 * looks inside them.
 * @param text - raw Markdown
 * @returns masked copy of identical length
 */
export function maskCode(text) {
  const chars = [...text];
  const blank = (from, to) => {
    for (let i = from; i < to && i < chars.length; i += 1) {
      if (chars[i] !== '\n') chars[i] = ' ';
    }
  };
  const fence = /```[\s\S]*?```|~~~[\s\S]*?~~~/g;
  let match;
  while ((match = fence.exec(text)) !== null) blank(match.index, match.index + match[0].length);
  const inline = /`[^`\n]*`/g;
  while ((match = inline.exec(text)) !== null) blank(match.index, match.index + match[0].length);
  const url = /https?:\/\/[^\s)]+/g;
  while ((match = url.exec(text)) !== null) blank(match.index, match.index + match[0].length);
  return chars.join('');
}

/**
 * Split source text into translation units at sentence boundaries.
 * The trailing incomplete sentence is always returned separately so callers can
 * treat it as a re-translatable tail.
 * @param text - reasoning text received so far
 * @param options.minLength - merged chunks shorter than this stay with the next one
 * @returns stable complete sentences plus the trailing partial sentence
 */
export function splitUnits(text, options = {}) {
  const minLength = Number.isFinite(options.minLength) ? options.minLength : 1;
  const masked = maskCode(text);
  const units = [];
  let start = 0;
  for (let i = 0; i < masked.length; i += 1) {
    if (!isSentenceEnd(masked, i)) continue;
    let end = i + 1;
    while (end < masked.length && (masked[end] === '"' || masked[end] === "'" || masked[end] === ')' || masked[end] === ']' || masked[end] === '`')) end += 1;
    const chunk = text.slice(start, end).replace(/^\s+/, '').replace(/\s+$/, '');
    start = end;
    if (chunk.trim() === '') continue;
    if (chunk.length < minLength && end < masked.length) {
      // Too short to stand alone: keep accumulating into the next sentence.
      continue;
    }
    units.push(chunk);
  }
  const tail = text.slice(start).replace(/^\s+/, '').replace(/\s+$/, '');
  const complete = [];
  for (const unit of units) {
    if (unit.trim() !== '') complete.push(unit);
  }
  /* `tailStart` is where the unfinished sentence begins in the ORIGINAL text. Callers
     that skip the tail (streaming) need it to report how much of the source the
     returned translation actually covers. */
  return { complete, tail: tail.trim() === '' ? '' : tail, tailStart: start };
}

/**
 * Number of CJK characters in the text.
 * @param text - text to inspect
 */
export function cjkCount(text) {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code >= 0x3400 && code <= 0x9fff) count += 1;
    else if (code >= 0xf900 && code <= 0xfaff) count += 1;
  }
  return count;
}

/**
 * Whether the text is already mostly Chinese and therefore needs no translation.
 * @param text - text to inspect
 * @param minRatio - CJK share above which the text counts as Chinese
 */
export function looksChinese(text, minRatio = 0.35) {
  const stripped = text.replace(/\s+/g, '');
  if (stripped.length === 0) return false;
  return cjkCount(stripped) / stripped.length >= minRatio;
}

/**
 * Word count used for omission detection: Latin word runs plus single CJK
 * characters, so English source and Chinese output can be compared.
 * @param text - text to count
 */
export function contentUnits(text) {
  const cjk = text.match(/[\u3400-\u9fff\uf900-\ufaff]/gu)?.length ?? 0;
  const words = text
    .replace(/[\u3400-\u9fff\uf900-\ufaff]/gu, ' ')
    .match(/[A-Za-z0-9_][A-Za-z0-9_.'\-]*/g)?.length ?? 0;
  return cjk + words;
}

/**
 * Whether a fragment is pure Markdown structure (bullets, rules, numbering) with
 * no translatable words, and should therefore be copied through verbatim.
 * @param text - fragment to inspect
 */
export function isMarkerOnly(text) {
  return text.replace(/[\s`*_#>|:\-[\](){}"'~+=\d.,;!?/\\-]/g, '') === '';
}

/**
 * Discard translator output that is empty or a refusal/echo rather than a translation.
 * @param value - raw translator output
 * @param source - source fragment it should translate
 * @returns trimmed translation, or null when unusable
 */
export function sanitizeTranslation(value, source) {
  if (typeof value !== 'string') return null;
  let text = value.trim();
  if (text === '') return null;
  // Strip a wrapping code fence the model may add.
  const fenced = /^```[a-zA-Z-]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fenced !== null) text = fenced[1].trim();
  if (text === '') return null;
  if (text === source.trim()) return null;
  text = text.replace(/^(原文|译文|翻译|translation)\s*[:：]\s*/i, '').trim();
  if (text === '') return null;
  return text;
}

/**
 * Join translated fragments into one readable block without merging Markdown
 * structure: each fragment keeps its own line, blank lines stay blank.
 * @param fragments - translated fragments in order
 */
export function joinTranslations(fragments) {
  const out = [];
  for (const fragment of fragments) {
    if (typeof fragment !== 'string') continue;
    const text = fragment.replace(/\s+$/u, '');
    if (text.trim() === '') continue;
    out.push(text);
  }
  return out.join('\n');
}
