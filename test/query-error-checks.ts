import assert from 'node:assert/strict';
import { QueryClient } from '@tanstack/query-core';

type Module = typeof import('./.generated/infinite/client.consumer.queries.ts');
type Staff = typeof import('./.generated/infinite/client.staff.queries.ts');
type Observed = import('./.generated/infinite/runtime.ts').ObservedResponse;

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected a query rejection');
}

const itemArgs = { context: {}, input: { path: { id: 'item' } } };
const pageArgs = { context: {}, input: { path: { collection: 'items' } } };
const missing: Observed = {
  status: 404,
  headers: { 'Content-Type': 'application/json' },
  body: '{"detail":"Missing","extra":"stripped"}',
};
const queryClient = () =>
  new QueryClient({ defaultOptions: { queries: { gcTime: Infinity } } });

export const queryErrorChecks = {
  'factory guards retain exact HTTP errors, bodyless errors and protocol evidence':
    async (module) => {
      const client = queryClient();
      let observed = missing;
      const config = {
        namespace: 'error-bodies',
        execute: async () => observed,
      };
      const ordinary = module.createQueries(config);
      const infinite = module.createInfiniteQueries(config);
      const executions = [
        {
          run: () => client.fetchQuery(ordinary.readItem.options(itemArgs)),
          isError: ordinary.readItem.isError,
        },
        {
          run: () =>
            client.fetchInfiniteQuery(infinite.listItems.options(pageArgs)),
          isError: infinite.listItems.isError,
        },
      ];
      try {
        for (const execution of executions) {
          observed = missing;
          const error = await rejected(execution.run());
          assert.ok(execution.isError(error));
          assert.ok(error instanceof module.QueryResponseError);
          assert.equal(error.result.kind, 'error');
          if (error.result.kind !== 'error')
            assert.fail('expected an HTTP error');
          assert.equal(error.result.status, 404);
          assert.deepEqual(error.result.data, { detail: 'Missing' });
          assert.ok(Object.isFrozen(error.result));

          observed = { status: 410, headers: {}, body: '' };
          const empty = await rejected(execution.run());
          assert.ok(execution.isError(empty));
          assert.equal(empty.result.kind, 'error');
          if (empty.result.kind !== 'error')
            assert.fail('expected an HTTP error');
          assert.equal(empty.result.status, 410);
          assert.equal(empty.result.data, undefined);

          for (const invalid of [
            { ...missing, body: '{}' },
            { ...missing, status: 499 },
            { status: 410, headers: {}, body: 'unexpected' },
          ]) {
            observed = invalid;
            const protocol = await rejected(execution.run());
            assert.ok(execution.isError(protocol));
            assert.equal(protocol.result.kind, 'protocol');
            assert.equal(protocol.result.status, invalid.status);
            assert.equal(Object.hasOwn(protocol.result, 'data'), false);
          }
        }
      } finally {
        client.clear();
      }
    },

  'error guards isolate operations, clients and namespaces across factory instances':
    async (module, staff) => {
      const client = queryClient();
      const config = {
        namespace: 'scoped-errors',
        execute: async () => missing,
      };
      const queries = module.createQueries(config);
      const infinite = module.createInfiniteQueries(config);
      try {
        const error = await rejected(
          client.fetchQuery(queries.readItem.options(itemArgs)),
        );
        assert.ok(queries.readItem.isError(error));
        assert.ok(module.createQueries(config).readItem.isError(error));
        assert.equal(queries.readMap.isError(error), false);
        assert.equal(queries.health.isError(error), false);
        assert.equal(infinite.listItems.isError(error), false);
        assert.equal(
          staff.createQueries(config).readItem.isError(error),
          false,
        );
        assert.equal(
          module
            .createQueries({ ...config, namespace: 'other-api' })
            .readItem.isError(error),
          false,
        );

        const pageError = await rejected(
          client.fetchInfiniteQuery(infinite.listItems.options(pageArgs)),
        );
        assert.ok(infinite.listItems.isError(pageError));
        assert.ok(queries.listItems.isError(pageError));
        const ordinaryPageError = await rejected(
          client.fetchQuery(queries.listItems.options(pageArgs)),
        );
        assert.ok(infinite.listItems.isError(ordinaryPageError));
        assert.equal(queries.readItem.isError(pageError), false);
      } finally {
        client.clear();
      }
    },

  'guards reject transport failures, forged errors and replaced response evidence':
    async (module) => {
      const client = queryClient();
      let transport: Error | undefined;
      const config = {
        namespace: 'untrusted-errors',
        execute: async () => {
          if (transport !== undefined) throw transport;
          return missing;
        },
      };
      const queries = module.createQueries(config);
      const infinite = module.createInfiniteQueries(config);
      const fake = new module.QueryResponseError({
        kind: 'error',
        operationId: 'readItem',
        status: 404,
        headers: {},
        validatedHeaders: {},
        data: { detail: 7 },
      });
      try {
        for (const value of [
          undefined,
          null,
          false,
          0,
          'failure',
          {},
          new Error('network'),
          fake,
          Object.create(module.QueryResponseError.prototype) as unknown,
          new Proxy(
            {},
            {
              get() {
                assert.fail('foreign getters must not run');
              },
            },
          ),
        ]) {
          assert.equal(queries.readItem.isError(value), false);
          assert.equal(infinite.listItems.isError(value), false);
        }
        for (const value of [new Error('network'), fake]) {
          transport = value;
          const error = await rejected(
            client.fetchQuery(queries.readItem.options(itemArgs)),
          );
          assert.equal(error, value);
          assert.equal(queries.readItem.isError(error), false);
        }
        transport = undefined;
        const error = await rejected(
          client.fetchQuery(queries.readItem.options(itemArgs)),
        );
        assert.ok(queries.readItem.isError(error));
        assert.equal(
          queries.readItem.isError(new module.QueryResponseError(error.result)),
          false,
        );
        assert.equal(queries.readItem.isError({ ...error }), false);
        Reflect.set(error, 'result', fake.result);
        assert.equal(queries.readItem.isError(error), false);
        Object.defineProperty(error, 'result', {
          get() {
            assert.fail('replaced response getters must not run');
          },
        });
        assert.equal(queries.readItem.isError(error), false);
      } finally {
        client.clear();
      }
    },
} satisfies Readonly<
  Record<string, (module: Module, staff: Staff) => Promise<void>>
>;

export async function verifyQueryErrors(module: Module, staff: Staff) {
  for (const check of Object.values(queryErrorChecks))
    await check(module, staff);
}
