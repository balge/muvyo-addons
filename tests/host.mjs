import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const sourceRoot = new URL('../src/', import.meta.url);

export function loadRuntime(options = {}) {
  return loadSources('', options);
}

export function loadPlugin(pluginId, options = {}) {
  if (!/^balge\.(miniyingshi|woniu|jying)$/.test(pluginId)) {
    throw new Error('Unknown test plugin ID');
  }
  const site = readFileSync(new URL(`${pluginId}/main.js`, sourceRoot), 'utf8');
  return loadSources(site, options);
}

function loadSources(site, {
  fetch: fetchResponse = () => { throw new Error('Unexpected network request'); },
  settings = {},
  store = new Map(),
  now = () => Date.now(),
  advanceClock,
  remainingMs = null,
} = {}) {
  const runtime = readFileSync(new URL('shared/runtime.js', sourceRoot), 'utf8');
  const calls = [];
  const config = jsonCopy(settings);
  let elapsedMs = 0;
  let sleptMs = 0;
  const clock = () => (typeof now === 'function' ? now() : now) + elapsedMs;
  const readRemaining = () => {
    const budget = typeof remainingMs === 'function' ? remainingMs() : remainingMs;
    return budget === null ? null : Math.max(0, budget - sleptMs);
  };
  const mv = {
    config,
    storage: {
      get: (key) => store.has(key) ? jsonCopy(store.get(key)) : null,
      set: (key, value) => store.set(key, jsonCopy(value)),
      remove: (key) => store.delete(key),
    },
    crypto: {
      sha256: (value) => createHash('sha256').update(value).digest('hex'),
    },
    time: { remainingMs: readRemaining },
    sleep(ms) {
      const remaining = readRemaining();
      if (!Number.isFinite(ms) || ms < 0 || ms > 10000 || sleptMs + ms > 30000 ||
          (remaining !== null && ms >= remaining)) {
        throw new RangeError('Sleep exceeds the host limits');
      }
      sleptMs += ms;
      if (advanceClock) advanceClock(ms);
      else elapsedMs += ms;
    },
    fetch({ url, ...options }) {
      const request = jsonCopy(options);
      calls.push({ url, options: request });
      const response = fetchResponse(url, request, clock());
      if (!response || typeof response.status !== 'number' || typeof response.then === 'function') {
        throw new Error('Expected a synchronous Muvyo response with a numeric HTTP status');
      }
      return jsonCopy({ headers: {}, body: '', set_cookies: [], url, proxied: false, ...response });
    },
  };

  const context = createContext({ mv, console: undefined, clock });
  runInContext('Date.now = ((readTime) => () => readTime())(clock); delete globalThis.clock;', context);
  runInContext(`${runtime}\n;\n${site}`, context, { filename: 'muvyo-entry.js' });
  const { MP, search, resolve } = runInContext(`({
    MP: typeof MP === 'undefined' ? undefined : MP,
    search: typeof search === 'function' ? search : undefined,
    resolve: typeof resolve === 'function' ? resolve : undefined,
  })`, context);
  const invoke = entry => entry && (args => {
    sleptMs = 0;
    return entry(args);
  });
  return { MP, search: invoke(search), resolve: invoke(resolve), calls, store };
}

function jsonCopy(value) {
  return JSON.parse(JSON.stringify(value));
}
