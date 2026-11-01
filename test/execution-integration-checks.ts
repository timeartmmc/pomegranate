import assert from 'node:assert/strict';
import { dehydrate, hydrate, QueryClient } from '@tanstack/query-core';
import { record, runtimeInput } from './assertions.ts';

type Module = typeof import('./.generated/execution/client.consumer.ts');
type Queries =
  typeof import('./.generated/execution/client.consumer.queries.ts');
type Executor = import('./.generated/execution/client.consumer.ts').Executor;
type Observed =
  import('./.generated/execution/client.consumer.ts').ObservedResponse;
type CancellationEvent =
  import('./.generated/execution/client.consumer.ts').CancellationEvent;

const response = (status: number, value: unknown): Observed => ({
  status,
  headers: {
    'Content-Type': 'application/json',
    'X-Request-ID': 'integration',
  },
  body: JSON.stringify(value),
});
const args = () => ({
  context: { revision: 'one', locale: 'en' },
  input: { path: { id: 'item' } },
});

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected rejection');
}

export const integrationChecks = {
  'scoped validation exposes frozen inspections and hands off mutable data':
    async (module) => {
      let expired: (() => unknown) | undefined;
      let inspected: unknown;
      const observed = { ...response(200, { id: 'item', label: 'Validated' }) };
      const execute: Executor = async (_request, execution) => {
        expired = () =>
          execution.validateResponse(
            response(200, { id: 'item', label: 'Expired' }),
          );
        const result = execution.validateResponse(observed);
        inspected = result;
        assert.equal(result.kind, 'success');
        if (result.kind !== 'success')
          assert.fail('expected a success inspection');
        assert.ok(Object.isFrozen(result));
        assert.ok(Object.isFrozen(result.data));
        assert.throws(() => {
          record(result.data)['label'] = 'Changed';
        }, TypeError);
        assert.throws(() => execution.validateResponse(observed), TypeError);
        return result;
      };
      const client = module.createClient({ namespace: 'inspection', execute });
      const first = await client.readItem.call(args());
      assert.equal(first.data.label, 'Validated');
      assert.notEqual(first, inspected);
      assert.equal(Object.isFrozen(first.data), false);
      first.data.label = 'Application edit';
      assert.equal(first.data.label, 'Application edit');
      assert.ok(expired);
      assert.throws(expired, TypeError);
      // Evidence identity is local to one execution, including for reused adapters.
      observed.body = '{"id":"item","label":"Second response"}';
      assert.equal(
        (await client.readItem.call(args())).data.label,
        'Second response',
      );
    },

  'scoped validation requires its original result and closes callbacks after rejection':
    async (module) => {
      let receipt: unknown;
      const first = module.createClient({
        namespace: 'receipt-source',
        execute: async (_request, execution) => {
          const result = execution.validateResponse(
            response(200, { id: 'item', label: 'Source' }),
          );
          receipt = result;
          return result;
        },
      });
      await first.readItem.call(args());
      assert.ok(receipt);
      for (const candidate of [
        receipt,
        { ...record(receipt) },
        { kind: 'success', status: 200, data: { id: 'item', label: 'Forged' } },
      ]) {
        const client = runtimeInput(module.createClient, {
          namespace: 'receipt-target',
          execute: async () => candidate,
        });
        const error = await rejected(client.readItem.call(args()));
        assert.ok(error instanceof TypeError);
        assert.equal(client.readItem.isError(error), false);
      }
      const raw = response(200, { id: 'item', label: 'Raw alias' });
      const inspectedRaw = module.createClient({
        namespace: 'inspected-raw',
        execute: async (_request, execution) => {
          execution.validateResponse(raw);
          return raw;
        },
      });
      assert.ok(
        (await rejected(inspectedRaw.readItem.call(args()))) instanceof
          TypeError,
      );
      let expired: (() => unknown) | undefined;
      const applicationError = new Error('application recovery failed');
      const failing = module.createClient({
        namespace: 'expiry-on-rejection',
        execute: async (_request, execution) => {
          expired = () => execution.validateResponse(raw);
          throw applicationError;
        },
      });
      assert.equal(
        await rejected(failing.readItem.call(args())),
        applicationError,
      );
      assert.ok(expired);
      assert.throws(expired, TypeError);
    },

  'recovery can return any validated response while protocol diagnostics remain immutable':
    async (module, queries) => {
      let selected: 'denial' | 'success' | 'protocol' = 'denial';
      const execute: Executor = async (_request, execution) => {
        const denial = execution.validateResponse(
          response(404, { detail: 'Known denial' }),
        );
        const success = execution.validateResponse(
          response(200, { id: 'item', label: 'Recovered' }),
        );
        const protocol = execution.validateResponse(response(200, { id: 7 }));
        assert.equal(denial.kind, 'error');
        assert.equal(protocol.kind, 'protocol');
        if (protocol.kind !== 'protocol')
          assert.fail('expected protocol issues');
        assert.ok(Object.isFrozen(protocol.issues));
        assert.ok(Object.isFrozen(protocol.issues[0]));
        assert.throws(() => {
          record(protocol.issues[0])['message'] = 'Changed';
        }, TypeError);
        if (selected === 'denial') return denial;
        return selected === 'success' ? success : protocol;
      };
      const config = { namespace: 'recovery-choice', execute };
      const client = module.createClient(config);
      const ordinary = queries.createQueries(config);
      const denial = await rejected(client.readItem.call(args()));
      assert.ok(client.readItem.isError(denial));
      assert.ok(ordinary.readItem.body().isError(denial));
      assert.equal(denial.result.kind, 'error');
      selected = 'success';
      assert.equal(
        (await client.readItem.call(args())).data.label,
        'Recovered',
      );
      selected = 'protocol';
      const protocol = await rejected(client.readItem.call(args()));
      assert.ok(client.readItem.isError(protocol));
      assert.equal(protocol.result.kind, 'protocol');
      if (protocol.result.kind !== 'protocol')
        assert.fail('expected a protocol failure');
      assert.notEqual(protocol.result.issues[0]?.message, 'Changed');
    },

  'deep inspection freezing preserves map keys and negative zero without freezing final bodies':
    async (module) => {
      const depth = 12_000;
      const body =
        '{"deep":' +
        '['.repeat(depth) +
        '{"__proto__":{"constructor":-0},"constructor":false}' +
        ']'.repeat(depth) +
        '}';
      function leaf(data: unknown, frozen: boolean): Record<string, unknown> {
        let current: unknown = record(data)['deep'];
        for (let index = 0; index < depth; index++) {
          assert.ok(Array.isArray(current));
          assert.equal(Object.isFrozen(current), frozen);
          current = current[0];
        }
        return record(current);
      }
      const client = module.createClient({
        namespace: 'deep-inspection',
        execute: async (_request, execution) => {
          const result = execution.validateResponse({
            status: 200,
            headers: { 'Content-Type': 'application/json' },
            body,
          });
          assert.equal(result.kind, 'success');
          if (result.kind !== 'success') assert.fail('expected map success');
          const value = leaf(result.data, true);
          assert.ok(Object.isFrozen(value));
          assert.ok(Object.hasOwn(value, '__proto__'));
          assert.ok(Object.is(record(value['__proto__'])['constructor'], -0));
          assert.throws(() => {
            value['constructor'] = true;
          }, TypeError);
          return result;
        },
      });
      const result = await client.readMap.call({ context: {} });
      const value = leaf(result.data, false);
      assert.equal(Object.isFrozen(value), false);
      assert.ok(Object.is(record(value['__proto__'])['constructor'], -0));
      value['constructor'] = true;
      assert.equal(value['constructor'], true);
    },

  'one cancellation mapper covers direct guards, late outcomes and query-function exits':
    async (module, queries) => {
      const reason = { cancelled: 'application' };
      const mapped = new Error('application cancellation');
      for (const stage of ['pre-abort', 'success', 'rejection'] as const) {
        const controller = new AbortController();
        const events: CancellationEvent[] = [];
        let attempts = 0;
        if (stage === 'pre-abort') controller.abort(reason);
        const config = {
          namespace: 'mapped-cancellation',
          execute: async () => {
            attempts++;
            controller.abort(reason);
            if (stage === 'rejection') {
              // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- A terminal undefined rejection must remain distinguishable from no rejection.
              return Promise.reject(undefined);
            }
            return response(200, { id: 'item', label: 'Late' });
          },
          mapCancellation: (event: CancellationEvent) => {
            events.push(event);
            return { error: mapped };
          },
        };
        const client = module.createClient(config);
        assert.equal(
          await rejected(
            client.readItem.call({ ...args(), signal: controller.signal }),
          ),
          mapped,
        );
        assert.equal(events.length, 1);
        const event = events[0]!;
        assert.ok(Object.isFrozen(event));
        assert.equal(event.namespace, config.namespace);
        assert.equal(event.operationId, 'readItem');
        assert.equal(event.reason, reason);
        assert.equal(event.executorInvoked, stage !== 'pre-abort');
        assert.equal(attempts, stage === 'pre-abort' ? 0 : 1);
        assert.equal(Object.hasOwn(event, 'rejection'), stage === 'rejection');
        if (stage === 'rejection') {
          assert.ok(event.rejection);
          assert.ok(Object.hasOwn(event.rejection, 'error'));
          assert.equal(event.rejection.error, undefined);
          assert.ok(Object.isFrozen(event.rejection));
        }
      }
      const controller = new AbortController();
      controller.abort(reason);
      let mappings = 0;
      const ordinary = queries.createQueries({
        namespace: 'query-mapping',
        execute: async () => response(200, { id: 'item', label: 'Unused' }),
        mapCancellation: () => {
          mappings++;
          return { error: mapped };
        },
      });
      const options = ordinary.readItem.body().options(args());
      const cache = new QueryClient();
      try {
        assert.equal(
          await rejected(
            options.queryFn({
              queryKey: options.queryKey,
              signal: controller.signal,
              client: cache,
              meta: undefined,
            }),
          ),
          mapped,
        );
        assert.equal(mappings, 1);
      } finally {
        cache.clear();
      }
    },

  'raw and scoped consumers cache ordinary bodies and both infinite body profiles':
    async (module, queries) => {
      for (const scoped of [false, true]) {
        const execute: Executor = async (request, execution) => {
          const url = new URL(request.url, 'https://synthetic.invalid');
          let observed: Observed;
          if (request.operationId === 'listItems') {
            const next = url.searchParams.has('after');
            observed = response(next ? 206 : 200, {
              results: [next ? { code: 2 } : { id: 'one', label: 'First' }],
              continuation: next ? null : 'next',
            });
          } else if (request.operationId === 'listRecords') {
            const next = url.searchParams.get('start') === '1';
            observed = response(next ? 206 : 200, {
              entries: [{ id: next ? 'two' : 'one' }],
              start: next ? 1 : 0,
              size: 1,
              count: 2,
              next: null,
              ...(next ? { segment: 'partial' } : {}),
            });
          } else if (request.method === 'HEAD')
            observed = { status: 204, headers: {}, body: '' };
          else observed = response(200, { id: 'item', label: 'Body' });
          return scoped ? execution.validateResponse(observed) : observed;
        };
        const config = {
          namespace: `body-consumer-${String(scoped)}`,
          execute,
        };
        const ordinary = queries.createQueries(config);
        const infinite = queries.createInfiniteQueries(config);
        const cache = new QueryClient({
          defaultOptions: {
            queries: { structuralSharing: queries.shareQueryData },
          },
        });
        try {
          const body = await cache.fetchQuery(
            ordinary.readItem.body().options(args()),
          );
          assert.deepEqual(body, { id: 'item', label: 'Body' });
          assert.equal(Object.isFrozen(body), false);
          const cursor = await cache.fetchInfiniteQuery({
            ...infinite.listItems.body().options({
              context: {},
              input: { path: { collection: 'items' } },
            }),
            pages: 2,
          });
          assert.deepEqual(cursor.pageParams, [null, 'next']);
          assert.deepEqual(infinite.listItems.body().items(cursor), [
            { id: 'one', label: 'First' },
            { code: 2 },
          ]);
          const offset = await cache.fetchInfiniteQuery({
            ...infinite.listRecords.body().options({
              context: {},
              input: { path: { category: 'records' } },
            }),
            pages: 2,
          });
          assert.deepEqual(offset.pageParams, [0, 1]);
          assert.deepEqual(infinite.listRecords.body().items(offset), [
            { id: 'one' },
            { id: 'two' },
          ]);
          assert.equal(
            (await module.createClient(config).health.call({ context: {} }))
              .status,
            204,
          );
        } finally {
          cache.clear();
        }
      }
    },

  'cold body writes and JSON hydration preserve arbitrary map keys and equal body identity':
    async (_module, queries) => {
      const source = '{"__proto__":{"constructor":null},"constructor":null}';
      const ordinary = queries.createQueries({
        namespace: 'cold-body',
        execute: async () => ({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: source,
        }),
      });
      const factory = ordinary.readMap.body();
      const key = factory.key({ context: {} });
      const defaults = {
        queries: {
          structuralSharing: queries.shareQueryData,
          staleTime: Infinity,
        },
      };
      const cache = new QueryClient({ defaultOptions: defaults });
      const restored = new QueryClient({ defaultOptions: defaults });
      try {
        const ownedMap = () => {
          const data: Record<string, null | { constructor: null }> = {};
          Object.defineProperty(data, '__proto__', {
            value: { constructor: null },
            enumerable: true,
            configurable: true,
            writable: true,
          });
          data['constructor'] = null;
          return data;
        };
        const first = ownedMap();
        cache.setQueryData(key, first);
        cache.setQueryData(key, ownedMap());
        assert.equal(cache.getQueryData(key), first);
        hydrate(
          restored,
          JSON.parse(JSON.stringify(dehydrate(cache))) as ReturnType<
            typeof dehydrate
          >,
        );
        const hydrated = restored.getQueryData(key);
        assert.equal(JSON.stringify(hydrated), source);
        await restored.invalidateQueries(factory.filter({ context: {} }));
        await restored.fetchQuery(factory.options({ context: {} }));
        assert.equal(restored.getQueryData(key), hydrated);
      } finally {
        cache.clear();
        restored.clear();
      }
    },
} satisfies Readonly<
  Record<string, (module: Module, queries: Queries) => Promise<void>>
>;
