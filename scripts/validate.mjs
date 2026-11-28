import { execFileSync } from 'node:child_process';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { Script } from 'node:vm';
import { pluginIds } from './build.mjs';

const domains = {
  'balge.miniyingshi': 'www.miniyingshi.com',
  'balge.woniu': 'www.wn4k.com',
  'balge.jying': 'www.jying.top',
};
const builtFiles = ['README.md', 'main.js', 'manifest.json'];
const releaseFiles = ['README.md', 'encrypted.json', 'manifest.json', 'signature.json'];
const releases = new Set(['index.json', 'index.json.sig', ...pluginIds.flatMap((id) =>
  releaseFiles.map((file) => `plugins/${id}/${file}`))]);
const tools = new Set([
  '.gitignore', '.githooks/pre-commit', 'README.md', 'package.json',
  '.claude/skills/muvyo-addon-publish/SKILL.md',
  '.claude/skills/muvyo-addon-publish/scripts/sign_index.py',
  'scripts/build.mjs', 'scripts/validate.mjs', 'scripts/live-probe.py',
]);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function requireValue(valid, label) {
  if (!valid) throw new Error(label);
}

function showExact(actual, expected, label) {
  requireValue(JSON.stringify([...actual].sort()) === JSON.stringify([...expected].sort()), label);
}

function requireEqual(actual, expected, label) {
  requireValue(isDeepStrictEqual(actual, expected), label);
}

function plainFile(root, file) {
  const path = join(root, file);
  requireValue(lstatSync(path).isFile(), `${file} must be a regular file`);
  return readFileSync(path);
}

function directory(root, folder, contents) {
  const path = join(root, folder);
  requireValue(lstatSync(path).isDirectory(), `${folder} must be a directory`);
  showExact(readdirSync(path), contents, `${folder} has unexpected or missing files`);
}

function manifestFrom(bytes, id) {
  const manifest = JSON.parse(bytes);
  requireValue(manifest.id === id && manifest.api === 1 && /^\d+\.\d+\.\d+$/.test(manifest.version) &&
    manifest.entry === 'main.js' && manifest.author === 'balge' && manifest.name && manifest.description &&
    manifest.min_mv_version === '3.14.0', `${id} has invalid manifest metadata`);
  requireEqual(manifest.permissions, { domains: [domains[id]] }, `${id} source permissions`);
  requireEqual(manifest.capabilities.search, {
    link_types: ['115', 'magnet'], supports_tmdb: false, resolve: true, resolve_cost: 'none',
  }, `${id} search capabilities`);
  requireValue(Array.isArray(manifest.config), `${id} has invalid settings`);
  showExact(manifest.config.map(({ key }) => key),
    ['username', 'password', 'result_limit', 'resource_types', ...(id === 'balge.woniu' ? ['network_mode'] : [])], `${id} settings`);
  if (id === 'balge.woniu') {
    requireEqual(manifest.config.find(({ key }) => key === 'network_mode'), {
      key: 'network_mode', label: '连接方式', type: 'select', default: 'direct',
      options: [{ value: 'direct', label: '直连' }, { value: 'proxy', label: '使用系统代理' }],
    }, `${id} network_mode`);
  }
  for (const [key, type] of [['username', 'text'], ['password', 'secret']]) {
    const { required, ...setting } = manifest.config.find((field) => field.key === key);
    requireValue(required === true && setting.type === type && setting.label &&
      Object.keys(setting).length === 3, `${id} ${key} must be required and have no preset`);
  }
  requireEqual(manifest.config.find(({ key }) => key === 'result_limit'), {
    key: 'result_limit', label: '每次获取数量', type: 'number',
    min: 1, max: 20, step: 1, unit: '条', default: '5',
  }, `${id} result_limit`);
  const resourceTypes = manifest.config.find(({ key }) => key === 'resource_types');
  requireValue(resourceTypes.type === 'select' && resourceTypes.default === 'both',
    `${id} resource_types default`);
  showExact(resourceTypes.options.map(({ value }) => value), ['both', '115', 'magnet'],
    `${id} resource_types options`);
  return manifest;
}

function checkBuild(root) {
  directory(root, 'dist', pluginIds);
  const runtime = plainFile(root, 'src/shared/runtime.js').toString('utf8');
  for (const id of pluginIds) {
    directory(root, `dist/${id}`, builtFiles);
    const entry = plainFile(root, `dist/${id}/main.js`).toString('utf8');
    manifestFrom(plainFile(root, `dist/${id}/manifest.json`), id);
    requireValue(entry === `${runtime}\n;\n${plainFile(root, `src/${id}/main.js`)}`,
      `${id} entry differs from the current source build`);
    new Script(entry, { filename: `${id}/main.js` });
    for (const file of ['manifest.json', 'README.md']) {
      requireValue(plainFile(root, `dist/${id}/${file}`).equals(plainFile(root, `src/${id}/${file}`)),
        `${id} ${file} differs from the source`);
    }
  }
}

function strictBase64(value, length) {
  const bytes = Buffer.from(value, 'base64');
  requireValue(bytes.toString('base64') === value && (length === undefined || bytes.length === length),
    'Malformed release Base64 field');
  return bytes;
}

function ed25519(value) {
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), strictBase64(value, 32)]),
    format: 'der',
    type: 'spki',
  });
}

