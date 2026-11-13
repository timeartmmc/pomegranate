import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { MediaClient } from './media-fixture.ts';
import type { Schema } from './schema-helpers.ts';

const selection = { clients: ['api'], surfaces: { api: ['echo'] } };
function document(
  content: Record<string, { schema: Schema }>,
  openapi = '3.1.2',
) {
  return {
    openapi,
    info: { title: 'Synthetic media interoperability', version: '1' },
    paths: {
      '/echo': {
        post: {
          operationId: 'echo',
          requestBody: { required: true, content },
          responses: { 200: { description: 'Echo', content } },
        },
      },
    },
  };
}
const textTypes = [
  'text/html',
  'text/csv',
  'text/markdown',
  'text/x-markdown',
  'text/x-diff',
  'text/x-patch',
  'text/calendar',
  'text/yaml',
  'text/x-yaml',
  'application/yaml',
  'application/x-yaml',
];

void test('JSON aliases and textual representations select the same decoder for requests and responses', async (t) => {
  for (const media of ['text/json', ...textTypes]) {
    const value = 'name,description\nexample,<p>text</p>';
    const content = { [media]: { schema: { type: 'string', minLength: 2 } } };
    const expected = await compile(document(content), selection);
    assert.deepEqual(
      await compile(document(content, '3.0.4'), selection),
      expected,
    );
    const root = await generatedTestWorkspace(t, expected);
    const client = await importGenerated<MediaClient>(root, 'client.api.ts');
    const operation = present(client.operations.echo);
    const built = operation.build({ body: value });
    const kind = media === 'text/json' ? 'json' : 'text';
    assert.equal(built.bodyKind, kind);
    assert.equal(built.body, value);
    assert.throws(
      () => operation.build({ body: 'x' }),
      client.RequestValidationError,
    );
    const result = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': `${media}; charset=utf-8` },
      body: kind === 'json' ? JSON.stringify(value) : value,
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.contentType, media);
    assert.equal(result.data, value);
    assert.equal(
      operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': media },
        body: kind === 'json' ? 'not json' : 'x',
      }).kind,
      'protocol',
    );
  }
});

void test('charset declarations preserve request headers and normalize response dispatch without mutating inputs', async (t) => {
  const content = {
    'Application/JSON; Charset="UTF-8"': { schema: { type: 'integer' } },
    'text/plain; charset=iso-8859-1': { schema: { type: 'string' } },
    'application/a+json': { schema: { type: 'boolean' } },
  };
  const source = document(content);
  const before = structuredClone(source);
  const files = await compile(source, selection);
  assert.deepEqual(
    await compile(parseYaml(stringify(source), 'charset.yaml'), selection),
    files,
  );
  assert.deepEqual(source, before);
  const root = await generatedTestWorkspace(t, files);
  const operation = present(
    (await importGenerated<MediaClient>(root, 'client.api.ts')).operations.echo,
  );
  const built = operation.build({ body: 2 });
  assert.equal(built.bodyKind, 'json');
  if (built.bodyKind === 'json')
    assert.equal(built.contentType, 'application/json; charset=utf-8');
  for (const [type, body, data] of [
    ['application/json', '2', 2],
    ['application/json; charset=utf-8', '2', 2],
    ['text/plain; charset=iso-8859-1', 'café', 'café'],
  ] as const) {
    const result = operation.parseResponse({
      status: 200,
      headers: { 'Content-Type': type },
      body,
    });
    assert.equal(result.kind, 'success');
    assert.equal(result.data, data);
    assert.equal(result.contentType, type.split(';')[0]);
  }
});

void test('unsupported media and parameters, ambiguous declarations and non-string textual schemas fail explicitly', async () => {
  for (const media of [
    'application/json;stream=watch',
    'application/json;charset=',
    'application/json;charset="utf;8"',
    'application/json;charset=utf-8;version=1',
    'application/json;charset=utf-8;charset=utf-8',
    'application/json; charset=utf-8\r\n',
    'application/json; charset=utf-8\n',
    'multipart/form-data;charset=utf-8',
    'text/event-stream',
    'application/x-ndjson',
    'text/xml',
  ])
    await assert.rejects(
      compile(document({ [media]: { schema: { type: 'string' } } }), selection),
      ContractError,
    );
  await assert.rejects(
    compile(
      document({
        'application/json': { schema: { type: 'string' } },
        'application/json; charset=utf-8': { schema: { type: 'integer' } },
      }),
      selection,
    ),
    /duplicate.*media type/,
  );
  for (const media of textTypes)
    for (const schema of [{ type: 'integer' }, { type: ['string', 'null'] }])
      await assert.rejects(
        compile(document({ [media]: { schema } }), selection),
        /requires a nonnullable string schema/,
      );
});
