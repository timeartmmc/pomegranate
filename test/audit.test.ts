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
            'application/zip': {
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

void test('blockers retained by unused aliases remain explicit after excluding their operations', async () => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const input = {
      openapi,
      info: { title: 'Synthetic retained audit blocker', version: '1' },
      paths: {
        '/bad': { get: { operationId: 'bad', ...reply('Bad') } },
        '/good': { get: { operationId: 'good', ...reply() } },
      },
      components: {
        schemas: {
          Bad: { type: 'string', minLength: -1 },
          UnusedAlias: ref('Bad'),
          Good: { type: 'string' },
        },
      },
    };
    const settings = {
      clients: ['consumer'],
      surfaces: { consumer: ['bad', 'good'] },
    };
    const result = await audit(input, settings);
    assert.equal(result.clean, false);
    assert.equal(result.complete, false);
    assert.deepEqual(result.failedOperations, ['bad']);
    assert.deepEqual(result.unassessedOperations, ['good']);
    assert.deepEqual(result.supportedOperations, []);
    assert.deepEqual(result.excludeOperations, ['bad']);
    assert.ok(
      result.diagnostics.some(
        (entry) =>
          entry.location === 'components.schemas.Bad.minLength' &&
          entry.operationIds.length === 0,
      ),
    );
    await assert.rejects(
      compile(input, {
        ...settings,
        excludeOperations: result.excludeOperations,
      }),
      /components.schemas.Bad.minLength/,
    );
    const pruned = await audit(input, {
      ...settings,
      pruneUnusedComponents: true,
    });
    assert.equal(pruned.complete, true);
    assert.deepEqual(pruned.supportedOperations, ['good']);
    assert.ok(
      pruned.diagnostics.every((entry) => entry.operationIds.length > 0),
    );
    await compile(input, {
      ...settings,
      pruneUnusedComponents: true,
      excludeOperations: pruned.excludeOperations,
    });
  }
});

void test('multiple blockers of one operation do not prevent assessing healthy operations', async () => {
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic simultaneous audit blockers', version: '1' },
    paths: {
      '/bad': { get: { operationId: 'bad', ...reply('Both') } },
      '/good': { get: { operationId: 'good', ...reply() } },
    },
    components: {
      schemas: {
        BadA: { type: 'string', minLength: -1 },
        BadB: { type: 'integer', multipleOf: 0 },
        Both: { anyOf: [ref('BadA'), ref('BadB')] },
        Good: { type: 'string' },
      },
    },
  };
  const settings = {
    clients: ['consumer'],
    surfaces: { consumer: ['bad', 'good'] },
  };
  const result = await audit(input, settings);
  assert.equal(result.complete, true);
  assert.deepEqual(result.failedOperations, ['bad']);
  assert.deepEqual(result.supportedOperations, ['good']);
  assert.deepEqual(result.unassessedOperations, []);
  assert.ok(result.diagnostics.every((entry) => entry.operationIds.length > 0));
  await compile(input, {
    ...settings,
    excludeOperations: result.excludeOperations,
  });
});

