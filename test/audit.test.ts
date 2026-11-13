import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import { audit, compile } from '../dist/index.js';
import type { CompileWarning } from '../dist/index.js';
import { ContractWorkError } from '../dist/diagnostics.js';
import { operationFilter } from '../dist/exclusions.js';
import { invalidOptions, json } from './assertions.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const reply = (name = 'Good') => ({
  responses: {
    200: {
      description: 'Synthetic response',
      content: { 'application/json': { schema: ref(name) } },
    },
  },
});
const options = {
  clients: ['consumer'],
  pruneUnusedComponents: true,
  excludeOperations: ['skip'],
  surfaces: {
    consumer: [
      'good',
      'shared-a',
      'shared-b',
      'inline',
      'inherited-a',
      'inherited-b',
      'trace',
      'GET /fallback',
      'skip',
    ],
  },
};
function fixture(openapi = '3.1.2') {
  const schemas: Record<string, Schema> = {
    Good: { type: 'string', minLength: 2, uniqueItems: true },
    'Bad.Schema': { type: 'string', minLength: -1 },
    Alias: ref('Bad.Schema'),
    Chain: ref('Alias'),
  };
  const paths: Record<string, unknown> = {
    '/good': { get: { operationId: 'good', ...reply() } },
    '/shared.a': { get: { operationId: 'shared-a', ...reply('Chain') } },
    '/shared': { post: { operationId: 'shared-b', ...reply('Alias') } },
    '/inline': {
      post: {
        operationId: 'inline',
        requestBody: {
          content: {
            'application/octet-stream': {
              schema: { type: 'string', format: 'binary' },
            },
          },
        },
        ...reply(),
      },
    },
    '/inherited': {
      parameters: [{ $ref: '#/components/parameters/BadParameter' }],
      get: { operationId: 'inherited-a', ...reply() },
      put: { operationId: 'inherited-b', ...reply() },
    },
    '/trace': { trace: { operationId: 'trace', ...reply() } },
    '/fallback': { get: reply() },
    '/skip': { get: { operationId: 'skip', 'x-private': true, ...reply() } },
  };
  return {
    openapi,
    info: { title: 'Synthetic operation audit', version: '1' },
    paths,
    components: {
      schemas,
      parameters: {
        BadParameter: {
          name: 'id',
          in: 'query',
          style: 'matrix',
          schema: { type: 'string' },
        },
      },
    },
  };
}

void test('audit groups shared blockers and reports every failed operation without rendering outputs', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    const input = fixture(version);
    const before = structuredClone(input);
    const warnings: CompileWarning[] = [];
    const result = await audit(input, {
      ...options,
      onWarning: (warning) => {
        warnings.push(warning);
      },
    });
    assert.equal(result.clean, false);
    assert.equal(result.complete, true);
    assert.deepEqual(result.supportedOperations, ['GET /fallback', 'good']);
    assert.deepEqual(result.failedOperations, [
      'inherited-a',
      'inherited-b',
      'inline',
      'shared-a',
      'shared-b',
      'trace',
    ]);
    assert.deepEqual(result.unassessedOperations, []);
    assert.deepEqual(
      result.excludeOperations,
      [...result.failedOperations, 'skip'].sort(),
    );
    assert.equal(result.diagnostics.length, 4);
    assert.deepEqual(
      result.diagnostics.find(
        (entry) => entry.location === 'components.schemas.Bad.Schema.minLength',
      )?.operationIds,
      ['shared-a', 'shared-b'],
    );
    assert.deepEqual(
      result.diagnostics.find((entry) =>
        entry.location.startsWith('components.parameters.BadParameter'),
      )?.operationIds,
      ['inherited-a', 'inherited-b'],
    );
    assert.deepEqual(result.warnings, warnings);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0]!.message, /occurrences/);
    await compile(input, {
      ...options,
      excludeOperations: result.excludeOperations,
    });
    assert.deepEqual(input, before);
  }
});

