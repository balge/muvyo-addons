import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadPlugin } from './host.mjs';

const id = 'balge.miniyingshi';
const origin = 'https://www.miniyingshi.com';
const query = { keyword: '测试作品' };
const title = { id: 'Movie1', title: '测试作品', mediaType: 1, year: 2025, torrentCount: 3, netdiskShareCount: 2 };
const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=Example';
const duplicateMagnet = 'magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=Duplicate';
const success = (data, extra = {}) => ({ status: 200, body: JSON.stringify({ code: 0, data }), ...extra });
const login = () => success({}, { set_cookies: ['mys_at=fixture-session; Path=/; HttpOnly; Secure'] });
const paths = ({ calls }) => calls.map(call => new URL(call.url).pathname);
const plain = value => JSON.parse(JSON.stringify(value));

function plugin(routes = {}, settings = {}, extra = {}) {
  return loadPlugin(id, {
    ...extra,
    settings: { username: 'fixture@example.test', password: 'fixture-secret', ...settings },
    fetch(url, options) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, origin);
      assert.equal(options.follow_redirects, false);
      if (parsed.pathname === '/api/auth/login' && !Object.hasOwn(routes, parsed.pathname)) {
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), { email: 'fixture@example.test', password: 'fixture-secret' });
        return login();
      }
      assert.ok(Object.hasOwn(routes, parsed.pathname), `Unexpected route ${parsed.pathname}`);
      const route = routes[parsed.pathname];
      return typeof route === 'function' ? route(parsed, options) : route;
    },
  });
}

const searchPage = (list, total = list.length) => success({ list, pagination: { page: 1, total }, fallback: 0 });
const routes = {
  '/api/search/titles': url => {
    assert.equal(url.searchParams.get('q'), query.keyword);
    return searchPage([title]);
  },
  '/api/titles/Movie1/torrents': success({ tabs: [], items: [
    { id: 'Direct1', kind: 1, name: 'Direct 2160p', sizeBytes: 12345, magnet },
    { id: 'Dupe01', kind: 1, name: 'Duplicate', magnet: duplicateMagnet },
    { id: 'Group1', kind: 2, name: 'Grouped', torrentCount: 2 },
  ] }),
  '/api/torrent-groups/Group1': success({
    group: { id: 'Group1', kind: 2, name: 'Grouped' }, title, torrents: [
      { id: 'Child1', name: 'Grouped 1080p', sizeBytes: 2048, episodeStart: 1, episodeEnd: 2, requiresLogin: true },
    ],
  }),
  '/api/titles/Movie1/netdisk-shares': success({ list: [
    { id: 'Other1', provider: 1, title: 'Unsupported' },
    { id: 'Share1', provider: 7, title: 'Share 2160p', requiresLogin: true },
  ] }),
};

test('search lists direct magnets, group members and deferred 115 shares with stable identities', () => {
  const site = plugin(routes);
  const { items } = site.search(query);
  assert.deepEqual(plain(items.map(item => [item.id, item.link_type])), [
    ['magnet:Direct1', 'magnet'], ['115:Share1', '115'], ['magnet:Child1', 'magnet'],
  ]);
  assert.equal(items[0].magnets[0], magnet);
  assert.equal(items[0].size_bytes, 12345);
  assert.equal(items[0].media_title, '测试作品');
  assert.equal(items[0].url, origin + '/torrent/Direct1');
  assert.equal(items[1].share_link, undefined);
  assert.equal(items[2].magnets, undefined);
  assert.equal(items[2].size_bytes, 2048);
  assert.deepEqual(Object.keys(plain(site.MP.untoken(items[1].resolve_token))).sort(), ['id', 'type']);
  assert.deepEqual(plain(site.MP.untoken(items[1].resolve_token)), { id: 'Share1', type: '115' });
  assert.deepEqual(plain(site.MP.untoken(items[2].resolve_token)), { id: 'Child1', type: 'magnet' });
  assert.ok(!paths(site).some(path => path.includes('/credential') || path.startsWith('/api/torrents/')));
  const repeated = site.search(query);
  assert.deepEqual(plain(repeated.items.map(({ id, resolve_token }) => [id, resolve_token])),
    plain(items.map(({ id, resolve_token }) => [id, resolve_token])));
  assert.equal(paths(site).filter(path => path === '/api/auth/login').length, 1);
});

