/**
 * Translation engines for dsh-think-zh.
 *
 * Every engine exposes the same shape — `chat({ system, user, signal })` returning
 * the assistant text — so the translator never learns which provider answered.
 * `dsh` delegates to the harness model service (`ctx.llm.stream`), which is the
 * same route the agent itself uses and therefore needs no extra credential.
 */

/**
 * Words that must survive translation unchanged. The second group are terms the
 * translation *target* itself uses: small local models were observed rendering
 * them as "槽注册表" / "助理-步骤条目", which makes the Chinese unreadable to
 * anyone who knows the codebase, so they are protected regardless of engine.
 */
const GLOSSARY = [
  'DSH', 'DeepSeek', 'Harness', 'npm', 'pnpm', 'Node', 'React', 'TypeScript',
  'Ollama', 'MCP', 'API', 'JSON', 'YAML', 'CSS', 'HTML', 'DOM', 'Git', 'GitHub',
  'TODO', 'FIXME', 'OK',
  'slot registry', 'assistant-step', 'renderer', 'profile', 'bundle',
  'reasoning', 'stream', 'chunk', 'hook', 'slot', 'node', 'session',
];

/**
 * Build the translator instruction. Tuned for short reasoning fragments: it must
 * return the translation and nothing else, and must preserve Markdown structure.
 * @param options.glossary - extra terms to keep verbatim
 */
export function translationSystemPrompt(options = {}) {
  const glossary = [...GLOSSARY, ...(options.glossary ?? [])].join(', ');
  return [
    '你是技术文本翻译器。把你收到的英文推理片段翻译成简体中文。',
    '',
    '铁律：',
    '1. 只输出译文本身。不要开场白、不要解释、不要「好的」、不要重复原文、不要用代码块包裹整段译文。',
    '2. 保持 Markdown 结构完全不变：列表符号、编号、缩进、换行、表格、引用前缀照抄；代码块、行内代码、文件路径、URL、命令原样保留。',
    '3. 保留术语与标识符原形：' + glossary + '；变量名、函数名、类名、包名、文件名、CLI 参数一律不译。',
    '4. 不要添加原文没有的内容，不要补充解释性括号。',
    '5. 原文不完整（半句话）时，就照直翻译这不完整的半句，不要补全它。',
    '',
    '示例：',
    '原文: The user wants a plugin that rewrites reasoning. Let me check `ctx.llm.stream` first.',
    '译文: 用户想要一个改写推理的插件。先检查一下 `ctx.llm.stream`。',
    '原文: - Step 1: read the config file',
    '译文: - 第 1 步：读取配置文件',
  ].join('\n');
}

/** Strip ` thinking…<｜end▁of▁thinking｜>` blocks some local models emit. */
export function stripThinking(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '')
    .replace(/^\s*<think(?:ing)?>[\s\S]*$/i, '')
    .trim();
}

async function postJson(fetchImpl, url, body, timeoutMs, signal) {
  const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  const onAbort = () => controller?.abort();
  try {
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller?.signal ?? signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}: ${text.slice(0, 300)}`);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${url} -> invalid JSON: ${text.slice(0, 300)}`);
    }
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}

/**
 * Create an engine from resolved configuration.
 * @param options.engine - `ollama` | `openai-compatible` | `dsh`
 * @param options.config - the engine slice of plugin configuration
 * @param options.fetch - fetch implementation (injected for tests)
 * @param options.llm - harness model service for the `dsh` engine
 */
export function createEngine(options) {
  const engine = options.engine ?? 'ollama';
  const config = options.config ?? {};
  const fetchImpl = options.fetch ?? globalThis.fetch;

  if (engine === 'dsh') {
    const llm = options.llm;
    if (llm === undefined || llm === null) throw new Error('engine "dsh" needs the harness model service (ctx.llm)');
    return {
      id: 'dsh',
      label: `DSH ${config.provider ?? ''}/${config.model ?? ''}`.trim(),
      async chat({ system, user, signal }) {
        let text = '';
        const stream = llm.stream({
          provider: config.provider,
          model: config.model,
          ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
          ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
          temperature: config.temperature ?? 0,
          messages: [
            { role: 'system', content: [{ type: 'text', text: system }] },
            { role: 'user', content: [{ type: 'text', text: user }] },
          ],
          ...(signal === undefined ? {} : { signal }),
        });
        for await (const chunk of stream) {
          if (chunk?.type === 'text-delta') text += chunk.text ?? '';
        }
        return stripThinking(text);
      },
    };
  }

  const baseURL = String(config.baseURL ?? (engine === 'ollama' ? 'http://127.0.0.1:11434' : '')).replace(/\/+$/, '');
  if (baseURL === '') throw new Error(`engine "${engine}" needs baseURL`);
  const model = config.model;
  if (typeof model !== 'string' || model === '') throw new Error(`engine "${engine}" needs model`);
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 60_000;
  const temperature = Number.isFinite(config.temperature) ? config.temperature : 0;

  if (engine === 'ollama') {
    return {
      id: 'ollama',
      label: `Ollama ${model}`,
      async chat({ system, user, signal }) {
        const body = {
          model,
          stream: false,
          think: false,
          keep_alive: config.keepAlive ?? '30m',
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          options: { temperature, num_predict: config.maxTokens ?? 1024 },
        };
        const json = await postJson(fetchImpl, `${baseURL}/api/chat`, body, timeoutMs, signal);
        return stripThinking(json?.message?.content ?? '');
      },
    };
  }

  if (engine === 'openai-compatible') {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof config.apiKey === 'string' && config.apiKey !== '') headers.Authorization = `Bearer ${config.apiKey}`;
    return {
      id: 'openai-compatible',
      label: `${config.displayName ?? 'OpenAI-compatible'} ${model}`,
      async chat({ system, user, signal }) {
        const body = {
          model,
          stream: false,
          temperature,
          ...(config.maxTokens === undefined ? {} : { max_tokens: config.maxTokens }),
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        };
        const controller = typeof AbortController === 'function' ? new AbortController() : undefined;
        const timer = setTimeout(() => controller?.abort(), timeoutMs);
        try {
          signal?.addEventListener?.('abort', () => controller?.abort(), { once: true });
          const response = await fetchImpl(`${baseURL}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: controller?.signal ?? signal,
          });
          const text = await response.text();
          if (!response.ok) throw new Error(`${baseURL}/chat/completions -> HTTP ${response.status}: ${text.slice(0, 300)}`);
          const json = JSON.parse(text);
          return stripThinking(json?.choices?.[0]?.message?.content ?? '');
        } finally {
          clearTimeout(timer);
        }
      },
    };
  }

  throw new Error(`unknown engine ${JSON.stringify(engine)}`);
}

/**
 * Probe an engine once so the UI can report whether translation is reachable.
 * @param engine - engine created by {@link createEngine}
 */
export async function probeEngine(engine) {
  const started = Date.now();
  try {
    const text = await engine.chat({
      system: translationSystemPrompt(),
      user: 'Reply with the single word: ready',
      signal: undefined,
    });
    return { ok: true, ms: Date.now() - started, sample: String(text).slice(0, 120) };
  } catch (error) {
    return { ok: false, ms: Date.now() - started, error: error instanceof Error ? error.message : String(error) };
  }
}
