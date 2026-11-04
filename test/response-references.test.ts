import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  inlineResponseFixture,
  responseReference as ref,
  responseReferenceConsumer,
  responseReferenceFixture as fixture,
  responseReferenceSelection as selection,
  verifyResponseReferences,
} from './response-reference-fixture.ts';
import type { RuntimeClient } from './runtime-types.ts';

const exec = promisify(execFile);
type Fixture = ReturnType<typeof fixture>;
let baseline: Readonly<Record<string, string>>;
before(async () => {
  baseline = Object.freeze(await compile(inlineResponseFixture(), selection));
});

async function rejectsAt(
  document: Fixture,
  location: string,
  message: RegExp,
  label = location,
) {
  const before = structuredClone(document);
  await assert.rejects(compile(document, selection), (error) => {
    assert.ok(error instanceof ContractError, label);
    assert.equal(error.location, location, label);
    assert.match(error.message, message, label);
    return true;
  });
  assert.deepEqual(document, before, label);
}

void test('response aliases preserve inline bytes, YAML, input values and transitive projection', async () => {
  const document = fixture();
  const before = structuredClone(document);
  assert.deepEqual(await compile(document, selection), baseline);
  assert.deepEqual(document, before);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'responses.yaml'), selection),
    baseline,
  );
  document.components.responses = Object.fromEntries(
    Object.entries(document.components.responses).reverse(),
  );
  assert.deepEqual(await compile(document, selection), baseline);
  assert.doesNotMatch(
    Object.values(baseline).join('\n'),
    /Secret|UnusedValue|internalRead/,
  );
  assert.match(baseline['client.consumer.schemas.ts'] ?? '', /Payload/);
  assert.match(baseline['client.staff.schemas.ts'] ?? '', /Payload/);
});

void test('shared responses preserve exact statuses, header constraints, directional data and protocol failures', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  verifyResponseReferences(
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
    await importGenerated<RuntimeClient>(root, 'client.staff.ts'),
  );
});

void test('response references preserve complete execution, query, cursor and offset modules', async () => {
  const document = executionFixture();
  const expected = await compile(document, executionSelection);
  const definitions: Record<string, unknown> = {};
  let index = 0;
  for (const item of Object.values(document.paths))
    for (const value of Object.values(record(item))) {
      const operation = record(value);
      if (!Object.hasOwn(operation, 'responses')) continue;
      const responses = record(operation.responses);
      for (const status of Object.keys(responses)) {
        const name = `Shared${index++}`;
        definitions[name] = responses[status];
        responses[status] = ref(name);
      }
    }
  Object.assign(document.components, { responses: definitions });
  assert.deepEqual(await compile(document, executionSelection), expected);
});

void test('response reference documentation never overrides terminal validation or generated behavior', async () => {
  const document = fixture();
  Object.assign(document.components.responses.PageAlias!, {
    description: '',
    summary: 'Alias documentation',
  });
  Object.assign(document.paths['/results'].get.responses['200']!, {
    description: 'Use-site description',
    summary: '',
  });
  assert.deepEqual(await compile(document, selection), baseline);
  Reflect.deleteProperty(
    present(document.components.responses.Page),
    'description',
  );
  await rejectsAt(
    document,
    'components.responses.Page.description',
    /expected a response description/,
  );
});

void test('response body legality is checked at every method/status use including unselected operations', async () => {
  const uses = [
    ['/health', 'head', 200],
    ['/health', 'head', 204],
    ['/results', 'get', 204],
    ['/results', 'get', 205],
    ['/results', 'get', 304],
    ['/internal', 'get', 204],
  ] as const;
  for (const [path, method, status] of uses) {
    const document = fixture();
    const operation = record(record(record(document.paths)[path])[method]);
    record(operation.responses)[status] = ref('PageAlias');
    await rejectsAt(
      document,
      `paths.${path}.${method}.responses.${status}.$ref`,
      /this HTTP method\/status cannot carry a body \(response reference "#\/components\/responses\/PageAlias"\)/,
    );
    const inline = fixture();
    const inlineOperation = record(record(record(inline.paths)[path])[method]);
    record(inlineOperation.responses)[status] = structuredClone(
      present(inline.components.responses.Page),
    );
    await rejectsAt(
      inline,
      `paths.${path}.${method}.responses.${status}.content`,
      /this HTTP method\/status cannot carry a body$/,
    );
  }
  const bodyless = fixture();
  bodyless.paths['/health'].head.responses['200'] = ref('EmptyAlias');
  bodyless.paths['/results'].get.responses['204'] = ref('Empty');
  await compile(bodyless, selection);
});

