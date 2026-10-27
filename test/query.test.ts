import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { once } from 'node:events';
import {
  QueryClient,
  QueryObserver,
  hydrate,
  isCancelledError,
} from '@tanstack/query-core';
import { compile, runProject } from '../dist/index.js';
import { invalidOptions, runtimeInput } from './assertions.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import type { QueryExecutor } from './.generated/queries/client.consumer.queries.ts';
import { queryFixture, querySelection } from './query-fixture.ts';
import { verifyQueries } from './query-checks.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { dehydrateJson } from './query-hydration.ts';

type Module = typeof import('./.generated/queries/client.consumer.queries.ts');
type Staff = typeof import('./.generated/queries/client.staff.queries.ts');
type Observed = import('./.generated/queries/runtime.ts').ObservedResponse;
const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string;
let module: Module;
let staff: Staff;
const item = (label = 'Synthetic'): Observed => ({
  status: 200,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id: 'item', label }),
});
const args = () => ({
  context: { session: 'one', locale: 'en' },
  input: { path: { id: 'item' } },
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });
}

before(async () => {
  root = await generatedWorkspace(
    await compile(queryFixture(), querySelection),
    'query-generated',
  );
  await cp(join(repo, 'test/query-types.ts'), join(root, 'query-types.ts'));
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
        noPropertyAccessFromIndexSignature: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        rewriteRelativeImportExtensions: true,
        outDir: 'built',
      },
      include: ['query-types.ts', 'query-generated/*.ts'],
    }),
  );
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  module = (await import(
    pathToFileURL(
      join(root, 'built/query-generated/client.consumer.queries.js'),
    ).href
  )) as Module;
  staff = (await import(
    pathToFileURL(join(root, 'built/query-generated/client.staff.queries.js'))
      .href
  )) as Staff;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

void test('generated queries satisfy shared installed-consumer acceptance checks', async () => {
  await verifyQueries(module.createQueries, module.QueryResponseError);
});

void test('query generation is opt-in, deterministic, and isolated by client', async () => {
  const document = queryFixture();
  const plain = await compile(document, {
    clients: ['consumer', 'staff'],
    transportHeaders: ['X-Language'],
  });
  assert.equal(
    Object.keys(plain).some((name) => name.includes('quer')),
    false,
  );
  assert.equal(
    Object.values(plain).some((source) => source.includes('@tanstack')),
    false,
  );
  const selected = await compile(document, querySelection);
  for (const [name, source] of Object.entries(plain))
    assert.equal(selected[name], source);
  assert.deepEqual(
    selected,
    await compile(document, {
      ...querySelection,
      clients: ['staff', 'consumer'],
      queries: {
        staff: ['readItem'],
        consumer: ['health', 'readMap', 'readOutcome', 'readItem'],
      },
    }),
  );
  assert.doesNotMatch(selected['client.consumer.queries.ts']!, /client\.staff/);
  assert.doesNotMatch(
    selected['client.staff.queries.ts']!,
    /readOutcome|client\.consumer/,
  );
  const consumerOnly = await compile(document, {
    ...querySelection,
    queries: { consumer: ['readItem'] },
  });
  assert.equal(Object.hasOwn(consumerOnly, 'client.staff.queries.ts'), false);
});

void test('invalid query selections receive explicit diagnostics', async () => {
  for (const [queries, message] of [
    [null, /queries.*expected an object/],
    [[], /queries.*expected an object/],
    [{ consumer: [] }, /nonempty array/],
    [{ consumer: [7] }, /nonempty array/],
    [{ consumer: ['readItem', 'readItem'] }, /duplicate query operation/],
    [{ missing: ['readItem'] }, /selected client/],
    [{ staff: ['readOutcome'] }, /belong to this client/],
    [{ consumer: ['missing'] }, /belong to this client/],
  ] as const) {
    await assert.rejects(
      invalidOptions(compile, queryFixture(), { ...querySelection, queries }),
      message,
    );
  }
  const document = queryFixture();
  Object.assign(document.paths, {
    '/write': {
      post: {
        operationId: 'write',
        'x-pom': {
          auth: 'session',
          retry: 'never',
          timeout: 'interactive',
          surfaces: ['consumer'],
        },
        responses: { 204: { description: 'Written' } },
      },
    },
  });
  await assert.rejects(
    compile(document, { ...querySelection, queries: { consumer: ['write'] } }),
    /only bodyless GET and HEAD/,
  );
  Object.assign(document.paths['/outcome'].get.responses, {
    default: { description: 'Unsupported' },
  });
  await assert.rejects(
    compile(document, { ...querySelection, queries: { consumer: ['health'] } }),
    /status|response/,
  );
});

