import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadPlugin } from './host.mjs';

const origin = 'https://www.jying.top';
const query = { keyword: '流浪地球' };
const settings = { username: 'fixture-user', password: 'fixture&password' };
const csrfPath = '/api/csrf/';
const loginPath = '/api/app/login/';
const csrf = 'fixturecsrfvalue';
const appToken = 'fixture-app-token';
const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
const share = 'https://115cdn.com/s/fixture';
const searchPath = (size, page = 1) => '/api/app/movies/?q=%E6%B5%81%E6%B5%AA%E5%9C%B0%E7%90%83&page=' + page + '&page_size=' + size;
const listPath = (size, page = 1, id = 379) => '/api/app/movie/' + id + '/resources/?page=' + page + '&page_size=' + size;
const accessPath = id => '/api/app/resource/' + id + '/access/';
const api = (body, extra = {}) => ({ status: 200, body: JSON.stringify(body), ...extra });
const csrfResponse = api({ status: 'success' }, { set_cookies: ['csrftoken=' + csrf + '; Path=/; Secure; SameSite=Lax'] });
const loginResponse = api({ status: 'success', token: appToken, user: { id: 17 } });
const movie = (id = 379, extra) => ({
  id, title: '流浪地球', tmdb_id: 535167, tmdb_media_type: 'movie', movie_type: 'movie',
  release_year: 2019, resource_count: 50, netdisk_count: 28, magnet_count: 22,
  is_private: false, private_price: 0, ...extra,
});
const movies = (results = [movie()], more = false) => api({
  status: 'success', page: 1, page_size: 5, total_pages: more ? 2 : 1, total_count: results.length,
  count: results.length, has_more: more, next_cursor: null, results, applied_preferences: {},
});
const resource = (id, type = '115', extra) => ({
  id, resource_type: type, title: '版本 ' + id, resource_description: '资源简介',
  description: '', file_size: '2.11 GB', resolution: '2160p',
  access_code: '', extraction_code: '', share_link: '',
  link_exposed: true, access_ticket: 'fixture-ticket-' + id,
  access_endpoint: accessPath(id), requires_purchase: false, private_price: 0, ...extra,
});
const resources = (rows, more = false) => api({
  status: 'success', movie: movie(), resources: rows, page: 1, page_size: 5,
  total_count: rows.length, has_more: more, applied_preferences: {},
});
const access = (id, target, code = '') => api({
  status: 'success', resource: { id }, access_mode: 'open', target, access_code: code, expires_in: 60,
});

function site(handler, options = {}) {
  return loadPlugin('balge.jying', {
    ...options,
    settings: { ...settings, ...options.settings },
    fetch(url, input) {
      assert.ok(url.startsWith(origin + '/'));
      assert.equal(input.proxy, false);
      assert.equal(input.follow_redirects, false);
      const path = url.slice(origin.length);
      if (path === loginPath) {
        assert.equal(input.method, 'POST');
        assert.equal(input.headers['X-CSRFToken'], csrf);
        assert.equal(input.headers['X-Requested-With'], 'XMLHttpRequest');
        assert.match(input.headers.Cookie, new RegExp('csrftoken=' + csrf));
        assert.deepEqual(JSON.parse(input.body), {
          username: options.settings?.username ?? settings.username,
          password: options.settings?.password ?? settings.password,
        });
      }
      const response = handler(path, input);
      if (response) return response;
      if (path === csrfPath) return csrfResponse;
      if (path === loginPath) return loginResponse;
      throw new Error('Unexpected path ' + path);
    },
  });
}

const paths = plugin => plugin.calls.map(({ url }) => url.slice(origin.length));

