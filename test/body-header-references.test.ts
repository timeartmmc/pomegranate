import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import {
  bodyHeaderReferenceConsumer,
  bodyHeaderReferenceFixture as fixture,
  bodyHeaderReferenceSelection as selection,
  bodyRef,
  headerRef,
  inlineBodyHeaderFixture,
  verifyBodyHeaderReferences,
} from './body-header-reference-fixture.ts';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { multipartFixture, multipartSelection } from './multipart-fixture.ts';
import type { RuntimeClient } from './runtime-types.ts';

const exec = promisify(execFile);
let baseline: Readonly<Record<string, string>>;
before(async () => {
  baseline = Object.freeze(await compile(inlineBodyHeaderFixture(), selection));
});

async function rejectsAt(document: unknown, location: string, message: RegExp) {
  const before = structuredClone(document);
  await assert.rejects(compile(document, selection), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, location);
    assert.match(error.message, message);
    return true;
  });
  assert.deepEqual(document, before);
}

void test('body and header aliases preserve inline bytes, YAML, input values and client projection', async () => {
  const document = fixture();
  const before = structuredClone(document);
  assert.deepEqual(await compile(document, selection), baseline);
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(
      parseYaml(stringify(document), 'body-headers.yaml'),
      selection,
    ),
    baseline,
  );
  document.components.requestBodies = Object.fromEntries(
    Object.entries(document.components.requestBodies).reverse(),
  );
  document.components.headers = Object.fromEntries(
    Object.entries(document.components.headers).reverse(),
  );
  document.paths['/create'].post.requestBody = bodyRef('OtherJsonAlias');
  document.components.responses.Done.headers['X-Trace'] =
    headerRef('OtherTraceAlias');
  assert.deepEqual(await compile(document, selection), baseline);
  assert.doesNotMatch(
    Object.values(baseline).join('\n'),
    /UnusedInput|UnusedHeader|InternalInput|internalCreate/,
  );
  for (const name of ['browser', 'native']) {
    const schemas = present(baseline[`client.${name}.schemas.ts`]);
    assert.match(schemas, /Input/);
    assert.match(schemas, /HeaderText/);
  }
});

void test('reusable bodies and headers retain browser/native runtime contracts', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  verifyBodyHeaderReferences(
    await importGenerated<RuntimeClient>(root, 'client.browser.ts'),
    await importGenerated<RuntimeClient>(root, 'client.native.ts'),
  );
});

void test('reference conversion preserves complete execution and multipart generated formats', async () => {
  for (const [document, options] of [
    [executionFixture(), executionSelection],
    [multipartFixture(), multipartSelection],
  ] as const) {
    const expected = await compile(document, options);
    const requestBodies: Record<string, unknown> = {};
    const headers: Record<string, unknown> = {};
    let bodyIndex = 0;
    let headerIndex = 0;
    for (const item of Object.values(document.paths))
      for (const value of Object.values(record(item))) {
        const operation = record(value);
        if (!Object.hasOwn(operation, 'responses')) continue;
        if (Object.hasOwn(operation, 'requestBody')) {
          const name = `Body${bodyIndex++}`;
          requestBodies[name] = operation.requestBody;
          operation.requestBody = bodyRef(name);
        }
        for (const response of Object.values(record(operation.responses))) {
          const responseHeaders = record(response).headers;
          if (!responseHeaders) continue;
          const entries = record(responseHeaders);
          for (const name of Object.keys(entries)) {
            const component = `Header${headerIndex++}`;
            headers[component] = entries[name];
            entries[name] = headerRef(component);
          }
        }
      }
    assert.ok(bodyIndex > 0);
    Object.assign(document.components, { requestBodies, headers });
    assert.deepEqual(await compile(document, options), expected);
  }
});

void test('reference annotations never change body requiredness, header behavior or terminal validation', async () => {
  const document = fixture();
  for (const value of [
    document.components.requestBodies.JsonAlias,
    document.paths['/create'].post.requestBody,
    document.components.headers.TraceAlias,
    document.components.responses.Done.headers['X-Trace'],
  ])
    Object.assign(present(value), {
      summary: '',
      description: 'Use-site docs',
    });
  Object.assign(present(document.components.requestBodies.Optional), {
    required: false,
  });
  // Request defaults are opaque annotations and do not supply required fields.
  Object.assign(
    present(present(document.components.schemas.Input).properties).secret!,
    {
      default: { 'x-note': 'annotation data' },
    },
  );
  assert.deepEqual(await compile(document, selection), baseline);
  Object.assign(present(document.components.requestBodies.Json), {
    required: 'true',
  });
  await rejectsAt(
    document,
    'components.requestBodies.Json.required',
    /expected a boolean/,
  );
});