void test('keys canonicalize omitted values and distinguish response-changing inputs', () => {
  const queries = module.createQueries({
    namespace: 'service',
    execute: async () => item(),
  });
  const base = queries.readItem.key(args());
  assert.deepEqual(
    base,
    queries.readItem.key({
      context: { locale: 'en', session: 'one' },
      input: {
        path: { id: 'item' },
        query: { filter: null, tags: [], page: undefined },
        headers: { 'X-View': null },
      },
    }),
  );
  for (const input of [
    { path: { id: 'other' } },
    { path: { id: 'item' }, query: { filter: '' } },
    { path: { id: 'item' }, query: { filter: 'null' } },
    { path: { id: 'item' }, query: { active: false } },
    { path: { id: 'item' }, query: { count: 0 } },
    { path: { id: 'item' }, query: { tags: ['a', 'b'] } },
    { path: { id: 'item' }, headers: { 'X-View': 'detail' } },
  ])
    assert.notDeepEqual(queries.readItem.key({ ...args(), input }), base);
  assert.notDeepEqual(
    queries.readItem.key({
      ...args(),
      input: { path: { id: 'item' }, query: { tags: ['a', 'b'] } },
    }),
    queries.readItem.key({
      ...args(),
      input: { path: { id: 'item' }, query: { tags: ['b', 'a'] } },
    }),
  );
  for (const context of [
    { session: 'two', locale: 'en' },
    { session: 'one', locale: 'az' },
    { ...args().context, tenant: 'other' },
  ])
    assert.notDeepEqual(queries.readItem.key({ ...args(), context }), base);
  const otherService = module.createQueries({
    namespace: 'other-service',
    execute: async () => item(),
  });
  const otherSurface = staff.createQueries({
    namespace: 'service',
    execute: async () => item(),
  });
  assert.notDeepEqual(otherService.readItem.key(args()), base);
  assert.notDeepEqual(otherSurface.readItem.key(args()), base);
  assert.notDeepEqual(queries.health.key({ context: args().context }), base);
});

void test('wire escaping and cache identities remain distinct over a synthetic Unicode corpus', () => {
  const queries = module.createQueries({
    namespace: 'corpus',
    execute: async () => item(),
  });
  const seen = new Set<string>();
  const values = [
    '',
    'null',
    'undefined',
    'a/b',
    '?&=#%',
    'é',
    'e\u0301',
    '😀',
    '\n',
    '\u0000',
    ...Array.from(
      { length: 128 },
      (_, code) => `value${String.fromCharCode(code)}`,
    ),
  ];
  for (const filter of values) {
    const key = queries.readItem.key({
      context: {},
      input: { path: { id: 'a/b' }, query: { filter } },
    });
    assert.ok(key[5] !== null);
    assert.equal(
      new URL(key[5], 'https://synthetic.invalid').searchParams.get('filter'),
      filter,
    );
    const encoded = JSON.stringify(key);
    assert.equal(
      seen.has(encoded),
      false,
      `distinct filter ${JSON.stringify(filter)}`,
    );
    seen.add(encoded);
  }
});