test('resolve reads only the selected resource and preserves the independent 115 passcode', () => {
  const site = plugin({
    ...routes,
    '/api/netdisk-shares/Share1/credential': success({ id: 'Share1', shareURL: 'https://115.com/s/sharetest', accessCode: 'a1b2' }),
    '/api/torrents/Child1': success({ id: 'Child1', kind: 1, magnet, title, sizeBytes: 2048, fileList: [] }),
  });
  const { items } = site.search(query);
  const resumed = plugin({
    '/api/netdisk-shares/Share1/credential': success({ id: 'Share1', shareURL: 'https://115.com/s/sharetest?password=z9z9', accessCode: 'a1b2' }),
    '/api/torrents/Child1': success({ id: 'Child1', kind: 1, magnet, title, sizeBytes: 2048, fileList: [] }),
  }, {}, { store: site.store });
  assert.deepEqual(plain(resumed.resolve({ token: items[1].resolve_token })), {
    share_link: 'https://115.com/s/sharetest', share_code: 'a1b2',
  });
  assert.deepEqual(plain(resumed.resolve({ token: items[2].resolve_token })), { magnets: [magnet] });
  assert.deepEqual(paths(resumed), ['/api/netdisk-shares/Share1/credential', '/api/torrents/Child1']);
});

test('selection type intersects the module setting and no result means no site access', () => {
  const site = plugin(routes, { resource_types: '115' });
  assert.deepEqual(plain(site.search({ ...query, link_types: ['magnet'] })), { items: [] });
  assert.deepEqual(plain(site.search({ ...query, limit: 0 })), { items: [] });
  assert.equal(site.calls.length, 0);
  assert.deepEqual(plain(site.search({ ...query, link_types: ['115', 'magnet'] }).items.map(row => row.id)), ['115:Share1']);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/netdisk-shares']);
});

test('a two-item mixed result keeps both types without expanding an unneeded group', () => {
  const site = plugin(routes, { result_limit: '2' });
  assert.deepEqual(plain(site.search(query).items.map(row => row.id)), ['magnet:Direct1', '115:Share1']);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents', '/api/titles/Movie1/netdisk-shares']);
});

test('a tighter requested limit stops before reading the next resource type or title', () => {
  const site = plugin({
    ...routes,
    '/api/search/titles': searchPage([title, { ...title, id: 'Later1' }], 100),
  }, { result_limit: '20' });
  assert.deepEqual(plain(site.search({ ...query, limit: 1 }).items.map(row => row.id)), ['magnet:Direct1']);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents']);
});

test('mixed searches reserve a slot for another type on a later title page', () => {
  const site = plugin({
    '/api/search/titles': url => url.searchParams.get('page') === '2'
      ? searchPage([{ ...title, id: 'Later1', torrentCount: 0 }], 2)
      : searchPage([{ ...title, netdiskShareCount: 0 }], 2),
    '/api/titles/Movie1/torrents': success({ tabs: [], items: [
      { id: 'First1', kind: 1, name: 'First' }, { id: 'Twice2', kind: 1, name: 'Second' },
    ] }),
    '/api/titles/Later1/netdisk-shares': success({ list: [{ id: 'Share2', provider: 7, title: 'Second-page share' }] }),
  }, { result_limit: '2' });
  assert.deepEqual(plain(site.search(query).items.map(row => row.id)), ['magnet:First1', '115:Share2']);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents', '/api/search/titles', '/api/titles/Later1/netdisk-shares']);
});

test('default 5 and maximum 20 stop before an avoidable page, group or credential read', () => {
  const rows = Array.from({ length: 22 }, (_, index) => ({ id: `Share${index}`, provider: 7, title: `Share ${index}` }));
  const many = {
    '/api/search/titles': searchPage([{ ...title, torrentCount: 0 }], 50),
    '/api/titles/Movie1/netdisk-shares': success({ list: rows }),
  };
  for (const [settings, count] of [[{}, 5], [{ result_limit: '100' }, 20]]) {
    const site = plugin(many, { resource_types: '115', ...settings });
    const { items } = site.search({ ...query, limit: 50 });
    assert.equal(items.length, count);
    assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/netdisk-shares']);
  }
});

