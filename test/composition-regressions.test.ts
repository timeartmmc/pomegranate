import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile } from '../dist/index.js';
import type { CompileWarning } from '../dist/index.js';
import { record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function document(schemas: Record<string, Schema>, openapi = '3.1.2') {
  return {
    openapi,
    info: { title: 'Synthetic composition regressions', version: '1' },
    paths: {},
    components: { schemas },
  };
}

function selection(names: readonly string[]) {
  return {
    clients: [],
    standalone: Object.fromEntries(
      names.flatMap((name) =>
        (['request', 'response'] as const).map((usage) => [
          `${name.toLowerCase()}-${usage}`,
          { schema: ref(name).$ref, usage },
        ]),
      ),
    ),
  };
}

function nullable(type: string, rules: Schema, openapi: string): Schema {
  return {
    ...(openapi.startsWith('3.0.')
      ? { type, nullable: true }
      : { type: [type, 'null'] }),
    ...rules,
  };
}

void test('enum narrowing through composed nullable references retains viable null and scalar values', async (t) => {
  const cases = [
    {
      name: 'String',
      type: 'string',
      first: { minLength: 2 },
      second: { maxLength: 3 },
      excluded: 'a',
      retained: 'ab',
    },
    {
      name: 'Number',
      type: 'number',
      first: { minimum: 0 },
      second: { multipleOf: 2 },
      excluded: 1,
      retained: 2,
    },
    {
      name: 'Integer',
      type: 'integer',
      first: { minimum: 0 },
      second: { maximum: 4 },
      excluded: 1.5,
      retained: 2,
    },
  ];
  for (const openapi of ['3.0.4', '3.1.2']) {
    const schemas: Record<string, Schema> = {};
    const names: string[] = [];
    for (const item of cases) {
      const composed = {
        allOf: [
          nullable(item.type, item.first, openapi),
          nullable(item.type, item.second, openapi),
        ],
      };
      let source = ref(`${item.name}Source`);
      if (item.name === 'Integer') {
        schemas.Holder = {
          type: 'object',
          properties: { value: composed },
        };
        schemas.IntegerSource = {
          $ref: '#/components/schemas/Holder/properties/value',
        };
      } else {
        schemas[`${item.name}Source`] = composed;
        if (item.name === 'Number') {
          schemas.NumberAlias = ref('NumberSource');
          schemas.NumberAlias2 = ref('NumberAlias');
          source = ref('NumberAlias2');
        }
      }
      for (const suffix of ['Null', 'Mixed']) {
        const name = `${item.name}${suffix}`;
        schemas[name] = {
          allOf: [
            source,
            {
              enum:
                suffix === 'Null'
                  ? [item.excluded, null]
                  : [item.excluded, item.retained, null],
            },
          ],
        };
        names.push(name);
      }
    }
    const warnings: CompileWarning[] = [];
    const root = await generatedTestWorkspace(
      t,
      await compile(document(schemas, openapi), {
        ...selection(names),
        onWarning: (warning) => warnings.push(warning),
      }),
    );
    assert.deepEqual(warnings, []);
    for (const item of cases)
      for (const suffix of ['Null', 'Mixed']) {
        const oracle = new Ajv2020({ strict: false }).compile({
          allOf: [
            { type: [item.type, 'null'], ...item.first },
            { type: [item.type, 'null'], ...item.second },
            {
              enum:
                suffix === 'Null'
                  ? [item.excluded, null]
                  : [item.excluded, item.retained, null],
            },
          ],
        });
        for (const usage of ['request', 'response']) {
          const { schema } = await importGenerated<StandaloneModule>(
            root,
            `standalone.${item.name.toLowerCase()}${suffix.toLowerCase()}-${usage}.ts`,
          );
          for (const value of [
            null,
            item.excluded,
            item.retained,
            '',
            -1,
            false,
            {},
            [],
          ]) {
            assert.equal(
              schema.safeParse(value).success,
              oracle(value),
              `${openapi} ${item.name}${suffix} ${usage}: ${JSON.stringify(value)}`,
            );
            if (oracle(value)) assert.equal(schema.parse(value), value);
          }
        }
      }
  }
});

void test('nullable composition warnings retain written origins without blaming narrowed references', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const composed = {
      allOf: [
        nullable('string', { minLength: 2 }, openapi),
        nullable('string', { maxLength: 3 }, openapi),
      ],
    };
    const warnings: CompileWarning[] = [];
    const root = await generatedTestWorkspace(
      t,
      await compile(
        document(
          {
            Source: composed,
            Referenced: { allOf: [ref('Source'), { enum: ['ab'] }] },
            Inline: { allOf: [composed, { enum: ['ab'] }] },
          },
          openapi,
        ),
        {
          ...selection(['Source', 'Referenced', 'Inline']),
          onWarning: (warning) => warnings.push(warning),
        },
      ),
    );
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'ignored-schema-keyword');
    assert.equal(
      warnings[0]?.path,
      'components.schemas.Inline.allOf[0].allOf[0].type',
    );
    assert.match(warnings[0].message, /2 occurrences/);
    for (const usage of ['request', 'response']) {
      const source = await importGenerated<StandaloneModule>(
        root,
        `standalone.source-${usage}.ts`,
      );
      assert.equal(source.schema.parse(null), null);
      for (const name of ['referenced', 'inline']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${name}-${usage}.ts`,
        );
        assert.equal(schema.parse('ab'), 'ab');
        assert.equal(schema.safeParse(null).success, false);
        assert.equal(schema.safeParse('abc').success, false);
      }
    }
  }
});

void test('nullable enum narrowing preserves explicit oneOf overlap rejection', async (t) => {
  const oracle = new Ajv2020({ strict: false }).compile({
    allOf: [
      {
        oneOf: [
          {
            allOf: [
              { type: ['integer', 'null'], minimum: 0 },
              { type: ['integer', 'null'], maximum: 4 },
            ],
          },
          { type: 'integer', enum: [2] },
        ],
      },
      { enum: [-1, 2, 4, null] },
    ],
  });
  for (const openapi of ['3.0.4', '3.1.2']) {
    const root = await generatedTestWorkspace(
      t,
      await compile(
        document(
          {
            SourceBase: {
              allOf: [
                nullable('integer', { minimum: 0 }, openapi),
                nullable('integer', { maximum: 4 }, openapi),
              ],
            },
            Choice: {
              allOf: [
                {
                  oneOf: [ref('SourceBase'), { type: 'integer', enum: [2] }],
                },
                { enum: [-1, 2, 4, null] },
              ],
            },
          },
          openapi,
        ),
        selection(['Choice']),
      ),
    );
    for (const usage of ['request', 'response']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.choice-${usage}.ts`,
      );
      for (const value of [-1, 0, 1, 2, 3, 4, 5, null, false, '4']) {
        const expected = value === 4 || value === null;
        assert.equal(oracle(value), expected);
        assert.equal(schema.safeParse(value).success, expected);
        if (expected) assert.equal(schema.parse(value), value);
      }
    }
  }
});