test('Jying emits metadata-only items, rereads selected rows and uses fresh tickets', () => {
  let lists = 0;
  const plugin = site((path, input) => {
    if (path === searchPath(2)) {
      assert.equal(input.headers['X-App-User-Token'], appToken);
      return movies();
    }
    if (path === listPath(2)) {
      lists++;
      return resources([
        resource(101, 'MagnetLink', { access_ticket: 'fresh-' + lists + '-101' }),
        resource(102, '115', { access_ticket: 'fresh-' + lists + '-102', access_endpoint: 'https://other.invalid/purchase/' }),
      ], true);
    }
    if (path === accessPath(102) || path === accessPath(101)) {
      const id = Number(path.split('/')[4]);
      assert.equal(input.method, 'POST');
      assert.equal(input.headers['X-CSRFToken'], csrf);
      assert.equal(input.headers['X-App-User-Token'], appToken);
      assert.deepEqual(JSON.parse(input.body), { access_ticket: 'fresh-' + lists + '-' + id });
      return id === 102 ? access(id, share, '1abc') : access(id, magnet);
    }
  });
  const items = plugin.search({ ...query, limit: 2 }).items;
  assert.deepEqual(Array.from(items, item => item.link_type), ['magnet', '115']);
  assert.equal(items[1].tmdb_id, 535167);
  assert.equal(items[1].media_title, '流浪地球');
  assert.equal(items[1].url, origin + '/movie/379');
  assert.ok(items.every(item => item.resolve_token && !item.magnets && !item.share_link));
  assert.doesNotMatch(JSON.stringify(plugin.MP.untoken(items[1].resolve_token)), /fresh|csrf|token|1abc/i);
  assert.deepEqual(paths(plugin), [csrfPath, loginPath, searchPath(2), listPath(2)]);

  const shareResult = plugin.resolve({ token: items[1].resolve_token });
  assert.equal(shareResult.share_link, share);
  assert.equal(shareResult.share_code, '1abc');
  assert.equal(plugin.resolve({ token: items[0].resolve_token }).magnets[0], magnet);
  assert.equal(paths(plugin).filter(path => path === listPath(2)).length, 3);
  assert.equal(paths(plugin).filter(path => path === loginPath).length, 1);
  assert.deepEqual(paths(plugin).filter(path => path.includes('/access/')), [accessPath(102), accessPath(101)]);
});

test('Jying ignores hidden, unavailable or paid rows and accepts explicitly owned positive-price rows', () => {
  const plugin = site(path => {
    if (path === searchPath(5)) return movies();
    if (path === listPath(5)) return resources([
      resource(1, '115', { requires_purchase: true }),
      resource(2, '115', { link_exposed: false, share_link: share }),
      resource(3, '115', { private_price: '3.00', requires_purchase: undefined }),
      resource(4, '115', { private_price: '3.00', requires_purchase: false }),
      resource(5, '115', { access_ticket: '' }),
    ]);
    if (path === accessPath(4)) return access(4, share + '?password=6abc');
  });
  const items = plugin.search(query).items;
  assert.deepEqual(Array.from(items, item => item.title), ['版本 4']);
  assert.equal(items[0].cost, 0);
  assert.equal(plugin.resolve({ token: items[0].resolve_token }).share_code, '6abc');
  assert.ok(!paths(plugin).some(path => path.includes('purchase')));
});

test('Jying rejects malformed links and rows that become unavailable before resolution', () => {
  let resourceReads = 0;
  let mode = 'invalid-link';
  const plugin = site(path => {
    if (path === searchPath(5)) return movies();
    if (path === listPath(5)) {
      resourceReads++;
      return resources([resource(33, '115', {
        requires_purchase: resourceReads > 2 && mode === 'paywall',
      })]);
    }
    if (path === accessPath(33)) return access(33, 'https://115.com.evil.invalid/s/false');
  });
  const token = plugin.search(query).items[0].resolve_token;
  assert.equal(plugin.resolve({ token }).error.kind, 'rejected');
  mode = 'paywall';
  assert.equal(plugin.resolve({ token }).error.kind, 'rejected');
  assert.equal(paths(plugin).filter(path => path === accessPath(33)).length, 1);
});

test('Jying keeps page sizes stable and resolves a later-page row without scanning earlier pages', () => {
  const plugin = site(path => {
    if (path === searchPath(2)) return movies();
    if (path === listPath(2)) return resources([resource(1, '115'), resource(2, '123')], true);
    if (path === listPath(2, 2)) return resources([resource(3, '115'), resource(4, 'MagnetLink')], true);
    if (path === accessPath(4)) return access(4, magnet);
  });
  const items = plugin.search({ ...query, limit: 2 }).items;
  assert.deepEqual(Array.from(items, item => item.link_type).sort(), ['115', 'magnet']);
  assert.deepEqual(paths(plugin), [csrfPath, loginPath, searchPath(2), listPath(2), listPath(2, 2)]);
  assert.equal(plugin.resolve({ token: items.find(item => item.link_type === 'magnet').resolve_token }).magnets[0], magnet);
  assert.equal(paths(plugin).filter(path => path === listPath(2)).length, 1);
  assert.equal(paths(plugin).filter(path => path === listPath(2, 2)).length, 2);
});

