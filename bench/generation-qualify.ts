import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { record } from './controller.ts';
import { generationWorkload } from './cases/generation.ts';
import { verifyTypecheckInventory } from './cases/typecheck.ts';
import type { TypecheckProfile } from './cases/typecheck.ts';

const [directory, profilePath] = process.argv.slice(2);
assert.ok(
  directory && profilePath,
  'expected generated directory and profile path',
);
const profile = JSON.parse(
  await readFile(profilePath, 'utf8'),
) as TypecheckProfile;
const client: unknown = await import(
  pathToFileURL(join(directory, 'client.consumer.ts')).href
);
const schemas: unknown = await import(
  pathToFileURL(join(directory, 'client.consumer.schemas.ts')).href
);
const inventory = verifyTypecheckInventory(profile, client, schemas);
const operations = record(record(client).operations);
// Existing correctness tests cover the compiler vocabulary. Here, retain the
// shared schema and each operation's routing/identity. With one shared schema,
// registry names and body values alone cannot detect aliased operations.
for (const [path, { post }] of Object.entries(
  generationWorkload(profile).document.paths,
)) {
  const id = post.operationId;
  const operation = record(operations[id]);
  assert.ok(typeof operation.build === 'function');
  const body = { kind: 'kind0', score: 1, tags: ['tag'], field0: 'a' };
  const request = record(Reflect.apply(operation.build, operation, [{ body }]));
  assert.equal(request.method, 'POST', `${id}: request method`);
  assert.equal(request.url, path, `${id}: request URL`);
  assert.deepEqual(request.body, body);
  assert.ok(typeof request.parseResponse === 'function');
  const response = record(
    Reflect.apply(request.parseResponse, request, [
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ]),
  );
  assert.equal(response.kind, 'success');
  assert.equal(response.operationId, id, `${id}: response operation identity`);
  assert.deepEqual(response.data, body);
}
process.stdout.write(`${JSON.stringify(inventory)}\n`);
