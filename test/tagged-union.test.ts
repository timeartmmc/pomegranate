import assert from 'node:assert/strict';
import { symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import { entry } from './assertions.ts';
import { temporary } from './helpers.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { nullable, object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const depth = 8;
const tags = ['__proto__', 'constructor', 'last'];
const repo = dirname(dirname(fileURLToPath(import.meta.url)));

function document() {
  const schemas: Record<string, Schema> = {
    Leaf: object({ text: { type: 'string', pattern: '^POM_LEAF$' } }),
  };
  let previous = 'Leaf';
  for (let level = 1; level <= depth; level++) {
    const mapping = tags.map((tag, index) => {
      const name = `Branch${level}_${index}`;
      schemas[name] = object({
        kind: { type: 'string', const: tag },
        value: ref(previous),
      });
      schemas[`${name}Alias`] = ref(name);
      return [tag, ref(`${name}Alias`).$ref] as const;
    });
    previous = `Union${level}`;
    schemas[previous] = {
      oneOf: mapping.map(([, $ref]) => ({ $ref })),
      discriminator: {
        propertyName: 'kind',
        mapping: Object.fromEntries(mapping),
      },
    };
  }
  const item = ref(previous);
  schemas.Containers = object({
    nullable: nullable(item),
    array: { type: 'array', items: item },
    map: { type: 'object', additionalProperties: item },
    optional: object({ selection: item }, []),
  });
  const operation = (operationId: string, schema: Schema) => {
    const content = { 'application/json': { schema } };
    return {
      post: {
        operationId,
        'x-pom': {
          auth: 'public',
          retry: 'never',
          timeout: 'interactive',
          surfaces: ['nested'],
        },
        requestBody: { required: true, content },
        responses: { 200: { description: 'Synthetic', content } },
      },
    };
  };
  return {
    openapi: '3.1.2',
    info: { title: 'Nested tagged unions', version: '1' },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['nested'],
    },
    components: { schemas },
    paths: {
      '/nested': operation('checkNested', item),
      '/containers': operation('checkContainers', ref('Containers')),
    },
  };
}

function nested(leaf: unknown, tagAt: (level: number) => string) {
  let body = leaf;
  for (let level = 0; level < depth; level++)
    body = { kind: tagAt(level), value: body };
  return body;
}

void test('nested tagged unions validate only the selected branches', async (t) => {
  const root = await temporary(t);
  await symlink(
    join(repo, 'node_modules'),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(
    await compile(document(), {
      clients: ['nested'],
      standalone: {
        output: { schema: ref(`Union${depth}`).$ref, usage: 'response' },
        containers: { schema: ref('Containers').$ref, usage: 'response' },
      },
    }),
  ))
    await writeFile(join(root, name), source);
  const { operations, RequestValidationError } = (await import(
    pathToFileURL(join(root, 'client.nested.ts')).href
  )) as RuntimeClient;
  const operation = entry(operations, 'checkNested');
  const { schema: responseSchema } = (await import(
    pathToFileURL(join(root, 'standalone.output.ts')).href
  )) as StandaloneModule;
  const containers = entry(operations, 'checkContainers');
  const { schema: containersSchema } = (await import(
    pathToFileURL(join(root, 'standalone.containers.ts')).href
  )) as StandaloneModule;
  const leafPath = [...Array.from({ length: depth }, () => 'value'), 'text'];

  await t.test(
    'valid first, middle, last and mixed tags read the leaf once',
    () => {
      for (const tag of [...tags, 'mixed']) {
        let reads = 0;
        const leaf = {
          get text() {
            reads++;
            return 'POM_LEAF';
          },
        };
        const body = nested(leaf, (level) =>
          tag === 'mixed' ? tags[level % tags.length]! : tag,
        );
        const built = operation.build({ body });
        assert.equal(reads, 1, tag);
        const expected = nested({ text: 'POM_LEAF' }, (level) =>
          tag === 'mixed' ? tags[level % tags.length]! : tag,
        );
        assert.deepEqual(built.body, expected);
        assert.notEqual(built.body, body);
      }
    },
  );

  await t.test(
    'an invalid leaf produces one request issue at its exact path',
    () => {
      let reads = 0;
      const body = nested(
        {
          get text() {
            reads++;
            return 'wrong';
          },
        },
        () => 'last',
      );
      assert.throws(
        () => operation.build({ body }),
        (error) => {
          assert.ok(error instanceof RequestValidationError);
          assert.equal(error.issues.length, 1);
          assert.deepEqual(error.issues[0]!.path, ['body', ...leafPath]);
          return true;
        },
      );
      assert.equal(reads, 1);
    },
  );

  await t.test(
    'response errors contain only the selected branch failure',
    () => {
      const result = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nested({ text: 'wrong' }, () => 'last')),
      });
      assert.equal(result.kind, 'protocol');
      assert.deepEqual(
        result.issues.map(({ part, path }) => ({ part, path })),
        [{ part: 'body', path: leafPath }],
      );
    },
  );

  await t.test('response validators read valid and invalid leaves once', () => {
    for (const text of ['POM_LEAF', 'wrong']) {
      let reads = 0;
      const body = nested(
        {
          get text() {
            reads++;
            return text;
          },
        },
        () => 'last',
      );
      const result = responseSchema.safeParse(body);
      assert.equal(reads, 1);
      assert.equal(result.success, text === 'POM_LEAF');
    }
  });

  await t.test(
    'containers validate each actual leaf once in both directions',
    () => {
      for (const text of ['POM_LEAF', 'wrong']) {
        let reads = 0;
        const item = nested(
          {
            get text() {
              reads++;
              return text;
            },
          },
          () => 'last',
        );
        const body = {
          nullable: item,
          array: [item, item],
          map: Object.fromEntries([
            ['__proto__', item],
            ['second', item],
          ]),
          optional: { selection: item },
        };
        if (text === 'POM_LEAF') containers.build({ body });
        else
          assert.throws(
            () => containers.build({ body }),
            RequestValidationError,
          );
        assert.equal(reads, 6);
        reads = 0;
        assert.equal(
          containersSchema.safeParse(body).success,
          text === 'POM_LEAF',
        );
        assert.equal(reads, 6);
      }
      const empty = { nullable: null, array: [], map: {}, optional: {} };
      assert.deepEqual(containers.build({ body: empty }).body, empty);
      assert.deepEqual(containersSchema.parse(empty), empty);
    },
  );

  await t.test(
    'responses strip additive fields through every selected branch',
    () => {
      const expected = nested({ text: 'POM_LEAF' }, () => 'constructor');
      const result = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expected, (_key, value: unknown) =>
          value !== null && typeof value === 'object'
            ? { ...value, extra: true }
            : value,
        ),
      });
      assert.equal(result.kind, 'success');
      assert.deepEqual(result.data, expected);
    },
  );

  await t.test(
    'unknown, missing and non-string tags fail before reading children',
    () => {
      for (const kind of ['toString', 'unknown', '', undefined, null, 1]) {
        let reads = 0;
        const body = {
          kind,
          get value() {
            reads++;
            return null;
          },
        };
        assert.throws(
          () => operation.build({ body }),
          (error) => {
            assert.ok(error instanceof RequestValidationError);
            assert.equal(error.issues.length, 1);
            assert.deepEqual(error.issues[0]!.path, ['body', 'kind']);
            return true;
          },
        );
        assert.equal(reads, 0);
      }
    },
  );
});