void test('body method restrictions apply to every reference use including unselected operations', async () => {
  for (const method of ['get', 'head']) {
    for (const selected of [true, false]) {
      const document = fixture();
      const operation = selected
        ? record(document.paths['/inspect'].get)
        : record(document.paths['/internal'].post);
      operation.requestBody = bodyRef('JsonAlias');
      if (selected && method === 'get') {
        await rejectsAt(
          document,
          'paths./inspect.get.requestBody',
          /GET bodies are unsupported/,
        );
        continue;
      }
      const path = selected ? '/inspect' : '/internal';
      Object.assign((record(document.paths)[path] = {}), {
        [method]: operation,
      });
      await rejectsAt(
        document,
        `paths.${path}.${method}.requestBody`,
        /GET bodies are unsupported|HEAD bodies are unsupported/,
      );
    }
  }
});

void test('body/header aliases reject missing, cyclic, malformed and foreign targets at the reference owner', async () => {
  for (const [section, ref, label, alias] of [
    ['requestBodies', bodyRef, 'request body', 'JsonAlias'],
    ['headers', headerRef, 'header', 'TraceAlias'],
  ] as const) {
    const local = section === 'requestBodies' ? 'Json' : 'Trace';
    const cases: [unknown, RegExp][] = [
      [null, /only local component/],
      ['', /only local component/],
      [
        `https://synthetic.invalid/spec.json#/components/${section}/${local}`,
        /only local component/,
      ],
      [`./shared.json#/components/${section}/${local}`, /only local component/],
      [`#/components/schemas/${local}`, /only local component/],
      [`#/components/${section}/`, /names must match/],
      [`#/components/${section}/${local}/schema`, /names must match/],
      [`#/components/${section}/%54race`, /names must match/],
      [`#/components/${section}/bad~1name`, /names must match/],
      [
        ref('Missing').$ref,
        new RegExp(`unresolved ${label} reference Missing`),
      ],
      [ref(alias).$ref, new RegExp(`cyclic ${label} reference`)],
    ];
    for (const [$ref, message] of cases) {
      const document = fixture();
      Object.assign(document.components[section], { [alias]: { $ref } });
      await rejectsAt(document, `components.${section}.${alias}.$ref`, message);
    }
    const cycle = fixture();
    Object.assign(cycle.components[section], { A: ref('B'), B: ref('A') });
    await rejectsAt(
      cycle,
      `components.${section}.A.$ref`,
      new RegExp(`cyclic ${label} reference`),
    );
    const unused = fixture();
    Object.assign(unused.components[section], { UnusedAlias: ref('Missing') });
    await rejectsAt(
      unused,
      `components.${section}.UnusedAlias.$ref`,
      /unresolved/,
    );
  }
  const missingBody = fixture();
  missingBody.paths['/create'].post.requestBody = bodyRef('Missing');
  await rejectsAt(
    missingBody,
    'paths./create.post.requestBody.$ref',
    /unresolved request body reference Missing/,
  );
  const missingHeader = fixture();
  missingHeader.components.responses.Done.headers['X-Trace'] =
    headerRef('Missing');
  await rejectsAt(
    missingHeader,
    'components.responses.Done.headers.X-Trace.$ref',
    /unresolved header reference Missing/,
  );
});

void test('body/header references accept only string annotations and reject semantic siblings before following them', async () => {
  for (const [section, name, ref, semantic] of [
    ['requestBodies', 'JsonAlias', bodyRef, 'content'],
    ['headers', 'TraceAlias', headerRef, 'schema'],
  ] as const) {
    for (const [key, value, message] of [
      ['description', null, /expected a string/],
      ['summary', 1, /expected a string/],
      ['required', false, /unsupported keyword/],
      [semantic, { 'x-unlisted': true }, /unsupported keyword/],
    ] as const) {
      const document = fixture();
      Object.assign(present(document.components[section][name]), {
        [key]: value,
      });
      await rejectsAt(
        document,
        `components.${section}.${name}.${key}`,
        message,
      );
    }
    const document = fixture();
    Object.assign(document.components[section], {
      [name]: { ...ref('Missing'), required: true },
    });
    await rejectsAt(
      document,
      `components.${section}.${name}.required`,
      /unsupported keyword/,
    );
  }
});

