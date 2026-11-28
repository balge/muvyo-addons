import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { loadRuntime } from './host.mjs';

const origin = 'https://video.example.test';
const btih = '0123456789abcdef0123456789abcdef01234567';
const magnet = `magnet:?xt=urn:btih:${btih}&dn=Demo`;

function makeClient(host, overrides = {}) {
  assert.ok(host.MP, 'The shared runtime exposes MP');
  return host.MP.client({
    origin,
    key: 'example',
    username: 'fake-user',
    password: 'fake-secret-a',
    login: (raw) => raw('/login', { method: 'POST' }),
    ...overrides,
  });
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('a 401 triggers one new login and returns the refreshed response', () => {
  let logins = 0;
  let latest = 0;
  const options = {
    fetch(url, request) {
      if (url === `${origin}/login`) {
        logins += 1;
        return { status: 200, set_cookies: [`sid=fake-${logins}; Path=/; Secure`] };
      }
      assert.equal(url, `${origin}/results`);
      return request.headers.Cookie === `sid=fake-${latest}`
        ? { status: 200, body: `version ${latest}` }
        : { status: 401 };
    },
  };
  const first = loadRuntime(options);
  latest = 1;
  assert.equal(makeClient(first).request('/results').body, 'version 1');

  latest = 2;
  const next = loadRuntime({ ...options, store: first.store });
  assert.equal(makeClient(next).request('/results').body, 'version 2');
  assert.deepEqual(next.calls.map(({ url, options: request }) => [url, request.headers.Cookie]), [
    [`${origin}/results`, 'sid=fake-1'],
    [`${origin}/login`, undefined],
    [`${origin}/results`, 'sid=fake-2'],
  ]);

  latest = 4;
  assert.equal(makeClient(next).request('/results').status, 401);
  assert.equal(logins, 3);
});

test('client computes the timeout at each dispatch, including both authenticated sends', () => {
  let remainingMs = 6500;
  let logins = 0;
  let reads = 0;
  const host = loadRuntime({
    remainingMs: () => remainingMs,
    fetch(url) {
      if (url === `${origin}/login`) {
        remainingMs = ++logins === 1 ? 4800 : 2600;
        return { status: 200, set_cookies: [`sid=fake-${logins}; Path=/`] };
      }
      assert.equal(url, `${origin}/results`);
      if (++reads === 1) {
        remainingMs = 3700;
        return { status: 401 };
      }
      return { status: 200 };
    },
  });
  const client = makeClient(host, {
    authCookies: ['sid'],
    timeoutForSend: (timeout = 6) => Math.min(timeout, Math.floor((remainingMs - 200) / 1000)),
  });
  assert.equal(client.request('/results', { timeout: 5 }).status, 200);
  assert.deepEqual(host.calls.map(({ url, options }) => [url, options.timeout]), [
    [`${origin}/login`, 6], [`${origin}/results`, 4], [`${origin}/login`, 3], [`${origin}/results`, 2],
  ]);
});

test('403, 429 and transport errors reuse the existing session without login retries', () => {
  const host = loadRuntime({
    fetch(url) {
      switch (url) {
        case `${origin}/login`: return { status: 200, set_cookies: ['sid=fake; Path=/'] };
        case `${origin}/denied`: return { status: 403 };
        case `${origin}/limited`: return { status: 429 };
        case `${origin}/offline`: throw new Error('private transport details');
        default: throw new Error('Unexpected route');
      }
    },
  });
  const client = makeClient(host);
  assert.equal(client.request('/denied').status, 403);
  assert.equal(client.request('/limited').status, 429);
  assert.throws(() => client.request('/offline'), { message: 'Site request failed' });
  assert.deepEqual(host.calls.map(({ url }) => url), [
    `${origin}/login`, `${origin}/denied`, `${origin}/limited`, `${origin}/offline`,
  ]);
});

test('an anonymous CSRF cookie does not suppress the first login', () => {
  const host = loadRuntime({
    fetch(url, { headers }) {
      switch (url) {
        case `${origin}/preflight`: return { status: 200, set_cookies: ['csrf=fake; Path=/'] };
        case `${origin}/login`:
          return headers.Cookie === 'csrf=fake'
            ? { status: 200, set_cookies: ['sid=authenticated; Path=/'] }
            : { status: 403 };
        case `${origin}/results`: return { status: headers.Cookie?.includes('sid=authenticated') ? 200 : 403 };
        default: throw new Error('Unexpected route');
      }
    },
  });
  const client = makeClient(host);
  client.raw('/preflight');
  assert.equal(client.request('/results').status, 200);
  assert.deepEqual(host.calls.map(({ url }) => url), [`${origin}/preflight`, `${origin}/login`, `${origin}/results`]);
});

test('a fresh invocation renews an expired login cookie while an auxiliary cookie survives', () => {
  let time = 1_700_000_000_000;
  const options = {
    now: () => time,
    fetch(url, { headers }) {
      switch (url) {
        case `${origin}/login`: return { status: 200, set_cookies: ['csrf=fake; Path=/', 'sid=authenticated; Path=/; Max-Age=2'] };
        case `${origin}/results`: return { status: headers.Cookie?.includes('sid=authenticated') ? 200 : 403 };
        default: throw new Error('Unexpected route');
      }
    },
  };
  const initial = loadRuntime(options);
  assert.equal(makeClient(initial, { authCookies: ['sid'] }).request('/results').status, 200);

  const beforeExpiry = loadRuntime({ ...options, store: initial.store });
  assert.equal(makeClient(beforeExpiry, { authCookies: ['sid'] }).request('/results').status, 200);
  assert.deepEqual(beforeExpiry.calls.map(({ url }) => url), [`${origin}/results`]);

  time += 2_000;
  const afterExpiry = loadRuntime({ ...options, store: initial.store });
  assert.equal(makeClient(afterExpiry, { authCookies: ['sid'] }).request('/results').status, 200);
  assert.deepEqual(afterExpiry.calls.map(({ url }) => url), [`${origin}/login`, `${origin}/results`]);
  assert.equal(afterExpiry.calls[0].options.headers.Cookie, 'csrf=fake');
});

test('the expiry of an auxiliary cookie does not refresh a valid declared login cookie', () => {
  let time = 1_700_000_000_000;
  const options = {
    now: () => time,
    fetch(url, { headers }) {
      switch (url) {
        case `${origin}/login`: return {
          status: 200,
          set_cookies: ['helper=fake; Path=/; Max-Age=1', 'sid=authenticated; Path=/; Max-Age=30'],
        };
        case `${origin}/results`: return { status: 200, body: headers.Cookie };
        default: throw new Error('Unexpected route');
      }
    },
  };
  const initial = loadRuntime(options);
  assert.equal(makeClient(initial, { authCookies: ['sid'] }).request('/results').body, 'helper=fake; sid=authenticated');

  time += 1_000;
  const next = loadRuntime({ ...options, store: initial.store });
  assert.equal(makeClient(next, { authCookies: ['sid'] }).request('/results').body, 'sid=authenticated');
  assert.deepEqual(next.calls.map(({ url }) => url), [`${origin}/results`]);
});

test('cookies scope to normalized paths and matching domains and expire by Max-Age or Expires', () => {
  let time = 1_700_000_000_000;
  const host = loadRuntime({
    now: () => time,
    fetch(url, options) {
      if (url === `${origin}/members/login`) {
        return {
          status: 200,
          set_cookies: [
            'sid=parent; Domain=.example.test; Path=/; Secure',
            'sid=members; Path=/members; Max-Age=2; Expires=Wed, 01 Jan 2020 00:00:00 GMT',
            'local=default-path',
            'other=forbidden; Domain=outside.test; Path=/',
            'public=forbidden; Domain=test; Path=/',
            'old=forbidden; Expires=Wed, 01 Jan 2020 00:00:00 GMT; Path=/',
            'dated=valid; Expires=Tue, 14 Nov 2023 22:13:23 GMT; Path=/',
          ],
        };
      }
      if (url === `${origin}/members/forget`) {
        return { status: 200, set_cookies: ['local=deleted; Path=/members; Max-Age=0'] };
      }
      return { status: 200, body: options.headers.Cookie || '' };
    },
  });
  const client = makeClient(host);
  client.raw('/members/login');
  assert.equal(client.raw('/members/list').body, 'sid=members; local=default-path; sid=parent; dated=valid');
  assert.equal(client.raw('/membership').body, 'sid=parent; dated=valid');
  assert.equal(client.raw('/members/%2e%2E/public').body, 'sid=parent; dated=valid');
  assert.equal(host.calls.at(-1).url, `${origin}/public`);
  time += 2_000;
  assert.equal(client.raw('/members/list').body, 'local=default-path; sid=parent; dated=valid');
  client.raw('/members/forget');
  time += 1_000;
  assert.equal(client.raw('/members/list').body, 'sid=parent');

  const http = loadRuntime({
    fetch(url, { headers }) {
      return url.endsWith('/login')
        ? { status: 200, set_cookies: ['secure=fake; Secure; Path=/', 'ordinary=fake; Path=/'] }
        : { status: 200, body: headers.Cookie || '' };
    },
  });
  assert.equal(makeClient(http, { origin: 'http://video.example.test' }).request('/results').body, 'ordinary=fake');
});

test('credential changes invalidate stored cookies, and clearing drops the current session', () => {
  let logins = 0;
  const options = {
    fetch(url, { headers }) {
      return url.endsWith('/login')
        ? { status: 200, set_cookies: [`sid=fake-${++logins}; Path=/`] }
        : { status: 200, body: headers.Cookie };
    },
  };
  const first = loadRuntime(options);
  assert.equal(makeClient(first).request('/results').body, 'sid=fake-1');
  const second = loadRuntime({ ...options, store: first.store });
  const changedPassword = makeClient(second, { password: 'fake-secret-b' });
  assert.equal(changedPassword.request('/results').body, 'sid=fake-2');
  const changedUser = makeClient(second, { username: 'fake-other-user', password: 'fake-secret-b' });
  assert.equal(changedUser.request('/results').body, 'sid=fake-3');
  const saved = JSON.stringify([...second.store]);
  assert.doesNotMatch(saved, /fake-secret|fake-other-user|fake-user|fake-1|fake-2/);
  assert.match(saved, /[a-f0-9]{64}/);
  changedUser.clear();
  assert.equal(second.store.size, 0);
  assert.equal(changedUser.request('/results').body, 'sid=fake-4');
});

test('site requests refuse foreign paths and disable automatic redirects', () => {
  const host = loadRuntime({
    fetch: () => ({ status: 302, headers: { location: 'https://outside.test/collect' } }),
  });
  const client = makeClient(host);
  for (const path of ['https://outside.test/x', `${origin}/safe`, '//outside.test/x', '/\\outside.test/x', '/\n/x']) {
    assert.throws(() => client.request(path), { message: 'Invalid site request path' });
  }
  assert.deepEqual(host.calls, []);
  assert.equal(client.raw('/start', {
    url: 'https://outside.test/collect',
    follow_redirects: true,
    headers: { cookie: 'fake-manual-cookie', Accept: 'application/json' },
  }).status, 302);
  assert.deepEqual(host.calls, [{ url: `${origin}/start`, options: {
    headers: { Accept: 'application/json' }, follow_redirects: false,
  } }]);
});

test('oversized cookie collections stay within the storage budget', () => {
  const host = loadRuntime({
    fetch(url, { headers }) {
      if (url.endsWith('/login')) return {
        status: 200,
        set_cookies: [
          `oversized=${'o'.repeat(5_000)}; Path=/`,
          ...Array.from({ length: 100 }, (_, index) => `sample-${index}=${'x'.repeat(900)}; Path=/`),
        ],
      };
      return { status: 200, body: headers.Cookie || '' };
    },
  });
  const body = makeClient(host).request('/results').body;
  assert.ok(body.includes('sample-99='));
  assert.doesNotMatch(body, /oversized=|sample-0=/);
  assert.ok(Buffer.byteLength(JSON.stringify([...host.store])) < 64 * 1_024);
});

test('JSON responses raise fixed errors without leaking response bodies', () => {
  const { MP } = loadRuntime();
  assert.ok(MP, 'The shared runtime exposes MP');
  assert.deepEqual(plain(MP.json({ status: 200, body: '{"count":2}' })), { count: 2 });
  assert.throws(() => MP.json({ status: 200, body: 'private details' }), { message: 'Invalid site response' });
  for (const [status, message] of [[401, 'Site authentication failed'], [403, 'Site access denied'], [429, 'Site rate limit exceeded'], [500, 'Site request failed']]) {
    assert.throws(() => MP.json({ status, body: 'private details' }), { message });
  }
});

test('normalizes real magnet and 115 formats and rejects malformed lookalikes', () => {
  const { MP } = loadRuntime();
  assert.ok(MP, 'The shared runtime exposes MP');
  assert.equal(MP.magnet(` ${magnet.replace('&', '&amp;')} `), magnet);
  assert.equal(MP.magnet('magnet:?xt=URN%3ABTIH%3AABCDEFGHIJKLMNOPQRSTUVWXYZ234567'), 'magnet:?xt=URN%3ABTIH%3AABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
  for (const malformed of [`magnet:?xt=urn:btih:${btih}a`, 'magnet:?xt=urn:btih:short', `https://outside.test/?xt=urn:btih:${btih}`, 'magnet:?xt=%ZZ']) {
    assert.equal(MP.magnet(malformed), '');
  }
  assert.deepEqual(plain(MP.share115('https://115.com/s/sdemo12?password=abcd')), {
    share_link: 'https://115.com/s/sdemo12', share_code: 'abcd',
  });
  assert.deepEqual(plain(MP.share115('https://115cdn.com/s/sdemo12?password=abcd', 'wxyz')), {
    share_link: 'https://115cdn.com/s/sdemo12', share_code: 'wxyz',
  });
  assert.deepEqual(plain(MP.share115('https://115.com/s/sdemo12')), {
    share_link: 'https://115.com/s/sdemo12', share_code: '',
  });
  for (const malformed of ['https://115.com.outside.test/s/sdemo12', 'https://115.com@outside.test/s/sdemo12', 'https://115.com/s/', 'https://115.com/file/sdemo12', 'https://115.com/s/%2f', 'https://115.com/s/sdemo12?password=%ZZ']) {
    assert.equal(MP.share115(malformed), null);
  }
});

test('HTML helpers extract links, copy-button resources and adjacent access codes', () => {
  const { MP } = loadRuntime();
  assert.ok(MP, 'The shared runtime exposes MP');
  const tag = '<a HREF="https://115.com/s/sdemo12?password=abcd&amp;from=demo" class=resource download>';
  assert.deepEqual(plain(MP.attrs(tag)), {
    href: 'https://115.com/s/sdemo12?password=abcd&from=demo', class: 'resource', download: '',
  });
  assert.equal(MP.text('<b>演&#x793A;</b>&nbsp;&amp;&nbsp;<i>demo</i>'), '演示 & demo');
  assert.deepEqual(plain(MP.links(`${tag}<strong>蓝光 &amp; 4K</strong></a>`)), [{
    href: 'https://115.com/s/sdemo12?password=abcd&from=demo', text: '蓝光 & 4K',
    attrs: { href: 'https://115.com/s/sdemo12?password=abcd&from=demo', class: 'resource', download: '' },
  }]);
  assert.equal(MP.links('<a href=https://115.com/s/sdemo12?password=abcd>蓝光</a>')[0].href,
    'https://115.com/s/sdemo12?password=abcd');
  assert.deepEqual(plain(MP.extract(`<p><a href="https://115.com/s/sdemo12">蓝光</a> 提取码：abcd</p>
    <button data-clipboard-text="${magnet.replace('&', '&amp;')}">磁力</button>
    <script>const url = 'https://115.com/s/unrelated'</script>`)), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: '蓝光' },
    { type: 'magnet', url: magnet, code: '', label: '磁力' },
  ]);
});

