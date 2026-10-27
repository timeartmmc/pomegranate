import assert from 'node:assert/strict';
import {
  QueryClient,
  QueryObserver,
  dehydrate,
  hydrate,
} from '@tanstack/query-core';
import { json, record } from './assertions.ts';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
type Observed = import('./.generated/infinite/runtime.ts').ObservedResponse;

const queryClient = (share: Module['shareQueryData']) =>
  new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, structuralSharing: share } },
  });
const headers = (value = 'original') =>
  Object.fromEntries([
    ['Content-Type', 'application/json'],
    ['__proto__', value],
  ]);
const observed = (body: unknown, header = 'original'): Observed => ({
  status: 200,
  headers: headers(header),
  body: JSON.stringify(body),
});

export const querySharingChecks = {
  'equal data trees reuse references and changed containers preserve frozen descriptors':
    async ({ shareQueryData: share }) => {
      const previous = Object.freeze({
        stable: Object.freeze({ id: 'same' }),
        changed: Object.freeze({ id: 'old' }),
      });
      const same = Object.freeze({
        stable: Object.freeze({ id: 'same' }),
        changed: Object.freeze({ id: 'old' }),
      });
      assert.equal(share(previous, same), previous);
      const next = Object.freeze({
        stable: Object.freeze({ id: 'same' }),
        changed: Object.freeze({ id: 'new' }),
      });
      const result = share(previous, next);
      assert.notEqual(result, previous);
      assert.notEqual(result, next);
      assert.equal(result.stable, previous.stable);
      assert.equal(result.changed, next.changed);
      assert.ok(Object.isFrozen(result));
      assert.deepEqual(Object.getOwnPropertyDescriptor(result, 'stable'), {
        value: previous.stable,
        enumerable: true,
        writable: false,
        configurable: false,
      });
      assert.equal(previous.changed.id, 'old');
      assert.notEqual(next.stable, previous.stable);

      const oldArray = Object.freeze([previous.stable, previous.changed]);
      const newArray = Object.freeze([next.stable, next.changed]);
      const array = share(oldArray, newArray);
      assert.ok(Array.isArray(array));
      assert.equal(array[0], previous.stable);
      assert.equal(array[1], next.changed);
      assert.ok(Object.isFrozen(array));
      assert.deepEqual(array, newArray);

      const reordered = share(
        { a: previous.stable, b: 1, removed: true },
        { b: 2, a: Object.freeze({ id: 'same' }) },
      );
      assert.deepEqual(Object.keys(reordered), ['b', 'a']);
      assert.equal(reordered.a, previous.stable);
      assert.equal(reordered.b, 2);
      assert.equal(Object.hasOwn(reordered, 'removed'), false);
      const mutable = share(previous, {
        stable: { id: 'same' },
        changed: { id: 'old' },
      });
      assert.notEqual(mutable, previous);
      assert.equal(Object.isFrozen(mutable), false);
      assert.equal(Object.isFrozen(mutable.stable), false);
    },

  'sharing preserves every special map key and null-prototype header record':
    async ({ shareQueryData: share }) => {
      const names = [
        '__proto__',
        'constructor',
        'prototype',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'toJSON',
        '',
        '0',
        '1',
        '01',
        '🔥',
        'a\u0000b',
        '\ud800',
      ];
      const previous = Object.fromEntries(
        names.map((name) => [name, { stable: [1], value: 'old' }]),
      );
      const next = Object.fromEntries(
        names.map((name) => [name, { stable: [1], value: 'new' }]),
      );
      const result = share(previous, next);
      assert.deepEqual(result, next);
      assert.equal(Object.getPrototypeOf(result), Object.prototype);
      for (const name of names) {
        assert.ok(Object.hasOwn(result, name));
        assert.equal(result[name]!.stable, previous[name]!.stable);
        assert.equal(result[name]!.value, 'new');
      }
      const oldHeaders = Object.freeze(
        Object.assign(Object.create(null) as Record<string, string>, {
          'content-type': 'application/json',
        }),
      );
      const newHeaders = Object.create(null) as Record<string, string>;
      for (const [name, value] of Object.entries(headers('new')))
        Object.defineProperty(newHeaders, name, {
          value,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      Object.freeze(newHeaders);
      const old = { headers: oldHeaders, stable: { id: 1 }, constructor: null };
      const fresh = {
        headers: newHeaders,
        stable: { id: 1 },
        constructor: null,
      };
      const shared = share(old, fresh);
      assert.equal(shared.stable, old.stable);
      assert.equal(Object.getPrototypeOf(shared.headers), null);
      assert.ok(Object.isFrozen(shared.headers));
      assert.ok(Object.hasOwn(shared.headers, '__proto__'));
      assert.equal(shared.headers['__proto__'], 'new');
      assert.equal(shared.constructor, null);
    },

  'unsupported selected objects and graph identities retain their new values':
    async ({ shareQueryData: share }) => {
      let reads = 0;
      const accessor = () =>
        Object.defineProperty({}, 'value', {
          enumerable: true,
          get() {
            reads++;
            return 1;
          },
        });
      class Selected {
        value = 1;
      }
      const sparse = (): unknown[] => {
        const values: unknown[] = [];
        values.length = 2;
        return values;
      };
      const symbol = Symbol('field');
      const values = [
        () => new Selected(),
        () => new Date(0),
        () => new Map([['value', 1]]),
        () => new Set([1]),
        () => ({ nested: new Selected() }),
        accessor,
        sparse,
        () => ({ [symbol]: 1 }),
        () => Object.defineProperty({}, 'hidden', { value: 1 }),
        () => Object.assign([1], { extra: true }),
        () => ({
          callback() {
            return 1;
          },
        }),
        () =>
          new Proxy(
            {},
            {
              getPrototypeOf() {
                throw new Error('opaque');
              },
            },
          ),
      ];
      for (const create of values) {
        const previous = create();
        const next = create();
        assert.equal(share(previous, next), next);
      }
      assert.equal(reads, 0);
      const previous: { self?: object } = {};
      previous.self = previous;
      const next: { self?: object } = {};
      next.self = next;
      assert.equal(share(previous, next), next);
      assert.equal(next.self, next);
      const oldTree = { a: { value: 1 }, b: { value: 1 } };
      const alias = { value: 1 };
      const newGraph = { a: alias, b: alias };
      assert.equal(share(oldTree, newGraph), newGraph);
      assert.equal(newGraph.a, newGraph.b);
      const oldGraph = { a: alias, b: alias };
      const newTree = { a: { value: 1 }, b: { value: 1 } };
      assert.equal(share(oldGraph, newTree), newTree);
      assert.notEqual(newTree.a, newTree.b);
      const branch = { leaf: alias };
      const hiddenNewAlias = { same: branch, other: alias };
      assert.equal(
        share({ same: branch, other: { value: 1 } }, hiddenNewAlias),
        hiddenNewAlias,
      );
      assert.equal(hiddenNewAlias.same.leaf, hiddenNewAlias.other);
      const hiddenOldAlias = { same: branch, other: { value: 1 } };
      assert.equal(
        share({ same: branch, other: alias }, hiddenOldAlias),
        hiddenOldAlias,
      );
      assert.notEqual(hiddenOldAlias.same.leaf, hiddenOldAlias.other);
      assert.ok(Object.is(share(0, -0), -0));
      assert.ok(Object.is(share(-0, 0), 0));
    },

  'deep JSON trees share without recursion or truncating changed leaves':
    async ({ shareQueryData: share }) => {
      let previous: unknown = { leaf: 1 };
      let next: unknown = { leaf: 1 };
      let changed: unknown = { leaf: 2 };
      for (let level = 0; level < 20_000; level++) {
        previous = { child: previous };
        next = { child: next };
        changed = { child: changed };
      }
      assert.equal(share(previous, next), previous);
      assert.equal(share(previous, changed), changed);
    },

  'seeded plain-data trees preserve values and reuse independently cloned equal trees':
    async ({ shareQueryData: share }) => {
      let seed = 0x706f6d;
      const random = () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed;
      };
      const names = ['__proto__', 'constructor', 'nested', '', '0', 'value'];
      function value(depth: number): unknown {
        const choice = random() % (depth === 0 ? 4 : 6);
        if (choice === 0) return null;
        if (choice === 1) return random() % 100;
        if (choice === 2) return random() % 2 === 0;
        if (choice === 3) return 'value-' + random();
        if (choice === 4)
          return Array.from({ length: random() % 5 }, () => value(depth - 1));
        return Object.fromEntries(
          Array.from({ length: random() % 5 }, () => [
            names[random() % names.length]!,
            value(depth - 1),
          ]),
        );
      }
      for (let iteration = 0; iteration < 160; iteration++) {
        const previous = value(6);
        const before = JSON.stringify(previous);
        const same = json(before);
        assert.equal(share(previous, same), previous);
        const next = value(6);
        const nextBefore = JSON.stringify(next);
        assert.deepEqual(share(previous, next), next);
        assert.equal(JSON.stringify(previous), before);
        assert.equal(JSON.stringify(next), nextBefore);
      }
    },

  'query caches and selections reuse unchanged data while preserving changed raw headers':
    async (module) => {
      const client = queryClient(module.shareQueryData);
      let raw = observed({ id: 'one', label: 'same' });
      const queries = module.createQueries({
        namespace: 'shared-headers',
        execute: async () => raw,
      });
      const options = queries.readItem.options({
        context: {},
        input: { path: { id: 'one' } },
      });
      const observer = new QueryObserver(client, {
        ...options,
        enabled: false,
        notifyOnChangeProps: ['data'],
        select: (result) => result.data,
      });
      let updates = 0;
      const unsubscribe = observer.subscribe(() => {
        updates++;
      });
      try {
        await client.fetchQuery(options);
        const first = client.getQueryData(options.queryKey)!;
        const selected = observer.getCurrentResult().data;
        const before = updates;
        await client.fetchQuery(options);
        const same = client.getQueryData(options.queryKey)!;
        assert.equal(same, first);
        assert.equal(observer.getCurrentResult().data, selected);
        assert.equal(updates, before);
        raw = observed({ id: 'one', label: 'same' }, 'changed');
        await client.fetchQuery(options);
        const changed = client.getQueryData(options.queryKey)!;
        assert.notEqual(changed, first);
        assert.equal(changed.data, first.data);
        assert.equal(changed.headers['__proto__'], 'changed');
        assert.ok(Object.hasOwn(changed.headers, '__proto__'));
        assert.equal(Object.getPrototypeOf(changed.headers), null);
        assert.ok(Object.isFrozen(changed.headers));
        assert.ok(Object.isFrozen(changed));
        assert.equal(updates, before);
        raw = observed({ id: 'one', label: 'updated' }, 'changed');
        const updated = await client.fetchQuery(options);
        assert.equal(updated.data.label, 'updated');
        assert.equal(updates, before + 1);
      } finally {
        unsubscribe();
        client.clear();
      }
    },

  'hydrated map caches preserve special keys through refetches and application updates':
    async (module) => {
      const client = queryClient(module.shareQueryData);
      const restored = queryClient(module.shareQueryData);
      let raw = observed({
        ['__proto__']: { stable: [1], revision: 0 },
        constructor: null,
      });
      const queries = module.createQueries({
        namespace: 'shared-maps',
        execute: async () => raw,
      });
      const options = queries.readMap.options({ context: {} });
      try {
        await client.fetchQuery(options);
        const initial = client.getQueryData(options.queryKey)!;
        await client.fetchQuery(options);
        assert.equal(client.getQueryData(options.queryKey), initial);
        hydrate(restored, json(JSON.stringify(dehydrate(client))));
        const hydrated = restored.getQueryData(options.queryKey)!;
        raw = observed({
          ['__proto__']: { stable: [1], revision: 1 },
          constructor: null,
        });
        await restored.fetchQuery(options);
        const changed = restored.getQueryData(options.queryKey)!;
        const data = record(changed.data);
        assert.ok(Object.hasOwn(data, '__proto__'));
        assert.equal(data['constructor'], null);
        assert.equal(
          record(data['__proto__'])['stable'],
          record(record(hydrated.data)['__proto__'])['stable'],
        );
        assert.equal(record(data['__proto__'])['revision'], 1);
        restored.setQueryData(options.queryKey, (previous) =>
          previous?.status === 200
            ? { ...previous, data: { ...previous.data, added: true } }
            : previous,
        );
        const updated = record(restored.getQueryData(options.queryKey)!.data);
        assert.ok(Object.hasOwn(updated, '__proto__'));
        assert.equal(updated['constructor'], null);
        assert.equal(updated['added'], true);
      } finally {
        client.clear();
        restored.clear();
      }
    },

  'generated map queries retain deep JSON through unchanged and changed refetches':
    async (module) => {
      const client = queryClient(module.shareQueryData);
      const depth = 12_000;
      let leaf = 'original';
      const queries = module.createQueries({
        namespace: 'shared-deep-json',
        execute: async () => ({
          status: 200,
          headers: headers(),
          body:
            '{"deep":' +
            '{"child":'.repeat(depth) +
            JSON.stringify({ leaf }) +
            '}'.repeat(depth) +
            ',"stable":{"id":1}}',
        }),
      });
      const options = queries.readMap.options({ context: {} });
      try {
        await client.fetchQuery(options);
        const initial = client.getQueryData(options.queryKey)!;
        await client.fetchQuery(options);
        assert.equal(client.getQueryData(options.queryKey), initial);
        leaf = 'changed';
        await client.fetchQuery(options);
        const changed = client.getQueryData(options.queryKey)!;
        assert.notEqual(changed, initial);
        assert.equal(
          record(changed.data)['stable'],
          record(initial.data)['stable'],
        );
        let nested = record(changed.data)['deep'];
        for (let level = 0; level < depth; level++)
          nested = record(nested)['child'];
        assert.equal(record(nested)['leaf'], leaf);
      } finally {
        client.clear();
      }
    },

  'infinite refetches reuse unchanged pages and selected items': async (
    module,
  ) => {
    const client = queryClient(module.shareQueryData);
    let revision = 0;
    const queries = module.createInfiniteQueries({
      namespace: 'shared-pages',
      execute: async (request) => {
        const later = new URL(
          request.url,
          'https://synthetic.invalid',
        ).searchParams.has('after');
        return observed({
          results: [
            {
              id: later ? 'later' : 'first',
              label: later ? String(revision) : 'stable',
            },
          ],
          continuation: later ? null : 'next',
        });
      },
    });
    const options = queries.listItems.options({
      context: {},
      input: { path: { collection: 'items' } },
    });
    try {
      await client.fetchInfiniteQuery({ ...options, pages: 2 });
      const initial = client.getQueryData(options.queryKey)!;
      const selected = module.shareQueryData(
        undefined,
        queries.listItems.items(initial),
      );
      await client.fetchInfiniteQuery(options);
      const same = client.getQueryData(options.queryKey)!;
      assert.equal(same, initial);
      assert.equal(
        module.shareQueryData(selected, queries.listItems.items(same)),
        selected,
      );
      revision++;
      await client.fetchInfiniteQuery(options);
      const changed = client.getQueryData(options.queryKey)!;
      assert.equal(changed.pages[0], initial.pages[0]);
      assert.notEqual(changed.pages[1], initial.pages[1]);
      assert.equal(changed.pageParams, initial.pageParams);
      assert.equal(changed.pages[1]!.data.results[0]!.label, '1');
    } finally {
      client.clear();
    }
  },
} satisfies Readonly<Record<string, (module: Module) => Promise<void>>>;

export async function verifyQuerySharing(module: Module) {
  for (const check of Object.values(querySharingChecks)) await check(module);
}
