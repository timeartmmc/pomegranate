import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';

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
    ['/pets/{id}', '/pets/{z-bad}', /path placeholder names must match/],
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
