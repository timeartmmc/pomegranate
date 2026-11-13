import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';

const methods = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const selection = {
  clients: ['selected'],
  surfaces: { selected: ['first'], excluded: ['second'] },
};

function operation(id: string, path: string) {
  const names = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]!);
  return {
    operationId: id,
    parameters: [...new Set(names)].map((name) => ({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    })),
    responses: { 200: { description: 'Synthetic bodyless response' } },
  };
}

function document(openapi: string, paths: Record<string, unknown>) {
  return {
    openapi,
    info: { title: 'Synthetic path hierarchy contract', version: '1' },
    paths,
  };
}

void test('empty and metadata-only path items preserve generated operations in both dialects', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    const paths = { '/pets': { get: operation('first', '/pets') } };
    const options = {
      clients: ['selected'],
      surfaces: { selected: ['first'] },
    };
    const expected = await compile(document(version, paths), options);
    assert.deepEqual(
      await compile(
        document(version, {
          ...paths,
          '/empty/{id}': {},
          '/hidden': {
            summary: 'Reserved path',
            description: 'Synthetic path with no published operations',
            parameters: [
              { name: 'q', in: 'query', schema: { type: 'string' } },
            ],
            servers: [{ url: 'https://example.invalid' }],
          },
        }),
        options,
      ),
      expected,
    );
  }
});

void test('path items without supported operations still validate methods, paths and metadata', async () => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const [path, item, location] of [
      [
        '/hidden',
        { trace: operation('trace', '/hidden') },
        'paths./hidden.trace',
      ],
      ['/hidden', { summary: 42 }, 'paths./hidden.summary'],
      [
        '/hidden',
        {
          parameters: [{ name: 'q', in: 'query', schema: { type: 'object' } }],
        },
        'paths./hidden.parameters[0].schema',
      ],
      ['/hidden', { servers: [{ url: 42 }] }, 'paths./hidden.servers[0].url'],
      ['relative', {}, 'paths.relative'],
      ['/pets/{name}', {}, 'paths./pets/{name}'],
    ] as const)
      await assert.rejects(
        compile(
          document(version, {
            '/pets/{id}': { get: operation('first', '/pets/{id}') },
            [path]: item,
          }),
          { clients: ['selected'], surfaces: { selected: ['first'] } },
        ),
        { name: 'ContractError', location },
        `${version}: ${location}`,
      );
});

void test('equivalent templated paths fail before client selection regardless of method or declaration order', async () => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const firstMethod of methods)
      for (const secondMethod of methods)
        for (const reverse of [false, true]) {
          const entries: [string, unknown][] = [
            ['/pets/{id}', { [firstMethod]: operation('first', '/pets/{id}') }],
            [
              '/pets/{name}',
              { [secondMethod]: operation('second', '/pets/{name}') },
            ],
          ];
          await assert.rejects(
            compile(
              document(
                version,
                Object.fromEntries(reverse ? entries.reverse() : entries),
              ),
              selection,
            ),
            {
              name: 'ContractError',
              location: 'paths./pets/{name}',
              message:
                'paths./pets/{name}: duplicate templated path hierarchy; first declared at paths./pets/{id}',
            },
          );
        }
});

void test('equivalent multi-segment and trailing-slash templates are rejected', async () => {
  for (const [first, second] of [
    ['/pets/{a}/{b}', '/pets/{b}/{a}'],
    ['/pets/{id}/', '/pets/{name}/'],
    ['/pets//{id}', '/pets//{name}'],
    ['/pets/{id}.json', '/pets/{name}.json'],
    ['/pets/{pet-id}', '/pets/{pet-name}'],
    ['/pets/{a}-{b}', '/pets/{c}-{d}'],
  ] as const)
    await assert.rejects(
      compile(
        document('3.1.2', {
          [first]: { get: operation('first', first) },
          [second]: { get: operation('second', second) },
        }),
        selection,
      ),
      /duplicate templated path hierarchy/,
    );
});

