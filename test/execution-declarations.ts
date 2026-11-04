import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { commandError } from './assertions.ts';

export async function verifyExecutionDeclarations(
  directory: string,
  compiler: string,
  fixture: string,
) {
  // Separate generated modules have independent private receipt symbols. A
  // shared adapter must preserve its caller's token instead of importing one.
  await cp(
    join(directory, 'execution-generated'),
    join(directory, 'execution-independent'),
    { recursive: true },
  );
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022', 'DOM'],
    types: ['node'],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noPropertyAccessFromIndexSignature: true,
    skipLibCheck: false,
  };
  async function typecheck(config: string, listFiles = false) {
    try {
      return await promisify(execFile)(
        process.execPath,
        [compiler, '-p', config, ...(listFiles ? ['--listFiles'] : [])],
        { cwd: directory, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
      );
    } catch (error) {
      const failure = commandError(error);
      failure.message += `\n${failure.stdout}${failure.stderr}`;
      throw failure;
    }
  }
  await writeFile(
    join(directory, 'execution-wrapper.ts'),
    `
    import { createClient, operations } from './execution-generated/client.consumer.ts';
    import type { Execution, Executor, ObservedResponse, PreparedRequest, ResponseInspection, Responses } from './execution-generated/client.consumer.ts';
    import type { Executor as IndependentExecutor } from './execution-independent/client.consumer.ts';
    import { createClient as createUploads } from './multipart-generated/client.browser.ts';
    import type { Executor as UploadExecutor } from './multipart-generated/client.browser.ts';
    import { createQueries, createInfiniteQueries } from './execution-generated/client.consumer.queries.ts';
    const executeRaw = async (_request: PreparedRequest, _execution: Execution): Promise<ObservedResponse> => ({status: 204, headers: {}, body: ''});
    const execute: Executor = executeRaw;
    export const adapter = async <R extends Responses, V extends ResponseInspection<R>>(request: PreparedRequest<R>, execution: Execution<R,V>): Promise<ObservedResponse|V> => execution.validateResponse(await executeRaw(request, execution));
    const independent: IndependentExecutor = adapter;
    void independent;
    export const sharedAdapter: Executor<Readonly<Record<string, unknown>>> = async (_request, execution) => execution.validateResponse({status:204,headers:{},body:''});
    export const mutablePolicyAdapter: Executor<{timeout: 'interactive' | 'upload'}> = async (request, execution) => {
      // @ts-expect-error The runtime freezes policy even with a mutable override.
      request.policy.timeout = 'upload';
      return execution.validateResponse({status:204,headers:{},body:''});
    };
    const uploadAdapter: UploadExecutor = sharedAdapter;
    export const uploadClient = createUploads({namespace: 'published-upload', execute: sharedAdapter});
    void uploadAdapter;
    export const client = createClient({namespace: 'published-client', execute});
    const queries = createQueries({namespace: 'published-client', execute});
    const infinite = createInfiniteQueries({namespace: 'published-client', execute});
    export const body = queries.readItem.body();
    export const bodyKey = body.key({context: {}, input: {path: {id: 'item'}}});
    export const bodyOptions = body.options({context: {}, input: {path: {id: 'item'}}});
    export const invalidation = body.invalidationFilter({context: {}});
    export const cursorBody = infinite.listItems.body();
    export const cursorBodyOptions = cursorBody.options({context: {}, input: {path: {collection: 'items'}}});
    export const offsetBody = infinite.listRecords.body();
    export const offsetBodyOptions = offsetBody.options({context: {}, input: {path: {category: 'records'}}});
    export const call = client.createWidget.call;
    export const optionalCall = client.maybeCreate.call;
    export const nullableCall = client.maybeCreateNullable.call;
    export const optionalRequest = operations.maybeCreate.build();
    export const nullableRequest = operations.maybeCreateNullable.build({body:null});
    export const isError = client.createWidget.isError;
    export function createApi() { return createClient({namespace: 'published-client', execute}); }
  `,
  );
  const emitConfig = join(directory, 'execution-publication.json');
  await writeFile(
    emitConfig,
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        rewriteRelativeImportExtensions: true,
        rootDir: '.',
        outDir: 'execution-publication',
      },
      include: [
        'execution-generated/*.ts',
        'execution-independent/*.ts',
        'multipart-generated/*.ts',
        'execution-wrapper.ts',
      ],
    }),
  );
  await typecheck(emitConfig);
  const publication = join(directory, 'execution-publication');
  const consumer = join(publication, 'consumer.ts');
  await writeFile(
    consumer,
    `${(await readFile(fixture, 'utf8')).replaceAll(".ts';", ".js';")}
    import { client as published, call, isError, createApi, adapter as publishedAdapter, bodyKey as publishedBodyKey, bodyOptions as publishedBodyOptions, invalidation, cursorBody, cursorBodyOptions as publishedCursorBodyOptions, offsetBody, offsetBodyOptions as publishedOffsetBodyOptions } from './execution-wrapper.js';
    import type { Executor as IndependentExecutor } from './execution-independent/client.consumer.js';
    import { sharedAdapter as publishedSharedAdapter, uploadClient as publishedUploadClient } from './execution-wrapper.js';
    import { mutablePolicyAdapter as publishedMutablePolicyAdapter } from './execution-wrapper.js';
    import { optionalCall, nullableCall, optionalRequest, nullableRequest } from './execution-wrapper.js';
    function verifyPublishedOptionalBodies() {
      // @ts-expect-error Published optional builders retain the bodyless possibility.
      const alwaysJson: 'json' = optionalRequest.bodyKind;
      void alwaysJson;
      if (optionalRequest.bodyKind === 'json') {
        const label: string = optionalRequest.body.label;
        // @ts-expect-error Published included bodies do not contain undefined.
        const missing: typeof optionalRequest.body = undefined;
        void [label, missing];
      } else {
        // @ts-expect-error Published bodyless requests have no body property.
        void optionalRequest.body;
      }
      if (nullableRequest.bodyKind === 'json') {
        const explicitNull: typeof nullableRequest.body = null;
        // @ts-expect-error Retaining null must not retain undefined.
        const missing: typeof nullableRequest.body = undefined;
        void [explicitNull, missing];
      }
    }
    void verifyPublishedOptionalBodies;
    function verifyPublishedReadonly(request: Parameters<typeof publishedMutablePolicyAdapter>[0]) {
      // @ts-expect-error Published policy overrides retain readonly fields.
      request.policy.timeout = 'upload';
    }
    void verifyPublishedReadonly;
    import type { Executor as PublishedUploadExecutor } from './multipart-generated/client.browser.js';
    const publishedUploadAdapter: PublishedUploadExecutor = publishedSharedAdapter;
    const independentAdapter: IndependentExecutor = publishedAdapter;
    void [publishedUploadAdapter, publishedUploadClient];
    const ordinaryBody = cache.getQueryData(publishedBodyKey);
    const ordinaryBodyOptions = cache.getQueryData(publishedBodyOptions.queryKey);
    if (ordinaryBody && ordinaryBodyOptions) {
      const label: string = ordinaryBody.label;
      ordinaryBodyOptions.label = label;
      // @ts-expect-error Published body keys retain body data tags.
      void ordinaryBody.data;
    }
    const cursorBodyData = cache.getQueryData(publishedCursorBodyOptions.queryKey);
    const offsetBodyData = cache.getQueryData(publishedOffsetBodyOptions.queryKey);
    if (cursorBodyData) {
      const parameter: string | null | undefined = cursorBodyData.pageParams[0];
      cursorBody.items(cursorBodyData);
      void parameter;
    }
    if (offsetBodyData) {
      const parameter: number | undefined = offsetBodyData.pageParams[0];
      offsetBody.items(offsetBodyData);
      void parameter;
    }
    cache.setQueriesData(invalidation, previous => {
      // @ts-expect-error A published mixed-family filter does not claim one data type.
      void previous?.label;
      return previous;
    });
    void independentAdapter;
    export async function downstream(error: unknown) {
      const args = {context: {}, input: {headers: {'Idempotency-Key': 'one'}, body: {label: 'Valid', values: []}}};
      const result = await call(args);
      const same = await published.createWidget.call(args);
      const status: 201 | 202 = result.status;
      const sameStatus: 201 | 202 = same.status;
      const empty: undefined = (await createApi().health.call({context: {}})).data;
      void [status, sameStatus, empty];
      const optional = await optionalCall({context: {}});
      const optionalStatus: 204 = optional.status;
      const optionalData: undefined = optional.data;
      await optionalCall({context: {}, input: {body: undefined}});
      await nullableCall({context: {}, input: {body: null}});
      await createApi().maybeUpdate.call({context: {}, input: {path: {id:'item'}, headers: args.input.headers}});
      void [optionalStatus, optionalData];
      // @ts-expect-error Published optional calls preserve nonnullable schemas.
      await optionalCall({context: {}, input: {body: null}});
      // @ts-expect-error Required parameters still require an input object.
      await createApi().maybeUpdate.call({context: {}});
      // @ts-expect-error Published call signatures retain required input.
      await call({context: {}});
      // @ts-expect-error Published clients retain required context.
      await createApi().health.call({});
      if (isError(error) && error.result.kind === 'error' && error.result.status === 409) {
        const detail: string = error.result.data.detail;
        void detail;
        // @ts-expect-error Published guards retain failure schemas.
        void error.result.data.id;
      }
    }
  `,
  );
  const config = join(publication, 'tsconfig.json');
  await writeFile(
    config,
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      include: ['consumer.ts'],
    }),
  );
  const { stdout } = await typecheck(config, true);
  const files = stdout
    .trim()
    .split(/\r?\n/)
    .map((file) => resolve(file));
  assert.ok(files.includes(consumer));
  assert.ok(files.includes(join(publication, 'execution-wrapper.d.ts')));
  assert.ok(
    files.includes(
      join(publication, 'execution-generated/client.consumer.execute.d.ts'),
    ),
  );
  assert.ok(
    files.every(
      (file) =>
        !file.startsWith(`${join(directory, 'execution-generated')}${sep}`),
    ),
    'downstream consumers must resolve declarations without original generated sources',
  );
  assert.ok(
    files.every(
      (file) =>
        !file.startsWith(`${join(directory, 'execution-independent')}${sep}`),
    ),
    'independent output compatibility must also resolve emitted declarations only',
  );
}