void test('finite numeric boundaries, booleans and repeated queries agree between wire requests and cache identities', async () => {
  const client = queryClient();
  const sent: string[] = [];
  const queries = module.createQueries({
    namespace: 'wire-scalars',
    execute: async (request) => {
      sent.push(request.url);
      return item(request.url);
    },
  });
  const numbers: readonly (readonly [number, string])[] = [
    [-0, '0'],
    [0, '0'],
    [Number.MIN_VALUE, '5e-324'],
    [-Number.MIN_VALUE, '-5e-324'],
    [Number.MAX_VALUE, '1.7976931348623157e+308'],
    [0.1, '0.1'],
    [1e-7, '1e-7'],
    [1e21, '1e+21'],
  ];
  const keys = new Map<string, string>();
  try {
    for (const [count, serialized] of numbers) {
      for (const active of [false, true]) {
        for (const tags of [[], ['', 'a&b', '🔥']]) {
          const options = queries.readItem.options({
            context: {},
            input: {
              path: { id: 'edge/🔥' },
              query: { count, active, tags },
            },
          });
          const result = await client.fetchQuery({
            ...options,
            staleTime: Infinity,
          });
          const wire = new URL(result.data.label, 'https://synthetic.invalid');
          assert.equal(wire.pathname, '/items/edge%2F%F0%9F%94%A5');
          assert.deepEqual(wire.searchParams.getAll('count'), [serialized]);
          assert.deepEqual(wire.searchParams.getAll('active'), [
            active ? 'true' : 'false',
          ]);
          assert.deepEqual(wire.searchParams.getAll('tags'), tags);
          assert.equal([...wire.searchParams].length, 2 + tags.length);
          const key = JSON.stringify(options.queryKey);
          const previous = keys.get(result.data.label);
          if (previous === undefined) {
            assert.ok(![...keys.values()].includes(key));
            keys.set(result.data.label, key);
          } else assert.equal(key, previous);
        }
      }
    }
    // Signed-zero inputs have the same wire request and share its cache entry.
    assert.equal(keys.size, (numbers.length - 1) * 4);
    assert.equal(sent.length, keys.size);
  } finally {
    client.clear();
  }
});

void test('all context field names survive TanStack hashing and JSON hydration without collisions', async () => {
  const client = queryClient();
  const restored = queryClient();
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'context-names',
    execute: async () => {
      calls += 1;
      return { status: 204, headers: {}, body: '' };
    },
  });
  try {
    for (const name of [
      '__proto__',
      'constructor',
      'prototype',
      'toJSON',
      '',
      '0',
    ]) {
      for (const value of ['one', 'two']) {
        const context = Object.fromEntries([[name, value]]);
        await client.fetchQuery({
          ...queries.health.options({ context }),
          staleTime: Infinity,
        });
      }
    }
    assert.equal(calls, 12);
    const state = dehydrateJson(client);
    hydrate(restored, state);
    assert.equal(restored.getQueryCache().getAll().length, 12);
    const context = Object.fromEntries([['__proto__', 'two']]);
    const options = queries.health.options({ context });
    await restored.fetchQuery({ ...options, staleTime: Infinity });
    assert.equal(calls, 12);
    assert.equal(restored.getQueryData(options.queryKey)?.status, 204);
  } finally {
    client.clear();
    restored.clear();
  }
});

void test('signed zero has one canonical context snapshot before and after cache hydration', async () => {
  const client = queryClient();
  const restored = queryClient();
  const seen: number[] = [];
  const queries = module.createQueries({
    namespace: 'signed-zero-hydration',
    execute: async (_request, { context }) => {
      const variant = context['variant'];
      assert.ok(typeof variant === 'number');
      assert.ok(Object.isFrozen(context));
      seen.push(variant);
      return item(`variant:${1 / variant}`);
    },
  });
  const context = { variant: -0 };
  const negative = queries.readItem.options({ ...args(), context });
  const positive = queries.readItem.options({
    ...args(),
    context: { variant: 0 },
  });
  try {
    const first = await client.fetchQuery({
      ...negative,
      staleTime: Infinity,
    });
    assert.equal(first.data.label, 'variant:Infinity');
    assert.deepEqual(negative.queryKey, positive.queryKey);
    assert.equal(context.variant, -0);
    assert.deepEqual(
      await client.fetchQuery({ ...positive, staleTime: Infinity }),
      first,
    );
    assert.deepEqual(seen, [0]);

    const state = dehydrateJson(client);
    hydrate(restored, state);
    const hydrated = await restored.fetchQuery({
      ...positive,
      staleTime: Infinity,
    });
    assert.equal(hydrated.status, first.status);
    assert.deepEqual(hydrated.data, first.data);
    assert.deepEqual(seen, [0]);
    assert.deepEqual(await restored.fetchQuery(negative), first);
    assert.deepEqual(seen, [0, 0]);
  } finally {
    client.clear();
    restored.clear();
  }
});

