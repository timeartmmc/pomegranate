import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
type Container = 'object' | 'map' | 'array';

function boundedGraph(kind: Container, depth: number) {
  const bounds =
    kind === 'array'
      ? { minItems: 1, maxItems: 2 }
      : { minProperties: 1, maxProperties: 2 };
  const reference = (name: string): Schema => ({
    $ref: `#/components/schemas/${name}`,
    ...bounds,
  });
  const schemas: Record<string, Schema> = {
    Node0:
      kind === 'array'
        ? { type: 'array', items: { type: 'string' } }
        : { type: 'object', properties: { value: { type: 'string' } } },
  };
  for (let index = 1; index <= depth; index++) {
    const fields: Schema = {
      type: 'object',
      properties: {
        left: reference(`Node${index - 1}`),
        right: reference(`Node${index - 1}`),
      },
    };
    schemas[`Node${index}`] =
      kind === 'array'
        ? { type: 'array', items: fields }
        : kind === 'map'
          ? { type: 'object', additionalProperties: fields }
          : fields;
  }
  schemas.Middle = reference(`Node${depth}`);
  schemas.Root = {
    $ref: '#/components/schemas/Middle',
    ...(kind === 'array' ? { maxItems: 1 } : { maxProperties: 1 }),
  };
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic shared bounded updates', version: '1' },
    components: { schemas },
    paths: {},
  };
}

function graphValue(kind: Container, depth: number, leaf: unknown): unknown {
  let value = leaf;
  for (let index = 0; index < depth; index++) {
    const fields = { left: value };
    value =
      kind === 'array' ? [fields] : kind === 'map' ? { entry: fields } : fields;
  }
  return value;
}

async function generate(kind: Container, depth: number) {
  return compile(boundedGraph(kind, depth), {
    clients: [],
    standalone: {
      request: { schema: '#/components/schemas/Root', usage: 'request' },
      response: { schema: '#/components/schemas/Root', usage: 'response' },
    },
  });
}

function size(files: Readonly<Record<string, string>>) {
  const source = ['standalone.request.ts', 'standalone.response.ts']
    .map((name) => present(files[name]))
    .join('\n');
  return {
    bytes: Buffer.byteLength(source),
    functions: source.match(/\bfunction\s/g)?.length ?? 0,
  };
}

for (const kind of ['object', 'map', 'array'] as const) {
  void test(`bounded ${kind} references preserve shared graph growth and validation`, async (t) => {
    const shallow = size(await generate(kind, 4));
    const practical = size(await generate(kind, 8));
    // The source graph doubles in size. Rebuilding every shared descendant
    // instead makes emission exponential; stop here before the deeper probe.
    assert.ok(
      practical.functions < shallow.functions * 4,
      `${kind} parser growth: ${shallow.functions} -> ${practical.functions}`,
    );
    assert.ok(
      practical.bytes < shallow.bytes * 4,
      `${kind} byte growth: ${shallow.bytes} -> ${practical.bytes}`,
    );
    const files = await generate(kind, 18);
    const deep = size(files);
    assert.ok(deep.functions < practical.functions * 3);
    assert.ok(deep.bytes < practical.bytes * 3);

    const root = await generatedTestWorkspace(t, files);
    for (const direction of ['request', 'response']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${direction}.ts`,
      );
      const leaf = kind === 'array' ? ['valid'] : { value: 'valid' };
      const input = graphValue(kind, 18, leaf);
      const output = schema.parse(input);
      assert.deepEqual(output, input);
      assert.notEqual(output, input);
      assert.equal(schema.safeParse(kind === 'array' ? [] : {}).success, false);
      assert.equal(
        schema.safeParse(graphValue(kind, 18, kind === 'array' ? [] : {}))
          .success,
        false,
      );
      const child = graphValue(kind, 17, leaf);
      const tooMany =
        kind === 'array'
          ? [{ left: child }, { right: child }]
          : kind === 'map'
            ? { first: { left: child }, second: { right: child } }
            : { left: child, right: child };
      assert.equal(schema.safeParse(tooMany).success, false);
      const failure = schema.safeParse(
        graphValue(kind, 18, kind === 'array' ? [1] : { value: 1 }),
      );
      assert.equal(failure.success, false);
      if (!failure.success)
        assert.deepEqual(failure.error.issues[0]?.path, [
          ...Array.from({ length: 18 }, () =>
            kind === 'array'
              ? [0, 'left']
              : kind === 'map'
                ? ['entry', 'left']
                : ['left'],
          ).flat(),
          kind === 'array' ? 0 : 'value',
        ]);
    }

    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          strict: true,
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          types: [],
        },
        include: ['./*.ts'],
      }),
    );
    await exec(process.execPath, [
      fileURLToPath(
        new URL('../node_modules/typescript/bin/tsc', import.meta.url),
      ),
      '-p',
      join(root, 'tsconfig.json'),
    ]);
  });
}
