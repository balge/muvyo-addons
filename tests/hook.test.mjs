import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

test('the Git hook admits an encrypted layout and blocks private or incomplete staging', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'muvyo-hook-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });
  const ok = (...args) => {
    const result = git(...args);
    assert.equal(result.status, 0, result.stderr);
  };
  const write = (path, value = '{}\n') => {
    mkdirSync(join(cwd, dirname(path)), { recursive: true });
    writeFileSync(join(cwd, path), value);
  };
  const plugin = 'plugins/example.addon';
  ok('init', '-q');
  ok('config', 'user.email', 'fixture@example.invalid');
  ok('config', 'user.name', 'Muvyo fixture');
  ok('config', 'core.hooksPath', '.githooks');
  mkdirSync(join(cwd, '.githooks'));
  copyFileSync(new URL('../.githooks/pre-commit', import.meta.url), join(cwd, '.githooks/pre-commit'));
  chmodSync(join(cwd, '.githooks/pre-commit'), 0o755);
  const release = ['README.md', 'manifest.json', 'signature.json', 'encrypted.json'].map((file) => `${plugin}/${file}`);
  for (const file of release) write(file);
  ok('add', '--', ...release);
  ok('commit', '-qm', 'fixture encrypted release');

  const rejects = [
    ['src/demo.js', /src\/demo\.js/],
    ['dist/demo/main.js', /dist\/demo\/main\.js/],
    [`${plugin}/main.js`, /main\.js/],
    ['.private/snapshot', /\.private\/snapshot/],
    ['artifacts/example.zip', /artifacts\/example\.zip/],
    ['example/muvyo-signing.json', /muvyo-signing\.json/],
    ['example/accounts.json', /accounts\.json/],
    ['example/mini-cookies.json', /mini-cookies\.json/],
    ['example/jying-token.json', /jying-token\.json/],
    ['.env.test', /\.env\.test/],
    ['ordinary.txt', /私钥/, ['-----BEGIN', 'PRIVATE', 'KEY-----'].join(' ')],
  ];
  for (const [path, message, contents] of rejects) {
    write(path, contents);
    ok('add', '--', path);
    const result = git('commit', '-qm', 'blocked fixture');
    assert.equal(result.status, 1, path);
    assert.match(result.stderr, message);
    ok('reset', '-q', 'HEAD', '--', path);
  }

  ok('rm', '-q', '--', `${plugin}/encrypted.json`);
  const missing = git('commit', '-qm', 'blocked incomplete fixture');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /encrypted\.json/);
});