test('year, season and media type filter known title mismatches before reading resources', () => {
  const site = plugin({
    '/api/search/titles': searchPage([
      title,
      { ...title, id: 'ShowNo', mediaType: 2, seasonNumber: 1 },
      { ...title, id: 'YearNo', mediaType: 2, seasonNumber: 2, year: 2023 },
      { ...title, id: 'ShowOK', mediaType: 2, seasonNumber: 2 },
    ]),
    '/api/titles/ShowOK/torrents': success({ tabs: [], items: [{ id: 'Episode', kind: 1, name: 'TV cut', episodeStart: 3, episodeEnd: 5 }] }),
  }, { result_limit: '1' });
  const { items } = site.search({ ...query, media_type: 'tv', year: 2025, season: 2 });
  assert.equal(items[0].media_type, 'tv');
  assert.equal(items[0].season, 2);
  assert.deepEqual(plain(items[0].episodes), [3, 4, 5]);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/ShowOK/torrents']);
});

test('only a marked resource 403 invokes the frontend gate once with cookie reuse', () => {
  let attempts = 0;
  const site = plugin({
    ...routes,
    '/api/titles/Movie1/torrents': (_, { headers }) => {
      if (++attempts === 1) return { status: 403, headers: { 'x-mys-gate': 'required' }, body: '' };
      assert.match(headers.Cookie, /(?:^|; )mys_js=fixture-gate(?:;|$)/);
      return routes['/api/titles/Movie1/torrents'];
    },
    '/api/gate': (_, { method, body }) => {
      assert.equal(method, 'POST');
      assert.deepEqual(JSON.parse(body), {});
      return success(null, { set_cookies: ['mys_js=fixture-gate; Path=/; Secure'] });
    },
  }, { result_limit: '1' });
  assert.equal(site.search(query).items[0].id, 'magnet:Direct1');
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents', '/api/gate', '/api/titles/Movie1/torrents']);
  const denied = plugin({ ...routes, '/api/titles/Movie1/torrents': { status: 403, body: '' } }, { result_limit: '1' });
  assert.throws(() => denied.search(query), /拒绝|权限/);
  assert.deepEqual(paths(denied), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents']);
});

test('a resource HTTP 401 refreshes once and login errors stay visible', () => {
  let attempts = 0;
  const site = plugin({
    ...routes,
    '/api/titles/Movie1/torrents': () => ++attempts === 1
      ? { status: 401, body: '' }
      : routes['/api/titles/Movie1/torrents'],
  }, { result_limit: '1' });
  assert.equal(site.search(query).items.length, 1);
  assert.deepEqual(paths(site), [
    '/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents', '/api/auth/login', '/api/titles/Movie1/torrents',
  ]);
  for (const response of [success({}), { status: 200, body: JSON.stringify({ code: 82008, msg: 'hidden upstream body' }) }]) {
    const failed = plugin({ '/api/auth/login': response });
    assert.throws(() => failed.search(query), /登录|authentication/i);
    assert.deepEqual(paths(failed), ['/api/auth/login']);
  }
});

test('a gated selected read uses the same one-refresh allowance in either recovery order', () => {
  const path = '/api/netdisk-shares/Share1/credential';
  for (const statuses of [[403, 401, 200], [401, 403, 200], [401, 403, 401]]) {
    let auth = 0;
    let read = 0;
    const site = plugin({
      '/api/auth/login': () => success({}, { set_cookies: [`mys_at=fixture-session-${++auth}; Path=/; Secure`] }),
      '/api/gate': success(null, { set_cookies: ['mys_js=fixture-gate; Path=/; Secure'] }),
      [path]: (_, { headers }) => {
        const index = read++;
        const status = statuses[index];
        if (index > statuses.indexOf(403)) assert.match(headers.Cookie, /(?:^|; )mys_js=fixture-gate(?:;|$)/);
        if (index > statuses.indexOf(401)) assert.match(headers.Cookie, /(?:^|; )mys_at=fixture-session-2(?:;|$)/);
        return status === 200
          ? success({ id: 'Share1', shareURL: 'https://115.com/s/sharetest', accessCode: 'a1b2' })
          : { status, headers: status === 403 ? { 'x-mys-gate': 'required' } : {}, body: '' };
      },
    });
    const result = site.resolve({ token: site.MP.token({ id: 'Share1', type: '115' }) });
    if (statuses[2] === 200) {
      assert.deepEqual(plain(result), { share_link: 'https://115.com/s/sharetest', share_code: 'a1b2' });
    } else {
      assert.equal(result.error.kind, 'source');
      assert.match(result.error.message, /登录/);
    }
    const recovery = statuses[0] === 403 ? ['/api/gate', '/api/auth/login'] : ['/api/auth/login', '/api/gate'];
    assert.deepEqual(paths(site), ['/api/auth/login', path, recovery[0], path, recovery[1], path]);
  }
});

test('invalid tokens and missing selected resources return structured rejections', () => {
  const site = plugin({ '/api/netdisk-shares/Share1/credential': { status: 404, body: '' } });
  const invalid = site.MP.token({ id: '../other', type: '115' });
  assert.equal(site.resolve({ token: invalid }).error.kind, 'rejected');
  assert.equal(site.calls.length, 0);
  const missing = site.MP.token({ id: 'Share1', type: '115' });
  assert.equal(site.resolve({ token: missing }).error.kind, 'rejected');
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/netdisk-shares/Share1/credential']);
});

test('rate limits and malformed collections remain visible to Muvyo', () => {
  const limited = plugin({ '/api/torrents/Child1': { status: 429, body: '' } });
  assert.equal(limited.resolve({ token: limited.MP.token({ id: 'Child1', type: 'magnet' }) }).error.kind, 'source');
  assert.deepEqual(paths(limited), ['/api/auth/login', '/api/torrents/Child1']);
  const broken = plugin({ '/api/search/titles': success({ list: null }) });
  assert.throws(() => broken.search(query), /格式|响应/);
});

test('returns completed items before its time budget is exhausted', () => {
  let remainingMs = 8000;
  const site = plugin({
    ...routes,
    '/api/titles/Movie1/torrents': () => {
      remainingMs = 80;
      return routes['/api/titles/Movie1/torrents'];
    },
  }, {}, { remainingMs: () => remainingMs });
  const { items, partial } = site.search(query);
  assert.deepEqual(plain(items.map(row => row.id)), ['magnet:Direct1']);
  assert.equal(partial, true);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents']);
});

test('refresh consuming the deadline returns collected items without sending a stale replay', () => {
  let remainingMs = 8000;
  let logins = 0;
  let shareReads = 0;
  const sharePath = '/api/titles/Movie1/netdisk-shares';
  const site = plugin({
    ...routes,
    '/api/auth/login': () => {
      if (++logins === 2) remainingMs = 1100;
      return login();
    },
    '/api/titles/Movie1/torrents': () => {
      remainingMs = 5500;
      return routes['/api/titles/Movie1/torrents'];
    },
    [sharePath]: () => ++shareReads === 1 ? { status: 401, body: '' } : routes[sharePath],
  }, { result_limit: '2' }, { remainingMs: () => remainingMs });
  const result = site.search(query);
  assert.deepEqual(plain(result.items).map(row => row.id), ['magnet:Direct1']);
  assert.equal(result.partial, true);
  assert.equal(shareReads, 1);
  assert.deepEqual(paths(site), ['/api/auth/login', '/api/search/titles', '/api/titles/Movie1/torrents', sharePath, '/api/auth/login']);
});

test('manifest declares the standalone settings and permissions used by the adapter', () => {
  const manifest = JSON.parse(readFileSync(new URL(`../src/${id}/manifest.json`, import.meta.url), 'utf8'));
  assert.equal(manifest.id, id);
  assert.equal(manifest.api, 1);
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.entry, 'main.js');
  assert.deepEqual(manifest.permissions.domains, ['www.miniyingshi.com']);
  assert.deepEqual(manifest.capabilities.search.link_types, ['115', 'magnet']);
  assert.equal(manifest.capabilities.search.resolve, true);
  assert.equal(manifest.config.find(field => field.key === 'password').type, 'secret');
  const { min, max, step, default: defaultLimit, label, unit } = manifest.config.find(field => field.key === 'result_limit');
  assert.deepEqual({ min, max, step, defaultLimit, label, unit }, {
    min: 1, max: 20, step: 1, defaultLimit: '5', label: '每次获取数量', unit: '条',
  });
});
