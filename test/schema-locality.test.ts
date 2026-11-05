import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { present } from './assertions.ts';
import { queryFixture } from './query-fixture.ts';
import { object, ref } from './schema-helpers.ts';

void test('equal shapes retain component-local type names across directions and added components', async () => {
  const document = queryFixture();
  const value = object({ id: { type: 'string' } });
  Object.assign(document.components, {
    schemas: {
      Beta: value,
      Container: object({
        beta: ref('Beta'),
        inline: value,
        values: { type: 'array', items: value },
      }),
    },
  });
  const operation = {
    ...document.paths['/map'].get,
    operationId: 'checkBeta',
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref('Beta') } },
    },
    responses: {
      200: {
        description: 'Container',
        content: { 'application/json': { schema: ref('Container') } },
      },
    },
  };
  Object.assign(document, { paths: { '/beta': { post: operation } } });
  const original = await compile(document, { clients: ['consumer'] });
  const name = 'client.consumer.schemas.ts';
  const source = present(original[name]);
  for (const direction of ['request', 'response']) {
    assert.match(
      source,
      new RegExp(`type type_Beta_${direction} =\\s+import\\(`),
    );
  }
  const types = Object.entries(original)
    .filter(([name]) => name.startsWith('schema-types.'))
    .map(([, source]) => source)
    .join('\n');
  assert.match(types, /export type type_Beta_request = \{/);
  assert.match(types, /beta: type_Beta_request;/);
  Object.assign(document.components.schemas, { Alpha: value });
  Object.assign(document.paths, {
    '/alpha': {
      post: {
        ...operation,
        operationId: 'checkAlpha',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: ref('Alpha') } },
        },
        responses: {
          200: {
            description: 'Alpha',
            content: { 'application/json': { schema: ref('Alpha') } },
          },
        },
      },
    },
  });
  const expanded = present(
    (await compile(document, { clients: ['consumer'] }))[name],
  );
  for (const direction of ['request', 'response']) {
    const start = `type type_Beta_${direction} =`;
    const extract = (text: string) => {
      const begin = text.indexOf(start);
      const parser = text.indexOf(
        `export function parse_Beta_${direction}`,
        begin,
      );
      return text.slice(begin, text.indexOf('\n}\n', parser) + 3);
    };
    assert.equal(extract(expanded), extract(source));
  }
  const beforeReordering = await compile(document, { clients: ['consumer'] });
  Object.assign(document.components, {
    schemas: Object.fromEntries(
      Object.entries(document.components.schemas).reverse(),
    ),
  });
  Object.assign(document, {
    paths: Object.fromEntries(Object.entries(document.paths).reverse()),
  });
  assert.deepEqual(
    await compile(document, { clients: ['consumer'] }),
    beforeReordering,
  );
});