void test('failing component aliases and recursive groups retain an independently compilable audit subset', async () => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const recursive of [false, true])
      for (const [target, alias] of [
        ['A', 'B_alias'],
        ['A.Bad', 'B.Alias'],
      ] as const) {
        const tagged: Schema = {
          oneOf: [ref('Cat')],
          discriminator: {
            propertyName: 'kind',
            mapping: { cat: ref('Cat').$ref },
          },
        };
        const input = {
          openapi,
          info: { title: 'Synthetic alias validation audit', version: '1' },
          components: {
            schemas: {
              [target]: recursive
                ? {
                    type: 'object',
                    properties: { next: ref(alias), bad: tagged },
                  }
                : tagged,
              [alias]: ref(target),
              // Dotted and textual prefix neighbors must stay independent of
              // an alias's diagnostic boundary.
              [`${alias}.Other`]: ref('Good'),
              [`${alias}Tail`]: ref('Good'),
              Cat: { type: 'object', properties: { kind: { type: 'string' } } },
              Good: { type: 'string' },
            },
          },
          paths: {
            '/a': { get: { operationId: 'usesTarget', ...reply(target) } },
            '/b': { get: { operationId: 'usesAlias', ...reply(alias) } },
            '/healthy': {
              get: { operationId: 'healthy', ...reply(`${alias}.Other`) },
            },
            '/prefix': {
              get: { operationId: 'healthy-prefix', ...reply(`${alias}Tail`) },
            },
          },
        };
        const settings = {
          clients: ['consumer'],
          surfaces: {
            consumer: ['usesTarget', 'usesAlias', 'healthy', 'healthy-prefix'],
          },
          pruneUnusedComponents: true,
        };
        const before = structuredClone(input);
        const result = await audit(input, settings);
        assert.equal(result.complete, true);
        assert.deepEqual(result.failedOperations, ['usesAlias', 'usesTarget']);
        assert.deepEqual(result.supportedOperations, [
          'healthy',
          'healthy-prefix',
        ]);
        assert.deepEqual(result.unassessedOperations, []);
        assert.equal(result.diagnostics.length, 1);
        assert.deepEqual(result.diagnostics[0]!.operationIds, [
          'usesAlias',
          'usesTarget',
        ]);
        await compile(input, {
          ...settings,
          excludeOperations: result.excludeOperations,
        });
        assert.deepEqual(input, before);
      }
});

void test('failed recursive groups preserve a healthy audit subset without repeating each member', async () => {
  for (const [phase, count] of [
    ['composition', 1_200],
    ['validation', 3_300],
  ] as const) {
    const schemas: Record<string, Schema> = {};
    const properties: Record<string, Schema> = {};
    const branches: Schema[] = [];
    for (let index = 0; index < count; index++) {
      const name = `Leaf${String(index).padStart(4, '0')}`;
      schemas[name] =
        phase === 'composition'
          ? { anyOf: [ref('Hub'), { type: 'string' }] }
          : { type: 'object', properties: { parent: ref('Hub') } };
      if (phase === 'composition')
        branches.push({ type: 'object', properties: { [name]: ref(name) } });
      else properties[name] = ref(name);
    }
    if (phase === 'composition')
      schemas.Hub = {
        allOf: [
          ...branches,
          { type: 'object', readOnly: true },
          { type: 'object', writeOnly: true },
        ],
      };
    else {
      schemas.Cat = {
        type: 'object',
        properties: { kind: { type: 'string' } },
      };
      properties.zbad = {
        oneOf: [ref('Cat')],
        discriminator: {
          propertyName: 'kind',
          mapping: { cat: ref('Cat').$ref },
        },
      };
      schemas.Hub = { type: 'object', properties };
    }
    const input = {
      openapi: '3.1.2',
      info: { title: 'Synthetic failing recursive audit groups', version: '1' },
      components: { schemas },
      paths: {
        '/hub': { get: { operationId: 'bad', ...reply('Hub') } },
        '/leaf': { get: { operationId: 'alias', ...reply('Leaf0000') } },
        '/good': {
          get: {
            operationId: 'good',
            responses: { 204: { description: 'Empty' } },
          },
        },
      },
    };
    const settings = {
      clients: ['consumer'],
      surfaces: { consumer: ['alias', 'bad', 'good'] },
      pruneUnusedComponents: true,
    };
    const result = await audit(input, settings);
    assert.equal(result.complete, true, phase);
    assert.deepEqual(result.supportedOperations, ['good'], phase);
    assert.deepEqual(result.failedOperations, ['alias', 'bad'], phase);
    assert.deepEqual(result.unassessedOperations, [], phase);
    assert.equal(result.diagnostics.length, 1, phase);
    await compile(input, {
      ...settings,
      excludeOperations: result.excludeOperations,
    });
  }
});

