import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import type { Validator } from '../src/runtime.ts';
import { entry, present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

interface Registries {
  requestSchemas: Readonly<Record<string, Validator<unknown>>>;
  responseSchemas: Readonly<Record<string, Validator<unknown>>>;
}

function documentWith(schemas: Record<string, Schema>, root: string) {
  const content = () => ({ 'application/json': { schema: ref(root) } });
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic scalar refinements', version: '1' },
    components: { schemas },
    paths: {
      '/value': {
        post: {
          operationId: 'value',
          requestBody: { required: true, content: content() },
          responses: {
            200: { description: 'Synthetic value', content: content() },
          },
        },
      },
    },
  };
}

function aliases(count: number) {
  const schemas: Record<string, Schema> = { Base: { type: 'string' } };
  let root = 'Base';
  // Define links before their targets to cover forward declaration order too.
  for (let index = 0; index < count; index++) {
    const name = `Alias${String(index).padStart(5, '0')}`;
    schemas[name] = {
      ...ref(
        index === count - 1
          ? 'Base'
          : `Alias${String(index + 1).padStart(5, '0')}`,
      ),
      minLength: 1,
    };
    if (index === 0) root = name;
  }
  return { document: documentWith(schemas, root), root };
}

function selection(root: string) {
  return {
    clients: ['consumer'],
    surfaces: { consumer: ['value'] },
    standalone: {
      request: { schema: ref(root).$ref, usage: 'request' },
      response: { schema: ref(root).$ref, usage: 'response' },
    },
  } as const;
}

function bytes(files: Readonly<Record<string, string>>) {
  return Object.values(files).reduce(
    (total, source) => total + Buffer.byteLength(source),
    0,
  );
}