void test('global and standalone blockers keep unassessed operations explicit', async () => {
  for (const change of [
    (input: ReturnType<typeof fixture>) => {
      Object.assign(input.info, { typo: true });
    },
    (input: ReturnType<typeof fixture>) => {
      input.components.schemas.Unused = { type: 'integer', minLength: -1 };
    },
    (input: ReturnType<typeof fixture>) => {
      Object.assign(input.components, {
        securitySchemes: { Global: { type: 'http', scheme: 'hmac' } },
      });
      Object.assign(input, { security: [{ Global: [] }] });
    },
  ]) {
    const input = fixture();
    // A global failure should win before any operation-specific malformed schema.
    input.components.schemas['Bad.Schema'] = { type: 'string' };
    change(input);
    const result = await audit(input, {
      ...options,
      pruneUnusedComponents: false,
    });
    assert.equal(result.clean, false);
    assert.equal(result.complete, false);
    assert.equal(result.failedOperations.length, 0);
    assert.equal(result.unassessedOperations.length, 8);
    assert.equal(result.diagnostics.length, 1);
    assert.deepEqual(result.diagnostics[0]!.operationIds, []);
  }
  const pinned = await audit(fixture(), {
    ...options,
    standalone: {
      pinned: { schema: ref('Bad.Schema').$ref, usage: 'response' },
    },
  });
  assert.equal(pinned.complete, false);
  assert.equal(pinned.unassessedOperations.length, 8);
  assert.deepEqual(pinned.failedOperations, []);
  const valid = {
    openapi: '3.1.2',
    info: { title: 'Synthetic missing standalone', version: '1' },
    paths: { '/good': { get: { operationId: 'good', ...reply() } } },
    components: { schemas: { Good: { type: 'string' } } },
  };
  const missing = await audit(valid, {
    clients: ['consumer'],
    surfaces: { consumer: ['good'] },
    pruneUnusedComponents: true,
    standalone: { missing: { schema: ref('Missing').$ref, usage: 'response' } },
  });
  assert.equal(missing.complete, false);
  assert.deepEqual(missing.supportedOperations, []);
  assert.deepEqual(missing.unassessedOperations, ['good']);
  assert.deepEqual(missing.excludeOperations, []);
  assert.equal(
    missing.diagnostics[0]!.location,
    'standalone.missing.schema.$ref',
  );
});

void test('ambiguous dotted source names never recommend excluding a healthy operation', async () => {
  const controls = [
    (ambiguous: boolean) => {
      const healthy = ambiguous ? 'Bad.minLength' : 'Healthy';
      return {
        openapi: '3.1.2',
        info: { title: 'Synthetic component attribution', version: '1' },
        paths: {
          '/bad': { get: { operationId: 'bad', ...reply('Bad') } },
          '/healthy': { get: { operationId: 'healthy', ...reply(healthy) } },
        },
        components: {
          schemas: {
            Bad: { type: 'string', minLength: -1 },
            [healthy]: { type: 'string' },
          },
        },
      };
    },
    (ambiguous: boolean) => ({
      openapi: '3.1.2',
      info: { title: 'Synthetic route attribution', version: '1' },
      paths: {
        '/a': {
          post: {
            operationId: 'bad',
            requestBody: {
              content: {
                'application/octet-stream': {
                  schema: { type: 'string', format: 'binary' },
                },
              },
            },
            ...reply(),
          },
        },
        [ambiguous ? '/a.post' : '/healthy']: {
          get: { operationId: 'healthy', ...reply() },
        },
      },
      components: { schemas: { Good: { type: 'string' } } },
    }),
  ];
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: ['bad', 'healthy'] },
    pruneUnusedComponents: true,
  };
  for (const control of controls) {
    const result = await audit(control(true), settings);
    assert.equal(result.complete, false);
    assert.deepEqual(result.failedOperations, []);
    assert.deepEqual(result.excludeOperations, []);
    assert.deepEqual(result.unassessedOperations, ['bad', 'healthy']);
    assert.ok(
      result.diagnostics.some(
        (entry) =>
          entry.location === 'audit' && entry.message.includes('ambiguous'),
      ),
    );
    const unambiguous = await audit(control(false), settings);
    assert.equal(unambiguous.complete, true);
    assert.deepEqual(unambiguous.failedOperations, ['bad']);
    assert.deepEqual(unambiguous.supportedOperations, ['healthy']);
  }
});