void test('refetching preserves all legal map values in cache and query observers', async () => {
  const client = queryClient();
  const cases = [
    {
      status: 202,
      values: [
        '{"__proto__":"retained","version":"1"}',
        '{"__proto__":"retained","version":"2"}',
      ],
    },
    {
      status: 200,
      values: [
        '{"constructor":null,"version":1}',
        '{"constructor":null,"version":2}',
      ],
    },
    {
      status: 200,
      values: [
        '{"__proto__":{"nested":true},"version":1}',
        '{"__proto__":{"nested":false},"version":2}',
      ],
    },
    {
      status: 200,
      values: [
        '{"nested":{"__proto__":null},"version":1}',
        '{"nested":{"__proto__":false},"version":2}',
      ],
    },
  ];
  try {
    for (const [index, sample] of cases.entries()) {
      let calls = 0;
      const queries = module.createQueries({
        namespace: `maps-${index}`,
        execute: async () => ({
          status: sample.status,
          headers: { 'Content-Type': 'application/json' },
          body: sample.values[calls++]!,
        }),
      });
      const options = queries.readMap.options({ context: {} });
      const observer = new QueryObserver(client, {
        ...options,
        enabled: false,
      });
      const unsubscribe = observer.subscribe(() => {});
      try {
        for (const source of sample.values) {
          await client.fetchQuery(options);
          const expected: unknown = JSON.parse(source);
          assert.deepEqual(
            client.getQueryData(options.queryKey)?.data,
            expected,
          );
          assert.deepEqual(observer.getCurrentResult().data?.data, expected);
        }
        assert.equal(calls, 2);
      } finally {
        unsubscribe();
      }
    }
  } finally {
    client.clear();
  }
});

void test('options capture immutable request and context snapshots without retaining caller state', async () => {
  let seen: Parameters<QueryExecutor>[0] | undefined;
  let seenContext: Parameters<QueryExecutor>[1]['context'] | undefined;
  const queries = module.createQueries({
    namespace: 'snapshots',
    execute: async (request, { context }) => {
      seen = request;
      seenContext = context;
      return item();
    },
  });
  const input = {
    path: { id: 'original' },
    query: { tags: ['first'] },
    headers: { 'X-View': 'small' },
  };
  const context = { session: 'one', locale: 'en' };
  const options = queries.readItem.options({ input, context });
  const snapshot = JSON.stringify(options.queryKey);
  input.path.id = 'changed';
  input.query.tags.push('second');
  input.headers['X-View'] = 'large';
  context.session = 'two';
  const client = queryClient();
  try {
    await client.fetchQuery(options);
    assert.equal(seen?.url, '/items/original?tags=first');
    assert.equal(seen?.headers['X-View'], 'small');
    assert.deepEqual(seenContext, { locale: 'en', session: 'one' });
    assert.ok(Object.isFrozen(seenContext));
    assert.equal(JSON.stringify(options.queryKey), snapshot);
    assert.ok(Object.isFrozen(options));
    assert.ok(Object.isFrozen(options.queryKey));
    assert.ok(Object.isFrozen(options.queryKey[4]));
    assert.ok(Object.isFrozen(options.queryKey[6]));
    assert.ok(options.queryKey[6].every(Object.isFrozen));
  } finally {
    client.clear();
  }
});

void test('context and argument validation rejects ambiguous or mutable identity values before executing', () => {
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'validation',
    execute: async () => {
      calls += 1;
      return item();
    },
  });
  const accessor = Object.defineProperty({}, 'session', {
    enumerable: true,
    get() {
      throw new Error('getter executed');
    },
  });
  for (const context of [
    undefined,
    null,
    [],
    new Date(),
    { user: {} },
    { user: [] },
    { user: undefined },
    { user: NaN },
    { user: Infinity },
    { [Symbol('scope')]: 'hidden' },
    Object.defineProperty({}, 'hidden', { value: 'scope' }),
    accessor,
  ])
    assert.throws(
      () => runtimeInput(queries.health.options, { context }),
      /query context/,
    );
  assert.throws(
    () => runtimeInput(queries.health.options, { context: {}, typo: true }),
    /unknown query argument/,
  );
  assert.throws(
    () => runtimeInput(queries.readItem.options, { context: {} }),
    /invalid request/,
  );
  assert.throws(
    () => queries.readItem.key({ context: {}, input: { path: { id: '.' } } }),
    /path/,
  );
  assert.throws(
    () =>
      queries.readItem.options({
        context: {},
        input: { path: { id: 'item' }, query: { page: 0 } },
      }),
    /invalid request/,
  );
  for (const namespace of ['', null, 7])
    assert.throws(
      () =>
        runtimeInput(module.createQueries, {
          namespace,
          execute: async () => item(),
        }),
      /namespace/,
    );
  assert.throws(
    () =>
      runtimeInput(module.createQueries, { namespace: 'valid', execute: null }),
    /executor/,
  );
  assert.equal(calls, 0);
  const special = JSON.parse(
    '{"__proto__":"scope","constructor":false}',
  ) as Record<string, string | boolean>;
  const key = queries.health.key({ context: special });
  assert.deepEqual(key[4], [
    ['__proto__', 'scope'],
    ['constructor', false],
  ]);
});