test('Jying default, configured and query caps set upstream page sizes and stop reading at the combined cap', () => {
  function evaluate(configured, queryLimit, expected) {
    const plugin = site(path => {
      if (path === searchPath(expected)) return movies([movie(), movie(380)], true);
      if (path === listPath(expected)) {
        return resources(Array.from({ length: expected }, (_, index) => resource(index + 1, index === 1 ? 'MagnetLink' : '115')), true);
      }
    }, { settings: { result_limit: configured } });
    const result = plugin.search({ ...query, limit: queryLimit });
    assert.equal(result.items.length, expected);
    assert.deepEqual(paths(plugin), [csrfPath, loginPath, searchPath(expected), listPath(expected)]);
    if (expected > 1) assert.ok(result.items.some(item => item.link_type === 'magnet'));
  }
  evaluate(undefined, undefined, 5);
  evaluate('25', undefined, 20);
  evaluate('20', 2, 2);
  evaluate('1', undefined, 1);
});

test('Jying first-page empties and empty user-selected type intersections stop early', () => {
  const plugin = site(path => path === searchPath(5) ? movies([]) : undefined, { settings: { resource_types: 'magnet' } });
  assert.equal(plugin.search({ ...query, link_types: ['115'] }).items.length, 0);
  assert.equal(plugin.search({ ...query, limit: 0 }).items.length, 0);
  assert.equal(plugin.calls.length, 0);
  assert.equal(plugin.search(query).items.length, 0);
  assert.deepEqual(paths(plugin), [csrfPath, loginPath, searchPath(5)]);
});

test('Jying saves refreshed auth tokens privately and invalidates them when account settings change', () => {
  const store = new Map();
  const rotated = 'fixture-rotated-token';
  const first = site((path, input) => {
    if (path === searchPath(5)) return { ...movies(), headers: { 'x-refreshed-token': rotated } };
    if (path === listPath(5)) {
      assert.equal(input.headers['X-App-User-Token'], rotated);
      return resources([]);
    }
  }, { store });
  assert.equal(first.search(query).items.length, 0);
  assert.doesNotMatch(JSON.stringify([...store]), /fixture-user|fixture&password/);
  const reused = site((path, input) => {
    if (path === searchPath(5)) {
      assert.equal(input.headers['X-App-User-Token'], rotated);
      return movies([]);
    }
  }, { store });
  assert.equal(reused.search(query).items.length, 0);
  assert.deepEqual(paths(reused), [searchPath(5)]);
  const changed = site((path, input) => {
    if (path === searchPath(5)) {
      assert.equal(input.headers['X-App-User-Token'], appToken);
      return movies([]);
    }
  }, { store, settings: { password: 'another-fixture-password' } });
  assert.equal(changed.search(query).items.length, 0);
  assert.deepEqual(paths(changed), [csrfPath, loginPath, searchPath(5)]);
});

test('Jying refreshes only once on HTTP 401 and never automatically logs in again on 403 or 429', () => {
  let reads = 0;
  const recovered = site(path => path === searchPath(5) ? ++reads === 1 ? { status: 401 } : movies([]) : undefined);
  assert.equal(recovered.search(query).items.length, 0);
  assert.deepEqual(paths(recovered), [csrfPath, loginPath, searchPath(5), csrfPath, loginPath, searchPath(5)]);

  const repeated = site(path => path === searchPath(5) ? { status: 401 } : undefined);
  assert.throws(() => repeated.search(query), /登录/);
  assert.deepEqual(paths(repeated), [csrfPath, loginPath, searchPath(5), csrfPath, loginPath, searchPath(5)]);
  for (const [status, message] of [[403, /拒绝/], [429, /受限/]]) {
    const denied = site(path => path === searchPath(5) ? { status } : undefined);
    assert.throws(() => denied.search(query), message);
    assert.deepEqual(paths(denied), [csrfPath, loginPath, searchPath(5)]);
  }
});