void test('scalar refinement chains scale linearly in standalone parsers and complete client registries', async (t) => {
  async function generate(count: number) {
    const value = aliases(count);
    return compile(value.document, selection(value.root));
  }
  const small = bytes(await generate(256));
  const medium = bytes(await generate(512));
  assert.ok(medium < small * 2.5, `alias source growth: ${small} -> ${medium}`);
  const files = await generate(2000);
  assert.ok(bytes(files) < 8 * 1024 * 1024);
  assert.ok(bytes(files) < medium * 4.5);
  const root = await generatedTestWorkspace(t, files);
  const registries = await importGenerated<Registries>(
    root,
    'client.consumer.schemas.ts',
  );
  for (const direction of ['request', 'response'] as const) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.${direction}.ts`,
    );
    const registry = registries[`${direction}Schemas`];
    for (const validator of [
      schema,
      entry(registry, 'Alias00000'),
      entry(registry, 'Alias01000'),
      entry(registry, 'Alias01999'),
    ]) {
      assert.equal(validator.parse('valid'), 'valid');
      assert.equal(validator.safeParse('').success, false);
      const wrongType = validator.safeParse(123);
      assert.equal(wrongType.success, false);
      if (!wrongType.success)
        assert.deepEqual(wrongType.error.issues, [
          { path: [], message: 'expected a string' },
        ]);
    }
    const failure = schema.safeParse('');
    assert.equal(failure.success, false);
    if (!failure.success) {
      assert.equal(failure.error.issues.length, 101);
      assert.ok(
        failure.error.issues
          .slice(0, 100)
          .every((issue) => issue.message === 'string is too short'),
      );
      assert.match(present(failure.error.issues[100]).message, /issue limit/);
    }
  }
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022', 'DOM'],
        types: [],
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        rewriteRelativeImportExtensions: true,
        outDir: 'declarations',
      },
      include: ['./*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('shared scalar refinements preserve independent rules, literals and ordered bounded issues', async (t) => {
  const schemas: Record<string, Schema> = {
    Text: { type: 'string', minLength: 2, pattern: '^a' },
    Pure: ref('Text'),
    Middle: { ...ref('Pure'), minLength: 3, pattern: 'b$' },
    TextRoot: {
      ...ref('Middle'),
      minLength: 3,
      maxLength: 6,
      pattern: '^[a-z]+$',
    },
    MaxOnly: { ...ref('Middle'), maxLength: 3 },
    Disjoint: { ...ref('Text'), pattern: '^b' },
    Number: { type: 'integer', minimum: 0, maximum: 20 },
    Even: { ...ref('Number'), multipleOf: 2 },
    Six: { ...ref('Even'), minimum: 1, multipleOf: 3 },
    Ten: { ...ref('Even'), multipleOf: 5 },
    Enum: { type: 'string', enum: ['alpha', 'ab', 'beta'] },
    EnumMiddle: { ...ref('Enum'), pattern: '^a' },
    EnumRoot: { ...ref('EnumMiddle'), minLength: 3 },
    Mail: { type: 'string', format: 'email' },
    MailRoot: { ...ref('Mail'), pattern: '@example', minLength: 6 },
    Positive: { type: 'number', minimum: 0 },
    Object: {
      type: 'object',
      properties: {
        text: { ...ref('Middle'), minLength: 4 },
        number: { ...ref('Six'), maximum: 15 },
      },
      required: ['text', 'number'],
    },
  };
  let previous = 'Positive';
  for (let index = 1; index <= 140; index++) {
    const name = `Positive${index}`;
    schemas[name] = { ...ref(previous), minimum: index };
    previous = name;
  }
  const names = [
    'TextRoot',
    'MaxOnly',
    'Disjoint',
    'Six',
    'Ten',
    'EnumRoot',
    'MailRoot',
    'Object',
    previous,
  ];
  const document = documentWith(schemas, 'TextRoot');
  // Inline operation constraints own their module's rules while sharing the
  // component chain, without importing another module's private constants.
  Object.assign(
    document.paths['/value'].post.requestBody.content['application/json']
      .schema,
    {
      ...ref('Middle'),
      minLength: 4,
    },
  );
  Object.assign(
    document.paths['/value'].post.responses[200].content['application/json']
      .schema,
    {
      ...ref('Middle'),
      maxLength: 3,
    },
  );
  const files = await compile(document, {
    ...selection('TextRoot'),
    standalone: Object.fromEntries(
      names.flatMap((name) =>
        (['request', 'response'] as const).map((usage) => [
          `${name.toLowerCase()}-${usage}`,
          { schema: ref(name).$ref, usage },
        ]),
      ),
    ),
  });
  const root = await generatedTestWorkspace(t, files);
  for (const direction of ['request', 'response']) {
    async function schema(name: string) {
      return (
        await importGenerated<StandaloneModule>(
          root,
          `standalone.${name.toLowerCase()}-${direction}.ts`,
        )
      ).schema;
    }
    async function messages(name: string, input: unknown) {
      const result = (await schema(name)).safeParse(input);
      assert.equal(result.success, false);
      return result.success
        ? []
        : result.error.issues.map((issue) => issue.message);
    }
    assert.equal((await schema('TextRoot')).parse('aabb'), 'aabb');
    assert.deepEqual(await messages('TextRoot', ''), [
      'string is too short',
      'string does not match pattern',
      'string is too short',
      'string does not match pattern',
      'string is too short',
      'string does not match pattern',
    ]);
    assert.deepEqual(await messages('MaxOnly', 'zzzz'), ['string is too long']);
    for (const value of ['a', 'b', 'c'])
      assert.equal((await schema('Disjoint')).safeParse(value).success, false);
    assert.equal((await schema('Six')).parse(6), 6);
    assert.equal((await schema('Ten')).parse(10), 10);
    assert.equal((await schema('Six')).safeParse(2).success, false);
    assert.equal((await schema('Ten')).safeParse(6).success, false);
    assert.deepEqual(await messages('Six', -1.5), [
      'expected an integer',
      'expected value >= 0',
      'expected a declared multiple',
      'expected value >= 1',
      'expected a declared multiple',
    ]);
    assert.equal((await schema('EnumRoot')).parse('alpha'), 'alpha');
    for (const value of ['ab', 'beta', 'other'])
      assert.equal((await schema('EnumRoot')).safeParse(value).success, false);
    assert.equal(
      (await schema('MailRoot')).parse('x@example.com'),
      'x@example.com',
    );
    for (const value of ['x@other.com', 'example', 'a@b.c'])
      assert.equal((await schema('MailRoot')).safeParse(value).success, false);
    assert.deepEqual(
      (await schema('Object')).parse({ text: 'aaab', number: 6 }),
      { text: 'aaab', number: 6 },
    );
    assert.equal(
      (await schema('Object')).safeParse({ text: 'ab', number: 18 }).success,
      false,
    );
    const bounded = await messages(previous, -1);
    assert.deepEqual(
      bounded.slice(0, 100),
      Array.from({ length: 100 }, (_, index) => `expected value >= ${index}`),
    );
    assert.equal(bounded.length, 101);
    assert.match(present(bounded[100]), /issue limit/);
  }
  const { operations } = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  const operation = entry(operations, 'value');
  assert.equal(operation.build({ body: 'aaab' }).body, 'aaab');
  assert.throws(() => operation.build({ body: 'aab' }));
  assert.equal(
    operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '"aab"',
    }).kind,
    'success',
  );
  assert.equal(
    operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '"aaab"',
    }).kind,
    'protocol',
  );
});
