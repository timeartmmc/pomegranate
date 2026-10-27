import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import {
  QueryClient,
  QueryObserver,
  dehydrate,
  hydrate,
} from '@tanstack/query-core';
import { compile } from '../dist/index.js';
import { runtimeInput } from './assertions.ts';
import { queryFixture, querySelection } from './query-fixture.ts';

type Module = typeof import('./.generated/queries/client.consumer.queries.ts');
type Observed = import('./.generated/queries/runtime.ts').ObservedResponse;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
let root: string;
let module: Module;

before(async () => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, 'pom-query-adversarial-'));
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(
    await compile(queryFixture(), querySelection),
  ))
    await writeFile(join(root, name), source);
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
        rewriteRelativeImportExtensions: true,
        declaration: true,
        rootDir: '.',
        outDir: 'built',
      },
      include: ['*.ts'],
    }),
  );
  await exec(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  module = (await import(
    pathToFileURL(join(root, 'built/client.consumer.queries.js')).href
  )) as Module;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

function queryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { gcTime: Infinity, retry: 3, structuralSharing: true },
    },
  });
}

const names = [
  '__proto__',
  'constructor',
  'prototype',
  'hasOwnProperty',
  'toString',
  'toJSON',
  'valueOf',
  '',
  '0',
  '1',
  '01',
  '🔥',
  'a\u0000b',
  '\ud800',
] as const;

void test('selected observer data and JSON hydration preserve every map entry after refetch', async () => {
  for (const name of names) {
    const client = queryClient();
    const restored = queryClient();
    // Computed fields preserve own __proto__ entries. These expectations come
    // from wire JSON rather than from the generated validator or cache key.
    const values = [
      { [name]: { nested: null }, iteration: 0 },
      { [name]: { nested: false }, iteration: 1 },
    ];
    let calls = 0;
    const queries = module.createQueries({
      namespace: 'observer-maps',
      execute: async () => ({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values[calls++]!),
      }),
    });
    const options = queries.readMap.options({ context: {} });
    // Observer selections have their own structural-sharing path, separate
    // from cache updates of the full response envelope.
    const observer = new QueryObserver(client, {
      ...options,
      enabled: false,
      select: (result) => result.data,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      for (const expected of values) {
        await client.fetchQuery(options);
        assert.deepEqual(observer.getCurrentResult().data, expected);
        assert.deepEqual(client.getQueryData(options.queryKey)?.data, expected);
      }
      assert.equal(calls, 2);
      const snapshot: unknown = JSON.parse(JSON.stringify(dehydrate(client)));
      hydrate(restored, snapshot);
      const result = await restored.fetchQuery({
        ...options,
        staleTime: Infinity,
      });
      assert.deepEqual(result.data, values[1]);
      assert.equal(calls, 2);
    } finally {
      unsubscribe();
      client.clear();
      restored.clear();
    }
  }
});

void test('scalar context identities stay distinct through real cache access and JSON hydration', async () => {
  const client = queryClient();
  const restored = queryClient();
  const values = [
    null,
    true,
    false,
    0,
    1,
    -1,
    1.1,
    1e300,
    '0',
    '1',
    'null',
    'false',
    '',
    '\ud800',
    '🔥',
  ] as const;
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'context-corpus',
    execute: async (_request, { context }) => {
      calls += 1;
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(context),
      };
    },
  });
  try {
    for (const name of names) {
      for (const value of values) {
        const context = { [name]: value };
        const options = queries.readMap.options({ context });
        const result = await client.fetchQuery({
          ...options,
          staleTime: Infinity,
        });
        assert.deepEqual(result.data, context);
      }
    }
    assert.equal(calls, names.length * values.length);
    const snapshot: unknown = JSON.parse(JSON.stringify(dehydrate(client)));
    hydrate(restored, snapshot);
    for (const name of names) {
      for (const value of values) {
        const context = { [name]: value };
        const result = await restored.fetchQuery({
          ...queries.readMap.options({ context }),
          staleTime: Infinity,
        });
        assert.deepEqual(result.data, context);
      }
    }
    assert.equal(calls, names.length * values.length);
  } finally {
    client.clear();
    restored.clear();
  }
});

void test('failed HTTP and protocol refetches retain previous validated success without caching the failure', async () => {
  const client = queryClient();
  let observed: Observed = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: '{"id":"item","label":"Valid"}',
  };
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'failed-refetch',
    execute: async () => {
      calls += 1;
      return observed;
    },
  });
  const options = queries.readItem.options({
    context: {},
    input: { path: { id: 'item' } },
  });
  const observer = new QueryObserver(client, { ...options, enabled: false });
  const unsubscribe = observer.subscribe(() => {});
  try {
    const previous = await client.fetchQuery(options);
    for (const [response, kind] of [
      [
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: '{"detail":"Missing"}',
        },
        'error',
      ],
      [
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: '{"id":0,"label":"Invalid"}',
        },
        'protocol',
      ],
    ] as const) {
      observed = response;
      await assert.rejects(client.fetchQuery(options), (error: unknown) => {
        assert.ok(error instanceof module.QueryResponseError);
        assert.equal(error.result.kind, kind);
        assert.equal(error.result.status, observed.status);
        return true;
      });
      assert.equal(client.getQueryData(options.queryKey), previous);
      const current = observer.getCurrentResult();
      assert.equal(current.status, 'error');
      assert.equal(current.data, previous);
    }
    assert.equal(calls, 3);
  } finally {
    unsubscribe();
    client.clear();
  }
});