function checkRelease(root, compareBuild) {
  directory(root, 'plugins', pluginIds);
  const indexBytes = plainFile(root, 'index.json');
  const index = JSON.parse(indexBytes);
  requireValue(index.name === 'Muvyo Addons' && Number.isSafeInteger(index.sequence) &&
    index.sequence >= pluginIds.length && Array.isArray(index.plugins), 'Invalid Muvyo Addons index');
  showExact(index.plugins.map(({ id }) => id), pluginIds, 'Wrong index plugin IDs');
  const publicKey = ed25519(index.public_key);
  const detached = strictBase64(plainFile(root, 'index.json.sig').toString('ascii').trim(), 64);
  requireValue(verify(null, indexBytes, publicKey, detached), 'Invalid repository index signature');

  for (const id of pluginIds) {
    const folder = `plugins/${id}`;
    directory(root, folder, releaseFiles);
    const files = Object.fromEntries(releaseFiles.map((file) => [file, plainFile(root, `${folder}/${file}`)]));
    const manifest = manifestFrom(files['manifest.json'], id);
    const { api, name, version, description, author } = manifest;
    requireEqual(index.plugins.find((plugin) => plugin.id === id),
      { id, name, version, description, author, path: folder, api }, `${id} index metadata`);

    const encrypted = JSON.parse(files['encrypted.json']);
    showExact(Object.keys(encrypted), ['alg', 'ciphertext', 'epk', 'key_version', 'nonce', 'version'],
      `${id} encrypted envelope fields`);
    requireValue(encrypted.version === 1 && encrypted.alg === 'x25519-hkdf-sha256-aes256gcm' &&
      Number.isSafeInteger(encrypted.key_version) && encrypted.key_version > 0 &&
      strictBase64(encrypted.epk, 32) && strictBase64(encrypted.nonce, 12) &&
      strictBase64(encrypted.ciphertext).length > 16, `${id} invalid encrypted envelope`);
    const signature = JSON.parse(files['signature.json']);
    showExact(Object.keys(signature), ['certificate', 'payload', 'signature', 'version'],
      `${id} signature envelope fields`);
    const authorKey = signature.certificate?.certificate?.public_key;
    requireValue(signature.version === 1 && authorKey !== index.public_key,
      `${id} must use an author key separate from the repository key`);
    // The author tool signs compact JSON with lexicographically sorted keys.
    const canonicalPayload = {
      files: Object.fromEntries(['README.md', 'encrypted.json', 'manifest.json'].map((file) =>
        [file, sha256(files[file])])),
      plugin_id: id,
      version,
    };
    requireEqual(signature.payload, canonicalPayload, `${id} signed payload hashes`);
    const signedBytes = Buffer.from('Muvyo addon package v1\0' + JSON.stringify(canonicalPayload));
    requireValue(verify(null, signedBytes, ed25519(authorKey), strictBase64(signature.signature, 64)),
      `${id} invalid author signature`);
    if (compareBuild) {
      requireValue(strictBase64(encrypted.ciphertext).length ===
        plainFile(root, `dist/${id}/main.js`).length + 16, `${id} ciphertext length differs from the build`);
      for (const file of ['manifest.json', 'README.md']) {
        requireValue(files[file].equals(plainFile(root, `dist/${id}/${file}`)),
          `${id} signed ${file} differs from the build`);
      }
    }
  }
}

function checkGit(root, stagedRelease) {
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 8 * 1024 * 1024 });
  const entries = git('ls-files', '--stage', '-z').toString('utf8').split('\0').filter(Boolean);
  const seenRelease = [];
  for (const entry of entries) {
    const match = /^(100644|100755) [0-9a-f]+ 0\t([^\n\r\t]+)$/.exec(entry);
    requireValue(match, 'Git contains a non-regular or unmerged entry');
    const file = match[2];
    requireValue(releases.has(file) || tools.has(file) ||
      /^tests\/(?:[\w-]+\.test\.mjs|host\.mjs|test_[\w]+\.py)$/.test(file),
    `Unexpected tracked or staged file ${file}`);
    const blob = git('show', `:${file}`);
    const secret = /BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----|"private_key"\s*:/;
    requireValue(!secret.test(blob.toString('utf8')), `Private credential marker in ${file}`);
    if (releases.has(file)) {
      seenRelease.push(file);
      if (stagedRelease) {
        requireValue(blob.equals(plainFile(root, file)), `${file} does not match the verified Git staging content`);
      }
    }
  }
  if (stagedRelease) showExact(seenRelease, releases, 'Git staging must contain the three complete releases');
}

function main() {
  const { values } = parseArgs({ options: {
    root: { type: 'string' },
    release: { type: 'boolean' },
    staged: { type: 'boolean' },
    python: { type: 'string' },
    signer: { type: 'string' },
  } });
  const root = resolve(values.root ?? fileURLToPath(new URL('..', import.meta.url)));
  const checkDist = !values.release && existsSync(join(root, 'src'));
  const checkPublication = values.release || values.staged || existsSync(join(root, 'index.json')) ||
    existsSync(join(root, 'plugins'));
  requireValue(checkDist || checkPublication, 'No local source build or published release found');
  checkGit(root, values.staged);
  if (checkDist) {
    checkBuild(root);
    console.log('Validated three local builds.');
  }
  if (checkPublication) {
    checkRelease(root, checkDist);
    if (values.signer) {
      const signer = resolve(values.signer);
      for (const id of pluginIds) {
        execFileSync(values.python ?? 'python3', [signer, 'verify', `plugins/${id}`],
          { cwd: root, stdio: 'inherit' });
      }
      execFileSync(values.python ?? 'python3',
        ['.claude/skills/muvyo-addon-publish/scripts/sign_index.py', 'verify'], { cwd: root, stdio: 'inherit' });
    }
    console.log('Validated three encrypted releases and the repository index signature.');
  } else {
    requireValue(!values.signer, 'Official verification requires a published release');
  }
  console.log('Checked tracked and staged paths.');
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
