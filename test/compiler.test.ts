import assert from 'node:assert/strict';
import test from 'node:test';
import { symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile as compileDocument, ContractError } from '../dist/index.js';
import { present } from './assertions.ts';
import { fixture, preparation, temporary } from './helpers.ts';
import type { Fixture } from './helpers.ts';

const compile = (document: unknown) =>
  compileDocument(document, { clients: ['consumer', 'staff'] });

for (const name of [
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
  'sec-fetch-site',
  'proxy-custom',
]) {
  void test(`rejects the transport-owned request header ${name} before selection`, async () => {
    for (const spelling of [name, name.toUpperCase()]) {
      const document = fixture();
      preparation(document).parameters.push({
        name: spelling,
        in: 'header',
        required: true,
        schema: { type: 'string' },
      });
      await assert.rejects(
        compileDocument(document, {
          clients: ['staff'],
          transportHeaders: [spelling],
        }),
        (error) =>
          error instanceof ContractError &&
          /reserved request header/.test(error.message),
        spelling,
      );
    }
  });
}

void test('accepts custom header names beside reserved names and prefixes', async () => {
  const document = fixture();
  for (const name of [
    'X-Host',
    'Proxy',
    'Sec',
    'X-Proxy-Custom',
    'X-Sec-Fetch-Site',
  ])
    preparation(document).parameters.push({
      name,
      in: 'header',
      required: true,
      schema: { type: 'string' },
    });
  await compile(document);
});

void test('header parameters reject non-string schemas, including optional nullable values', async () => {
  for (const type of ['number', 'integer', 'boolean'])
    for (const nullable of [false, true]) {
      const document = fixture();
      preparation(document).parameters.push({
        name: 'X-Value',
        in: 'header',
        schema: { type: nullable ? [type, 'null'] : type },
      });
      await assert.rejects(compile(document), (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(error.location, /parameters\[\d+\]\.schema$/);
        assert.match(
          error.message,
          /header parameters require string schemas|optional nullable string headers/,
        );
        return true;
      });
    }
});

void test('redirect and error responses cannot satisfy the required success response', async () => {
  for (const status of [300, 302, 400, '3XX', '5XX']) {
    const document = fixture();
    Object.assign(preparation(document), {
      responses: { [status]: { description: 'No successful response' } },
    });
    await assert.rejects(compile(document), {
      name: 'ContractError',
      message:
        /responses: at least one 2xx, 2XX or default response is required/,
    });
  }
});

for (const name of ['Set-Cookie', 'sEt-CoOkIe2']) {
  for (const required of [false, true]) {
    void test(`rejects ${required ? 'required' : 'optional'} Fetch-hidden response header ${name}`, async () => {
      const document = fixture();
      Object.assign(preparation(document).responses['202'].headers, {
        [name]: {
          required,
          schema: { type: 'string' },
        },
      });
      await assert.rejects(
        compile(document),
        /response header is unavailable to browser Fetch/,
      );
    });
  }
}

void test('invalid placeholder identifiers explain the name restriction', async () => {
  for (const name of ['widget-id', '9widget', '']) {
    const document = fixture();
    Object.assign(document, {
      paths: {
        [`/api/widgets/{${name}}`]: document.paths['/api/widgets/{widgetId}'],
      },
    });
    await assert.rejects(
      compile(document),
      /path placeholder names must match/,
    );
  }
});

void test('compiles every supported method and keeps per-status responses distinct', async (t) => {
  const outputs = await compile(fixture());
  assert.deepEqual(
    Object.keys(outputs)
      .filter((name) => !name.startsWith('schema-types.'))
      .sort(),
    [
      'client.consumer.operations.ts',
      'client.consumer.schemas.ts',
      'client.consumer.ts',
      'client.staff.operations.ts',
      'client.staff.schemas.ts',
      'client.staff.ts',
      'endpoint-runtime.ts',
      'policy-types.ts',
      'runtime.ts',
    ],
  );
  for (const id of [
    'prepareWidget',
    'getWidget',
    'checkHealth',
    'widgetOptions',
  ])
    assert.ok(present(outputs['client.consumer.operations.ts']).includes(id));
  const root = await temporary(t);
  await symlink(
    fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  for (const [name, source] of Object.entries(outputs))
    await writeFile(join(root, name), source);
  const { operations } = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as typeof import('./.generated/example/client.consumer.ts');
  assert.equal(operations.checkHealth.build().method, 'HEAD');
  assert.equal(operations.widgetOptions.build().method, 'OPTIONS');
  const pending = {
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': 'synthetic',
    },
    body: JSON.stringify({ state: 'pending', reference: 'synthetic' }),
  };
  assert.equal(
    operations.prepareWidget.parseResponse({ ...pending, status: 202 }).kind,
    'success',
  );
  assert.equal(
    operations.prepareWidget.parseResponse({ ...pending, status: 200 }).kind,
    'protocol',
  );
  assert.doesNotMatch(
    Object.values(outputs).join('\n'),
    /@pomegranate\/compiler|\/Users\/|\/home\//,
  );
  for (const source of Object.values(outputs))
    for (const [, specifier] of source.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g))
      assert.ok(
        present(specifier).startsWith('./'),
        `Unexpected generated import: ${specifier}`,
      );
});

