/**
 * dsh-think-zh — host half.
 *
 * Responsibilities:
 *  1. own the persisted settings (enable flag, engine choice, display mode);
 *  2. build the active translation engine (harness model service, Ollama, or any
 *     OpenAI-compatible endpoint) and translate reasoning fragments through it;
 *  3. serve those three things to the browser half over loopback-only routes.
 *
 * The host never writes Session state: translations live next to the transcript,
 * never inside it.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { TranslationCache, createTranslator } from './translator.js';
import { createEngine, probeEngine, translationSystemPrompt } from './translate.js';

/** Host-side defaults; the browser half only sends the fields the user changed. */
function defaultConfig() {
  return {
    enabled: true,
    engine: 'dsh',
    showOriginal: true,
    defaultOpenOriginal: false,
    minChars: 40,
    engines: {
      dsh: { provider: '', model: '', reasoningEffort: 'off', maxTokens: 1024, temperature: 0 },
      // qwen2.5:1.5b is the measured best local translator for this workload: the only
      // small model that stayed complete, translated unfinished tails correctly, and
      // ran 200-419ms per call. Do NOT switch to qwen3.6/qwen3.8: their hybrid linear
      // attention cannot reuse a prompt prefix, so every new fragment re-reads the whole
      // 371-token instruction (~5.8s per call).
      ollama: { baseURL: 'http://127.0.0.1:11434', model: 'qwen2.5:1.5b', keepAlive: '30m', timeoutMs: 120000 },
      'openai-compatible': { baseURL: '', model: '', apiKey: '', displayName: 'OpenAI-compatible', timeoutMs: 60000 },
    },
    glossary: [],
  };
}

/** Merge persisted settings over the defaults, keeping unknown keys out. */
function normalize(saved, base) {
  if (saved === null || typeof saved !== 'object') return base;
  const merged = { ...base };
  if (typeof saved.enabled === 'boolean') merged.enabled = saved.enabled;
  if (typeof saved.showOriginal === 'boolean') merged.showOriginal = saved.showOriginal;
  if (typeof saved.defaultOpenOriginal === 'boolean') merged.defaultOpenOriginal = saved.defaultOpenOriginal;
  if (Number.isFinite(saved.minChars)) merged.minChars = saved.minChars;
  if (typeof saved.engine === 'string' && ['dsh', 'ollama', 'openai-compatible'].includes(saved.engine)) merged.engine = saved.engine;
  if (Array.isArray(saved.glossary)) merged.glossary = saved.glossary.filter((value) => typeof value === 'string');
  for (const key of Object.keys(base.engines)) {
    const incoming = saved.engines?.[key];
    if (incoming === null || typeof incoming !== 'object') continue;
    merged.engines[key] = { ...base.engines[key], ...incoming };
  }
  return merged;
}

/** Loopback-only guard: the translator reads and writes this machine's config. */
function trustGuard(req, res) {
  const host = String(req.headers.host ?? '');
  const remote = String(req.socket?.remoteAddress ?? '');
  const loopbackRemote = remote === '' || remote === '::1' || remote === '127.0.0.1' || remote.startsWith('127.') || remote === '::ffff:127.0.0.1';
  if (!loopbackRemote) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dsh-think-zh: loopback only');
    return false;
  }
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const allowed = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '';
  if (!allowed) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dsh-think-zh: untrusted host');
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const originHost = new URL(origin).hostname;
      if (originHost !== hostname && originHost !== 'localhost' && originHost !== '127.0.0.1' && originHost !== '::1') {
        res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('dsh-think-zh: cross-origin rejected');
        return false;
      }
    } catch {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('dsh-think-zh: bad origin');
      return false;
    }
  }
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('dsh-think-zh: cross-site rejected');
    return false;
  }
  return true;
}

