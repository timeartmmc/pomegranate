import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(
  new URL('../examples/json/openapi.json', import.meta.url),
  'utf8',
);
export const fixture = () => JSON.parse(source);
export const preparation = (document) =>
  document.paths['/api/widgets/{widgetId}/preparations'].post;

export async function temporary(t) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pom-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function fileSnapshot(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    const entry = await stat(join(root, name));
    if (entry.isFile())
      result[name] = {
        source: await readFile(join(root, name), 'utf8'),
        mtime: entry.mtimeMs,
      };
  }
  return result;
}
