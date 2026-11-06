import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { compile } from '../dist/index.js';
import { entry, runtimeInput } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';
import {
  typeCompositionCases,
  typeCompositionFixture,
  typeCompositionSelection,
  verifyTypeComposition,
} from './type-composition-fixture.ts';

void test('directional compositions retain runtime validation and source and published declarations', async (t) => {
  const files = await compile(
    typeCompositionFixture(),
    typeCompositionSelection,
  );
  const root = await generatedTestWorkspace(t, files, 'generated');
  const client = await importGenerated<RuntimeClient>(
    root,
    'generated/client.consumer.ts',
  );
  for (const value of typeCompositionCases()) {
    const operation = entry(client.operations, value.name);
    const request = await importGenerated<StandaloneModule>(
      root,
      `generated/standalone.${value.name}-request.ts`,
    );
    const response = await importGenerated<StandaloneModule>(
      root,
      `generated/standalone.${value.name}-response.ts`,
    );
    const parsed = request.schema.parse(value.request);
    assert.deepEqual(parsed, value.request);
    assert.notEqual(parsed, value.request);
    const built = runtimeInput(operation.build, { body: parsed });
    assert.deepEqual(built.body, value.request);
    assert.notEqual(built.body, parsed);
    assert.deepEqual(
      response.schema.parse(value.responseInput),
      value.response,
    );
    const observed = built.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value.responseInput),
    });
    assert.equal(observed.kind, 'success');
    if (observed.kind === 'success') {
      assert.deepEqual(observed.data, value.response);
      if (value.name !== 'access')
        assert.deepEqual(
          runtimeInput(operation.build, { body: observed.data }).body,
          value.response,
        );
      else
        assert.throws(
          () => runtimeInput(operation.build, { body: observed.data }),
          client.RequestValidationError,
        );
    }
    assert.equal(request.schema.safeParse(value.invalid).success, false);
    assert.equal(response.schema.safeParse(value.invalid).success, false);
    assert.throws(
      () => runtimeInput(operation.build, { body: value.invalid }),
      client.RequestValidationError,
    );
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value.invalid),
      }).kind,
      'protocol',
    );
  }
  await verifyTypeComposition(
    root,
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
  );
});

function scalingFixture(models: number) {
  const schemas: Record<string, Schema> = {};
  const paths: Record<string, unknown> = {};
  const operations: string[] = [];
  const fields = Object.fromEntries(
    Array.from({ length: 59 }, (_, index) => [
      `field${index}`,
      { type: 'string' },
    ]),
  );
  // Independent chains exercise real transitive projection without exceeding
  // structural depth 61 or increasing connectivity as the model count grows.
  for (let start = 0; start < models; start += 60) {
    let previous: string | undefined;
    for (let index = start; index < Math.min(models, start + 60); index++) {
      const name = `Model${String(index).padStart(4, '0')}`;
      schemas[name] = object(
        {
          ...fields,
          value: previous ? ref(previous) : { type: 'string' },
          secret: { type: 'string', writeOnly: true },
        },
        ['value'],
      );
      previous = name;
    }
    const id = `save${start / 60}`;
    operations.push(id);
    const content = {
      'application/json': { schema: ref(previous!) },
    };
    paths[`/models/${id}`] = {
      post: {
        operationId: id,
        requestBody: { required: true, content },
        responses: { 200: { description: 'Synthetic models', content } },
      },
    };
  }
  return {
    document: {
      openapi: '3.1.2',
      info: { title: 'Synthetic model scaling', version: '1' },
      components: { schemas },
      paths,
    },
    selection: { clients: ['consumer'], surfaces: { consumer: operations } },
  };
}

void test('300 and 600 directional models fit the output budget with linear type growth', async () => {
  const sizes = [];
  for (const count of [300, 600]) {
    const fixture = scalingFixture(count);
    const files = await compile(fixture.document, fixture.selection);
    const size = {
      total: Object.values(files).reduce(
        (sum, source) => sum + Buffer.byteLength(source),
        0,
      ),
      types: Object.entries(files)
        .filter(([name]) => name.startsWith('schema-types.'))
        .reduce((sum, [, source]) => sum + Buffer.byteLength(source), 0),
    };
    assert.ok(size.total < 32 * 1024 * 1024);
    sizes.push(size);
  }
  const [smaller, larger] = sizes;
  assert.ok(smaller && larger);
  // Deduplication may improve this bound; avoid locking in exact byte counts.
  assert.ok(larger.types < smaller.types * 2.1);
  assert.ok(larger.total < smaller.total * 2.1);
});
