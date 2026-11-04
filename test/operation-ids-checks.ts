import assert from 'node:assert/strict';
import { QueryClient, dehydrate, hydrate } from '@tanstack/query-core';
import { runtimeInput } from './assertions.ts';

type Client = typeof import('./.generated/operation-ids/client.consumer.ts');
type Queries =
  typeof import('./.generated/operation-ids/client.consumer.queries.ts');
type Executor =
  import('./.generated/operation-ids/client.consumer.ts').Executor;
import { operationIds } from './operation-ids-fixture.ts';

export async function verifyOperationIds(module: Client, queryModule: Queries) {
  assert.deepEqual(
    Object.keys(module.operations).sort(),
    [...operationIds].sort(),
  );
  for (const scoped of [false, true]) {
    const execute: Executor = async (request, execution) => {
      assert.ok(operationIds.some((id) => id === request.operationId));
      const response = {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tag: request.operationId,
          items: [request.operationId],
          next: null,
          start: 0,
          size: 1,
          count: 1,
        }),
      };
      return scoped ? execution.validateResponse(response) : response;
    };
    const config = { namespace: 'ids', execute };
    const client = module.createClient(config);
    const queries = queryModule.createQueries(config);
    const infinite = queryModule.createInfiniteQueries(config);
    const cache = new QueryClient({
      defaultOptions: { queries: { gcTime: Infinity, retry: false } },
    });
    const restored = new QueryClient();
    try {
      for (const id of operationIds) {
        assert.equal(module.operations[id].build().operationId, id);
        assert.equal((await client[id].call({ context: {} })).data.tag, id);
        const args = { context: {} };
        for (const factory of [queries[id], queries[id].body()]) {
          const key = factory.key(args);
          assert.equal(key[3], id);
          await runtimeInput(
            cache.fetchQuery.bind(cache),
            factory.options(args),
          );
        }
      }
      const cursor = await cache.fetchInfiniteQuery(
        infinite['repos/get'].options({ context: {} }),
      );
      assert.equal(cursor.pages[0]?.data.tag, 'repos/get');
      const offset = await cache.fetchInfiniteQuery(
        infinite['get-stations'].body().options({ context: {} }),
      );
      assert.equal(offset.pages[0]?.tag, 'get-stations');
      hydrate(
        restored,
        JSON.parse(JSON.stringify(dehydrate(cache))) as ReturnType<
          typeof dehydrate
        >,
      );
      for (const id of operationIds) {
        assert.equal(
          restored.getQueryData(queries[id].key({ context: {} }))?.data.tag,
          id,
        );
        assert.equal(
          restored.getQueryData(queries[id].body().key({ context: {} }))?.tag,
          id,
        );
      }
    } finally {
      cache.clear();
      restored.clear();
    }
  }
}