test('extracting the same URL from a link label retains its access code once', () => {
  const { MP } = loadRuntime();
  assert.deepEqual(plain(MP.extract('<p><a href="https://115.com/s/sdemo12">https://115.com/s/sdemo12</a> 提取码：abcd</p>')), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: 'https://115.com/s/sdemo12' },
  ]);
  assert.equal(MP.extract('<p><a href="https://115.com/s/sdemo12?password=abcd">蓝光</a> 提取码：wxyz</p>')[0].code, 'abcd');
  assert.deepEqual(plain(MP.extract('<div><a href="https://115.com/s/sdemo12?password=abcd"><span>蓝光</span></a><span class="pan-link-meta">https://115.com/s/sdemo12</span></div>')), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: '蓝光' },
  ]);
});

test('plain shares keep access codes split across inline tags and stop at block boundaries', () => {
  const { MP } = loadRuntime();
  assert.deepEqual(plain(MP.extract(`<p><span>https://115.com/s/sdemo12</span>，<i>提取码：</i><b>abcd</b></p>
    <p>https://115.com/s/sdemo34</p><p>提取码：wxyz</p>`)), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: '' },
    { type: '115', url: 'https://115.com/s/sdemo34', code: '', label: '' },
  ]);
});

test('the code in a link wins over its repeated label and separately explicit codes remain', () => {
  const { MP } = loadRuntime();
  assert.deepEqual(plain(MP.extract(`<p><a href="https://115.com/s/sdemo12?password=abcd">https://115.com/s/sdemo12</a> 提取码：wxyz</p>
    <p><a href="https://115.com/s/sdemo12" data-password="efgh">另一版本</a></p>`)), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: 'https://115.com/s/sdemo12' },
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'efgh', label: '另一版本' },
  ]);
});