void test('audit retains strict inventory checks and does not convert compiler exceptions into contract failures', async () => {
  await assert.rejects(
    audit(fixture(), { ...options, excludeOperations: ['missing'] }),
    /unknown operation identifier/,
  );
  await assert.rejects(
    audit(fixture(), { ...options, excludeOperations: ['skip', 'skip'] }),
    /duplicate operation identifier/,
  );
  const duplicate = fixture();
  duplicate.paths['/duplicate'] = { get: { operationId: 'good', ...reply() } };
  await assert.rejects(
    audit(duplicate, options),
    /duplicate operation identifier/,
  );
  await assert.rejects(
    invalidOptions(audit, fixture(), { ...options, onWarning: 'bad' }),
    /onWarning.*expected a function/,
  );
  const exception = new Error('Synthetic getter failure');
  const broken = fixture();
  Object.defineProperty(broken.components.schemas.Good!, 'type', {
    get: () => {
      throw exception;
    },
  });
  await assert.rejects(audit(broken, options), (error) => error === exception);
});

void test('audit handles hidden operation IDs and schema fields without mutating null-prototype inputs', async () => {
  const broken = Object.create(null, {
    type: { value: 'string' },
    minLength: { value: -1 },
  }) as Schema;
  const operation = Object.create(null, {
    operationId: { value: 'hidden' },
    ...Object.getOwnPropertyDescriptors(reply('Hidden')),
  }) as Record<string, unknown>;
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic hidden audit', version: '1' },
    paths: {
      '/hidden': { get: operation },
      '/good': { get: { operationId: 'good', ...reply() } },
    },
    components: { schemas: { Hidden: broken, Good: { type: 'string' } } },
  };
  const before = Object.getOwnPropertyDescriptors(broken);
  const result = await audit(input, {
    clients: ['consumer'],
    surfaces: { consumer: ['hidden', 'good'] },
    pruneUnusedComponents: true,
  });
  assert.deepEqual(result.failedOperations, ['hidden']);
  assert.equal(result.complete, true);
  assert.deepEqual(Object.getOwnPropertyDescriptors(broken), before);
});

void test('independent schema failures retain dialect diagnostics across normalization, composition and validation', async () => {
  const schemas: Record<string, Schema> = {
    SyntaxA: { type: 'string', not: {} },
    SyntaxB: { type: 'array', items: { type: 'string' }, uniqueItems: 'yes' },
    ComposeA: {
      allOf: [
        { type: 'array', items: { type: 'string' } },
        { type: 'array', items: { type: 'string' }, minItems: 1 },
      ],
    },
    ComposeB: { allOf: [{ type: 'string' }, { type: 'object' }] },
    ValidateA: {
      oneOf: [{ type: 'string' }, { type: 'string', minLength: 1 }],
    },
    ValidateB: { oneOf: [{ type: 'integer' }, { type: 'number' }] },
    Good: { type: 'string' },
  };
  const ids = Object.keys(schemas);
  for (const openapi of ['3.0.4', '3.1.2']) {
    const input = {
      openapi,
      info: { title: 'Synthetic independent audit phases', version: '1' },
      components: { schemas },
      paths: Object.fromEntries(
        ids.map((id) => [`/${id}`, { get: { operationId: id, ...reply(id) } }]),
      ),
    };
    const settings = {
      clients: ['consumer'],
      surfaces: { consumer: ids },
      pruneUnusedComponents: true,
    };
    const result = await audit(input, settings);
    assert.equal(result.complete, true);
    assert.deepEqual(result.supportedOperations, ['Good']);
    assert.deepEqual(
      result.failedOperations,
      ids.filter((id) => id !== 'Good').sort(),
    );
    const syntax = result.diagnostics.find(
      (entry) => entry.location === 'components.schemas.SyntaxA.not',
    );
    assert.ok(syntax);
    assert.equal(syntax.message.includes('"const"'), openapi.startsWith('3.1'));
    await compile(input, {
      ...settings,
      excludeOperations: result.excludeOperations,
    });
  }
});