void test('cancelled refetches retain cached success and cannot replace a later result under the same key', async () => {
  for (const completion of ['resolve', 'reject'] as const) {
    const client = queryClient();
    let release!: (value: Observed) => void;
    let reject!: (error: Error) => void;
    const late = new Promise<Observed>((yes, no) => {
      release = yes;
      reject = no;
    });
    const observed = (label: string): Observed => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: 'item', label }),
    });
    let calls = 0;
    let cancelledSignal: AbortSignal | undefined;
    const queries = module.createQueries({
      namespace: `cached-cancellation-${completion}`,
      execute: async (_request, { signal }) => {
        calls += 1;
        if (calls === 2) {
          cancelledSignal = signal;
          return late;
        }
        return observed(calls === 1 ? 'previous' : 'current');
      },
    });
    const options = queries.readItem.options({
      context: { session: 'one' },
      input: { path: { id: 'item' } },
    });
    try {
      const previous = await client.fetchQuery(options);
      const pending = client
        .fetchQuery(options)
        .catch((error: unknown) => error);
      await client.cancelQueries({ queryKey: options.queryKey, exact: true });
      assert.equal(cancelledSignal?.aborted, true);
      // TanStack cancellation reverts to existing success data; the cancelled
      // executor's later result must never replace that data or its successor.
      assert.equal(await pending, previous);
      assert.equal(client.getQueryData(options.queryKey), previous);
      assert.equal(client.getQueryState(options.queryKey)?.status, 'success');

      const current = await client.fetchQuery(options);
      assert.deepEqual(current.data, { id: 'item', label: 'current' });
      if (completion === 'resolve') release(observed('cancelled'));
      else reject(new Error('Cancelled executor failed after replacement'));
      await late.catch(() => {});
      await setImmediate();
      assert.equal(client.getQueryData(options.queryKey), current);
      assert.equal(client.getQueryState(options.queryKey)?.status, 'success');
      assert.equal(calls, 3);
    } finally {
      release(observed('cleanup'));
      client.clear();
    }
  }
});

void test('unsubscribing the last observer aborts execution and rejects its late result', async () => {
  const client = queryClient();
  let release!: (value: Observed) => void;
  const response = new Promise<Observed>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  const queries = module.createQueries({
    namespace: 'observer-cancellation',
    execute: async (_request, execution) => {
      signal = execution.signal;
      return response;
    },
  });
  const options = queries.health.options({ context: {} });
  const observer = new QueryObserver(client, options);
  const unsubscribe = observer.subscribe(() => {});
  try {
    assert.equal(signal?.aborted, false);
    unsubscribe();
    assert.equal(signal?.aborted, true);
    release({ status: 204, headers: {}, body: '' });
    await response;
    await setImmediate();
    assert.equal(client.getQueryData(options.queryKey), undefined);
    assert.equal(client.getQueryState(options.queryKey)?.fetchStatus, 'idle');
  } finally {
    unsubscribe();
    client.clear();
  }
});

void test('query functions accept basic live signals and reject basic pre-aborted signals', async () => {
  let calls = 0;
  const signal = { aborted: false };
  const queries = module.createQueries({
    namespace: 'basic-signals',
    execute: async (_request, execution) => {
      calls += 1;
      assert.equal(execution.signal, signal);
      return { status: 204, headers: {}, body: '' };
    },
  });
  const options = queries.health.options({ context: {} });
  // Native AbortSignal polyfills can expose only the basic aborted state and
  // event API. They need neither throwIfAborted nor reason for query execution.
  const execution = { queryKey: options.queryKey, signal };
  const result = await runtimeInput(options.queryFn, execution);
  assert.equal(result.status, 204);
  signal.aborted = true;
  await assert.rejects(runtimeInput(options.queryFn, execution), {
    name: 'AbortError',
  });
  assert.equal(calls, 1);
});

void test('basic cancellation rejects both late executor responses and late transport failures', async () => {
  for (const completion of ['resolve', 'reject'] as const) {
    let resolve!: (value: Observed) => void;
    let reject!: (error: Error) => void;
    const response = new Promise<Observed>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    const signal = { aborted: false };
    let calls = 0;
    const queries = module.createQueries({
      namespace: 'basic-late-cancellation',
      execute: async () => {
        calls += 1;
        return response;
      },
    });
    const options = queries.health.options({ context: {} });
    const pending = runtimeInput(options.queryFn, {
      queryKey: options.queryKey,
      signal,
    });
    signal.aborted = true;
    if (completion === 'resolve')
      resolve({ status: 204, headers: {}, body: '' });
    else reject(new Error('Late transport failure'));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(calls, 1);
  }
});

void test('defined cancellation reasons preserve their exact value including falsy reasons', async () => {
  let calls = 0;
  const queries = module.createQueries({
    namespace: 'cancellation-reasons',
    execute: async () => {
      calls += 1;
      return { status: 204, headers: {}, body: '' };
    },
  });
  const options = queries.health.options({ context: {} });
  for (const reason of [
    null,
    false,
    0,
    -0,
    '',
    'cancelled',
    Symbol('cancelled'),
    { cancelled: true },
    new Error('Explicit cancellation'),
  ]) {
    await assert.rejects(
      runtimeInput(options.queryFn, {
        queryKey: options.queryKey,
        signal: { aborted: true, reason },
      }),
      (error: unknown) => Object.is(error, reason),
    );
  }
  assert.equal(calls, 0);
});