test('a displayed share URL supplies the code when its matching href is uncoded', () => {
  const { MP } = loadRuntime();
  assert.deepEqual(plain(MP.extract(`<p><a href="https://115.com/s/sdemo12"><span>https://115.com/s/sdemo12?password=abcd</span></a> 提取码：wxyz</p>`)), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: 'https://115.com/s/sdemo12?password=abcd' },
  ]);
});

test('commas and semicolons inside plain share query values preserve later passcodes', () => {
  const { MP } = loadRuntime();
  assert.deepEqual(plain(MP.extract(`<p>https://115.com/s/sdemo12?title=a,b&amp;password=abcd</p>
    <p>https://115.com/s/sdemo34?title=a;b&amp;password=wxyz</p>
    <p>https://115.com/s/sdemo56, 提取码：efgh</p>`)), [
    { type: '115', url: 'https://115.com/s/sdemo12', code: 'abcd', label: '' },
    { type: '115', url: 'https://115.com/s/sdemo34', code: 'wxyz', label: '' },
    { type: '115', url: 'https://115.com/s/sdemo56', code: 'efgh', label: '' },
  ]);
});

test('resource validators reject invalid escapes in bare query components', () => {
  const { MP } = loadRuntime();
  assert.equal(MP.magnet(`${magnet}&bare%QX`), '');
  assert.equal(MP.share115('https://115.com/s/sdemo12?password=abcd&bare%QX'), null);
  assert.equal(MP.magnet(`${magnet}&bare%20optional`), `${magnet}&bare%20optional`);
});