void test('generation is deterministic and leaves the input object intact', async () => {
  const document = fixture();
  const before = structuredClone(document);
  assert.deepEqual(await compile(document), await compile(document));
  assert.deepEqual(document, before);
});

const unsupported: [string, (d: Fixture) => void, RegExp][] = [
  [
    'body-bearing 205 response',
    (d) => {
      Object.assign(preparation(d).responses, {
        205: structuredClone(preparation(d).responses['202']),
      });
    },
    /responses\.205\.content: this HTTP method\/status cannot carry a body/,
  ],
  [
    'HEAD request body',
    (d) => {
      Object.assign(d.paths['/api/health'].head, {
        requestBody: structuredClone(preparation(d).requestBody),
      });
    },
    /head\.requestBody: HEAD bodies are unsupported/,
  ],
  [
    'interim response status',
    (d) => {
      Object.assign(preparation(d).responses, {
        101: { description: 'An interim response is not a final response' },
      });
    },
    /responses\.101: expected a final HTTP status 200–599, a range 2XX–5XX or default/,
  ],
  [
    'duplicate case-insensitive response headers',
    (d) => {
      Object.assign(preparation(d).responses['202'].headers, {
        'x-request-id': { schema: { type: 'string', const: 'different' } },
      });
    },
    /responses\.202\.headers\.x-request-id: duplicate case-insensitive header/,
  ],
  [
    'two null oneOf branches',
    (d) => {
      Object.assign(d.components.schemas, {
        DuplicateNull: { oneOf: [{ type: 'null' }, { type: 'null' }] },
      });
    },
    /components\.schemas\.DuplicateNull: oneOf alternatives without a discriminator must accept disjoint JSON types/,
  ],
  [
    'unknown HTTP method',
    (d) => {
      Object.assign(d.paths, {
        '/api/trace': {
          trace: structuredClone(d.paths['/api/health'].head),
        },
      });
    },
    /trace.*unsupported keyword/,
  ],
  [
    'unresolved path-level parameter references',
    (d) => {
      Object.assign(d.paths['/api/health'], {
        parameters: [{ $ref: '#/components/parameters/Health' }],
      });
    },
    /\$ref.*unresolved parameter reference Health/,
  ],
  [
    'malformed Unicode query name',
    (d) => {
      preparation(d).parameters.push({
        name: '\ud800',
        in: 'query',
        schema: { type: 'string' },
      });
    },
    /query parameter names must contain well-formed Unicode/,
  ],
  [
    'operation security',
    (d) => {
      Object.assign(preparation(d), { security: [{ AnyBearerName: [] }] });
    },
    /undeclared security scheme/,
  ],
  [
    'document security',
    (d) => {
      Object.assign(d, { security: [{ AnyBearerName: [] }] });
    },
    /undeclared security scheme/,
  ],
  [
    'security schemes',
    (d) => {
      Object.assign(d.components.securitySchemes, {
        Other: { type: 'http', scheme: 'digest' },
      });
    },
    /unsupported security scheme/,
  ],
  [
    'semantic extension',
    (d) => {
      Object.assign(preparation(d), { 'x-multi-segment': {} });
    },
    /x-multi-segment.*unsupported semantic extension/,
  ],
  [
    'policy version',
    (d) => {
      d['x-pom-policy'].version = 1;
    },
    /policy version 3/,
  ],
  [
    'undeclared policy',
    (d) => {
      preparation(d)['x-pom'].auth = 'member';
    },
    /undeclared policy label/,
  ],
  [
    'unknown policy semantics',
    (d) => {
      preparation(d)['x-pom'].surfaces = ['public'];
    },
    /undeclared surface/,
  ],
  [
    'interim status range',
    (d) => {
      Object.assign(preparation(d).responses, {
        '1XX': { description: 'Interim' },
      });
    },
    /responses\.1XX: expected a final HTTP status/,
  ],
  [
    'lowercase status range',
    (d) => {
      Object.assign(preparation(d).responses, {
        '4xx': { description: 'Error' },
      });
    },
    /responses\.4xx: expected a final HTTP status/,
  ],
  [
    'external reference',
    (d) => {
      Object.assign(d.components.schemas, {
        Widget: { $ref: './other.json#/Widget' },
      });
    },
    /only local component/,
  ],
  [
    'missing reference',
    (d) => {
      Object.assign(d.components.schemas, {
        Widget: { $ref: '#/components/schemas/Missing' },
      });
    },
    /unresolved reference/,
  ],
  [
    'nonproductive recursive alias',
    (d) => {
      Object.assign(d.components.schemas, {
        Widget: { $ref: '#/components/schemas/Widget' },
      });
    },
    /recursive schemas/,
  ],
  [
    'reference constraints',
    (d) => {
      Object.assign(d.components.schemas, {
        Widget: {
          $ref: '#/components/schemas/Problem',
          minLength: 1,
        },
      });
    },
    /minLength.*unsupported on referenced object/,
  ],
  [
    'overlapping oneOf',
    (d) => {
      Object.assign(d.components.schemas, {
        Widget: {
          oneOf: [{ type: 'string' }, { type: 'string', format: 'uuid' }],
        },
      });
    },
    /oneOf alternatives without a discriminator must accept disjoint JSON types/,
  ],
  [
    'invalid readOnly annotation',
    (d) => {
      Object.assign(d.components.schemas.Widget.properties.id, {
        readOnly: 'true',
      });
    },
    /readOnly.*expected a boolean/,
  ],
  [
    'schema format',
    (d) => {
      Object.assign(d.components.schemas.Widget.properties, {
        id: {
          type: 'string',
          format: false,
        },
      });
    },
    /format.*expected a string/,
  ],
  [
    'malformed response default',
    (d) => {
      Object.assign(d.components.schemas.Pending.properties.reference, {
        default: undefined,
      });
    },
    /default.*expected an object/,
  ],
  [
    'dynamic map',
    (d) => {
      Object.assign(d.components.schemas.Widget, {
        additionalProperties: true,
      });
    },
    /mixed fixed properties and dynamic maps/,
  ],
  [
    'malformed request body required flag',
    (d) => {
      Object.assign(preparation(d).requestBody, { required: 'false' });
    },
    /requestBody.required.*expected a boolean/,
  ],
  [
    'multipart without a client target',
    (d) => {
      Object.assign(preparation(d).requestBody, {
        content: {
          'multipart/form-data': {
            schema: { type: 'object', additionalProperties: false },
          },
        },
      });
    },
    /multipart clients require an explicit/,
  ],
  [
    'free-form multipart object',
    (d) => {
      Object.assign(preparation(d).requestBody, {
        content: { 'multipart/form-data': { schema: { type: 'object' } } },
      });
    },
    /multipart requires a fixed object of text and file fields/,
  ],
  [
    'nullable required array',
    (d) => {
      Object.assign(d.components.schemas.Widget, { required: null });
    },
    /expected an array/,
  ],
  [
    'nullable properties map',
    (d) => {
      Object.assign(d.components.schemas.Widget, { properties: null });
    },
    /expected an object/,
  ],
  [
    'nullable components',
    (d) => {
      Object.assign(d, { components: null });
    },
    /expected an object/,
  ],
  [
    'partial placeholder',
    (d) => {
      Object.assign(d.paths, {
        '/api/prefix-{id}': structuredClone(d.paths['/api/health']),
      });
    },
    /complete segment/,
  ],
  [
    'static dot segment',
    (d) => {
      Object.assign(d.paths, {
        '/api/../unsafe': structuredClone(d.paths['/api/health']),
      });
    },
    /dot segments/,
  ],
  [
    'missing placeholder declaration',
    (d) => {
      preparation(d).parameters.shift();
    },
    /must match exactly/,
  ],
  [
    'duplicate operation',
    (d) => {
      d.paths['/api/health'].head.operationId = 'getWidget';
    },
    /duplicate operation identifier/,
  ],
  [
    'duplicate header casing',
    (d) => {
      preparation(d).parameters.push({
        name: 'idempotency-key',
        in: 'header',
        schema: { type: 'string' },
      });
    },
    /duplicate parameter/,
  ],
  [
    'reserved request header',
    (d) => {
      preparation(d).parameters.push({
        name: 'Cookie',
        in: 'header',
        schema: { type: 'string' },
      });
    },
    /reserved request header/,
  ],
  [
    'body on 204',
    (d) => {
      Object.assign(d.paths['/api/health'].head.responses['204'], {
        content: {
          'application/json': { schema: { type: 'null' } },
        },
      });
    },
    /cannot carry a body/,
  ],
  [
    'unsupported unused component',
    (d) => {
      Object.assign(d.components.schemas, {
        Unused: {
          type: 'string',
          contentEncoding: 'base64',
        },
      });
    },
    /contentEncoding.*unsupported keyword/,
  ],
];

