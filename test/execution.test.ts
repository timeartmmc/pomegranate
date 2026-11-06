import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compile, runProject } from '../dist/index.js';
import { invalidOptions, runtimeInput } from './assertions.ts';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import {
  executionChecks,
  verifyExecutableMultipart,
  verifyExecutionParsing,
} from './execution-checks.ts';
import { verifyExecutionDeclarations } from './execution-declarations.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import { multipartFixture, multipartSelection } from './multipart-fixture.ts';
import { symbolFixture, symbolOperationIds } from './symbol-fixture.ts';
import type { ExecutionClient } from './.generated/execution/call-runtime.ts';
import { record } from './assertions.ts';
import * as transport from '../examples/json/transport.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
let root: string;
let module: typeof import('./.generated/execution/client.consumer.ts');
let staff: typeof import('./.generated/execution/client.staff.ts');
let queries: typeof import('./.generated/execution/client.consumer.queries.ts');
before(async () => {
  root = await generatedWorkspace(
    await compile(executionFixture(), executionSelection),
    'execution-generated',
  );
  await mkdir(join(root, 'multipart-generated'));
  for (const [name, source] of Object.entries(
    await compile(multipartFixture(), multipartSelection),
  ))
    await writeFile(join(root, 'multipart-generated', name), source);
  module = (await import(
    pathToFileURL(join(root, 'execution-generated/client.consumer.ts')).href
  )) as typeof module;
  staff = (await import(
    pathToFileURL(join(root, 'execution-generated/client.staff.ts')).href
  )) as typeof staff;
  queries = (await import(
    pathToFileURL(join(root, 'execution-generated/client.consumer.queries.ts'))
      .href
  )) as typeof queries;
});
after(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

void test('omitted call and query arguments never inherit input, context or signal from Object.prototype', async () => {
  const signals: AbortSignal[] = [];
  const config: Parameters<typeof module.createClient>[0] = {
    namespace: 'own-arguments',
    execute: async (_request, execution) => {
      signals.push(execution.signal);
      assert.deepEqual({ ...execution.context }, {});
      return { status: 204, headers: {}, body: '' };
    },
  };
  const client = module.createClient(config);
  const families = queries.createQueries(config);
  const signal = new AbortController().signal;
  const aborted = new AbortController();
  aborted.abort(new Error('inherited signal must not cancel a call'));
  const values = {
    context: { inherited: true },
    input: { path: { id: 'inherited' } },
    signal: aborted.signal,
  };
  const before = Object.entries(values).map(
    ([name]) =>
      [name, Object.getOwnPropertyDescriptor(Object.prototype, name)] as const,
  );
  try {
    for (const [name, value] of Object.entries(values))
      Object.defineProperty(Object.prototype, name, {
        value,
        configurable: true,
        writable: true,
      });
    await assert.rejects(
      runtimeInput(client.health.call, { input: {}, signal }),
      TypeError,
    );
    assert.throws(
      () =>
        runtimeInput(families.readItem.options, {
          input: { path: { id: 'own' } },
        }),
      TypeError,
    );
    await client.health.call({ context: {}, input: {} });
    await client.health.call({ context: {}, signal });
    assert.equal(signals.length, 2);
    assert.notEqual(signals[0], aborted.signal);
    assert.equal(signals[0]?.aborted, false);
    assert.equal(signals[1], signal);
    await assert.rejects(
      runtimeInput(client.readItem.call, { context: {}, signal }),
      module.RequestValidationError,
    );
    for (const family of [families.readItem, families.readItem.body()])
      assert.throws(
        () => runtimeInput(family.options, { context: {} }),
        module.RequestValidationError,
      );
    const options = families.health.options({ context: {} });
    assert.deepEqual(options.queryKey[4], []);
    assert.equal(signals.length, 2);
  } finally {
    for (const [name, descriptor] of before) {
      if (descriptor) Object.defineProperty(Object.prototype, name, descriptor);
      else Reflect.deleteProperty(Object.prototype, name);
    }
  }
});

void test('direct calls preserve dynamic map names and scoped operation identifiers', async () => {
  const source =
    '{"__proto__":{"constructor":null},"constructor":null,"prototype":"value"}';
  const client = module.createClient({
    namespace: 'map-keys',
    execute: async () => ({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: source,
    }),
  });
  const result = await client.readMap.call({ context: {} });
  assert.equal(JSON.stringify(result.data), source);
  const files = await compile(symbolFixture(), {
    clients: ['symbols'],
    executionClients: ['symbols'],
  });
  await mkdir(join(root, 'symbols'));
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, 'symbols', name), source);
  type Operations =
    typeof import('./.generated/symbols/client.symbols.ts').operations;
  const symbols = (await import(
    pathToFileURL(join(root, 'symbols/client.symbols.ts')).href
  )) as {
    createClient: (
      config: Parameters<typeof module.createClient>[0],
    ) => ExecutionClient<Operations>;
  };
  const calls = symbols.createClient({
    namespace: 'special-ids',
    execute: async (request) => {
      assert.equal(request.bodyKind, 'json');
      return {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'X-Result': request.operationId,
        },
        body: JSON.stringify(
          request.bodyKind === 'json' ? request.body : undefined,
        ),
      };
    },
  });
  for (const id of symbolOperationIds) {
    const response = await runtimeInput(calls[id].call, {
      context: {},
      input: { path: { entry: id }, body: { tag: id, values: [id, null] } },
    });
    assert.equal(record(response.data)['tag'], id);
  }
});

