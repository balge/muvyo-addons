import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadPlugin } from './host.mjs';

const origin = 'https://www.wn4k.com';
const query = { keyword: '地球' };
const searchPath = '/vodsearch/%E5%9C%B0%E7%90%83-------------/';
const nextPath = '/vodsearch/%E5%9C%B0%E7%90%83----------2---/';
const detail = id => '/voddetail/' + id + '/';
const loginPath = '/user/login.html';
const settings = { username: 'fixture+name', password: 'fixture&password' };
const magnet = 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567';
const share = 'https://115.com/s/fixture';
const copyURL = share + '?password=9abc';
const lock = '<div class="pan-lock-box"><h3 class="pan-lock-title">网盘资源已锁定</h3></div>';
const loggedIn = {
  status: 200,
  body: '{"code":1,"msg":"登录成功","url":"/user/index.html"}',
  set_cookies: ['user_id=42; Path=/; Secure', 'user_check=fake-session; Path=/; Secure'],
};

const ok = body => ({ status: 200, body });
const row = (title, meta, action = '') => `
  <div class="pan-link-item" data-pan-item>
    <div class="pan-link-info">
      <div class="pan-link-title">${title}</div><div class="pan-link-meta">${meta}</div>
    </div><div class="pan-link-actions">${action}</div>
  </div>`;
const group = (...rows) => `<section class="detail-panel"><div class="detail-panel-body">
  <div class="pan-group" data-pan-group><div class="pan-group-title">网盘资源</div>
  <div class="pan-link-list" data-pan-list>${rows.join('')}</div></div></div>
</section>`;
const card = id => `<a href="${detail(id)}" class="video-card" title="地球 ${id}">
  <div class="video-info"><div class="video-title">地球 ${id}</div>
  <div class="video-meta"> 2024 · CN · 电影 </div></div></a>`;
const page = (ids, next = '') => `<main class="main"><section class="video-section">
  <div class="section-header"><h1 class="section-title">搜索：地球</h1></div>
  <div class="video-grid">${ids.map(card).join('')}</div>
  ${next ? `<div class="pagination mac-pagination"><a class="page-btn" href="${next}" title="下一页">下一页</a></div>` : ''}
</section></main>`;

function site(handler, options = {}) {
  return loadPlugin('balge.woniu', {
    ...options,
    settings: { ...settings, ...options.settings },
    fetch(url, input) {
      assert.ok(url.startsWith(origin + '/'));
      assert.equal(input.follow_redirects, false);
      const path = url.slice(origin.length);
      if (path === loginPath) {
        assert.equal(input.method, 'POST');
        assert.equal(input.body, 'user_name=fixture%2Bname&user_pwd=fixture%26password');
      }
      const response = handler(path, input);
      if (response) return response;
      if (path === loginPath) return loggedIn;
      throw new Error('Unexpected path ' + path);
    },
  });
}

const paths = plugin => plugin.calls.map(({ url }) => url.slice(origin.length));

test('Woniu reads real resource containers and lazily resolves both validated link types', () => {
  const valid = group(
    row('磁力 A', '', `<a class="pan-link-btn" href="${magnet}&amp;dn=fixture">打开</a>`),
    row('磁力 B', '', '<button data-copy="magnet:?xt=urn:btih:abcdefghijklmnopqrstuvwxyz234567">复制</button>'),
    row('坏链接', 'https://115.com.invalid/s/not-a-share magnet:?xt=urn:btih:xyz'),
    row('115 &amp; 2160p', copyURL, `<a class="pan-link-btn" href="${copyURL}">打开</a>`),
    row('文本提取码', 'https://115cdn.com/s/second 提取码：z321'),
  );
  const plugin = site((path, input) => {
    if (path === searchPath) return ok(page([18260, 7128], nextPath));
    if (path === detail(18260)) {
      assert.match(input.headers.Cookie, /user_check=fake-session/);
      return ok(valid + `<a href="https://115.com/s/outside">out of group</a>`);
    }
  });
  const items = plugin.search({ ...query, limit: 2 }).items;
  assert.deepEqual(Array.from(items, item => item.link_type), ['magnet', '115']);
  assert.equal(items[1].title, '115 & 2160p');
  assert.equal(items[1].media_title, '地球 18260');
  assert.equal(items[1].url, origin + detail(18260));
  assert.ok(items.every(item => item.resolve_token && !item.magnets && !item.share_link));
  assert.doesNotMatch(JSON.stringify(plugin.MP.untoken(items[1].resolve_token)), /fixture|9abc|fake-session/);
  assert.deepEqual(paths(plugin), [loginPath, searchPath, detail(18260)]);

  const shareResult = plugin.resolve({ token: items[1].resolve_token });
  assert.equal(shareResult.share_link, share);
  assert.equal(shareResult.share_code, '9abc');
  assert.equal(plugin.resolve({ token: items[0].resolve_token }).magnets[0], magnet + '&dn=fixture');
  assert.deepEqual(paths(plugin), [loginPath, searchPath, detail(18260), detail(18260), detail(18260)]);

  const textOnly = plugin.search({ ...query, link_types: ['115'] }).items.find(item => item.title === '文本提取码');
  assert.equal(plugin.resolve({ token: textOnly.resolve_token }).share_code, 'z321');
});

