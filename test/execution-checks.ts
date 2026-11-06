import assert from 'node:assert/strict';
import { MutationObserver, QueryClient, skipToken } from '@tanstack/query-core';
import { record, runtimeInput } from './assertions.ts';
import { integrationChecks } from './execution-integration-checks.ts';

type Module = typeof import('./.generated/execution/client.consumer.ts');
type Staff = typeof import('./.generated/execution/client.staff.ts');
type Queries =
  typeof import('./.generated/execution/client.consumer.queries.ts');
type Executor = import('./.generated/execution/client.consumer.ts').Executor;
type Observed = import('./.generated/execution/runtime.ts').ObservedResponse;
const json = (status: number, data: unknown): Observed => ({
  status,
  headers: { 'Content-Type': 'application/json', 'X-Request-ID': 'synthetic' },
  body: JSON.stringify(data),
});
const command = () => ({
  context: { revision: 'one', locale: 'en' },
  input: {
    headers: { 'Idempotency-Key': 'attempt' },
    body: { label: 'Synthetic', values: ['one'] },
  },
});
const item = () => ({
  context: { revision: 'one', locale: 'en' },
  input: { path: { id: 'item' } },
});
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('expected execution to reject');
}

export const executionChecks = {
  ...integrationChecks,
  'calls and queries expose the declared bearer scheme to their executor':
    async (module, queries) => {
      const seen: string[] = [];
      const config = {
        namespace: 'bearer-identity',
        execute: async (request: Parameters<Executor>[0]) => {
          assert.equal(request.security.transport, 'bearer');
          if (request.security.transport === 'bearer')
            seen.push(request.security.scheme);
          assert.ok(Object.isFrozen(request.security));
          return json(200, { id: 'item', label: 'Synthetic' });
        },
      };
      await module.createClient(config).readItem.call(item());
      const cache = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });
      try {
        await cache.fetchQuery(
          queries.createQueries(config).readItem.options(item()),
        );
        assert.deepEqual(seen, ['Session', 'Session']);
      } finally {
        cache.clear();
      }
    },
  'executor contexts contain only their own captured values for calls and queries':
    async (module, queries) => {
      let calls = 0;
      const execute: Executor = async (_request, { context }) => {
        calls++;
        assert.equal(context['inheritedContextValue'], undefined);
        assert.equal(context['own'], 'explicit');
        assert.equal(Object.isFrozen(context), true);
        return { status: 204, headers: {}, body: '' };
      };
      const config = { namespace: 'own-context', execute };
      const client = module.createClient(config);
      const options = queries
        .createQueries(config)
        .health.options({ context: { own: 'explicit' } });
      const cache = new QueryClient({
        defaultOptions: { queries: { gcTime: Infinity, retry: false } },
      });
      const before = Object.getOwnPropertyDescriptor(
        Object.prototype,
        'inheritedContextValue',
      );
      try {
        Object.defineProperty(Object.prototype, 'inheritedContextValue', {
          value: 'polluted',
          configurable: true,
        });
        await client.health.call({ context: { own: 'explicit' } });
        await cache.fetchQuery(options);
        assert.equal(calls, 2);
        assert.deepEqual(options.queryKey[4], [['own', 'explicit']]);
      } finally {
        cache.clear();
        if (before)
          Object.defineProperty(
            Object.prototype,
            'inheritedContextValue',
            before,
          );
        else Reflect.deleteProperty(Object.prototype, 'inheritedContextValue');
      }
    },
  'optional JSON bodies preserve absence and null through raw and scoped execution':
    async (module) => {
      for (const scoped of [false, true]) {
        const requests: Parameters<Executor>[0][] = [];
        const client = module.createClient({
          namespace: 'optional-json',
          execute: async (request, execution) => {
            await Promise.resolve();
            requests.push(request);
            const observed = { status: 204, headers: {}, body: '' };
            return scoped ? execution.validateResponse(observed) : observed;
          },
        });
        for (const [operation, build] of [
          [client.maybeCreate, module.operations.maybeCreate.build],
          [
            client.maybeCreateNullable,
            module.operations.maybeCreateNullable.build,
          ],
        ] as const) {
          for (const input of [undefined, {}, { body: undefined }]) {
            const prepared = runtimeInput(build, input);
            assert.equal(prepared.bodyKind, 'none');
            assert.equal(Object.hasOwn(prepared, 'body'), false);
          }
          assert.equal(build().bodyKind, 'none');
          for (const args of [
            { context: {} },
            { context: {}, input: undefined },
            { context: {}, input: {} },
            { context: {}, input: { body: undefined } },
          ]) {
            const result = await operation.call(args);
            assert.equal(result.status, 204);
            assert.equal(result.data, undefined);
            const request = requests.at(-1);
            assert.equal(request?.bodyKind, 'none');
            assert.equal(Object.hasOwn(request ?? {}, 'body'), false);
          }
          const body = {
            ...command().input.body,
            attributes: { phase: 'original' },
          };
          const pending = operation.call({ context: {}, input: { body } });
          body.label = 'Changed';
          body.values.push('changed');
          body.attributes.phase = 'changed';
          await pending;
          const request = requests.at(-1);
          assert.equal(request?.bodyKind, 'json');
          assert.deepEqual(request?.bodyKind === 'json' && request.body, {
            label: 'Synthetic',
            values: ['one'],
            attributes: { phase: 'original' },
          });
        }
        await client.maybeCreateNullable.call({
          context: {},
          input: { body: null },
        });
        const nullable = requests.at(-1);
        assert.equal(nullable?.bodyKind, 'json');
        assert.equal(nullable?.bodyKind === 'json' && nullable.body, null);
        const required = {
          path: { id: 'a/b' },
          headers: { 'Idempotency-Key': 'attempt' },
        };
        for (const input of [required, { ...required, body: undefined }]) {
          await client.maybeUpdate.call({ context: {}, input });
          const request = requests.at(-1);
          assert.equal(request?.url, '/commands/optional/a%2Fb');
          assert.equal(request?.headers['Idempotency-Key'], 'attempt');
          assert.equal(request?.bodyKind, 'none');
          assert.equal(Object.hasOwn(request ?? {}, 'body'), false);
        }
        await client.maybeUpdate.call({
          context: {},
          input: { ...required, body: command().input.body },
        });
        const updated = requests.at(-1);
        assert.equal(updated?.bodyKind, 'json');
        assert.deepEqual(updated?.bodyKind === 'json' && updated.body, {
          label: 'Synthetic',
          values: ['one'],
        });
        const attempts = requests.length;
        await assert.rejects(
          runtimeInput(client.maybeCreate.call, {
            context: {},
            input: { body: null },
          }),
          module.RequestValidationError,
        );
        for (const input of [
          undefined,
          {},
          { path: required.path },
          { headers: required.headers },
          { ...required, body: null },
          { ...required, body: { label: 'ab', values: [] } },
        ])
          await assert.rejects(
            runtimeInput(client.maybeUpdate.call, { context: {}, input }),
            module.RequestValidationError,
          );
        assert.equal(requests.length, attempts);
      }
    },

  'all seven methods retain exact success envelopes and JSON request snapshots':
    async (module) => {
      const requests: Parameters<Executor>[0][] = [];
      const contexts: Parameters<Executor>[1][] = [];
      const config = {
        namespace: 'all-methods',
        execute: async (...[request, execution]: Parameters<Executor>) => {
          requests.push(request);
          contexts.push(execution);
          if (request.bodyKind === 'json')
            return json(201, {
              id: 'created',
              label: 'Created',
              extra: 'stripped',
            });
          if (request.method === 'GET')
            return json(200, { id: 'item', label: 'Read' });
          return { status: 204, headers: { Allow: 'GET, POST' }, body: '' };
        },
      };
      const client = module.createClient(config);
      assert.deepEqual(Object.keys(client), Object.keys(module.operations));
      assert.ok(Object.isFrozen(client));
      assert.ok(Object.isFrozen(client.createWidget));
      const args = command();
      const promise = client.createWidget.call(args);
      args.input.body.values.push('changed');
      args.input.body.label = 'Changed';
      args.context.revision = 'changed';
      const created = await promise;
      assert.equal(created.kind, 'success');
      assert.equal(created.status, 201);
      assert.deepEqual(created.data, { id: 'created', label: 'Created' });
      assert.equal(created.validatedHeaders['x-request-id'], 'synthetic');
      assert.equal(created.headers['content-type'], 'application/json');
      assert.equal((await client.replaceWidget.call(command())).status, 201);
      assert.equal((await client.write_options.call(command())).status, 201);
      assert.equal((await client.readItem.call(item())).status, 200);
      for (const result of [
        await client.health.call({ context: {} }),
        await client.commandOptions.call({ context: {} }),
        await client.removeWidget.call({
          context: {},
          input: { path: { id: 'item' } },
        }),
      ]) {
        assert.equal(result.status, 204);
        assert.equal(result.data, undefined);
        assert.ok(Object.hasOwn(result, 'data'));
      }
      assert.deepEqual(requests.map((request) => request.method).sort(), [
        'DELETE',
        'GET',
        'HEAD',
        'OPTIONS',
        'PATCH',
        'POST',
        'PUT',
      ]);
      assert.deepEqual(requests[0]?.bodyKind === 'json' && requests[0].body, {
        label: 'Synthetic',
        values: ['one'],
      });
      assert.deepEqual(
        { ...contexts[0]?.context },
        { locale: 'en', revision: 'one' },
      );
      for (const execution of contexts) {
        assert.ok(Object.isFrozen(execution));
        assert.ok(Object.isFrozen(execution.context));
        assert.equal(execution.signal.aborted, false);
      }
    },

  'invalid calls fail before execution and contexts normalize once': async (
    module,
  ) => {
    let attempts = 0;
    const client = module.createClient({
      namespace: 'invalid-inputs',
      execute: async () => {
        attempts++;
        return json(201, { id: 'item', label: 'Created' });
      },
    });
    for (const input of [
      undefined,
      { ...command().input, body: { label: 'ab', values: [] } },
      { ...command().input, body: { label: 'valid', values: [], extra: true } },
      { ...command().input, body: { label: 'valid', values: [1] } },
      { headers: command().input.headers },
      { body: command().input.body },
      { ...command().input, extra: true },
    ])
      await assert.rejects(
        runtimeInput(client.createWidget.call, { context: {}, input }),
        module.RequestValidationError,
      );
    let argumentReads = 0;
    let contextReads = 0;
    for (const args of [
      undefined,
      null,
      [],
      new Date(),
      Object.setPrototypeOf(command(), { inherited: true }),
      { ...command(), context: undefined },
      { ...command(), context: null },
      { ...command(), context: [] },
      { ...command(), context: new Date() },
      { ...command(), context: { count: Infinity } },
      { ...command(), context: { count: NaN } },
      { ...command(), context: { count: 1n } },
      { ...command(), context: { value: Symbol('context') } },
      { ...command(), context: { nested: {} } },
      { ...command(), context: { token: undefined } },
      { ...command(), extra: true },
      { ...command(), signal: null },
      { ...command(), signal: {} },
      { ...command(), signal: { aborted: false } },
      { ...command(), signal: { aborted: 'false' } },
      {
        ...command(),
        signal: { aborted: false, addEventListener() {} },
      },
      Object.defineProperty(command(), 'hidden', { value: true }),
      { ...command(), [Symbol('argument')]: true },
      {
        ...command(),
        context: Object.defineProperty({}, 'hidden', { value: 'context' }),
      },
      { ...command(), context: { [Symbol('context')]: 'value' } },
      Object.defineProperty(command(), 'context', {
        enumerable: true,
        get() {
          argumentReads++;
          return command().context;
        },
      }),
      {
        ...command(),
        context: Object.defineProperty({}, 'locale', {
          enumerable: true,
          get() {
            contextReads++;
            return 'en';
          },
        }),
      },
    ])
      await assert.rejects(
        runtimeInput(client.createWidget.call, args),
        TypeError,
      );
    assert.equal(argumentReads, 0, 'argument getters must not run');
    assert.equal(contextReads, 0, 'context getters must not run');
    assert.equal(attempts, 0);
    const context = Object.fromEntries<string | number | null>([
      ['__proto__', 'data'],
      ['constructor', null],
      ['number', -0],
    ]);
    const normalized = module.createClient({
      namespace: 'normalized',
      execute: async (_request, execution) => {
        assert.equal(execution.context['__proto__'], 'data');
        assert.equal(execution.context['constructor'], null);
        assert.equal(Object.is(execution.context['number'], -0), false);
        return { status: 204, headers: {}, body: '' };
      },
    });
    const nullContext = { ...context };
    Object.setPrototypeOf(nullContext, null);
    for (const value of [context, nullContext]) {
      const args = { context: value };
      Object.setPrototypeOf(args, null);
      await normalized.health.call(args);
    }
  },

  'calls capture configuration and independent request snapshots before delayed execution':
    async (module) => {
      const requests: Parameters<Executor>[0][] = [];
      const executions: Parameters<Executor>[1][] = [];
      let observed = json(200, { id: 'item', label: 'Read' });
      const config = {
        namespace: 'captured-config',
        execute: async (...[request, execution]: Parameters<Executor>) => {
          await Promise.resolve();
          requests.push(request);
          executions.push(execution);
          return observed;
        },
      };
      const originalConfig = { ...config };
      const client = module.createClient(config);
      config.namespace = 'changed-config';
      config.execute = async () => {
        assert.fail('an existing client must retain its configured executor');
      };
      const first = {
        context: { revision: 'one', locale: 'en' },
        input: {
          path: { id: 'a/b' },
          query: { tags: ['first'], count: 0 },
          headers: { 'X-View': 'original' },
        },
      };
      const pending = client.readItem.call(first);
      first.context.revision = 'changed';
      first.input.path.id = 'changed';
      first.input.query.tags.push('changed');
      first.input.headers['X-View'] = 'changed';
      const next = client.readItem.call({
        context: { revision: 'two' },
        input: { path: { id: 'second' } },
      });
      await Promise.all([pending, next]);
      assert.deepEqual(
        requests.map((request) => request.url),
        ['/items/a%2Fb?tags=first&count=0', '/items/second'],
      );
      assert.equal(requests[0]?.headers['X-View'], 'original');
      assert.deepEqual(
        executions.map((execution) => ({ ...execution.context })),
        [{ locale: 'en', revision: 'one' }, { revision: 'two' }],
      );
      assert.notEqual(executions[0]?.signal, executions[1]?.signal);
      for (const execution of executions) {
        assert.equal(execution.signal.aborted, false);
        assert.equal(typeof execution.signal.addEventListener, 'function');
        assert.equal(typeof execution.signal.removeEventListener, 'function');
      }
      observed = json(404, { detail: 'Missing' });
      const error = await rejected(client.readItem.call(item()));
      assert.ok(module.createClient(originalConfig).readItem.isError(error));
      assert.equal(module.createClient(config).readItem.isError(error), false);
    },

  'direct and ordinary reads preserve schema-valid pages while infinite queries reject invalid pagination':
    async (module, queries) => {
      const page = {
        entries: [{ id: 'one' }],
        start: 0,
        size: 1,
        count: 1,
        next: null,
      };
      let observed = json(200, page);
      const config = {
        namespace: 'pagination-boundary',
        execute: async () => observed,
      };
      const client = module.createClient(config);
      const ordinary = queries.createQueries(config);
      const infinite = queries.createInfiniteQueries(config);
      const args = { context: {}, input: { path: { category: 'records' } } };
      const options = infinite.listRecords.options(args);
      const cache = new QueryClient();
      try {
        const previous = await cache.fetchInfiniteQuery(options);
        observed = json(200, { ...page, start: 7 });
        assert.equal((await client.listRecords.call(args)).data.start, 7);
        assert.equal(
          (await cache.fetchQuery(ordinary.listRecords.options(args))).data
            .start,
          7,
        );
        const error = await rejected(cache.fetchInfiniteQuery(options));
        assert.ok(infinite.listRecords.isError(error));
        assert.ok(client.listRecords.isError(error));
        assert.ok(ordinary.listRecords.isError(error));
        assert.equal(error.result.kind, 'protocol');
        if (error.result.kind !== 'protocol')
          assert.fail('expected pagination issues');
        assert.equal(error.result.status, 200);
        assert.equal(error.result.headers['x-request-id'], 'synthetic');
        assert.deepEqual(
          error.result.issues.map(({ part, path }) => ({ part, path })),
          [{ part: 'body', path: ['start'] }],
        );
        assert.equal(Object.hasOwn(error.result, 'data'), false);
        assert.equal(cache.getQueryData(options.queryKey), previous);
      } finally {
        cache.clear();
      }
    },

  'direct, ordinary, cursor and offset calls share errors without widening provenance':
    async (module, queries, staff) => {
      const denial = json(404, { detail: 'Missing' });
      const config = {
        namespace: 'shared-errors',
        execute: async () => denial,
      };
      const client = module.createClient(config);
      const ordinary = queries.createQueries(config);
      const infinite = queries.createInfiniteQueries(config);
      const cache = new QueryClient();
      try {
        const error = await rejected(client.readItem.call(item()));
        assert.ok(client.readItem.isError(error));
        assert.ok(ordinary.readItem.isError(error));
        assert.ok(error instanceof queries.QueryResponseError);
        assert.ok(error instanceof module.ResponseError);
        assert.equal(error.name, 'QueryResponseError');
        assert.equal(staff.createClient(config).readItem.isError(error), false);
        assert.equal(
          module
            .createClient({ ...config, namespace: 'other' })
            .readItem.isError(error),
          false,
        );
        assert.equal(client.readMap.isError(error), false);
        assert.equal(
          client.readItem.isError(new module.ResponseError(error.result)),
          false,
        );
        assert.equal(client.readItem.isError({ ...error }), false);
        const ordinaryError = await rejected(
          cache.fetchQuery(ordinary.readItem.options(item())),
        );
        assert.ok(client.readItem.isError(ordinaryError));
        for (const [id, input] of [
          ['listItems', { path: { collection: 'items' } }],
          ['listRecords', { path: { category: 'records' } }],
        ] as const) {
          const options =
            id === 'listItems'
              ? infinite.listItems.options({
                  context: {},
                  input: { path: { collection: 'items' } },
                })
              : infinite.listRecords.options({
                  context: {},
                  input: { path: { category: 'records' } },
                });
          const pageError = await rejected(
            id === 'listItems'
              ? cache.fetchInfiniteQuery(
                  infinite.listItems.options({
                    context: {},
                    input: { path: { collection: 'items' } },
                  }),
                )
              : cache.fetchInfiniteQuery(
                  infinite.listRecords.options({
                    context: {},
                    input: { path: { category: 'records' } },
                  }),
                ),
          );
          assert.ok(client[id].isError(pageError));
          assert.ok(ordinary[id].isError(pageError));
          assert.equal(options.retry, false);
          const directError = await rejected(
            runtimeInput(client[id].call, { context: {}, input }),
          );
          assert.ok(infinite[id].isError(directError));
        }
        Reflect.set(error, 'result', denial);
        assert.equal(client.readItem.isError(error), false);
      } finally {
        cache.clear();
      }
    },

  'failed writes cannot trigger mutation success and protocol failures expose no data':
    async (module) => {
      let observed = json(409, { detail: 'Conflict' });
      let successes = 0;
      let attempts = 0;
      const client = module.createClient({
        namespace: 'mutation',
        execute: async () => {
          attempts++;
          return observed;
        },
      });
      const cache = new QueryClient();
      const mutation = new MutationObserver(cache, {
        mutationFn: () => client.createWidget.call(command()),
        retry: false,
        onSuccess: () => {
          successes++;
        },
      });
      try {
        const error = await rejected(mutation.mutate());
        assert.ok(client.createWidget.isError(error));
        assert.equal(mutation.getCurrentResult().status, 'error');
        assert.equal(successes, 0);
        assert.equal(attempts, 1);
        for (const response of [
          json(201, { state: 'pending', reference: 'wrong-status-schema' }),
          {
            ...json(201, { id: 'item', label: 'Valid' }),
            headers: {
              'Content-Type': 'text/plain',
              'X-Request-ID': 'evidence',
            },
          },
          {
            ...json(201, { id: 'item', label: 'Valid' }),
            headers: { 'Content-Type': 'application/json' },
          },
          { ...json(201, {}), body: '{' },
          json(299, {}),
          { status: 403, headers: {}, body: 'unexpected' },
        ]) {
          observed = response;
          const failure = await rejected(client.createWidget.call(command()));
          assert.ok(client.createWidget.isError(failure));
          assert.equal(failure.result.kind, 'protocol');
          assert.equal(failure.result.status, response.status);
          assert.equal(Object.hasOwn(failure.result, 'data'), false);
        }
        observed = { status: 403, headers: {}, body: '' };
        const bodyless = await rejected(client.createWidget.call(command()));
        assert.ok(client.createWidget.isError(bodyless));
        if (bodyless.result.kind === 'error') {
          assert.equal(bodyless.result.status, 403);
          assert.equal(bodyless.result.data, undefined);
        } else assert.fail('expected a declared bodyless denial');
        observed = json(202, { state: 'pending', reference: 'accepted' });
        const success = await mutation.mutate();
        assert.equal(success.status, 202);
        assert.equal(successes, 1);
      } finally {
        cache.clear();
      }
    },

  'application recovery, retries, locale, session fencing and deadlines stay executor-owned':
    async (module, queries) => {
      let revision = 'one';
      let attempts = 0;
      let recoveries = 0;
      const deadline = new Error('application deadline');
      const fenced = new Error('application session changed');
      let mode: 'recover' | 'deadline' | 'fenced' = 'recover';
      const execute: Executor = async (_request, execution) => {
        assert.equal(execution.context['locale'], 'en');
        attempts++; // An application observes a denial, then retries once.
        if (mode === 'deadline') throw deadline;
        recoveries++;
        await Promise.resolve();
        if (mode === 'fenced') revision = 'two';
        if (execution.context['revision'] !== revision) throw fenced;
        attempts++;
        return json(200, { id: 'item', label: execution.context['locale'] });
      };
      const config = { namespace: 'application-policy', execute };
      const client = module.createClient(config);
      const ordinary = queries.createQueries(config);
      const cache = new QueryClient();
      try {
        assert.equal((await client.readItem.call(item())).data.label, 'en');
        assert.equal(
          (await cache.fetchQuery(ordinary.readItem.options(item()))).data
            .label,
          'en',
        );
        assert.equal(attempts, 4);
        assert.equal(recoveries, 2);
        mode = 'deadline';
        assert.equal(await rejected(client.readItem.call(item())), deadline);
        assert.equal(attempts, 5);
        mode = 'fenced';
        assert.equal(
          await rejected(cache.fetchQuery(ordinary.readItem.options(item()))),
          fenced,
        );
        assert.equal(attempts, 6);
        assert.equal(client.readItem.isError(fenced), false);
        assert.equal(ordinary.readItem.isError(deadline), false);
        const skipped = ordinary.readItem.options({
          context: item().context,
          input: skipToken,
        });
        assert.equal(skipped.queryFn, skipToken);
        assert.equal(attempts, 6);
      } finally {
        cache.clear();
      }
    },

  'cancellation keeps reasons and prevents late responses or body-read failures becoming success':
    async (module) => {
      const reason = { cancelled: 'provided reason' };
      const aborted = new AbortController();
      aborted.abort(reason);
      let attempts = 0;
      const noop = module.createClient({
        namespace: 'pre-abort',
        execute: async () => {
          attempts++;
          return json(200, { id: 'item', label: 'late' });
        },
      });
      assert.equal(
        await rejected(
          noop.readItem.call({ ...item(), signal: aborted.signal }),
        ),
        reason,
      );
      assert.equal(attempts, 0);
      for (const rejectRead of [false, true]) {
        const controller = new AbortController();
        const client = module.createClient({
          namespace: 'late',
          execute: async (_request, execution) => {
            assert.equal(execution.signal, controller.signal);
            await Promise.resolve();
            controller.abort(reason);
            if (rejectRead) throw new Error('body read interrupted');
            return json(200, { id: 'item', label: 'late' });
          },
        });
        assert.equal(
          await rejected(
            client.readItem.call({ ...item(), signal: controller.signal }),
          ),
          reason,
        );
      }
      const controller = new AbortController();
      const duringRead = module.createClient({
        namespace: 'read-abort',
        execute: async () => ({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          get body() {
            controller.abort(reason);
            return '{"id":"item","label":"late"}';
          },
        }),
      });
      assert.equal(
        await rejected(
          duringRead.readItem.call({ ...item(), signal: controller.signal }),
        ),
        reason,
      );
    },

  'nonmonotonic signal getters cannot bypass preparation or complete without validation':
    async (module) => {
      for (const scoped of [false, true]) {
        for (const targetRead of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
          const reason = new Error('Transient abort');
          const mapped = new Error('Mapped abort');
          let reads = 0;
          let attempts = 0;
          let mappings = 0;
          const signal = {
            get aborted() {
              return ++reads === targetRead;
            },
            reason,
            addEventListener() {},
            removeEventListener() {},
          };
          const client = module.createClient({
            namespace: 'signal-getter',
            execute: async (request, execution) => {
              attempts++;
              assert.ok(
                request,
                'an executor must always receive a built request',
              );
              const observed = json(200, { id: 'item', label: 'Validated' });
              return scoped ? execution.validateResponse(observed) : observed;
            },
            mapCancellation: (event) => {
              mappings++;
              assert.equal(event.reason, reason);
              assert.equal(event.executorInvoked, attempts > 0);
              return { error: mapped };
            },
          });
          const args =
            targetRead === 2
              ? { ...item(), input: { path: { id: 123 } }, signal }
              : { ...item(), signal };
          try {
            const result = await runtimeInput(client.readItem.call, args);
            assert.ok(result, 'a call must never resolve undefined');
            assert.equal(result.kind, 'success');
            assert.ok(
              reads < targetRead,
              'an observed abort cannot become success',
            );
          } catch (error) {
            assert.equal(error, mapped);
            assert.equal(mappings, 1);
          }
          if (targetRead === 2) assert.equal(attempts, 0);
        }
      }
    },
} satisfies Readonly<
  Record<
    string,
    (module: Module, queries: Queries, staff: Staff) => Promise<void>
  >