void test('unused body definitions eagerly retain requiredness, content, schema and request-direction validation', async () => {
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [{ required: null, content: {} }, '.required', /expected a boolean/],
    [{ content: {} }, '.content', /expected at least one supported media type/],
    [
      { content: { 'application/xml': { schema: { type: 'string' } } } },
      '.content.application/xml',
      /unsupported keyword/,
    ],
    [
      { content: { 'application/json': {}, 'multipart/form-data': {} } },
      '.content.application/json.schema',
      /expected an object/,
    ],
    [
      {
        content: {
          'multipart/form-data': {
            schema: { type: 'object', additionalProperties: false },
          },
        },
      },
      '.required',
      /optional multipart/,
    ],
    [
      {
        required: false,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', additionalProperties: false },
          },
        },
      },
      '.required',
      /optional multipart/,
    ],
    [
      {
        content: {
          'application/json': { schema: { type: 'string', format: 'binary' } },
        },
      },
      '.content.application/json.schema',
      /binary|multipart/,
    ],
    [
      {
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Missing' },
          },
        },
      },
      '.content.application/json.schema.$ref',
      /unresolved reference Missing/,
    ],
    [
      {
        content: {
          'application/json': {
            schema: { type: 'string', default: undefined },
          },
        },
      },
      '.content.application/json.schema.default',
      /expected an object/,
    ],
    [
      {
        content: {
          'application/json': { schema: { type: 'string', readOnly: true } },
        },
      },
      '.content.application/json.schema',
      /readOnly|request/,
    ],
    [
      {
        description: null,
        content: { 'application/json': { schema: { type: 'string' } } },
      },
      '.description',
      /expected a string/,
    ],
  ];
  for (const [definition, suffix, message] of cases) {
    const document = fixture();
    Object.assign(document.components.requestBodies, { Unused: definition });
    await rejectsAt(
      document,
      `components.requestBodies.Unused${suffix}`,
      message,
    );
  }
  const document = {
    openapi: '3.1.0',
    info: { title: 'Unused multipart definition', version: '1' },
    components: {},
    paths: {
      '/ready': {
        post: {
          operationId: 'ready',
          responses: { 204: { description: 'Ready' } },
        },
      },
    },
  };
  const options = { clients: ['simple'], surfaces: { simple: ['ready'] } };
  const expected = await compile(document, options);
  // Targets are required only for selected multipart operations, not for a
  // valid unused declaration that is normalized before client projection.
  Object.assign(document.components, {
    requestBodies: {
      Unused: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
    },
  });
  assert.deepEqual(await compile(document, options), expected);
});

void test('unused header definitions eagerly retain response schema constraints and metadata validation', async () => {
  const cases: [Record<string, unknown>, string, RegExp][] = [
    [
      { schema: { type: 'integer' } },
      '.schema',
      /response headers require string/,
    ],
    [
      { schema: { type: ['string', 'null'] } },
      '.schema',
      /response headers require string/,
    ],
    [
      { schema: { type: 'string', default: undefined } },
      '.schema.default',
      /expected an object/,
    ],
    [
      { schema: { type: 'string', format: 'binary' } },
      '.schema',
      /binary|multipart/,
    ],
    [
      { schema: { $ref: '#/components/schemas/Missing' } },
      '.schema.$ref',
      /unresolved reference Missing/,
    ],
    [
      { schema: { type: 'string' }, required: 'yes' },
      '.required',
      /expected a boolean/,
    ],
    [
      { schema: { type: 'string' }, style: 'form' },
      '.style',
      /only simple headers/,
    ],
    [
      { schema: { type: 'string' }, explode: 1 },
      '.explode',
      /expected a boolean/,
    ],
    [
      { schema: { type: 'string' }, deprecated: 1 },
      '.deprecated',
      /expected a boolean/,
    ],
    [
      { schema: { type: 'string' }, description: 1 },
      '.description',
      /expected a string/,
    ],
    [
      { schema: { type: 'string' }, name: 'X-Trace' },
      '.name',
      /unsupported keyword/,
    ],
    [
      { schema: { type: 'string' }, example: true, examples: {} },
      '',
      /example and examples/,
    ],
  ];
  for (const [definition, suffix, message] of cases) {
    const document = fixture();
    Object.assign(document.components.headers, { Unused: definition });
    await rejectsAt(document, `components.headers.Unused${suffix}`, message);
  }
});