test('Woniu preserves empty search results and never follows a non-source detail or page link', () => {
  const plugin = site(path => path === searchPath ? ok(page([], 'https://other.invalid/search/')) : undefined);
  assert.equal(plugin.search(query).items.length, 0);
  assert.deepEqual(paths(plugin), [loginPath, searchPath]);
});

test('Woniu recovers a marked login wall once and reports a persistent wall', () => {
  let detailReads = 0;
  const recovered = site(path => {
    if (path === searchPath) return ok(page([18260]));
    if (path === detail(18260)) return ok(++detailReads === 1 ? lock : group(row('115', copyURL)));
  });
  assert.equal(recovered.search(query).items.length, 1);
  assert.deepEqual(paths(recovered), [loginPath, searchPath, detail(18260), loginPath, detail(18260)]);

  const persistent = site(path => path === searchPath ? ok(page([18260])) : path === detail(18260) ? ok(lock) : undefined);
  assert.throws(() => persistent.search(query), /登录/);
  assert.deepEqual(paths(persistent), [loginPath, searchPath, detail(18260), loginPath, detail(18260)]);
});

test('Woniu uses one recovery allowance across HTTP 401 and marked walls', () => {
  let reads = 0;
  const plugin = site(path => {
    if (path === searchPath) return ok(page([1, 2]));
    if (path === detail(1)) return ++reads === 1 ? { status: 401 } : ok(group(row('115', copyURL)));
    if (path === detail(2)) return ok(lock);
  });
  assert.throws(() => plugin.search(query), /登录/);
  assert.deepEqual(paths(plugin), [loginPath, searchPath, detail(1), loginPath, detail(1), detail(2)]);
});

test('Woniu clamps the request after a wall-triggered login and preserves earlier results at cutoff', () => {
  let time = 9000;
  let logins = 0;
  const plugin = site(path => {
    if (path === loginPath && ++logins === 2) time = 1100;
    if (path === searchPath) return ok(page([1, 2]));
    if (path === detail(1)) return ok(group(row('115', copyURL)));
    if (path === detail(2)) return ok(lock);
  }, { remainingMs: () => time });
  const result = plugin.search(query);
  assert.equal(result.partial, true);
  assert.equal(result.items.length, 1);
  assert.deepEqual(paths(plugin), [loginPath, searchPath, detail(1), detail(2), loginPath]);
});