>;

export async function verifyExecutions(
  module: Module,
  queries: Queries,
  staff: Staff,
) {
  for (const check of Object.values(executionChecks))
    await check(module, queries, staff);
}

export async function verifyExecutionParsing(
  module: Module,
  schemas: typeof import('./.generated/execution/client.consumer.schemas.ts'),
  transport: Pick<
    typeof import('../examples/json/transport.ts'),
    'createExecutor' | 'execute'
  >,
) {
  const sparse = ['user'];
  sparse.length = 2;
  assert.equal(Object.hasOwn(Object.prototype, '1'), false);
  Object.defineProperty(Object.prototype, '1', {
    value: 'staff',
    writable: true,
    configurable: true,
  });
  try {
    const input = command().input;
    assert.throws(
      () =>
        module.operations.createWidget.build({
          ...input,
          body: { ...input.body, values: sparse },
        }),
      module.RequestValidationError,
    );
    assert.equal(
      schemas.responseSchemas.JsonMap.safeParse({ roles: sparse }).success,
      false,
    );
  } finally {
    Reflect.deleteProperty(Object.prototype, '1');
  }
  let parses = 0;
  let reads = 0;
  let successes = 0;
  let denials = 0;
  let recoveries = 0;
  let denyNext = false;
  const successText = '{"id":"item","label":"Once"}';
  const denialText = '{"detail":"Synthetic recovery"}';
  const parse = JSON.parse;
  // Generated operations call their parsers directly. Count each schema pass
  // by the one read it makes of a declared field of the decoded body.
  const counted = (value: unknown, key: string, count: () => void): unknown => {
    if (value === null || typeof value !== 'object') return value;
    const field: unknown = Reflect.get(value, key);
    Object.defineProperty(value, key, {
      enumerable: true,
      configurable: true,
      get: () => {
        count();
        return field;
      },
    });
    return value;
  };
  try {
    JSON.parse = (...args: Parameters<typeof JSON.parse>): unknown => {
      // Node lazily initializes Fetch with unrelated JSON of its own. Count
      // parsing of these observed bodies, including any accidental second pass.
      if (args[0] === successText || args[0] === denialText) parses++;
      const value = parse(...args) as unknown;
      if (args[0] === successText)
        return counted(value, 'id', () => successes++);
      if (args[0] === denialText)
        return counted(value, 'detail', () => denials++);
      return value;
    };
    const send: typeof fetch = async () => {
      const deny = denyNext;
      denyNext = false;
      const response = new Response(deny ? denialText : successText, {
        status: deny ? 409 : 201,
        headers: [
          ['Content-Type', 'application/json'],
          ['X-Request-ID', 'counted'],
          ['__proto__', 'raw-evidence'],
          ['constructor', 'header data'],
        ],
      });
      const text = response.text.bind(response);
      response.text = () => {
        reads++;
        return text();
      };
      return response;
    };
    const executeRaw = async (): Promise<Observed> => {
      const response = await send('https://synthetic.invalid');
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      };
    };
    const tokenFor = async () => 'synthetic-token';
    const existingRaw = transport.createExecutor(
      send,
      tokenFor,
      'https://synthetic.invalid',
    );
    const recovering: Executor = async (request, execution) => {
      const observed = await existingRaw(request, execution);
      assert.ok('body' in observed && typeof observed.body === 'string');
      if (observed.status !== 409) return observed;
      // Application policy can inspect a denial for recovery without parsing
      // final success, discarding its envelope or capturing parser evidence.
      assert.equal(request.parseResponse(observed).kind, 'error');
      recoveries++;
      return existingRaw(request, execution);
    };
    const scoped: Executor = async (_request, execution) =>
      execution.validateResponse(await executeRaw());
    const scopedRecovery: Executor = async (_request, execution) => {
      const denial = execution.validateResponse(await executeRaw());
      assert.equal(denial.kind, 'error');
      recoveries++;
      return execution.validateResponse(await executeRaw());
    };
    for (const execute of [executeRaw, recovering, scoped, scopedRecovery]) {
      denyNext = execute === recovering || execute === scopedRecovery;
      const client = module.createClient({ namespace: 'counted', execute });
      const result = await client.createWidget.call(command());
      assert.equal(result.status, 201);
      if (result.status !== 201) assert.fail('expected created data');
      assert.equal(result.data.label, 'Once');
      assert.equal(result.headers['__proto__'], 'raw-evidence');
      assert.equal(result.headers['constructor'], 'header data');
    }
    denyNext = true;
    const denied = module.createClient({
      namespace: 'counted-denial',
      execute: scoped,
    });
    const error = await rejected(denied.createWidget.call(command()));
    assert.ok(denied.createWidget.isError(error));
    assert.equal(error.result.kind, 'error');
    const legacy = await transport.execute(
      module.operations.createWidget.build(command().input),
      send,
      tokenFor,
      'https://synthetic.invalid',
    );
    assert.equal(legacy.kind, 'success');
    assert.equal(legacy.headers['__proto__'], 'raw-evidence');
    assert.equal(legacy.headers['constructor'], 'header data');
    assert.equal(reads, 8);
    assert.equal(parses, 8);
    assert.equal(successes, 5);
    assert.equal(denials, 3);
    assert.equal(recoveries, 2);
  } finally {
    JSON.parse = parse;
  }
}