void test('header wire names are checked at each use rather than at component declaration names', async () => {
  for (const [name, message] of [
    ['Content-Type', /content-type is determined/],
    ['Set-Cookie', /transport-owned response header/],
    ['Set-Cookie2', /transport-owned response header/],
    ['bad header', /invalid HTTP header name/],
    ['__proto__', /unsupported object key/],
    ['constructor', /unsupported object key/],
    ['prototype', /unsupported object key/],
    ['x-trace', /duplicate case-insensitive header/],
  ] as const) {
    const document = fixture();
    Object.defineProperty(document.components.responses.Done.headers, name, {
      value: headerRef('TraceAlias'),
      enumerable: true,
    });
    await rejectsAt(
      document,
      `components.responses.Done.headers.${name}`,
      message,
    );
  }
  const document = fixture();
  document.components.headers['Set-Cookie'] = headerRef('TraceAlias');
  document.components.responses.Done.headers['X-Trace'] =
    headerRef('Set-Cookie');
  assert.deepEqual(await compile(document, selection), baseline);
  // An unselected inline response has the same name binding checks.
  document.paths['/internal'].post.responses['204'] = {
    description: 'Hidden',
    headers: { 'Set-Cookie': headerRef('Trace') },
  };
  await rejectsAt(
    document,
    'paths./internal.post.responses.204.headers.Set-Cookie',
    /transport-owned response header/,
  );
});

void test('body/header component maps, entries and identifiers retain explicit diagnostics', async () => {
  for (const section of ['requestBodies', 'headers'] as const) {
    for (const value of [null, [], true]) {
      const document = fixture();
      Object.assign(document.components, { [section]: value });
      await rejectsAt(document, `components.${section}`, /expected an object/);
      const entry = fixture();
      Object.assign(entry.components[section], { Unused: value });
      await rejectsAt(
        entry,
        `components.${section}.Unused`,
        /expected an object/,
      );
    }
    for (const name of [
      '',
      'bad/name',
      'bad%20name',
      'bad\n',
      '__proto__',
      'constructor',
      'prototype',
    ]) {
      const document = fixture();
      Object.defineProperty(document.components[section], name, {
        value: {},
        enumerable: true,
      });
      await rejectsAt(
        document,
        `components.${section}.${name}`,
        /names must match|unsupported object key/,
      );
    }
  }
});

void test('extension filtering traverses new definitions and aliases without removing x- named contract data', async () => {
  const document = fixture();
  document.components.requestBodies['x-note'] = bodyRef('JsonAlias');
  document.components.headers['x-note'] = headerRef('TraceAlias');
  document.paths['/create'].post.requestBody = bodyRef('x-note');
  document.components.responses.Done.headers['x-note'] = headerRef('x-note');
  const input = present(document.components.schemas.Input);
  present(input.properties)['x-note'] = { type: 'string', default: 'data' };
  const expected = await compile(document, selection);
  for (const value of [
    document.components.requestBodies.Json,
    document.components.requestBodies.JsonAlias,
    document.components.requestBodies['x-note'],
    document.components.headers.Trace,
    document.components.headers.TraceAlias,
    document.components.headers['x-note'],
    document.paths['/create'].post.requestBody,
    document.components.responses.Done.headers['x-note'],
  ])
    Object.assign(present(value), { 'x-note': { opaque: true } });
  const before = structuredClone(document);
  assert.deepEqual(
    await compile(document, { ...selection, ignoreExtensions: ['x-note'] }),
    expected,
  );
  assert.deepEqual(document, before);
  await assert.rejects(
    compile(document, selection),
    /x-note.*ignoreExtensions/,
  );
  assert.match(Object.values(expected).join('\n'), /x-note/);
});

void test('long body/header alias chains share tails without consuming schema depth or changing output', async () => {
  const document = fixture();
  for (let index = 0; index < 10_000; index++) {
    document.components.requestBodies[`Chain${index}`] = bodyRef(
      index === 9_999 ? 'Json' : `Chain${index + 1}`,
    );
    document.components.headers[`Chain${index}`] = headerRef(
      index === 9_999 ? 'Trace' : `Chain${index + 1}`,
    );
  }
  document.components.requestBodies.JsonAlias = bodyRef('Chain0');
  document.components.headers.TraceAlias = headerRef('Chain0');
  assert.deepEqual(await compile(document, selection), baseline);
});

void test('referenced body/header types survive source and separate declaration-only consumers', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  await writeFile(join(root, 'consumer.ts'), bodyHeaderReferenceConsumer);
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    types: [],
  };
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import { create } from './declarations/consumer.js';
    create({body:{label:'label',secret:'secret'}});
    // @ts-expect-error Declaration publication retains required request bodies.
    create();
    // @ts-expect-error Declaration publication retains request direction.
    create({body:{label:'label',secret:'secret',serverId:'server'}});
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});
