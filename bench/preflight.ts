import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { compile } from 'pomegranate-compiler';
import {
  jsonResponseCase,
  jsonResponseSubject,
  jsonResponseWorkload,
  verifyJsonResponse,
} from './cases/json-response.ts';

const sha256 = (source: string) =>
  createHash('sha256').update(source).digest('hex');

const root = await mkdtemp(
  join(await realpath(tmpdir()), 'pom-bench-preflight-'),
);
try {
  const { document, options } = jsonResponseWorkload();
  const before = structuredClone({ document, options });
  const files = await compile(document, options);
  assert.deepEqual(
    { document, options },
    before,
    'compilation must preserve inputs',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const inventory = [];
  for (const name of Object.keys(files).sort()) {
    // POM's current output inventory is flat. A bad candidate must not make this
    // preflight write outside its own scratch directory.
    assert.match(name, /^[a-zA-Z0-9_.-]+\.ts$/);
    const source = files[name];
    assert.ok(typeof source === 'string');
    await writeFile(join(root, name), source);
    inventory.push({
      name,
      bytes: Buffer.byteLength(source),
      sha256: sha256(source),
    });
  }
  // Core generated code must execute outside the checkout with no node_modules
  // links. This is a correctness preflight; it intentionally records no timings.
  const client: unknown = await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  );
  const schemas: unknown = await import(
    pathToFileURL(join(root, 'client.consumer.schemas.ts')).href
  );
  verifyJsonResponse(jsonResponseSubject(client, schemas));
  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        case: jsonResponseCase,
        compilerEntry: import.meta.resolve('pomegranate-compiler'),
        caseSha256: sha256(
          await readFile(
            new URL('./cases/json-response.ts', import.meta.url),
            'utf8',
          ),
        ),
        behavior: 'verified',
        performance: 'unmeasured',
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        generated: inventory,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
