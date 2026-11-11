import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { entry } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

void test('multipart text constraints validate normalized values without changing other schema uses', async (t) => {
  const operation = (
    operationId: string,
    mediaType: string,
    schema: Schema,
  ) => ({
    operationId,
    requestBody: { required: true, content: { [mediaType]: { schema } } },
    responses: { 204: { description: 'Synthetic empty response' } },
  });
  const body: Schema = {
    type: 'object',
    properties: {
      length: { type: 'string', minLength: 4, maxLength: 4 },
      pattern: { type: 'string', pattern: '^a\r\nb$' },
      literal: { type: 'string', const: 'a\r\nb' },
      format: { type: 'string', format: 'line-pair' },
    },
    required: ['length', 'pattern', 'literal', 'format'],
  };
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic multipart text normalization', version: '1' },
    components: {
      schemas: {
        Body: body,
        BodyAlias: { ...ref('Body'), minProperties: 4 },
        Text: { type: 'string' },
      },
    },
    paths: {
      '/multipart': {
        post: operation('multipart', 'multipart/form-data', ref('BodyAlias')),
      },
      '/json': { post: operation('json', 'application/json', ref('Body')) },
      '/json-string': {
        post: operation('jsonString', 'application/json', ref('Text')),
      },
      '/text': { post: operation('text', 'text/plain', ref('Text')) },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(document, {
      clients: ['consumer'],
      surfaces: { consumer: ['multipart', 'json', 'jsonString', 'text'] },
      targets: { consumer: 'browser' },
      formats: { 'line-pair': { type: 'string', pattern: 'a\r\nb' } },
      standalone: {
        body: { schema: '#/components/schemas/Body', usage: 'request' },
      },
    }),
  );
  const { operations, RequestValidationError } =
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts');
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.body.ts',
  );
  const multipart = entry(operations, 'multipart');
  const input = Object.freeze({
    length: 'a\nb',
    pattern: 'a\nb',
    literal: 'a\nb',
    format: 'a\nb',
  });
  const expected = {
    length: 'a\r\nb',
    pattern: 'a\r\nb',
    literal: 'a\r\nb',
    format: 'a\r\nb',
  };
  assert.deepEqual(multipart.build({ body: input }).body, expected);
  assert.deepEqual(input, {
    length: 'a\nb',
    pattern: 'a\nb',
    literal: 'a\nb',
    format: 'a\nb',
  });
  for (const [key, value, message] of [
    ['length', '\n', /too short/],
    ['length', 'a\nbc', /too long/],
    ['pattern', 'a\nc', /pattern/],
    ['literal', 'a\nc', /expected/],
    ['format', 'a\nc', /line-pair format/],
  ] as const) {
    const invalid = Object.freeze({ ...input, [key]: value });
    assert.throws(
      () => multipart.build({ body: invalid }),
      (error) => {
        assert.ok(error instanceof RequestValidationError);
        assert.ok(
          error.issues.some(
            (issue) =>
              issue.path.join('.') === `body.${key}` &&
              message.test(issue.message),
          ),
          JSON.stringify(error.issues),
        );
        return true;
      },
    );
    assert.equal(invalid[key], value);
  }
  assert.throws(
    () => entry(operations, 'json').build({ body: input }),
    RequestValidationError,
  );
  assert.equal(schema.safeParse(input).success, false);
  assert.deepEqual(schema.parse(expected), expected);
  for (const operationId of ['jsonString', 'text'])
    for (const text of ['a\nb', 'a\rb', 'a\r\nb'])
      assert.equal(
        entry(operations, operationId).build({ body: text }).body,
        text,
      );
});
