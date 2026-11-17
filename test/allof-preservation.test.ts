import assert from 'node:assert/strict';
import test from 'node:test';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

function document(schemas: Record<string, Schema>, openapi: string) {
  return {
    openapi,
    info: { title: 'Synthetic allOf assertion preservation', version: '1' },
    paths: {},
    components: { schemas },
  };
}
const selection = (names: readonly string[]) => ({
  clients: [],
  standalone: Object.fromEntries(
    names.flatMap((name) =>
      (['request', 'response'] as const).map((usage) => [
        `${name.toLowerCase()}-${usage}`,
        { schema: ref(name).$ref, usage },
      ]),
    ),
  ),
});

void test('bare object assertions preserve recursive union references and required-only fields regardless of component order', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const keyword of ['anyOf', 'oneOf'])
      for (const [union, wrapper] of [
        ['AUnion', 'BNode'],
        ['ZUnion', 'ANode'],
      ] as const) {
        const schemas: Record<string, Schema> = {
          [union]: {
            [keyword]: [
              {
                type: 'object',
                properties: { next: ref(wrapper) },
                required: ['next'],
              },
              { type: 'object', required: ['x'] },
            ],
          },
          [wrapper]: { allOf: [ref(union), { type: 'object' }] },
        };
        const root = await generatedTestWorkspace(
          t,
          await compile(document(schemas, openapi), selection([wrapper])),
        );
        const oracle = new Ajv2020({ strict: false }).compile({
          ...ref(wrapper),
          components: { schemas },
        });
        for (const usage of ['request', 'response']) {
          const { schema } = await importGenerated<StandaloneModule>(
            root,
            `standalone.${wrapper.toLowerCase()}-${usage}.ts`,
          );
          for (const value of [
            {},
            { next: {} },
            { x: 1 },
            { next: { x: 2 } },
          ]) {
            assert.equal(schema.safeParse(value).success, oracle(value));
            if (oracle(value)) assert.deepEqual(schema.parse(value), value);
          }
        }
      }
});

void test('explicit arbitrary-value maps beside unions preserve required keys and every entry', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const additionalProperties of [true, {}]) {
      const required: Schema = { type: 'object', required: ['a'] };
      const map: Schema = { type: 'object', additionalProperties };
      const schemas: Record<string, Schema> = {
        Plain: { allOf: [required, map] },
        Wrapped: { allOf: [{ anyOf: [required] }, map] },
        Typed: { ...map, anyOf: [required] },
        Untyped: { additionalProperties, anyOf: [required] },
        Exact: { allOf: [{ oneOf: [required] }, map] },
      };
      const root = await generatedTestWorkspace(
        t,
        await compile(
          document(schemas, openapi),
          selection(Object.keys(schemas)),
        ),
      );
      for (const name of Object.keys(schemas))
        for (const usage of ['request', 'response']) {
          const { schema } = await importGenerated<StandaloneModule>(
            root,
            `standalone.${name.toLowerCase()}-${usage}.ts`,
          );
          const value = { a: 1, extra: 2 };
          const output = schema.parse(value);
          assert.deepEqual(output, value);
          assert.notEqual(output, value);
          assert.equal(schema.safeParse({ extra: 2 }).success, false);
        }
    }
});