test('limits respect both requested and configured caps and a nullable time budget', () => {
  const { MP } = loadRuntime({ settings: { result_limit: '99' }, remainingMs: 1200 });
  assert.ok(MP, 'The shared runtime exposes MP');
  assert.equal(MP.limit({}), 20);
  assert.equal(MP.limit({ limit: 2.9 }), 2);
  assert.equal(MP.limit({ limit: 175 }), 20);
  assert.equal(MP.limit({ limit: 0 }), 0);
  assert.equal(MP.limit({ limit: -1 }), 1);
  assert.equal(MP.hasTime(1200), true);
  assert.equal(MP.hasTime(1201), false);
  const defaults = loadRuntime().MP;
  assert.equal(defaults.limit({ limit: Infinity }), 5);
  assert.equal(defaults.limit({ limit: 9 }), 5);
  assert.equal(defaults.hasTime(1201), true);
  assert.equal(loadRuntime({ settings: { result_limit: 0 } }).MP.limit({}), 1);
});

test('selection tokens round-trip JSON metadata and reject malformed or secret fields', () => {
  const { MP } = loadRuntime();
  assert.ok(MP, 'The shared runtime exposes MP');
  const metadata = { id: 'source-22', title: '测试 🎞', type: '115' };
  const value = MP.token(metadata);
  assert.match(value, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(value, /source-22/);
  assert.deepEqual(plain(MP.untoken(value)), metadata);
  assert.equal(MP.untoken('not-a-valid-token'), null);
  assert.equal(MP.untoken(`${value}!`), null);
  assert.equal(MP.token({ id: '22', nested: { share_code: 'abcd' } }), '');
});

test('selection token encoding and decoding reject nested access credentials', () => {
  const { MP } = loadRuntime();
  for (const key of ['token', 'access_ticket', 'access_code', 'session', 'AccessTicket', 'access-code']) {
    const metadata = { id: 'source-22', fields: [{ [key]: 'fake-private-value' }] };
    const supplied = `v1_${Buffer.from(JSON.stringify(metadata)).toString('base64url')}`;
    assert.equal(MP.token(metadata), '', `encoder rejects ${key}`);
    assert.equal(MP.untoken(supplied), null, `decoder rejects ${key}`);
  }
});

test('build compiles standalone entries and copies only their manifest and readme', async () => {
  const ids = ['balge.miniyingshi', 'balge.woniu', 'balge.jying'];
  const root = mkdtempSync(join(tmpdir(), 'muvyo-build-'));
  try {
    mkdirSync(join(root, 'src/shared'), { recursive: true });
    writeFileSync(join(root, 'src/shared/runtime.js'), 'var MP = { runtime: true };');
    for (const id of ids) {
      const path = join(root, 'src', id);
      mkdirSync(path);
      writeFileSync(join(path, 'main.js'), `function search() { return MP.runtime && ${JSON.stringify(id)}; }`);
      writeFileSync(join(path, 'manifest.json'), JSON.stringify({ id }));
      writeFileSync(join(path, 'README.md'), `# ${id}\n`);
      writeFileSync(join(path, 'local-test-input.txt'), 'a transient test file');
    }

    const { build } = await import('../scripts/build.mjs');
    build(root);
    for (const id of ids) {
      const dist = join(root, 'dist', id);
      assert.deepEqual(readdirSync(dist).sort(), ['README.md', 'main.js', 'manifest.json']);
      const entry = readFileSync(join(dist, 'main.js'), 'utf8');
      assert.equal(runInNewContext(`${entry}\nsearch()`, { mv: {} }), id);
      assert.equal(readFileSync(join(dist, 'manifest.json'), 'utf8'), JSON.stringify({ id }));
      assert.equal(readFileSync(join(dist, 'README.md'), 'utf8'), `# ${id}\n`);
    }
    const first = readFileSync(join(root, 'dist', ids[0], 'main.js'), 'utf8');
    build(root);
    assert.equal(readFileSync(join(root, 'dist', ids[0], 'main.js'), 'utf8'), first);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Diagnostics must never replace the client's fixed public error with private host text.
test('transport diagnostic hooks cannot expose raw errors even if the hook fails', () => {
  const host = loadRuntime({ fetch() { throw new Error('private-upstream-cookie'); } });
  const client = makeClient(host, { onFetchError() { throw new Error('private-hook-value'); } });
  assert.throws(() => client.raw('/results'), { message: 'Site request failed' });
});
