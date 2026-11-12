import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { stringify } from 'yaml';
import { parseYaml } from '../dist/yaml.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  serializationFixture,
  serializationSelection,
  verifySerialization,
  verifyFormSerialization,
} from './serialization-fixture.ts';
import type { MediaClient } from './media-fixture.ts';
import type { StandaloneModule } from './runtime-types.ts';

void test('typed headers serialize and validate without changing raw evidence or standalone schemas', async (t) => {
  const files = await compile(serializationFixture(), serializationSelection);
  assert.deepEqual(
    await compile(serializationFixture(false), serializationSelection),
    files,
  );
  assert.deepEqual(
    await compile(
      parseYaml(stringify(serializationFixture()), 'serialization.yaml'),
      serializationSelection,
    ),
    files,
  );
  const root = await generatedTestWorkspace(t, files);
  verifySerialization(
    await importGenerated<MediaClient>(root, 'client.consumer.ts'),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.count.ts',
  );
  assert.equal(schema.parse(2), 2);
  assert.equal(schema.safeParse('2').success, false);
});

void test('flat form bodies encode scalar and array values once while preserving optionality', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(serializationFixture(), serializationSelection),
  );
  verifyFormSerialization(
    await importGenerated<MediaClient>(root, 'client.consumer.ts'),
  );
});

void test('form schemas and encoding reject unsupported semantics before files change', async () => {
  for (const schema of [
    { type: 'object', additionalProperties: true },
    { type: 'object', properties: { nested: { type: 'object' } } },
    { type: 'object', properties: { nullable: { type: ['string', 'null'] } } },
    {
      type: 'object',
      properties: { file: { type: 'string', format: 'binary' } },
    },
  ]) {
    const document = serializationFixture();
    Object.assign(document.components.schemas, { Form: schema });
    await assert.rejects(
      compile(document, serializationSelection),
      ContractError,
    );
  }
  for (const encoding of [
    null,
    { missing: {} },
    { ids: { style: 'deepObject' } },
    { ids: { explode: 'yes' } },
    { ids: { allowReserved: true } },
    { ids: { contentType: 'application/json' } },
  ]) {
    const document = serializationFixture();
    Object.assign(
      document.paths['/form'].post.requestBody.content[
        'application/x-www-form-urlencoded'
      ],
      { encoding },
    );
    await assert.rejects(
      compile(document, serializationSelection),
      ContractError,
    );
  }
  const document = serializationFixture();
  Object.assign(document.paths['/form'].post.requestBody, {
    content: {
      'application/x-www-form-urlencoded; charset=iso-8859-1':
        document.paths['/form'].post.requestBody.content[
          'application/x-www-form-urlencoded'
        ],
    },
  });
  await assert.rejects(
    compile(document, serializationSelection),
    /require UTF-8/,
  );
});

void test('unexploded form arrays keep literal delimiter commas and percent-encode commas inside data', async (t) => {
  const document = serializationFixture();
  Object.assign(
    document.paths['/form'].post.requestBody.content[
      'application/x-www-form-urlencoded'
    ].encoding,
    { tags: { explode: false } },
  );
  const root = await generatedTestWorkspace(
    t,
    await compile(document, serializationSelection),
  );
  const { operations } = await importGenerated<MediaClient>(
    root,
    'client.consumer.ts',
  );
  const tags = ['alpha,beta', 'a b', 'c+d', 'p%q', 'x&y'];
  const request = present(operations.submit).build({
    body: { name: 'demo', count: 0, enabled: false, tags },
  });
  assert.equal(request.bodyKind, 'form');
  if (request.bodyKind !== 'form') return;
  const pair = present(
    request.body.split('&').find((part) => part.startsWith('tags=')),
  );
  assert.equal(pair, 'tags=alpha%2Cbeta,a%20b,c%2Bd,p%25q,x%26y');
  assert.deepEqual(
    pair
      .slice('tags='.length)
      .split(',')
      .map((part) => decodeURIComponent(part)),
    tags,
  );
});

void test('recursive array components receive wire-shape diagnostics in request headers, response headers and forms', async () => {
  for (const position of ['request', 'response', 'form']) {
    const document = serializationFixture();
    const loop = { $ref: '#/components/schemas/Loop' };
    Object.assign(document.components.schemas, {
      Loop: { type: 'array', items: loop },
    });
    if (position === 'request')
      Object.assign(document.paths['/headers'].get.parameters[0]!, {
        schema: loop,
      });
    else if (position === 'response')
      Object.assign(
        document.paths['/headers'].get.responses[200].headers['X-Count'],
        { schema: loop },
      );
    else
      Object.assign(present(document.components.schemas.Form.properties), {
        loop,
      });
    await assert.rejects(compile(document, serializationSelection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /primitive/);
      assert.match(
        error.location,
        position === 'form'
          ? /^paths\.\/form\.post\.requestBody/
          : /^paths\.\/headers\.get/,
      );
      return true;
    });
  }
});