void test('exact source ownership distinguishes dotted components and path names', async () => {
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
                'application/zip': {
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
  for (const control of controls)
    for (const ambiguous of [false, true]) {
      const input = control(ambiguous);
      const before = structuredClone(input);
      const result = await audit(input, settings);
      assert.equal(result.complete, true);
      assert.deepEqual(result.failedOperations, ['bad']);
      assert.deepEqual(result.excludeOperations, ['bad']);
      assert.deepEqual(result.supportedOperations, ['healthy']);
      assert.deepEqual(result.unassessedOperations, []);
      assert.equal(result.diagnostics.length, 1);
      assert.deepEqual(result.diagnostics[0]!.operationIds, ['bad']);
      await compile(input, {
        ...settings,
        excludeOperations: result.excludeOperations,
      });
      assert.deepEqual(input, before);
    }
});

async function verifyAttributedSubset(
  input: unknown,
  failed: string[],
  supported = ['healthy'],
) {
  const settings = {
    clients: ['consumer'],
    pruneUnusedComponents: true,
    surfaces: { consumer: [...failed, ...supported] },
  };
  const before = structuredClone(input);
  const result = await audit(input, settings);
  assert.equal(result.complete, true);
  assert.deepEqual(result.failedOperations, [...failed].sort());
  assert.deepEqual(result.supportedOperations, [...supported].sort());
  assert.deepEqual(result.unassessedOperations, []);
  assert.ok(
    result.diagnostics.every(
      (diagnostic) => diagnostic.operationIds.length > 0,
    ),
  );
  await compile(input, {
    ...settings,
    excludeOperations: result.excludeOperations,
  });
  assert.deepEqual(input, before);
  return result;
}

void test('different source owners can have identical display locations without losing a healthy subset', async () => {
  for (const openapi of ['3.0.4', '3.1.2']) {
    const result = await verifyAttributedSubset(
      {
        openapi,
        info: {
          title: 'Synthetic identical diagnostic locations',
          version: '1',
        },
        components: {
          schemas: {
            A: { type: 'object', properties: { b: { type: 'invalid' } } },
            'A.properties.b': { type: 'invalid' },
            Good: { type: 'string' },
          },
        },
        paths: {
          '/a': { get: { operationId: 'a', ...reply('A') } },
          '/b': { get: { operationId: 'b', ...reply('A.properties.b') } },
          '/healthy': { get: { operationId: 'healthy', ...reply() } },
        },
      },
      ['a', 'b'],
    );
    assert.equal(result.diagnostics.length, 2);
    assert.deepEqual(
      result.diagnostics.map(({ location }) => location),
      [
        'components.schemas.A.properties.b.type',
        'components.schemas.A.properties.b.type',
      ],
    );
    assert.deepEqual(
      result.diagnostics.map(({ operationIds }) => operationIds),
      [['a'], ['b']],
    );
  }
});

void test('extension, dialect and remapped keyword errors retain exact component ownership', async () => {
  for (const [openapi, schema, suffix] of [
    ['3.1.2', { type: 'string', 'x-private': true }, 'x-private'],
    ['3.0.4', { type: 'string', const: 'one' }, 'const'],
    ['3.0.4', { type: 'string', not: {} }, 'not'],
  ] satisfies [string, Schema, string][]) {
    const result = await verifyAttributedSubset(
      {
        openapi,
        info: { title: 'Synthetic preprocessing provenance', version: '1' },
        components: {
          schemas: { A: schema, [`A.${suffix}`]: { type: 'string' } },
        },
        paths: {
          '/bad': { get: { operationId: 'bad', ...reply('A') } },
          '/healthy': {
            get: { operationId: 'healthy', ...reply(`A.${suffix}`) },
          },
        },
      },
      ['bad'],
    );
    assert.equal(
      result.diagnostics[0]!.location,
      `components.schemas.A.${suffix}`,
    );
    if (suffix === 'not')
      assert.equal(result.diagnostics[0]!.message.includes('"const"'), false);
  }
});

void test('reusable parameter and example roots preserve dotted-name ownership', async () => {
  for (const section of ['parameters', 'examples']) {
    const parameter = (name: string) => ({
      name: 'q',
      in: 'query',
      schema: { type: 'string' },
      ...(section === 'examples'
        ? { examples: { value: { $ref: `#/components/examples/${name}` } } }
        : {}),
    });
    const declared =
      section === 'parameters'
        ? {
            P: { ...parameter('P'), style: 'matrix' },
            'P.style': parameter('P.style'),
          }
        : { P: { value: undefined }, 'P.value': { value: 'one' } };
    const bind = (name: string) =>
      section === 'parameters'
        ? { $ref: `#/components/parameters/${name}` }
        : parameter(name);
    await verifyAttributedSubset(
      {
        openapi: '3.1.2',
        info: { title: 'Synthetic reusable source owners', version: '1' },
        components: {
          schemas: { Good: { type: 'string' } },
          [section]: declared,
        },
        paths: {
          '/bad': {
            get: { operationId: 'bad', parameters: [bind('P')], ...reply() },
          },
          '/healthy': {
            get: {
              operationId: 'healthy',
              parameters: [
                bind(section === 'parameters' ? 'P.style' : 'P.value'),
              ],
              ...reply(),
            },
          },
        },
      },
      ['bad'],
    );
  }
});

void test('unsupported TRACE does not exclude a healthy method on the same path', async () => {
  await verifyAttributedSubset(
    {
      openapi: '3.1.2',
      info: { title: 'Synthetic method source owners', version: '1' },
      components: { schemas: { Good: { type: 'string' } } },
      paths: {
        '/shared': {
          trace: { operationId: 'trace', ...reply() },
          get: { operationId: 'healthy', ...reply() },
        },
      },
    },
    ['trace'],
  );
});

void test('dotted alias-cycle sources remain attributable to their full dependent group', async () => {
  await verifyAttributedSubset(
    {
      openapi: '3.1.2',
      info: { title: 'Synthetic dotted alias cycle', version: '1' },
      components: {
        schemas: {
          A: { type: 'string' },
          'A.B': ref('A.B.C'),
          'A.B.C': ref('A.B'),
        },
      },
      paths: {
        '/b': { get: { operationId: 'b', ...reply('A.B') } },
        '/c': { get: { operationId: 'c', ...reply('A.B.C') } },
        '/healthy': { get: { operationId: 'healthy', ...reply('A') } },
      },
    },
    ['b', 'c'],
  );
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
        { type: 'array', items: { type: 'integer' }, minItems: 1 },
      ],
    },
    ComposeB: { allOf: [{ type: 'string' }, { type: 'object' }] },
    ValidateA: { ...ref('Good'), minLength: 3 },
    ValidateB: { ...ref('Good'), pattern: '^bad$' },
    Good: { type: 'string', enum: ['ok'] },
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

void test('failed operations retain completed validation work for later healthy operations', async () => {
  const ids = Array.from({ length: 400 }, (_, index) => `op${index}`);
  const failed = ids.filter((_, index) => index % 2 === 0).sort();
  const input = {
    openapi: '3.1.2',
    info: { title: 'Synthetic shared validation cache audit', version: '1' },
    components: {
      schemas: {
        Wide: {
          type: 'string',
          enum: Array.from({ length: 6_000 }, (_, index) => `v${index}`),
        },
        Narrow: { ...ref('Wide'), minLength: 1 },
      },
    },
    paths: Object.fromEntries(
      ids.map((operationId, index) => [
        `/p${String(index).padStart(4, '0')}`,
        {
          get: {
            operationId,
            responses: {
              200: {
                description: 'Value',
                content: {
                  [index % 2 === 0 ? 'application/xml' : 'application/json']: {
                    schema: ref('Narrow'),
                  },
                },
              },
            },
          },
        },
      ]),
    ),
  };
  const settings = { clients: ['consumer'], surfaces: { consumer: ids } };
  const result = await audit(input, settings);
  assert.equal(result.complete, true);
  assert.deepEqual(result.failedOperations, failed);
  assert.deepEqual(
    result.supportedOperations,
    ids.filter((id) => !failed.includes(id)).sort(),
  );
  assert.deepEqual(result.unassessedOperations, []);
  assert.equal(result.diagnostics.length, failed.length);
  await compile(input, {
    ...settings,
    excludeOperations: result.excludeOperations,
  });
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
  const source = ['components', 'schemas', 'Bad'];
  remaining = 0;
  assert.throws(() => index.affected(source), ContractWorkError);
  remaining = Infinity;
  assert.deepEqual(index.affected(source), ['bad']);
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