void test('query arguments reject accessors and hidden fields without evaluating them', () => {
  let calls = 0;
  let reads = 0;
  const queries = module.createQueries({
    namespace: 'argument-descriptors',
    execute: async () => {
      calls += 1;
      return { status: 204, headers: {}, body: '' };
    },
  });
  const invalid = [
    Object.defineProperty({ context: {} }, 'input', {
      enumerable: true,
      get() {
        reads += 1;
        return undefined;
      },
    }),
    Object.defineProperty({}, 'context', {
      enumerable: true,
      get() {
        reads += 1;
        return {};
      },
    }),
    Object.defineProperty({ context: {} }, 'input', {
      value: undefined,
    }),
    { context: {}, [Symbol('input')]: undefined },
  ];
  for (const value of invalid) {
    for (const build of [queries.health.key, queries.health.options])
      assert.throws(() => runtimeInput(build, value), {
        name: 'TypeError',
        message: /query arguments must contain enumerable data fields/,
      });
  }
  assert.equal(reads, 0);
  assert.equal(calls, 0);
});

void test('exact statuses, response headers, and failures retain protocol evidence', async () => {
  const client = queryClient();
  try {
    for (const [observed, kind] of [
      [
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: '{"detail":"Conflict"}',
        },
        'error',
      ],
      [
        {
          status: 202,
          headers: { 'Content-Type': 'application/json' },
          body: '{"state":"pending","reference":"ref"}',
        },
        'protocol',
      ],
      [
        {
          status: 202,
          headers: {
            'Content-Type': 'application/json',
            'X-Request-ID': 'ref',
          },
          body: '{"state":"ready","value":7}',
        },
        'protocol',
      ],
      [
        {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
          body: '{"state":"ready","value":7}',
        },
        'protocol',
      ],
      [{ status: 299, headers: {}, body: '' }, 'protocol'],
      [
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{',
        },
        'protocol',
      ],
    ] as const) {
      const queries = module.createQueries({
        namespace: `fail-${observed.status}-${kind}`,
        execute: async () => observed,
      });
      const options = queries.readOutcome.options({ context: {} });
      await assert.rejects(client.fetchQuery(options), (error: unknown) => {
        assert.ok(error instanceof module.QueryResponseError);
        assert.equal(error.result.kind, kind);
        assert.equal(error.result.status, observed.status);
        if (error.result.kind === 'error')
          assert.deepEqual(error.result.data, { detail: 'Conflict' });
        else assert.equal(Object.hasOwn(error.result, 'data'), false);
        return true;
      });
      assert.equal(client.getQueryData(options.queryKey), undefined);
    }
    const observed = {
      status: 202,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': 'request',
        'X-Unmodeled': 'retained',
        'X-Trace': 'first',
        'x-trace': 'second',
      },
      body: '{"state":"pending","reference":"reference","extra":true}',
    };
    const queries = module.createQueries({
      namespace: 'pending',
      execute: async () => observed,
    });
    const options = queries.readOutcome.options({ context: {} });
    const result = await client.fetchQuery(options);
    assert.equal(result.status, 202);
    assert.deepEqual(result.data, { state: 'pending', reference: 'reference' });
    const expectedHeaders = {
      'content-type': 'application/json',
      'x-request-id': 'request',
      'x-unmodeled': 'retained',
      'x-trace': 'first, second',
    };
    assert.deepEqual({ ...result.headers }, expectedHeaders);
    assert.deepEqual(
      { ...result.validatedHeaders },
      {
        'x-request-id': 'request',
      },
    );
    observed.headers['X-Request-ID'] = 'changed';
    observed.headers['X-Unmodeled'] = 'changed';
    assert.deepEqual({ ...result.headers }, expectedHeaders);
    assert.equal(result.validatedHeaders['x-request-id'], 'request');
    assert.equal(client.getQueryData(options.queryKey), result);
  } finally {
    client.clear();
  }
});