void test('direct calls reject malformed raw evidence without minting response provenance', async () => {
  for (const observed of [
    undefined,
    null,
    {},
    { status: '200', headers: {}, body: '{}' },
    { status: 200, headers: {}, body: {} },
    { status: 200, headers: new Headers(), body: '{}' },
  ]) {
    const client = runtimeInput(module.createClient, {
      namespace: 'malformed-evidence',
      execute: async () => observed,
    });
    await assert.rejects(
      client.readItem.call({ context: {}, input: { path: { id: 'item' } } }),
      (error: unknown) =>
        error instanceof TypeError && !client.readItem.isError(error),
    );
  }
});

void test('shared execution cannot attest a fabricated request parser as another operation', async () => {
  const shared = (await import(
    pathToFileURL(join(root, 'execution-generated/execution-runtime.ts')).href
  )) as typeof import('./.generated/execution/execution-runtime.ts');
  const fake = {
    ...module.operations.health.build(),
    parseResponse: () => ({
      kind: 'error' as const,
      operationId: 'readItem',
      status: 404,
      headers: {},
      validatedHeaders: {},
      contentType: 'application/json',
      data: { detail: 7 },
    }),
  } as const;
  const execute = async () => ({
    status: 404,
    headers: { 'Content-Type': 'application/json' },
    body: '{"detail":7}',
  });
  const config = { namespace: 'forged-parser', execute };
  const client = module.createClient(config);
  const scope = {
    operation: module.operations.readItem,
    operationId: 'readItem',
    namespace: config.namespace,
    client: 'consumer',
  };
  let failure: unknown;
  try {
    await shared.executeRequest<
      import('./.generated/execution/runtime.ts').Responses,
      'none'
    >(fake, execute, {}, new AbortController().signal, scope);
  } catch (error) {
    failure = error;
  }
  assert.ok(client.readItem.isError(failure));
  assert.equal(failure.result.kind, 'protocol');
  assert.equal(Object.hasOwn(failure.result, 'data'), false);
  Reflect.set(scope, 'operation', module.operations.readOutcome);
  Reflect.set(scope, 'operationId', 'readOutcome');
  assert.ok(client.readItem.isError(failure));
  assert.equal(client.readOutcome.isError(failure), false);
});

void test('shared execution captures its operation before executor work and evidence getters can change the scope', async () => {
  const shared = (await import(
    pathToFileURL(join(root, 'execution-generated/execution-runtime.ts')).href
  )) as typeof import('./.generated/execution/execution-runtime.ts');
  for (const stage of ['executor', 'evidence'] as const) {
    const scope = {
      operation: module.operations.createWidget,
      namespace: 'scope-snapshot',
      client: 'consumer',
      operationId: 'createWidget',
    };
    const replaceScope = () => {
      Reflect.set(scope, 'operation', module.operations.readItem);
      Reflect.set(scope, 'operationId', 'readItem');
    };
    const execute = async () => {
      if (stage === 'executor') {
        await Promise.resolve();
        replaceScope();
      }
      return {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
        get body() {
          if (stage === 'evidence') replaceScope();
          return '{"detail":"Conflict"}';
        },
      };
    };
    const client = module.createClient({ namespace: scope.namespace, execute });
    await assert.rejects(
      shared.executeRequest<
        import('./.generated/execution/runtime.ts').Responses,
        'none'
      >(
        module.operations.health.build(),
        execute,
        {},
        new AbortController().signal,
        scope,
      ),
      (error: unknown) => {
        assert.ok(client.createWidget.isError(error), stage);
        assert.equal(client.readItem.isError(error), false, stage);
        assert.equal(error.result.kind, 'error');
        assert.equal(error.result.status, 409);
        return true;
      },
    );
  }
});

