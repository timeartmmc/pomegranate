import { mkdir, rm, writeFile } from 'node:fs/promises';
import { compile } from '../dist/index.js';
import type { CompileOptions } from '../dist/index.js';
import { deepFixture } from '../test/deep-fixture.ts';
import { fixture, generatedFixture } from '../test/helpers.ts';
import {
  multipartFixture,
  multipartSelection,
} from '../test/multipart-fixture.ts';
import { schemaFixture, standaloneSelection } from '../test/schema-fixture.ts';
import { symbolFixture } from '../test/symbol-fixture.ts';

// Give the test program the real generated signatures. Runtime tests still
// compile into fresh temporary directories, and independent consumer fixtures
// retain their accepted examples and expected compile errors.
const fixtures: [string, unknown, CompileOptions][] = [
  ['example', fixture(), { clients: ['consumer', 'staff'] }],
  ['runtime', generatedFixture(), { clients: ['consumer', 'staff'] }],
  [
    'schema',
    schemaFixture(),
    {
      clients: ['samples'],
      transportHeaders: ['X-Origin'],
      standalone: standaloneSelection,
    },
  ],
  ['multipart', multipartFixture(), multipartSelection],
  ['deep', deepFixture(), { clients: ['deep'] }],
  ['symbols', symbolFixture(), { clients: ['symbols', 'other'] }],
];
// Keep cleanup unsuffixed: a final slash would follow a directory symlink.
const root = new URL('../test/.generated', import.meta.url);
const directoryBase = new URL(`${root.href}/`);
const rendered = await Promise.all(
  fixtures.map(async ([name, document, options]) => ({
    name,
    files: await compile(document, options),
  })),
);
await rm(root, { recursive: true, force: true });
for (const { name, files } of rendered) {
  const directory = new URL(`${name}/`, directoryBase);
  await mkdir(directory, { recursive: true });
  for (const [path, source] of Object.entries(files))
    await writeFile(new URL(path, directory), source);
}