void test('network errors propagate unchanged and never receive an automatic second retry budget', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 4, retryDelay: 0, gcTime: Infinity } },
  });
  const failure = new Error('synthetic transport failure');
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'network',
    execute: async () => {
      calls += 1;
      throw failure;
    },
  });
  try {
    await assert.rejects(
      client.fetchQuery(queries.readItem.options(args())),
      (error: unknown) => error === failure,
    );
    assert.equal(calls, 1);
  } finally {
    client.clear();
  }
});

void test('equivalent concurrent reads share one execution while context changes use separate caches', async () => {
  const client = queryClient();
  const response = deferred<Observed>();
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'concurrency',
    execute: async () => {
      calls += 1;
      return response.promise;
    },
  });
  try {
    const first = client.fetchQuery(queries.readItem.options(args()));
    const second = client.fetchQuery(
      queries.readItem.options({
        ...args(),
        context: { locale: 'en', session: 'one' },
      }),
    );
    assert.equal(calls, 1);
    response.resolve(item());
    assert.deepEqual(await first, await second);
    assert.equal(
      client.getQueryData(
        queries.readItem.key({
          ...args(),
          context: { session: 'two', locale: 'en' },
        }),
      ),
      undefined,
    );
  } finally {
    client.clear();
  }
});

void test('TanStack cancellation reaches the executor and a late response cannot populate either session cache', async () => {
  const client = queryClient();
  const response = deferred<Observed>();
  let signal: AbortSignal | undefined;
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'sessions',
    execute: async (_request, context) => {
      calls += 1;
      if (calls === 1) {
        signal = context.signal;
        return response.promise;
      }
      return item('new session');
    },
  });
  try {
    const original = queries.readItem.options(args());
    const pending = client
      .fetchQuery(original)
      .catch((error: unknown) => error);
    await client.cancelQueries({ queryKey: original.queryKey, exact: true });
    assert.equal(signal?.aborted, true);
    assert.ok(isCancelledError(await pending));
    const next = queries.readItem.options({
      ...args(),
      context: { session: 'two', locale: 'en' },
    });
    const current = await client.fetchQuery(next);
    response.resolve(item('old session'));
    await response.promise;
    await Promise.resolve();
    assert.equal(client.getQueryData(original.queryKey), undefined);
    assert.deepEqual(client.getQueryData(next.queryKey), current);
  } finally {
    client.clear();
  }
});

