import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';
import { build } from '../scripts/build.mjs';

const ids = new Map([
  ['balge.miniyingshi', '迷你影视'],
  ['balge.woniu', '蜗牛 4K'],
  ['balge.jying', '鲸影'],
]);
const validatePath = fileURLToPath(new URL('../scripts/validate.mjs', import.meta.url));

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'muvyo-build-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL('../src', import.meta.url), join(root, 'src'), { recursive: true });
  return root;
}

test('builds deterministic standalone entries and reports missing settings using only mv', (t) => {
  const root = workspace(t);
  const output = join(root, 'dist', 'balge.miniyingshi');
  mkdirSync(output, { recursive: true });
  writeFileSync(join(output, 'obsolete.js'), 'const obsolete = true;');

  build(root);
  const entries = new Map();
  for (const [id, site] of ids) {
    const folder = join(root, 'dist', id);
    const entry = readFileSync(join(folder, 'main.js'), 'utf8');
    entries.set(id, entry);

    const mv = {
      config: {},
      fetch: () => assert.fail('Missing settings must not make a request'),
      storage: {
        get: () => null,
        set: () => assert.fail('Missing settings must not store data'),
        remove: () => assert.fail('Missing settings must not remove data'),
      },
      crypto: { sha256: () => assert.fail('Missing settings must not hash data') },
      time: { remainingMs: () => 60_000 },
    };
    const context = createContext({ mv });
    runInContext(entry, context, { filename: id + '/main.js', timeout: 1000 });
    assert.equal(runInContext('typeof search + " " + typeof resolve', context), 'function function');
    assert.throws(
      () => runInContext('search({ keyword: "fixture" })', context, { timeout: 1000 }),
      { name: 'Error', message: new RegExp(site + '.*密码') },
    );
    assert.deepEqual(readdirSync(folder).sort(), ['README.md', 'main.js', 'manifest.json']);
  }

  build(root);
  for (const [id, entry] of entries) {
    assert.equal(readFileSync(join(root, 'dist', id, 'main.js'), 'utf8'), entry);
  }
});

test('check rejects a modified manifest and a staged plaintext entry', (t) => {
  const root = workspace(t);
  build(root);
  execFileSync('git', ['init', '-q', root]);
  const check = () => spawnSync(process.execPath, [validatePath, '--root', root], { encoding: 'utf8' });
  const good = check();
  assert.equal(good.status, 0, good.stderr);

  const file = join(root, 'dist', 'balge.jying', 'manifest.json');
  const original = readFileSync(file);
  const manifest = JSON.parse(original);
  manifest.config.find((setting) => setting.key === 'result_limit').default = '20';
  writeFileSync(file, JSON.stringify(manifest));
  const wrongLimit = check();
  assert.equal(wrongLimit.status, 1);
  assert.match(wrongLimit.stderr, /balge\.jying.*result_limit/);
  writeFileSync(file, original);

  writeFileSync(join(root, 'main.js'), '// plaintext entry');
  execFileSync('git', ['-C', root, 'add', '--', 'main.js']);
  rmSync(join(root, 'main.js'));
  const staged = check();
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /main\.js/);
});