void test('cancellation during shared scope capture prevents transport and preserves the abort reason', async () => {
  const shared = (await import(
    pathToFileURL(join(root, 'execution-generated/execution-runtime.ts')).href
  )) as typeof import('./.generated/execution/execution-runtime.ts');
  for (const throwRead of [false, true]) {
    const controller = new AbortController();
    const reason = new Error('scope read cancelled');
    let attempts = 0;
    const scope = {
      get operation() {
        controller.abort(reason);
        if (throwRead) throw new Error('scope read failed after abort');
        return module.operations.health;
      },
      namespace: 'scope-abort',
      client: 'consumer',
      operationId: 'health',
    };
    await assert.rejects(
      shared.executeRequest(
        module.operations.health.build(),
        async () => {
          attempts++;
          return { status: 204, headers: {}, body: '' };
        },
        {},
        controller.signal,
        scope,
      ),
      (error: unknown) => error === reason,
    );
    assert.equal(attempts, 0);
  }
});

void test('direct cancellation preserves falsy reasons and native fallback errors even when evidence reads throw', async () => {
  let attempts = 0;
  const client = module.createClient({
    namespace: 'abort-reasons',
    execute: async () => {
      attempts++;
      return { status: 204, headers: {}, body: '' };
    },
  });
  for (const reason of [
    false,
    null,
    0,
    -0,
    '',
    'cancelled',
    Symbol('cancelled'),
    { cancelled: true },
  ]) {
    const controller = new AbortController();
    controller.abort(reason);
    await assert.rejects(
      client.health.call({ context: {}, signal: controller.signal }),
      (error: unknown) => Object.is(error, reason),
    );
  }
  await assert.rejects(
    runtimeInput(client.health.call, {
      context: {},
      signal: {
        aborted: true,
        addEventListener() {},
        removeEventListener() {},
      },
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  );
  assert.equal(attempts, 0);
  const controller = new AbortController();
  const reason = new Error('abort while interpreting evidence');
  const reading = module.createClient({
    namespace: 'abort-read',
    execute: async () => ({
      status: 204,
      headers: {},
      get body(): string {
        controller.abort(reason);
        throw new Error('read failed after abort');
      },
    }),
  });
  await assert.rejects(
    reading.health.call({ context: {}, signal: controller.signal }),
    (error: unknown) => error === reason,
  );
});
for (const [name, check] of Object.entries(executionChecks))
  void test(name, async () => {
    await check(module, queries, staff);
  });

void test('browser and native executable uploads preserve the complete field inventory without browser globals on native', async () => {
  const browser = (await import(
    pathToFileURL(join(root, 'multipart-generated/client.browser.ts')).href
  )) as typeof import('./.generated/multipart/client.browser.ts');
  const native = (await import(
    pathToFileURL(join(root, 'multipart-generated/client.native.ts')).href
  )) as typeof import('./.generated/multipart/client.native.ts');
  await verifyExecutableMultipart(browser, native);
});

void test('raw and existing transport paths each perform one body read, JSON parse and schema pass per final response', async () => {
  const schemas = (await import(
    pathToFileURL(join(root, 'execution-generated/client.consumer.schemas.ts'))
      .href
  )) as typeof import('./.generated/execution/client.consumer.schemas.ts');
  await verifyExecutionParsing(module, schemas, transport);
  await verifyExecutionParsing(module, schemas, transport);
});

void test('execution selections are opt-in, deterministic and diagnosed before output', async () => {
  const document = executionFixture();
  const without = await compile(document, {
    ...executionSelection,
    executionClients: [],
  });
  assert.equal(Object.hasOwn(without, 'client.consumer.execute.ts'), false);
  assert.equal(Object.hasOwn(without, 'call-runtime.ts'), false);
  assert.doesNotMatch(
    without['client.consumer.ts']!,
    /createClient|execution-runtime/,
  );
  const only = await compile(document, {
    clients: ['consumer'],
    transportHeaders: ['X-Language'],
    executionClients: ['consumer'],
  });
  assert.ok(Object.hasOwn(only, 'client.consumer.execute.ts'));
  assert.equal(Object.hasOwn(only, 'query-runtime.ts'), false);
  assert.equal(Object.hasOwn(only, 'query-sharing.ts'), false);
  for (const source of Object.values(only))
    assert.doesNotMatch(source, /@tanstack|from ['"]react['"]/);
  assert.deepEqual(
    await compile(document, executionSelection),
    await compile(document, {
      ...executionSelection,
      executionClients: ['staff', 'consumer'],
    }),
  );
  for (const executionClients of [
    null,
    'consumer',
    [1],
    ['consumer', 'consumer'],
    ['missing'],
    ['staff'],
  ])
    await assert.rejects(
      invalidOptions(compile, document, {
        clients: ['consumer'],
        executionClients,
      }),
      /executionClients/,
    );
  for (const namespace of ['', null, 1])
    assert.throws(
      () =>
        runtimeInput(module.createClient, {
          namespace,
          execute: async () => ({ status: 204, headers: {}, body: '' }),
        }),
      /namespace/,
    );
  assert.throws(
    () =>
      runtimeInput(module.createClient, { namespace: 'valid', execute: null }),
    /executor/,
  );
});

void test('execution output drift is read-only and stale cleanup preserves modified modules and unrelated files', async (t) => {
  const directory = await temporary(t);
  try {
    const config = join(directory, 'pom.json');
    const output = join(directory, 'generated');
    await writeFile(
      join(directory, 'openapi.json'),
      JSON.stringify(executionFixture()),
    );
    const selection = {
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      clients: ['consumer'],
      transportHeaders: ['X-Language'],
    };
    await writeFile(
      config,
      JSON.stringify({ ...selection, executionClients: ['consumer'] }),
    );
    await runProject(config);
    const target = join(output, 'client.consumer.execute.ts');
    const snapshot = async () => ({
      root: await fileSnapshot(directory),
      output: await fileSnapshot(output),
    });
    await writeFile(join(output, 'keep.txt'), 'application owned');
    await writeFile(config, JSON.stringify(selection));
    const before = await snapshot();
    const drift = await runProject(config, { check: true });
    assert.equal(drift.clean, false);
    assert.deepEqual(await snapshot(), before);
    for (const path of [
      target,
      join(output, 'execution-runtime.ts'),
      join(output, 'call-runtime.ts'),
    ]) {
      const source = await readFile(path, 'utf8');
      await writeFile(path, `${source}\n// application edit\n`);
      const modified = await snapshot();
      await assert.rejects(runProject(config), /modified owned output/);
      assert.deepEqual(await snapshot(), modified);
      await writeFile(path, source);
    }
    await runProject(config);
    await assert.rejects(readFile(target), { code: 'ENOENT' });
    await assert.rejects(readFile(join(output, 'execution-runtime.ts')), {
      code: 'ENOENT',
    });
    await assert.rejects(readFile(join(output, 'call-runtime.ts')), {
      code: 'ENOENT',
    });
    assert.equal(
      await readFile(join(output, 'keep.txt'), 'utf8'),
      'application owned',
    );
    await writeFile(
      config,
      JSON.stringify({ ...selection, executionClients: ['staff'] }),
    );
    const invalid = await snapshot();
    await assert.rejects(runProject(config), /executionClients/);
    assert.deepEqual(await snapshot(), invalid);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test('execution signatures survive declaration publication and native output compiles without DOM libraries', async () => {
  await verifyExecutionDeclarations(
    root,
    join(repo, 'node_modules/typescript/bin/tsc'),
    join(repo, 'test/execution-types.ts'),
  );
  const native = await compile(multipartFixture(), {
    clients: ['native'],
    targets: { native: 'native' },
    executionClients: ['native'],
  });
  await mkdir(join(root, 'native-only'));
  for (const [name, source] of Object.entries(native))
    await writeFile(join(root, 'native-only', name), source);
  await writeFile(
    join(root, 'native-consumer.ts'),
    `
    import {createClient} from './native-only/client.native.ts';
    const client = createClient({namespace: 'native', execute: async () => ({status: 201, headers: {'Content-Type': 'application/json'}, body: '{"count":1}'})});
    client.uploadInline.call({context: {}, input: {body: {file: {uri: 'native://item', name: 'item'}}}});
    // @ts-expect-error Native executable upload inputs require a URI.
    client.uploadInline.call({context: {}, input: {body: {file: {name: 'item'}}}});
  `,
  );
  await writeFile(
    join(root, 'native.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        lib: ['ES2022'],
        types: ['node'],
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['native-only/*.ts', 'native-consumer.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'native.json'),
  ]);
  await cp(
    join(repo, 'test/execution-types.ts'),
    join(root, 'execution-types.ts'),
  );
});