for (const [name, mutate, message] of unsupported) {
  void test(`rejects ${name} explicitly`, async () => {
    const document = fixture();
    mutate(document);
    await assert.rejects(
      compile(document),
      (error) => error instanceof ContractError && message.test(error.message),
    );
  });
}

void test('allows a public override and multiple documentation tags', async () => {
  const document = fixture();
  Object.assign(preparation(document), { security: [] });
  preparation(document)['x-pom'].auth = 'public';
  await compile(document);
});

void test('rejects header declarations with terminal line breaks or non-ASCII case-folding aliases', async () => {
  for (const name of ['X-Name\n', 'X-Name\r', 'X-Name\u2028', 'X-\u212Aey']) {
    const request = fixture();
    preparation(request).parameters.push({
      name,
      in: 'header',
      schema: { type: 'string' },
    });
    await assert.rejects(compile(request), /invalid HTTP header name/);
    const response = fixture();
    Object.assign(preparation(response).responses['202'].headers, {
      [name]: {
        schema: { type: 'string' },
      },
    });
    await assert.rejects(compile(response), /invalid HTTP header name/);
  }
});

void test('rejects request header keys that become reserved after case folding', async () => {
  for (const name of ['__PROTO__', '__pRoTo__', 'CONSTRUCTOR', 'Prototype']) {
    const document = fixture();
    preparation(document).parameters.push({
      name,
      in: 'header',
      required: true,
      schema: { type: 'string', const: 'must-match' },
    });
    for (const transportHeaders of [[], [name]])
      await assert.rejects(
        compileDocument(document, {
          clients: ['consumer'],
          transportHeaders,
        }),
        /parameters\[.*\]\.name: unsupported object key/,
      );
  }
});