test('Woniu limits actual dispatches across searches and details', () => {
  const plugin = site(path => {
    if (path === searchPath) return ok(page(Array.from({ length: 35 }, (_, index) => index + 1)));
    if (/^\/voddetail\//.test(path)) return ok('<main class="main"></main>');
  });
  const result = plugin.search(query);
  assert.equal(result.partial, true);
  assert.equal(result.items.length, 0);
  assert.equal(plugin.calls.length, 30);
});

test('Woniu default, configured and query caps bound detail reads and search pages', () => {
  function evaluate(input, configured, limit) {
    const ids = Array.from({ length: 24 }, (_, index) => index + 1);
    const plugin = site(path => {
      if (path === searchPath) return ok(page(ids, nextPath));
      const id = /^\/voddetail\/(\d+)\/$/.exec(path)?.[1];
      if (id) return ok(group(row('115 ' + id, 'https://115.com/s/fixture' + id)));
    }, { settings: { result_limit: configured } });
    assert.equal(plugin.search({ ...query, ...input }).items.length, limit);
    assert.equal(plugin.calls.length, 2 + limit);
    assert.ok(!paths(plugin).includes(nextPath));
  }
  evaluate({}, undefined, 5);
  evaluate({}, '99', 20);
  evaluate({ limit: 2 }, '20', 2);
  evaluate({}, '1', 1);
});

test('Woniu follows grounded sequential pagination only while it needs results', () => {
  const plugin = site(path => {
    if (path === searchPath) return ok(page([1], nextPath));
    if (path === nextPath) return ok(page([2]));
    if (path === detail(1)) return ok('<main class="main"></main>');
    if (path === detail(2)) return ok(group(row('115', copyURL)));
  });
  assert.equal(plugin.search({ ...query, limit: 1 }).items.length, 1);
  assert.deepEqual(paths(plugin), [loginPath, searchPath, detail(1), nextPath, detail(2)]);
});

test('Woniu filters modes before network and rejects forged selection paths', () => {
  const plugin = site(() => undefined, { settings: { resource_types: '115' } });
  assert.equal(plugin.search({ ...query, limit: 0 }).items.length, 0);
  assert.equal(plugin.search({ ...query, link_types: ['magnet'] }).items.length, 0);
  assert.equal(plugin.resolve({ token: plugin.MP.token({ type: '115', id: '../../purchase', key: 'a'.repeat(64) }) }).error.kind, 'rejected');
  assert.equal(plugin.calls.length, 0);
});

test('Woniu reports blank credentials, failed login, and opaque denials', () => {
  const missing = site(() => undefined, { settings: { password:'' } });
  assert.throws(() => missing.search(query), /账号/);
  assert.equal(missing.calls.length, 0);
  const bad = site(path => path === loginPath ? ok('{"code":0,"msg":"denial"}') : undefined);
  assert.throws(() => bad.search(query), /登录/);
  assert.deepEqual(paths(bad), [loginPath]);
  for (const [status, message] of [[403, /拒绝/], [429, /受限/]]) {
    const denied = site(path => path === searchPath ? { status } : undefined);
    assert.throws(() => denied.search(query), message);
    assert.deepEqual(paths(denied), [loginPath, searchPath]);
  }
});

test('Woniu declares the two resource types and required result-limit setting', () => {
  const manifest = JSON.parse(readFileSync(new URL('../src/balge.woniu/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.permissions.domains, ['www.wn4k.com']);
  assert.deepEqual(manifest.capabilities.search.link_types, ['115', 'magnet']);
  assert.equal(manifest.capabilities.search.resolve, true);
  assert.equal(manifest.config.find(config => config.key === 'password').type, 'secret');
  assert.deepEqual(manifest.config.find(config => config.key === 'result_limit'), {
    key: 'result_limit', label: '每次获取数量', type: 'number', min: 1, max: 20, step: 1, unit: '条', default: '5',
  });
});

test('Woniu recognizes the actual login form when protected detail returns it directly', () => {
  const loginForm = '<form method="post" id="fm" class="auth-form" action="">' +
    '<input type="text" name="user_name"><input type="password" name="user_pwd"></form>';
  let reads = 0;
  const plugin = site(path => {
    if (path === searchPath) return ok(page([18260]));
    if (path === detail(18260)) return ok(++reads === 1 ? loginForm : group(row('115', copyURL)));
  });
  assert.equal(plugin.search(query).items.length, 1);
  assert.deepEqual(paths(plugin), [loginPath, searchPath, detail(18260), loginPath, detail(18260)]);
});

test('Woniu resolves a passcode also presented in a separate row for the same share', () => {
  const plugin = site(path => {
    if (path === searchPath) return ok(page([18260]));
    if (path === detail(18260)) return ok(group(row('分享', share), row('附提取码', copyURL)));
  });
  const token = plugin.search({ ...query, limit: 1 }).items[0].resolve_token;
  assert.equal(plugin.resolve({ token }).share_code, '9abc');
});