async function readJsonBody(req, limit = 512 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

/** The loader entry name is `dsh-think-zh`, so the row id matches the package. */
export default {
  name: 'dsh-think-zh',
  apply(root) {
    const log = (message) => {
      try {
        root.logger?.info?.(`[dsh-think-zh] ${message}`);
      } catch {
        /* logger is optional */
      }
    };

    const home = process.env.DSH_HOME ?? path.join(process.env.HOME ?? '.', '.dsh');
    const dataDir = path.join(home, 'dsh-think-zh');
    const configFile = path.join(dataDir, 'config.json');
    const cacheFile = path.join(dataDir, 'cache.json');

    let config = defaultConfig();
    let configReady = false;
    let translator = undefined;
    let engineError = undefined;
    const cache = new TranslationCache(4000, cacheFile);
    const pending = new Map();

    async function loadConfig() {
      try {
        config = normalize(JSON.parse(await fs.readFile(configFile, 'utf8')), defaultConfig());
      } catch {
        config = defaultConfig();
      }
    }

    async function saveConfig() {
      await fs.mkdir(dataDir, { recursive: true });
      await fs.writeFile(configFile, JSON.stringify(config, null, 2), 'utf8');
    }

    /**
     * Resolve the model route for the `dsh` engine. An empty provider or model in
     * the plugin config means "follow whatever this deployment already uses", so it
     * is read from the live default-model selection instead of being left blank.
     * @param slice - the configured `engines.dsh` slice
     */
    function resolveDshRoute(slice) {
      if (slice.provider !== '' && slice.model !== '') return slice;
      let selection;
      try {
        selection = root.get?.('agentDefaultModel')?.currentSelection?.();
      } catch {
        selection = undefined;
      }
      if (selection === undefined) return slice;
      return {
        ...slice,
        provider: slice.provider === '' ? selection.provider : slice.provider,
        model: slice.model === '' ? selection.model : slice.model,
      };
    }

    /** (Re)build the engine + translator from the current configuration. */
    function rebuild() {
      if (!configReady) return;
      engineError = undefined;
      translator = undefined;
      try {
        const engine = createEngine({
          engine: config.engine,
          config: config.engine === 'dsh' ? resolveDshRoute(config.engines.dsh) : config.engines[config.engine],
          llm: root.get?.('llm'),
        });
        translator = createTranslator({
          engine,
          systemPrompt: translationSystemPrompt({ glossary: config.glossary }),
          cache,
          enabled: config.enabled,
          log: (message) => log(message),
        });
        log(`engine ready: ${engine.label}`);
      } catch (error) {
        engineError = error instanceof Error ? error.message : String(error);
        log(`engine unavailable: ${engineError}`);
      }
    }

    /** Serialize requests per row so a fast stream cannot interleave translations. */
    function serialize(key, task) {
      const previous = pending.get(key) ?? Promise.resolve();
      const next = previous.then(task, task);
      pending.set(key, next.catch(() => {}));
      return next;
    }

    // Routes need only the web server. The engine additionally needs the model
    // service, which is optional (a deployment may translate through Ollama only),
    // so it is watched separately: whenever that service appears or changes, the
    // engine is rebuilt instead of staying broken until the next config save.
    let rebuildTimer;
    root.inject(['llm'], () => {
      root.effect(() => {
        clearTimeout(rebuildTimer);
        rebuildTimer = setTimeout(() => rebuild(), 0);
        rebuildTimer.unref?.();
        return () => clearTimeout(rebuildTimer);
      });
    });

    root.inject(['webServer'], (ctx) => {
      const disposers = [];
      const routes = [
        {
          path: '/dsh-think-zh/config',
          methods: ['GET', 'POST'],
          handler: async (req, res) => {
            if (req.method === 'GET') {
              sendJson(res, 200, {
                config,
                engine: translator === undefined ? null : { id: translator.engineId, label: translator.engineLabel },
                error: engineError ?? null,
                stats: translator?.stats() ?? null,
              });
              return;
            }
            const patch = await readJsonBody(req);
            config = normalize(patch, config);
            rebuild();
            await saveConfig();
            sendJson(res, 200, {
              config,
              engine: translator === undefined ? null : { id: translator.engineId, label: translator.engineLabel },
              error: engineError ?? null,
              stats: translator?.stats() ?? null,
            });
          },
        },
        {
          path: '/dsh-think-zh/translate',
          methods: ['POST'],
          handler: async (req, res) => {
            const body = await readJsonBody(req);
            if (translator === undefined) {
              sendJson(res, 200, { fragments: [], skipped: 'no-engine', error: engineError ?? 'engine unavailable' });
              return;
            }
            const key = typeof body.key === 'string' && body.key !== '' ? body.key : 'anonymous';
            const payload = await serialize(key, () => translator.translate({ text: body.text, signal: undefined }));
            sendJson(res, 200, payload);
          },
        },
        {
          path: '/dsh-think-zh/probe',
          methods: ['GET', 'POST'],
          handler: async (req, res) => {
            if (translator === undefined) {
              sendJson(res, 200, { ok: false, error: engineError ?? 'engine unavailable' });
              return;
            }
            const engine = createEngine({
              engine: config.engine,
              config: config.engines[config.engine],
              llm: root.get?.('llm'),
            });
            const result = await probeEngine(engine);
            sendJson(res, 200, { ...result, engine: engine.label });
          },
        },
        {
          path: '/dsh-think-zh/log',
          methods: ['POST'],
          handler: async (req, res) => {
            const body = await readJsonBody(req);
            const level = body.level === 'error' ? 'error' : 'info';
            try {
              root.logger?.[level]?.(`[dsh-think-zh/client] ${String(body.message ?? '')}`);
            } catch {
              /* ignore */
            }
            sendJson(res, 200, { ok: true });
          },
        },
      ];

      for (const route of routes) {
        try {
          disposers.push(ctx.webServer.register({
            kind: 'exact',
            path: route.path,
            handler: async (req, res) => {
              if (!trustGuard(req, res)) return;
              if (!route.methods.includes(req.method ?? 'GET')) {
                res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('method not allowed');
                return;
              }
              try {
                await route.handler(req, res);
              } catch (error) {
                log(`route ${route.path} failed: ${error instanceof Error ? error.message : String(error)}`);
                if (!res.headersSent) sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) });
                else res.end();
              }
            },
          }));
        } catch (error) {
          log(`could not register ${route.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      ctx.effect(() => () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* already gone */
          }
        }
      });
    });

    void (async () => {
      await cache.load();
      await loadConfig();
      configReady = true;
      rebuild();
    })();

    root.effect(() => () => {
      void cache.save();
    });
  },
};