void test('a failed JSON usage cannot hide later failures or reject a valid multipart usage of the same schema', async () => {
  const jsonIds = Array.from({ length: 12 }, (_, index) => `json${index}`);
  const operation = (operationId: string, media: string) => ({
    operationId,
    requestBody: { content: { [media]: { schema: ref('Upload') } } },
    responses: { 204: { description: 'Empty' } },
  });
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic audit usage caches', version: '1' },
    components: {
      schemas: {
        Upload: {
          type: 'object',
          properties: { file: { type: 'string', format: 'binary' } },
          required: ['file'],
        },
      },
    },
    paths: {
      ...Object.fromEntries(
        jsonIds.map((id) => [
          `/${id}`,
          { post: operation(id, 'application/json') },
        ]),
      ),
      '/upload': { post: operation('upload', 'multipart/form-data') },
    },
  };
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: [...jsonIds, 'upload'] },
    targets: { consumer: 'browser' as const },
    pruneUnusedComponents: true,
  };
  const result = await audit(input, settings);
  assert.equal(result.complete, true);
  assert.deepEqual(result.failedOperations, [...jsonIds].sort());
  assert.deepEqual(result.supportedOperations, ['upload']);
  await compile(input, {
    ...settings,
    excludeOperations: result.excludeOperations,
  });
});

void test('semantic component extensions are attributed without ignoring their meaning', async () => {
  const parameter = { $ref: '#/components/parameters/Ref' };
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic semantic extension audit', version: '1' },
    components: {
      schemas: { Good: { type: 'string' } },
      parameters: {
        Ref: {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
          'x-multi-segment': true,
        },
      },
    },
    paths: {
      '/bad/{id}': {
        get: { operationId: 'bad', parameters: [parameter], ...reply() },
      },
      '/also/{id}': {
        get: { operationId: 'also', parameters: [parameter], ...reply() },
      },
      '/good': { get: { operationId: 'good', ...reply() } },
    },
  };
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: ['bad', 'also', 'good'] },
    ignoreExtensions: ['x-multi-segment'],
    pruneUnusedComponents: true,
  };
  const before = structuredClone(input);
  await assert.rejects(
    compile(input, settings),
    /unsupported semantic extension/,
  );
  const result = await audit(input, settings);
  assert.equal(result.complete, true);
  assert.deepEqual(result.failedOperations, ['also', 'bad']);
  assert.deepEqual(result.supportedOperations, ['good']);
  assert.equal(
    result.diagnostics[0]!.location,
    'components.parameters.Ref.x-multi-segment',
  );
  await compile(input, {
    ...settings,
    excludeOperations: result.excludeOperations,
  });
  assert.deepEqual(input, before);
});

void test('an interrupted ownership build cannot leave a partially published index', () => {
  let remaining = Infinity;
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic interrupted audit index', version: '1' },
    components: {
      schemas: {
        Good: { type: 'string' },
        Bad: { type: 'string', minLength: -1 },
      },
    },
    paths: {
      '/bad': { get: { operationId: 'bad', ...reply('Bad') } },
      '/good': { get: { operationId: 'good', ...reply() } },
    },
  };
  const index = operationFilter(input, {}, (amount) => {
    if ((remaining -= amount) < 0)
      throw new ContractWorkError('audit', 'synthetic work exhaustion');
  });
  remaining = 0;
  assert.throws(
    () => index.affected('components.schemas.Bad.minLength'),
    ContractWorkError,
  );
  remaining = Infinity;
  assert.deepEqual(index.affected('components.schemas.Bad.minLength'), ['bad']);
});