void test('rejects invalid constraints instead of emitting an impossible validator', async () => {
  const document = fixture();
  Object.assign(document.components.schemas.Widget.properties, {
    label: {
      type: 'string',
      const: '😀',
      maxLength: 1,
    },
  });
  await compile(document);
  Object.assign(document.components.schemas.Widget.properties.label, {
    maxLength: 0,
  });
  await assert.rejects(compile(document), /literal violates declared bounds/);
});

const prototypeFields: [string, (d: Fixture) => void][] = [
  [
    'optional response',
    (d) => {
      Object.assign(d.components.schemas.Widget.properties, {
        toString: { type: 'string' },
      });
    },
  ],
  [
    'required request',
    (d) => {
      Object.assign(d.components.schemas.PreparationInput.properties, {
        valueOf: {
          type: 'string',
        },
      });
      d.components.schemas.PreparationInput.required.push('valueOf');
    },
  ],
  [
    'nested unselected response',
    (d) => {
      Object.assign(d.components.schemas.StaffReport.properties, {
        details: {
          type: 'object',
          properties: { toLocaleString: { type: 'string' } },
        },
      });
    },
  ],
  [
    'optional query',
    (d) => {
      preparation(d).parameters.push({
        name: 'hasOwnProperty',
        in: 'query',
        schema: { type: 'string' },
      });
    },
  ],
  [
    'required query',
    (d) => {
      preparation(d).parameters.push({
        name: 'isPrototypeOf',
        in: 'query',
        required: true,
        schema: { type: 'string' },
      });
    },
  ],
  [
    'optional header',
    (d) => {
      preparation(d).parameters.push({
        name: 'toString',
        in: 'header',
        schema: { type: 'string' },
      });
    },
  ],
];

for (const [name, mutate] of prototypeFields) {
  void test(`rejects inherited-name ${name} fields before generation`, async () => {
    const document = fixture();
    mutate(document);
    await assert.rejects(
      compileDocument(document, { clients: ['consumer'] }),
      /Object\.prototype property names are unsupported as contract fields/,
    );
  });
}

void test('the inherited-field diagnostic does not reserve unrelated metadata or schema names', async () => {
  const document = fixture();
  Object.assign(document['x-pom-policy'].auth, {
    toString: { transport: 'bearer' },
  });
  preparation(document)['x-pom'].auth = 'toString';
  Object.assign(document.components.schemas, {
    toString: { type: 'string' },
  });
  Object.assign(document.components.schemas.PreparationInput.properties, {
    label: {
      $ref: '#/components/schemas/toString',
    },
  });
  await compile(document);
});