void test('embedded placeholders encode each value and preserve path literals', async (t) => {
  const path = '/files/prefix-{id}.{extension}/{left}{right}';
  for (const version of ['3.0.4', '3.1.2']) {
    const root = await generatedTestWorkspace(
      t,
      await compile(
        document(version, { [path]: { get: operation('first', path) } }),
        { clients: ['selected'], surfaces: { selected: ['first'] } },
      ),
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.selected.ts',
    );
    const build = present(client.operations.first).build;
    assert.equal(
      build({
        path: { id: 'a/b?c#d%', extension: 'json', left: 'x/', right: 'y z' },
      }).url,
      '/files/prefix-a%2Fb%3Fc%23d%25.json/x%2Fy%20z',
    );
    for (const id of ['', '.', '..', '\ud800'])
      assert.throws(
        () => build({ path: { id, extension: 'json', left: 'x', right: 'y' } }),
        client.RequestValidationError,
      );
  }
});

void test('hyphenated path names bind exact keys and preserve value escaping', async (t) => {
  const path = '/sets/{set-id}/prefix-{item-id}.json';
  for (const version of ['3.0.4', '3.1.2']) {
    const source = document(version, {
      [path]: { get: operation('first', path) },
    });
    const options = {
      clients: ['selected'],
      surfaces: { selected: ['first'] },
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(source, options),
    );
    const client = await importGenerated<RuntimeClient>(
      root,
      'client.selected.ts',
    );
    const build = present(client.operations.first).build;
    assert.equal(
      build({ path: { 'set-id': 'a/b?c#d%', 'item-id': 'x y' } }).url,
      '/sets/a%2Fb%3Fc%23d%25/prefix-x%20y.json',
    );
    for (const value of ['', '.', '..', '\ud800'])
      assert.throws(
        () => build({ path: { 'set-id': value, 'item-id': 'valid' } }),
        client.RequestValidationError,
      );
    const mismatch = operation('first', path);
    present(mismatch.parameters[0]).name = 'set_id';
    await assert.rejects(
      compile(document(version, { [path]: { get: mismatch } }), options),
      /path placeholders and path parameters must match exactly/,
    );
  }
});

void test('embedded placeholders retain name, brace and literal diagnostics', async () => {
  for (const path of [
    '/pets/{id',
    '/pets/id}',
    '/pets/{{id}}',
    '/pets/{}.json',
    '/pets/{bad name}.json',
    '/pets/{id}?q',
    '/pets/{id}%2F',
  ])
    await assert.rejects(
      compile(
        document('3.1.2', {
          [path]: { get: operation('first', path) },
        }),
        { clients: ['selected'], surfaces: { selected: ['first'] } },
      ),
      /path placeholder|path literal/,
    );
});

void test('concrete overlaps and different literal, slash or placeholder positions retain both operations', async () => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const [first, second] of [
      ['/pets/{id}', '/pets/mine'],
      ['/{entity}/me', '/books/{id}'],
      ['/pets/{id}', '/pets/{id}/'],
      ['/pets/{id}', '/pets//{id}'],
      ['/a/{id}', '/b/{id}'],
      ['/a/{id}', '/a/{id}/{child}'],
      ['/', '/{id}'],
    ] as const)
      await compile(
        document(version, {
          [first]: { get: operation('first', first) },
          [second]: { get: operation('second', second) },
        }),
        { clients: ['selected'], surfaces: { selected: ['first', 'second'] } },
      );

  const path = '/pets/{id}';
  await compile(
    document('3.1.2', {
      [path]: {
        get: operation('first', path),
        post: operation('second', path),
      },
    }),
    { clients: ['selected'], surfaces: { selected: ['first', 'second'] } },
  );
});

void test('a conflicting hierarchy does not hide malformed or repeated placeholder diagnostics', async () => {
  for (const [first, second, diagnostic] of [
    ['/pets/{id}', '/pets/{z bad}', /path placeholder names must match/],
    [
      '/pets/{a}/{b}',
      '/pets/{c}/{c}',
      /repeated path placeholders are unsupported/,
    ],
  ] as const)
    await assert.rejects(
      compile(
        document('3.1.2', {
          [first]: { get: operation('first', first) },
          [second]: { get: operation('second', second) },
        }),
        selection,
      ),
      diagnostic,
    );
});