void test('response references retain final exact-status and success requirements', async () => {
  for (const status of ['default', '2XX', '4XX', '101', '600']) {
    const document = fixture();
    document.paths['/results'].get.responses[status] = ref('Empty');
    await rejectsAt(
      document,
      `paths./results.get.responses.${status}`,
      /only exact numeric final HTTP statuses/,
    );
  }
  const document = fixture();
  document.paths['/results'].get.responses = { 404: ref('Problem') };
  await rejectsAt(document, 'paths./results.get.responses', /at least one 2xx/);
});

void test('response references reject invalid targets, aliases and semantic siblings at their owners', async () => {
  const cases: [string, (document: Fixture) => void, string, RegExp][] = [
    [
      'missing use target',
      (d) => {
        d.paths['/results'].get.responses['200'] = ref('Missing');
      },
      'paths./results.get.responses.200.$ref',
      /unresolved response reference Missing/,
    ],
    [
      'missing unused alias',
      (d) => {
        d.components.responses.UnusedAlias = ref('Missing');
      },
      'components.responses.UnusedAlias.$ref',
      /unresolved response reference Missing/,
    ],
    [
      'self cycle',
      (d) => {
        d.components.responses.UnusedAlias = ref('UnusedAlias');
      },
      'components.responses.UnusedAlias.$ref',
      /cyclic response reference/,
    ],
    [
      'unused cycle',
      (d) => {
        Object.assign(d.components.responses, { A: ref('B'), B: ref('A') });
      },
      'components.responses.A.$ref',
      /cyclic response reference/,
    ],
    [
      'remote target',
      (d) => {
        d.components.responses.PageAlias = {
          $ref: 'https://synthetic.invalid/openapi.json#/components/responses/Page',
        };
      },
      'components.responses.PageAlias.$ref',
      /only local component response references/,
    ],
    [
      'relative external target',
      (d) => {
        d.components.responses.PageAlias = {
          $ref: './responses.json#/components/responses/Page',
        };
      },
      'components.responses.PageAlias.$ref',
      /only local component response references/,
    ],
    [
      'wrong category',
      (d) => {
        d.components.responses.PageAlias = {
          $ref: '#/components/schemas/Payload',
        };
      },
      'components.responses.PageAlias.$ref',
      /only local component response references/,
    ],
    [
      'nested pointer',
      (d) => {
        d.components.responses.PageAlias = ref('Page/content');
      },
      'components.responses.PageAlias.$ref',
      /component response names must match/,
    ],
    [
      'encoded target',
      (d) => {
        d.components.responses.PageAlias = ref('%50age');
      },
      'components.responses.PageAlias.$ref',
      /component response names must match/,
    ],
    [
      'empty target',
      (d) => {
        d.components.responses.PageAlias = ref('');
      },
      'components.responses.PageAlias.$ref',
      /component response names must match/,
    ],
    [
      'nonstring ref',
      (d) => {
        Object.assign(d.components.responses.PageAlias!, { $ref: null });
      },
      'components.responses.PageAlias.$ref',
      /only local component response references/,
    ],
    [
      'alias description',
      (d) => {
        Object.assign(d.components.responses.PageAlias!, {
          description: false,
        });
      },
      'components.responses.PageAlias.description',
      /expected a string/,
    ],
    [
      'use summary',
      (d) => {
        Object.assign(d.paths['/results'].get.responses['200']!, {
          summary: null,
        });
      },
      'paths./results.get.responses.200.summary',
      /expected a string/,
    ],
    [
      'content sibling',
      (d) => {
        Object.assign(d.components.responses.PageAlias!, { content: {} });
      },
      'components.responses.PageAlias.content',
      /unsupported keyword/,
    ],
    [
      'headers sibling',
      (d) => {
        Object.assign(d.paths['/results'].get.responses['200']!, {
          headers: {},
        });
      },
      'paths./results.get.responses.200.headers',
      /unsupported keyword/,
    ],
  ];
  for (const [name, mutate, location, message] of cases) {
    const document = fixture();
    mutate(document);
    await rejectsAt(document, location, message, name);
  }
});