void test('neutral recursive object wrappers preserve constraints, closure and directional fields through containers', async (t) => {
  const node = ref('Node');
  const edge = (type: Schema): Schema => ({ allOf: [node, type] });
  const warnings: CompileWarning[] = [];
  const root = await generatedTestWorkspace(
    t,
    await compile(
      document({
        Bare: { type: 'object' },
        BareAlias: ref('Bare'),
        Node: {
          allOf: [
            {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'integer', minimum: 0 },
                label: { type: 'string' },
                next: edge({ type: 'object' }),
                kids: {
                  type: 'array',
                  items: edge({ type: ['object', 'null'] }),
                },
                index: {
                  type: 'object',
                  additionalProperties: edge(ref('BareAlias')),
                },
                server: { type: 'string', readOnly: true },
                secret: { type: 'string', writeOnly: true },
              },
              required: ['id', 'label', 'server', 'secret'],
            },
            {
              type: 'object',
              properties: {
                id: { type: 'number', multipleOf: 2 },
                label: { type: 'string', minLength: 1 },
              },
            },
          ],
        },
        Exact: { oneOf: [node, { type: 'boolean' }] },
      }),
      {
        ...selection(['Node', 'Exact']),
        onWarning: (warning) => warnings.push(warning),
      },
    ),
  );
  assert.deepEqual(
    warnings.map(({ code, path }) => ({ code, path })),
    [
      {
        code: 'ignored-schema-keyword',
        path: 'components.schemas.Node.allOf[0].properties.kids.items.allOf[1].type',
      },
    ],
  );
  for (const usage of ['request', 'response']) {
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      `standalone.node-${usage}.ts`,
    );
    const exact = await importGenerated<StandaloneModule>(
      root,
      `standalone.exact-${usage}.ts`,
    );
    const visible = usage === 'request' ? 'secret' : 'server';
    const child = { id: 2, label: 'child', [visible]: 'child-value' };
    const input = {
      id: 0,
      label: 'root',
      [visible]: 'root-value',
      next: child,
      kids: [child, child],
      index: { a: child, b: child },
    };
    const output = record(schema.parse(input));
    assert.deepEqual(output, input);
    assert.deepEqual(exact.schema.parse(input), input);
    assert.ok(Array.isArray(output.kids));
    const index = record(output.index);
    const children = [output.next, ...output.kids, index.a, index.b];
    assert.equal(new Set(children).size, 5);
    for (const parsed of children) assert.notEqual(parsed, child);
    for (const changed of [
      { ...child, id: 1 },
      { ...child, id: -2 },
      { ...child, label: '' },
      { [visible]: 'missing-id-and-label' },
      null,
    ])
      for (const value of [
        { ...input, next: changed },
        { ...input, kids: [changed] },
        { ...input, index: { a: changed } },
      ])
        assert.equal(schema.safeParse(value).success, false);
    const extra = { ...child, extra: true };
    const withExtra = { ...input, next: extra };
    assert.equal(exact.schema.safeParse(withExtra).success, false);
    if (usage === 'request') {
      assert.equal(schema.safeParse(withExtra).success, false);
      assert.equal(
        schema.safeParse({ ...input, next: { ...child, server: 'forbidden' } })
          .success,
        false,
      );
    } else {
      assert.deepEqual(schema.parse(withExtra), input);
      assert.deepEqual(
        schema.parse({ ...input, next: { ...child, secret: 'omitted' } }),
        input,
      );
    }
  }
});

void test('neutral recursive shortcuts do not admit recursive merging or hide invalid assertions', async () => {
  const recursive = (other: Schema): Schema => ({
    type: 'object',
    properties: {
      id: { type: 'integer' },
      next: { allOf: [ref('Node'), other] },
    },
    required: ['id'],
  });
  await assert.rejects(
    compile(
      document({
        Node: recursive({
          type: 'object',
          properties: { label: { type: 'string' } },
          required: ['label'],
        }),
      }),
      selection(['Node']),
    ),
    /recursive allOf object expansion is unsupported/,
  );
  await assert.rejects(
    compile(
      document({ Node: recursive({ type: 'object', minimumTypo: 1 }) }),
      selection(['Node']),
    ),
    /minimumTypo.*unsupported keyword/,
  );
  await assert.rejects(
    compile(
      document({ Node: recursive({ type: 'object', minProperties: 'bad' }) }),
      selection(['Node']),
    ),
    /minProperties.*nonnegative safe integer/,
  );
});