export async function verifyExecutableMultipart(
  browser: typeof import('./.generated/multipart/client.browser.ts'),
  native: typeof import('./.generated/multipart/client.native.ts'),
) {
  const file = new File(['synthetic'], 'item.txt', { type: 'text/plain' });
  const reference = {
    uri: 'file:///synthetic/item.txt',
    name: 'item.txt',
    mediaType: 'text/plain',
  };
  for (const [module, value] of [
    [browser, file],
    [native, reference],
  ] as const) {
    const body = {
      caption: 'a\r\nb',
      note: 'a\r\nb',
      cover: value,
      attachments: [value, value],
      extras: [value],
    };
    const expectedFile = module === browser ? file : { ...reference };
    const expectedBody = {
      caption: 'a\r\nb',
      note: 'a\r\nb',
      cover: expectedFile,
      attachments: [expectedFile, expectedFile],
      extras: [expectedFile],
    };
    let attempts = 0;
    const client = module.createClient({
      namespace: 'uploads',
      execute: async (request) => {
        attempts++;
        // Inspect only after the caller has changed its text, arrays and native
        // file reference, as a transport awaiting credentials would do.
        await Promise.resolve();
        assert.equal(request.bodyKind, 'multipart');
        if (request.bodyKind !== 'multipart')
          assert.fail('expected multipart metadata');
        assert.deepEqual(request.body, expectedBody);
        const captured = record(request.body);
        assert.notEqual(request.body, body);
        assert.notEqual(captured['attachments'], body.attachments);
        assert.notEqual(captured['extras'], body.extras);
        if (module === browser) assert.equal(captured['cover'], file);
        else assert.notEqual(captured['cover'], reference);
        assert.deepEqual(
          request.multipart.map((field) => field.name),
          ['attachments', 'caption', 'cover', 'extras', 'note'],
        );
        return json(201, { count: 5 });
      },
    });
    const pending = runtimeInput(client.upload.call, {
      context: {},
      input: { body },
    });
    body.caption = 'changed';
    body.note = 'changed';
    body.attachments.push(value);
    body.extras.length = 0;
    if (module === native) {
      reference.uri = 'native://changed';
      reference.name = 'changed.txt';
      reference.mediaType = 'application/octet-stream';
    }
    assert.equal((await pending).data.count, 5);
    for (const invalid of [
      {
        ...expectedBody,
        cover: module === browser ? { uri: 'native://file' } : file,
      },
      { ...expectedBody, cover: undefined },
      { ...expectedBody, attachments: [] },
    ])
      await assert.rejects(
        runtimeInput(client.upload.call, {
          context: {},
          input: { body: invalid },
        }),
        module.RequestValidationError,
      );
    assert.equal(attempts, 1, 'invalid upload bodies must not execute');
    const scoped = module.createClient({
      namespace: 'scoped-uploads',
      execute: async (request, execution) => {
        assert.equal(request.bodyKind, 'multipart');
        assert.deepEqual(
          request.bodyKind === 'multipart' && request.body,
          expectedBody,
        );
        return execution.validateResponse(json(201, { count: 5 }));
      },
    });
    assert.equal(
      (
        await runtimeInput(scoped.upload.call, {
          context: {},
          input: { body: expectedBody },
        })
      ).data.count,
      5,
    );
  }
  const nativeClient = native.createClient({
    namespace: 'native',
    execute: async (request, execution) => {
      await Promise.resolve();
      assert.equal(request.bodyKind, 'multipart');
      assert.deepEqual(request.bodyKind === 'multipart' && request.body, {
        file: { uri: 'native://snapshot' },
      });
      return execution.validateResponse(json(201, { count: 1 }));
    },
  });
  const globals = (['File', 'FormData'] as const).map(
    (name) =>
      [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  try {
    Reflect.deleteProperty(globalThis, 'File');
    Reflect.deleteProperty(globalThis, 'FormData');
    assert.equal(typeof globalThis.File, 'undefined');
    assert.equal(typeof globalThis.FormData, 'undefined');
    const mutable = { uri: 'native://snapshot' };
    const pending = nativeClient.uploadInline.call({
      context: {},
      input: { body: { file: mutable } },
    });
    mutable.uri = 'changed';
    await pending;
  } finally {
    for (const [name, descriptor] of globals)
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
  }
}
