import assert from 'node:assert/strict';
import {
  InfiniteQueryObserver,
  QueryClient,
  QueryObserver,
  hydrate,
} from '@tanstack/query-core';
import { json, record } from './assertions.ts';
import { dehydrateJson } from './query-hydration.ts';

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
        const retained = create();
        const oldWrapper = { retained };
        const newWrapper = { retained };
        assert.equal(share(oldWrapper, newWrapper), newWrapper);
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

  'retained selections inspect each field once and appends leave retained branches untouched':
    async ({ shareQueryData: share }) => {
      let reads = 0;
      const retained = new Proxy(
        { value: 1 },
        {
          getOwnPropertyDescriptor(target, key) {
            if (key === 'value') reads++;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        },
      );
      const previous = { rows: [retained] };
      assert.equal(share(previous, { rows: previous.rows }), previous);
      assert.equal(reads, 1);
      reads = 0;
      const appended = { rows: [...previous.rows, { value: 2 }] };
      assert.equal(share(previous, appended), appended);
      assert.equal(reads, 0);
    },

  'new branches defer reflection only while output stays unchanged': async ({
    shareQueryData: share,
  }) => {
    let inspections = 0;
    const incoming = new Proxy(
      { value: 1 },
      {
        ownKeys(target) {
          inspections++;
          return Reflect.ownKeys(target);
        },
      },
    );
    assert.equal(share(undefined, incoming), incoming);
    const next = { rows: [incoming] };
    assert.equal(share({ rows: [] }, next), next);
    assert.equal(inspections, 0);

    const stable = { value: 1 };
    const previous = { stable };
    const changed = { stable: { value: 1 }, rows: [incoming] };
    const result = share(previous, changed);
    assert.equal(result.stable, stable);
    assert.ok(inspections > 0);
    assert.deepEqual(result, changed);

    for (const candidate of [
      { stable: { value: 1 }, added: { link: stable } },
      { added: { link: stable }, stable: { value: 1 } },
    ]) {
      const shared = share(previous, candidate);
      assert.deepEqual(shared, candidate);
      assert.notEqual(shared.stable, shared.added.link);
    }
  },

  'retained branches cannot link back to either outer container': async ({
    shareQueryData: share,
  }) => {
    for (const origin of ['previous', 'next'] as const) {
      const retained: { link?: object } = {};
      const previous = { rows: [retained] };
      const next = { rows: previous.rows };
      retained.link = origin === 'previous' ? previous : next;
      assert.equal(share(previous, next), next);
      assert.equal(next.rows[0], retained);
      assert.equal(retained.link, origin === 'previous' ? previous : next);
    }
  },

  'relocated nodes cannot merge independent objects in the next tree': async ({
    shareQueryData: share,
  }) => {
    const retained = { value: 1 };
    for (const next of [
      { a: { value: 1 }, b: retained },
      { b: retained, a: { value: 1 } },
    ]) {
      const result = share({ a: retained }, next);
      assert.deepEqual(result, next);
      assert.notEqual(result.a, result.b);
      assert.notEqual(next.a, next.b);
    }

    const previous = [
      { id: 'a', attributes: { value: 0 } },
      { id: 'b', attributes: { value: 1 } },
      { id: 'c', attributes: { value: 1 } },
    ];
    for (const next of [
      [{ id: 'new', attributes: { value: 0 } }, ...previous],
      previous.slice(1),
      [previous[2]!, previous[0]!, previous[1]!],
    ]) {
      const before = JSON.stringify(next);
      const result = share(previous, next);
      assert.deepEqual(result, next);
      assert.equal(
        new Set(result.map((item) => item.attributes)).size,
        next.length,
      );
      assert.equal(JSON.stringify(next), before);
    }
  },

  'cache updates preserve distinct fresh and relocated objects': async (
    module,
  ) => {
    const client = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity } },
    });
    const queries = module.createQueries({
      namespace: 'relocated-cache-data',
      execute: async () => observed({ a: { value: 1 } }),
    });
    const options = queries.readMap.options({ context: {} });
    try {
      await client.fetchQuery(options);
      client.setQueryData(options.queryKey, (previous) => {
        if (previous?.status !== 200) return previous;
        const retained = previous.data['a'];
        assert.ok(retained !== undefined);
        return { ...previous, data: { a: { value: 1 }, b: retained } };
      });
      const data = record(client.getQueryData(options.queryKey)!.data);
      assert.deepEqual(data, { a: { value: 1 }, b: { value: 1 } });
      assert.notEqual(data['a'], data['b']);
    } finally {
      client.clear();
    }
  },

  'filtered selections preserve independent objects from retained items':
    async (module) => {
      const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
      });
      const queries = module.createInfiniteQueries({
        namespace: 'filtered-shared-items',
        execute: async () =>
          observed({
            results: [
              { id: 'a', label: 'a', attributes: { value: 0 } },
              { id: 'b', label: 'b', attributes: { value: 1 } },
              { id: 'c', label: 'c', attributes: { value: 1 } },
            ],
            continuation: null,
          }),
      });
      const options = queries.listItems.options({
        context: {},
        input: { path: { collection: 'items' } },
      });
      const observer = new InfiniteQueryObserver(client, {
        ...options,
        enabled: false,
        select: queries.listItems.items,
      });
      const unsubscribe = observer.subscribe(() => {});
      try {
        await client.fetchInfiniteQuery(options);
        observer.setOptions({
          ...options,
          enabled: false,
          select: (data) => queries.listItems.items(data).slice(1),
        });
        const items = observer.getCurrentResult().data!;
        assert.deepEqual(
          items.map((item) => item.id),
          ['b', 'c'],
        );
        assert.notEqual(items[0]!.attributes, items[1]!.attributes);
      } finally {
        unsubscribe();
        client.clear();
      }
    },

  'page eviction preserves independent nested objects in caches and selections':
    async (module) => {
      const client = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity } },
      });
      let calls = 0;
      const queries = module.createInfiniteQueries({
        namespace: 'evicted-shared-items',
        execute: async (request) => {
          calls++;
          const cursor = new URL(
            request.url,
            'https://synthetic.invalid',
          ).searchParams.get('after');
          const index = cursor === null ? 0 : Number(cursor);
          return observed({
            results: [
              {
                id: String(index),
                label: 'item',
                attributes: { first: index === 0 },
              },
            ],
            continuation: index < 3 ? String(index + 1) : null,
          });
        },
      });
      const options = {
        ...queries.listItems.options({
          context: {},
          input: { path: { collection: 'items' } },
        }),
        maxPages: 2,
      };
      const observer = new InfiniteQueryObserver(client, {
        ...options,
        enabled: false,
        select: queries.listItems.items,
      });
      const unsubscribe = observer.subscribe(() => {});
      try {
        await client.fetchInfiniteQuery({ ...options, pages: 2 });
        for (const index of [2, 3]) {
          const selected = await observer.fetchNextPage();
          assert.equal(selected.status, 'success');
          const cached = client.getQueryData(options.queryKey)!;
          assert.deepEqual(cached.pageParams, [
            String(index - 1),
            String(index),
          ]);
          const items = queries.listItems.items(cached);
          assert.deepEqual(
            items.map((item) => item.id),
            [String(index - 1), String(index)],
          );
          assert.notEqual(items[0]!.attributes, items[1]!.attributes);
          assert.notEqual(
            selected.data[0]!.attributes,
            selected.data[1]!.attributes,
          );
          assert.ok(Object.isFrozen(cached.pages[0]));
          assert.equal(cached.pages[0]!.headers['__proto__'], 'original');
        }
        assert.equal(calls, 4);
      } finally {
        unsubscribe();
        client.clear();
      }
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

  'mixed retained graphs preserve aliases, cycles and descriptors without modifying inputs':
    async ({ shareQueryData: share }) => {
      function graph(
        value: unknown,
        seen = new Map<object, number>(),
      ): unknown {
        if (value === null || typeof value !== 'object') return value;
        const reference = seen.get(value);
        if (reference !== undefined) return ['reference', reference];
        const id = seen.size;
        seen.set(value, id);
        const prototype: unknown = Object.getPrototypeOf(value);
        return [
          id,
          prototype,
          Object.isExtensible(value),
          Reflect.ownKeys(value).map((key) => {
            const field = Object.getOwnPropertyDescriptor(value, key)!;
            const child: unknown = field.value;
            return [
              key,
              field.enumerable,
              field.configurable,
              field.writable,
              graph(child, seen),
            ];
          }),
        ];
      }
      let seed = 0x706f6d;
      const random = () => (seed = (seed * 1664525 + 1013904223) >>> 0);
      type Node = { value: number; link?: object };
      type Root = { a: unknown; b: unknown; rows: unknown[] };
      for (let iteration = 0; iteration < 512; iteration++) {
        const pool: Node[] = Array.from({ length: 5 }, () => ({
          value: random() % 3,
        }));
        const pick = () => pool[random() % pool.length]!;
        const previous: Root = {
          a: pick(),
          b: { leaf: pick() },
          rows: [pick(), pick()],
        };
        if (iteration % 5 === 0) pool[0]!.link = previous;
        const next: Root = {
          a: random() % 2 ? pick() : { value: random() % 3 },
          b: { leaf: pick() },
          rows: [pick(), { value: random() % 3 }],
        };
        if (iteration % 7 === 0) next.rows.push(next);
        if (iteration % 11 === 0) Object.freeze(pick());
        const before = graph(next);
        const beforePrevious = graph(previous);
        assert.deepEqual(graph(share(previous, next)), before);
        assert.deepEqual(graph(next), before);
        assert.deepEqual(graph(previous), beforePrevious);
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
        hydrate(restored, dehydrateJson(client));
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