void test('query functions reject pre-aborted and late-aborted work even when executors ignore the signal', async () => {
  const client = queryClient();
  let calls = 0;
  const response = deferred<Observed>();
  const queries = module.createQueries({
    namespace: 'abort',
    execute: async () => {
      calls += 1;
      return response.promise;
    },
  });
  const options = queries.readItem.options(args());
  const controller = new AbortController();
  const reason = new Error('synthetic cancellation');
  try {
    controller.abort(reason);
    await assert.rejects(
      options.queryFn({
        client,
        queryKey: options.queryKey,
        signal: controller.signal,
        meta: undefined,
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(calls, 0);
    const late = new AbortController();
    const pending = options.queryFn({
      client,
      queryKey: options.queryKey,
      signal: late.signal,
      meta: undefined,
    });
    late.abort(reason);
    response.resolve(item());
    await assert.rejects(pending, (error: unknown) => error === reason);
    assert.equal(calls, 1);
    const rejected = deferred<Observed>();
    const failing = module.createQueries({
      namespace: 'late-error',
      execute: async () => rejected.promise,
    });
    const failedOptions = failing.readItem.options(args());
    const failureSignal = new AbortController();
    const failure = failedOptions.queryFn({
      client,
      queryKey: failedOptions.queryKey,
      signal: failureSignal.signal,
      meta: undefined,
    });
    failureSignal.abort(reason);
    rejected.reject(new Error('late transport error'));
    await assert.rejects(failure, (error: unknown) => error === reason);
  } finally {
    client.clear();
  }
});

void test('a query key override cannot run a request under a different identity', async () => {
  const client = queryClient();
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'mismatch',
    execute: async () => {
      calls += 1;
      return item();
    },
  });
  const options = queries.readItem.options(args());
  const other = queries.readItem.key({
    ...args(),
    context: { session: 'two' },
  });
  try {
    await assert.rejects(
      client.fetchQuery({ ...options, queryKey: other }),
      /does not match/,
    );
    assert.equal(calls, 0);
    assert.equal(client.getQueryData(other), undefined);
  } finally {
    client.clear();
  }
});

void test('query options execute through an application Fetch adapter against a synthetic HTTP server', async () => {
  const requests: {
    url: string;
    language: string | string[] | undefined;
    auth: string | undefined;
  }[] = [];
  const server = createServer((request, response) => {
    requests.push({
      url: request.url ?? '',
      language: request.headers['x-language'],
      auth: request.headers.authorization,
    });
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({ id: 'over/http', label: 'Wire response', extra: true }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = queryClient();
  const queries = module.createQueries({
    namespace: 'synthetic-http',
    execute: async (request, { signal, context }) => {
      const locale = context['locale'];
      assert.ok(typeof locale === 'string');
      const response = await fetch(
        `http://127.0.0.1:${address.port}${request.url}`,
        {
          method: request.method,
          signal,
          headers: request.validateHeaders({
            ...request.headers,
            'X-Language': locale,
            Authorization: 'Bearer synthetic-token',
          }),
        },
      );
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    },
  });
  try {
    const context = { session: 'synthetic-session', locale: 'en' };
    const options = queries.readItem.options({
      context,
      input: { path: { id: 'over/http' }, query: { tags: ['a', 'b'] } },
    });
    context.locale = 'az';
    const result = await client.fetchQuery(options);
    assert.deepEqual(result.data, { id: 'over/http', label: 'Wire response' });
    assert.deepEqual(requests, [
      {
        url: '/items/over%2Fhttp?tags=a&tags=b',
        language: 'en',
        auth: 'Bearer synthetic-token',
      },
    ]);
    assert.equal(
      JSON.stringify(options.queryKey).includes('synthetic-token'),
      false,
    );
  } finally {
    client.clear();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
});

void test('query outputs participate in read-only drift checks and safe stale-file cleanup', async (t) => {
  const directory = await temporary(t);
  const output = join(directory, 'generated');
  const configFile = join(directory, 'pom.json');
  const config = {
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    ...querySelection,
  };
  await writeFile(
    join(directory, 'openapi.json'),
    JSON.stringify(queryFixture()),
  );
  await writeFile(configFile, JSON.stringify(config));
  await runProject(configFile);
  const previous = await fileSnapshot(output);
  await writeFile(
    configFile,
    JSON.stringify({ ...config, queries: { consumer: ['missing'] } }),
  );
  await assert.rejects(runProject(configFile), /belong to this client/);
  assert.deepEqual(await fileSnapshot(output), previous);
  await writeFile(configFile, JSON.stringify({ ...config, queries: {} }));
  assert.equal((await runProject(configFile, { check: true })).clean, false);
  assert.deepEqual(await fileSnapshot(output), previous);
  await runProject(configFile);
  const remaining = await fileSnapshot(output);
  assert.equal(Object.hasOwn(remaining, 'query-runtime.ts'), false);
  assert.equal(Object.hasOwn(remaining, 'client.consumer.queries.ts'), false);
  assert.equal(Object.hasOwn(remaining, 'client.staff.queries.ts'), false);
  await writeFile(configFile, JSON.stringify(config));
  await runProject(configFile);
  await writeFile(
    join(output, 'query-runtime.ts'),
    `${await readFile(join(output, 'query-runtime.ts'), 'utf8')}\n// Application edit\n`,
  );
  await writeFile(configFile, JSON.stringify({ ...config, queries: {} }));
  const edited = await fileSnapshot(output);
  await assert.rejects(runProject(configFile), /modified/);
  assert.deepEqual(await fileSnapshot(output), edited);
});