test('Jying preserves gathered results when refreshing a 401 leaves too little time to replay', () => {
  let time = 9000;
  let logins = 0;
  const plugin = site(path => {
    if (path === loginPath && ++logins === 2) time = 1100;
    if (path === searchPath(5)) return movies([movie(), movie(380)]);
    if (path === listPath(5)) return resources([resource(1)]);
    if (path === listPath(5, 1, 380)) return { status: 401 };
  }, { remainingMs: () => time });
  const result = plugin.search(query);
  assert.equal(result.partial, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(paths(plugin), [csrfPath, loginPath, searchPath(5), listPath(5), listPath(5, 1, 380), csrfPath, loginPath]);
});

test('Jying clamps elapsed budgets before authentication steps and stops after 30 actual requests', () => {
  let time = 6000;
  const early = site(path => {
    if (path === csrfPath) time = 1100;
  }, { remainingMs: () => time });
  assert.equal(early.search(query).partial, true);
  assert.deepEqual(paths(early), [csrfPath]);

  const exhausted = site(path => {
    if (path === searchPath(5)) return movies();
    if (path.includes('/resources/')) return resources([resource(1, '123')], true);
  });
  assert.equal(exhausted.search(query).partial, true);
  assert.equal(exhausted.calls.length, 30);
});

test('Jying validates selection IDs, page metadata and account settings before dispatch', () => {
  const plugin = site(() => undefined);
  for (const token of [
    'invalid',
    plugin.MP.token({ type: '115', movieId: '../purchase', resourceId: 7, page: 1, pageSize: 5 }),
    plugin.MP.token({ type: 'magnet', movieId: 1, resourceId: 7, page: 31, pageSize: 5 }),
    plugin.MP.token({ type: 'magnet', movieId: 1, resourceId: 7, page: 1, pageSize: 21 }),
  ]) assert.equal(plugin.resolve({ token }).error.kind, 'rejected');
  assert.equal(plugin.calls.length, 0);
  const missing = site(() => undefined, { settings: { password: '' } });
  assert.throws(() => missing.search(query), /账号/);
  assert.equal(missing.calls.length, 0);
});

test('Jying declares the canonical origin and required result-limit setting', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/balge.jying/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions.domains, ['www.jying.top']);
  assert.deepEqual(manifest.capabilities.search.link_types, ['115', 'magnet']);
  assert.equal(manifest.capabilities.search.resolve, true);
  assert.equal(manifest.config.find(config => config.key === 'password').type, 'secret');
  assert.deepEqual(manifest.config.find(config => config.key === 'result_limit'), {
    key: 'result_limit', label: '每次获取数量', type: 'number', min: 1, max: 20, step: 1, unit: '条', default: '5',
  });
});

test('Jying reauthenticates a selected access request with a newly read ticket', () => {
  let lists = 0;
  let attempts = 0;
  const plugin = site((path, input) => {
    if (path === searchPath(5)) return movies();
    if (path === listPath(5)) return resources([resource(1, '115', { access_ticket: 'current-' + ++lists })]);
    if (path === accessPath(1)) {
      assert.deepEqual(JSON.parse(input.body), { access_ticket: 'current-' + lists });
      return ++attempts === 1 ? { status: 401 } : access(1, share);
    }
  });
  const token = plugin.search(query).items[0].resolve_token;
  assert.equal(plugin.resolve({ token }).share_link, share);
  assert.equal(lists, 3);
  assert.equal(attempts, 2);
  assert.equal(paths(plugin).filter(path => path === loginPath).length, 2);
});

test('Jying uses the CSRF cookie rotated by login before a cold selected access', () => {
  const rotated = 'fixturecsrfrotated';
  const plugin = site((path, input) => {
    if (path === loginPath) {
      return { ...loginResponse, set_cookies: ['csrftoken=' + rotated + '; Path=/; Secure'] };
    }
    if (path === listPath(5)) return resources([resource(1)]);
    if (path === accessPath(1)) {
      assert.equal(input.headers['X-CSRFToken'], rotated);
      assert.match(input.headers.Cookie, new RegExp('csrftoken=' + rotated));
      return access(1, share);
    }
  });
  const token = plugin.MP.token({ type: '115', movieId: 379, resourceId: 1, page: 1, pageSize: 5 });
  assert.equal(plugin.resolve({ token }).share_link, share);
  assert.deepEqual(paths(plugin), [csrfPath, loginPath, listPath(5), accessPath(1)]);
});

test('Jying prefers a current target passcode to an older listing passcode', () => {
  const plugin = site(path => {
    if (path === listPath(5)) return resources([resource(1, '115', { extraction_code: 'old1' })]);
    if (path === accessPath(1)) return access(1, share + '?password=new1');
  });
  const token = plugin.MP.token({ type: '115', movieId: 379, resourceId: 1, page: 1, pageSize: 5 });
  assert.equal(plugin.resolve({ token }).share_code, 'new1');
});
