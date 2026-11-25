import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

export const pluginIds = Object.freeze(['balge.miniyingshi', 'balge.woniu', 'balge.jying']);

const workspace = fileURLToPath(new URL('..', import.meta.url));

export function build(root = workspace) {
  const runtime = readFileSync(join(root, 'src/shared/runtime.js'), 'utf8');
  const plugins = pluginIds.map((id) => {
    const source = join(root, 'src', id);
    const site = readFileSync(join(source, 'main.js'), 'utf8');
    const entry = `${runtime}\n;\n${site}`;
    new Script(entry, { filename: `${id}/main.js` });
    return {
      id,
      entry,
      manifest: readFileSync(join(source, 'manifest.json')),
      readme: readFileSync(join(source, 'README.md')),
    };
  });

  for (const { id, entry, manifest, readme } of plugins) {
    const output = join(root, 'dist', id);
    mkdirSync(output, { recursive: true });
    writeFileSync(join(output, 'main.js'), entry);
    writeFileSync(join(output, 'manifest.json'), manifest);
    writeFileSync(join(output, 'README.md'), readme);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build();
}