void test('shared compiler work exhaustion leaves operations unassessed without proposing exclusions', async () => {
  const schemas: Record<string, Schema> = {
    Base: {
      type: 'integer',
      enum: Array.from({ length: 20_000 }, (_, index) => index),
    },
  };
  const ids = Array.from({ length: 51 }, (_, index) => `alias${index}`);
  for (const id of ids) schemas[id] = { ...ref('Base'), minimum: 0 };
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic aggregate work limit', version: '1' },
    components: { schemas },
    paths: Object.fromEntries(
      ids.map((id) => [`/${id}`, { get: { operationId: id, ...reply(id) } }]),
    ),
  };
  const result = await audit(input, {
    clients: ['consumer'],
    surfaces: { consumer: ids },
    pruneUnusedComponents: true,
  });
  assert.equal(result.complete, false);
  assert.deepEqual(result.failedOperations, []);
  assert.deepEqual(result.excludeOperations, []);
  assert.deepEqual(result.unassessedOperations, [...ids].sort());
  assert.ok(
    result.diagnostics.some(
      (entry) =>
        entry.operationIds.length === 0 &&
        /validation work exceeds.*1000000/.test(entry.message),
    ),
  );
});

void test('one shared error reports a large batch and leaves an independently compilable subset', async () => {
  const paths = Object.fromEntries(
    Array.from({ length: 1_000 }, (_, index) => [
      `/route${index}`,
      {
        get: {
          operationId: `route${index}`,
          ...reply(index < 500 ? 'Broken' : 'Good'),
        },
      },
    ]),
  );
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic shared audit scale', version: '1' },
    paths,
    components: {
      schemas: {
        Good: { type: 'string' },
        Broken: { type: 'string', minLength: -1 },
      },
    },
  };
  const settings = {
    clients: ['consumer'],
    surfaces: {
      consumer: Array.from({ length: 1_000 }, (_, index) => `route${index}`),
    },
    pruneUnusedComponents: true,
  };
  const result = await audit(input, settings);
  assert.equal(result.complete, true);
  assert.equal(result.failedOperations.length, 500);
  assert.equal(result.supportedOperations.length, 500);
  assert.equal(result.diagnostics.length, 1);
  await compile(input, {
    ...settings,
    excludeOperations: result.excludeOperations,
  });
});

void test('CLI audit emits JSON with meaningful exit codes and never touches output files', async (t) => {
  const root = await temporary(t);
  const output = join(root, 'generated');
  await mkdir(output);
  await writeFile(
    join(output, 'client.consumer.ts'),
    '// application-owned sentinel\n',
  );
  const outputBefore = await fileSnapshot(output);
  for (const extension of ['json', 'yaml']) {
    const input = fixture();
    await writeFile(
      join(root, `openapi.${extension}`),
      extension === 'json' ? JSON.stringify(input) : stringify(input),
    );
    const config = join(root, 'pom.json');
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        openapi: `./openapi.${extension}`,
        output: './generated',
        ...options,
      }),
    );
    const before = await fileSnapshot(root);
    const result = spawnSync(
      process.execPath,
      [cli, 'audit', '--config', config],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(result.status, 1, result.stderr);
    assert.deepEqual(json(result.stdout), await audit(input, options));
    assert.match(result.stderr, /POM warning \[ignored-schema-keyword\]/);
    assert.deepEqual(await fileSnapshot(root), before);
    assert.deepEqual(await fileSnapshot(output), outputBefore);
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        openapi: `./openapi.${extension}`,
        output: './generated',
        ...options,
        excludeOperations: [
          'inherited-a',
          'inherited-b',
          'inline',
          'shared-a',
          'shared-b',
          'trace',
          'skip',
        ],
      }),
    );
    const clean = spawnSync(
      process.execPath,
      [cli, 'audit', '--config', config],
      { encoding: 'utf8', timeout: 10_000 },
    );
    assert.equal(clean.status, 0, clean.stderr);
    assert.deepEqual(
      json(clean.stdout),
      await audit(input, {
        ...options,
        excludeOperations: [
          'inherited-a',
          'inherited-b',
          'inline',
          'shared-a',
          'shared-b',
          'trace',
          'skip',
        ],
      }),
    );
    assert.deepEqual(await fileSnapshot(output), outputBefore);
  }
});