void test('unused response definitions undergo full response schema and header validation', async () => {
  const cases: [string, unknown, string, RegExp][] = [
    [
      'missing description',
      { description: undefined },
      '.description',
      /expected a response description/,
    ],
    [
      'unsupported media',
      {
        description: 'Invalid',
        content: { 'text/plain': { schema: { type: 'string' } } },
      },
      '.content.text/plain',
      /unsupported keyword/,
    ],
    [
      'missing schema',
      {
        description: 'Invalid',
        content: {
          'application/json': {
            schema: { $ref: '#/components/schemas/Missing' },
          },
        },
      },
      '.content.application/json.schema.$ref',
      /unresolved reference/,
    ],
    [
      'visible response default',
      {
        description: 'Invalid',
        content: {
          'application/json': {
            schema: { type: 'string', default: 'annotation' },
          },
        },
      },
      '.content.application/json.schema.default',
      /response schemas must not declare defaults/,
    ],
    [
      'write-only root',
      {
        description: 'Invalid',
        content: {
          'application/json': { schema: { type: 'string', writeOnly: true } },
        },
      },
      '.content.application/json.schema',
      /may only be omitted as object properties/,
    ],
    [
      'numeric response header',
      {
        description: 'Invalid',
        headers: { Count: { schema: { type: 'integer' } } },
      },
      '.headers.Count.schema',
      /response headers require string schemas/,
    ],
    [
      'reserved response header',
      {
        description: 'Invalid',
        headers: { 'Set-Cookie': { schema: { type: 'string' } } },
      },
      '.headers.Set-Cookie',
      /transport-owned response header/,
    ],
    [
      'header default',
      {
        description: 'Invalid',
        headers: {
          Count: { schema: { type: 'string', default: 'annotation' } },
        },
      },
      '.headers.Count.schema.default',
      /response schemas must not declare defaults/,
    ],
  ];
  for (const [name, definition, suffix, message] of cases) {
    const document = fixture();
    Object.assign(document.components.responses, { Unused: definition });
    await rejectsAt(
      document,
      `components.responses.Unused${suffix}`,
      message,
      name,
    );
  }
  const unselected = fixture();
  Object.assign(unselected.components.responses.Internal!, {
    content: { 'text/plain': { schema: { type: 'string' } } },
  });
  await rejectsAt(
    unselected,
    'components.responses.Internal.content.text/plain',
    /unsupported keyword/,
  );
});

void test('response component maps, entries and names retain explicit input diagnostics', async () => {
  for (const responses of [null, [], 'responses']) {
    const document = fixture();
    Object.assign(document.components, { responses });
    await rejectsAt(document, 'components.responses', /expected an object/);
  }
  for (const response of [null, [], true]) {
    const document = fixture();
    Object.assign(document.components.responses, { Unused: response });
    await rejectsAt(
      document,
      'components.responses.Unused',
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
    Object.defineProperty(document.components.responses, name, {
      enumerable: true,
      value: { description: 'Invalid name' },
    });
    await rejectsAt(
      document,
      `components.responses.${name}`,
      /component response names must match|unsupported object key/,
    );
  }
});

void test('response extension filtering preserves same-named component keys while ignoring annotations', async () => {
  const document = fixture();
  document.components.responses['x-note'] = ref('EmptyAlias');
  document.paths['/results'].get.responses['410'] = ref('x-note');
  const expected = await compile(document, selection);
  const sites = [
    document.components.responses.Page!,
    document.components.responses.PageAlias!,
    document.components.responses['x-note'],
    document.paths['/results'].get.responses['200']!,
  ];
  for (const value of sites)
    Object.assign(value, { 'x-note': { opaque: true } });
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
});

void test('long response alias chains keep schema depth independent and generated bytes unchanged', async () => {
  const document = fixture();
  for (let index = 0; index < 10_000; index++)
    document.components.responses[`Chain${index}`] = ref(
      index === 9_999 ? 'Page' : `Chain${index + 1}`,
    );
  document.components.responses.PageAlias = ref('Chain0');
  assert.deepEqual(await compile(document, selection), baseline);
});

void test('referenced response types survive source and declaration-only consumers', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  await writeFile(join(root, 'consumer.ts'), responseReferenceConsumer);
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
    import { parse } from './declarations/consumer.js';
    const result = parse({status:201,headers:{},body:''});
    if(result.kind === 'success') {
      const status: 200 | 201 = result.status;
      const label: string = result.data.label;
      // @ts-expect-error Published projected data omits write-only fields.
      void result.data.secret;
      // @ts-expect-error Published response types do not widen known fields.
      const invalid: number = result.data.label;
      void [status,label,invalid];
    }
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

void test('invalid response references and HTTP bindings preserve output during generate and check', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  await writeFile(input, JSON.stringify(fixture()));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const snapshot = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  for (const mutate of [
    (d: Fixture) => {
      d.components.responses.UnusedAlias = ref('Missing');
    },
    (d: Fixture) => {
      d.components.responses.UnusedAlias = ref('UnusedAlias');
    },
    (d: Fixture) => {
      Object.assign(d.components.responses.Unused!, { description: null });
    },
    (d: Fixture) => {
      d.paths['/health'].head.responses['204'] = ref('Page');
    },
  ]) {
    const document = fixture();
    mutate(document);
    const source = JSON.stringify(document);
    await writeFile(input, source);
    for (const check of [false, true])
      await assert.rejects(runProject(config, { check }), ContractError);
    assert.deepEqual(await fileSnapshot(output), snapshot);
    assert.equal(await readFile(input, 'utf8'), source);
  }
});
