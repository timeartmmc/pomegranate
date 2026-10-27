import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { commandError } from './assertions.ts';

const exec = promisify(execFile);

// Exercise a consumer of published declarations, not the source program that
// emitted them. Also publish ordinary inferred application exports: they can
// expand types at a different boundary than the generated factory itself.
export async function verifyQueryDeclarations(
  directory: string,
  compiler: string,
  fixture: string,
  infiniteFixture?: string,
): Promise<void> {
  const compilerOptions = {
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
  const publication = join(directory, 'query-publication');
  const emitConfig = join(directory, 'query-publication.json');
  await writeFile(
    join(directory, 'query-wrapper.ts'),
    `import { skipToken } from '@tanstack/query-core';
    import { createQueries, shareQueryData } from './query-generated/client.consumer.queries.ts';
    export const sharing = shareQueryData;
    const config = {
      namespace: 'synthetic-published-api',
      execute: async () => ({ status: 204, headers: {}, body: '' }),
    };
    export const queries = createQueries(config);
    export const itemOptions = queries.readItem.options({
      context: {}, input: { path: { id: 'item' } },
    });
    export const itemKey = itemOptions.queryKey;
    export const healthOptions = queries.health.options({ context: {} });
    export const skippedOptions = queries.readItem.options({ context: {}, input: skipToken });
    export const operationFilter = queries.readItem.filter({ context: {} });
    export const isItemError = queries.readItem.isError;
    export function waitingOptions(id: string | undefined) {
      return queries.readItem.options({ context: {}, input: id === undefined ? skipToken : { path: { id } } });
    }
    export function createApi() { return createQueries(config); }
    ${
      infiniteFixture === undefined
        ? ''
        : `
    import { createInfiniteQueries } from './query-generated/client.consumer.queries.ts';
    export const infiniteQueries = createInfiniteQueries(config);
    export const infiniteOptions = infiniteQueries.listItems.options({ context: {}, input: { path: { collection: 'items' } } });
    export const infiniteKey = infiniteOptions.queryKey;
    export const infiniteSkippedOptions = infiniteQueries.listItems.options({ context: {}, input: skipToken });
    export const infiniteFilter = infiniteQueries.listItems.filter({ context: {} });
    export const infiniteItems = infiniteQueries.listItems.items;
    export const isPageError = infiniteQueries.listItems.isError;
    export function infiniteWaitingOptions(collection: string | undefined) {
      return infiniteQueries.listItems.options({ context: {}, input: collection === undefined ? skipToken : { path: { collection } } });
    }
    `
    }
    `,
  );
  await writeFile(
    emitConfig,
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        declaration: true,
        rewriteRelativeImportExtensions: true,
        rootDir: '.',
        outDir: 'query-publication',
      },
      include: ['query-generated/*.ts', 'query-wrapper.ts'],
    }),
  );
  async function typecheck(config: string, listFiles = false) {
    try {
      return await exec(
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
  await typecheck(emitConfig);
  const consumer = join(publication, 'consumer.ts');
  await writeFile(
    consumer,
    `${(await readFile(fixture, 'utf8')).replaceAll('.queries.ts', '.queries.js')}
    import { queries as publishedQueries, itemOptions, itemKey, healthOptions, skippedOptions, waitingOptions, operationFilter, createApi, isItemError, sharing } from './query-wrapper.js';
    const shared = sharing(undefined, { label: 'typed' });
    const sharedLabel: string = shared.label;
    void sharedLabel;
    // @ts-expect-error Sharing preserves the new value's type.
    void shared.missing;
    export function publishedError(error: unknown) {
      if (isItemError(error) && error.result.kind === 'error' && error.result.status === 404) {
        const detail: string = error.result.data.detail;
        void detail;
        // @ts-expect-error Published guards retain the declared failure body.
        void error.result.data.label;
      }
    }
    const published = client.getQueryData(itemKey);
    const publishedOptions = client.getQueryData(itemOptions.queryKey);
    const health = client.getQueryData(healthOptions.queryKey);
    const api = createApi();
    client.invalidateQueries(operationFilter);
    const skippedCache = client.getQueryData(skippedOptions.queryKey);
    const waitingCache = client.getQueryData(waitingOptions(undefined).queryKey);
    if (skippedCache && waitingCache) {
      const skippedLabel: string = skippedCache.data.label;
      const waitingLabel: string = waitingCache.data.label;
      void [skippedLabel, waitingLabel];
      // @ts-expect-error Published skip keys preserve their data tags.
      void skippedCache.data.reference;
    }
    api.health.options({ context: {} });
    publishedQueries.readItem.options(args);
    // @ts-expect-error Inferred wrapper factories must retain required inputs.
    api.readItem.options({ context: {} });
    if (published && publishedOptions) {
      const status: 200 = published.status;
      const label: string = publishedOptions.data.label;
      void [status, label];
      // @ts-expect-error Wrapper keys must retain their response data tags.
      void published.data.reference;
    }
    if (health) {
      const status: 204 = health.status;
      const data: undefined = health.data;
      void [status, data];
    }
    `,
  );
  if (infiniteFixture !== undefined) {
    await writeFile(
      join(publication, 'infinite-consumer.ts'),
      `
      ${(await readFile(infiniteFixture, 'utf8')).replaceAll('.queries.ts', '.queries.js')}
    import { infiniteKey, infiniteOptions, infiniteSkippedOptions, infiniteFilter, infiniteItems, infiniteWaitingOptions, isPageError } from './query-wrapper.js';
    export function publishedPageError(error: unknown) {
      if (isPageError(error) && error.result.kind === 'error' && error.result.status === 410) {
        const data: undefined = error.result.data;
        void data;
        // @ts-expect-error A bodyless failure cannot expose item data.
        void error.result.data.results;
      }
    }
    infiniteClient.invalidateQueries(infiniteFilter);
    const publishedInfinite = infiniteClient.getQueryData(infiniteKey);
    const publishedSkipped = infiniteClient.getQueryData(infiniteSkippedOptions.queryKey);
    const publishedWaiting = infiniteClient.getQueryData(infiniteWaitingOptions(undefined).queryKey);
    void [publishedSkipped, publishedWaiting];
    const publishedItems = infiniteItems(publishedInfinite);
    const publishedItemId: string | undefined = publishedItems[0]?.id;
    void publishedItemId;
    infiniteClient.fetchInfiniteQuery(infiniteOptions);
    // @ts-expect-error Published infinite item selection preserves the item shape.
    void publishedItems[0]?.missing;

    `,
    );
  }
  const consumeConfig = join(publication, 'tsconfig.json');
  await writeFile(
    consumeConfig,
    JSON.stringify({
      compilerOptions: {
        ...compilerOptions,
        rootDir: '.',
        noEmit: true,
      },
      include: [
        'consumer.ts',
        ...(infiniteFixture === undefined ? [] : ['infinite-consumer.ts']),
      ],
    }),
  );
  const { stdout } = await typecheck(consumeConfig, true);
  const files = stdout
    .trim()
    .split(/\r?\n/)
    .map((file) => resolve(file));
  assert.ok(files.includes(consumer), 'must check the downstream consumer');
  assert.ok(
    files.includes(join(publication, 'query-wrapper.d.ts')),
    'must resolve the emitted application declarations',
  );
  assert.ok(
    files.includes(
      join(publication, 'query-generated/client.consumer.queries.d.ts'),
    ),
    'must resolve the emitted query declarations',
  );
  assert.ok(
    files.every(
      (file) => !file.startsWith(`${join(directory, 'query-generated')}${sep}`),
    ),
    'declaration checks must not resolve original generated sources',
  );
  // Error tags must preserve the application's registered default. Executors
  // and AbortSignal reasons may reject with values other than Error instances.
  await writeFile(
    join(publication, 'registered-errors.ts'),
    `
    import { QueryClient } from '@tanstack/query-core';
    import { queries ${infiniteFixture === undefined ? '' : ', infiniteQueries'} } from './query-wrapper.js';
    declare module '@tanstack/query-core' { interface Register { defaultError: unknown; } }
    const client = new QueryClient();
    const error = client.getQueryState(queries.health.key({ context: {} }))?.error;
    // @ts-expect-error Registered unknown errors need narrowing before access.
    void error?.message;
    if (queries.readItem.isError(error) && error.result.kind === 'error' && error.result.status === 404) {
      const detail: string = error.result.data.detail;
      void detail;
    }
    const health: 204 | undefined = client.getQueryData(queries.health.key({ context: {} }))?.status;
    void health;
    ${
      infiniteFixture === undefined
        ? ''
        : `
    const key = infiniteQueries.listItems.key({ context: {}, input: { path: { collection: 'items' } } });
    const infiniteError = client.getQueryState(key)?.error;
    // @ts-expect-error Infinite keys must preserve registered unknown errors too.
    void infiniteError?.message;
    if (infiniteQueries.listItems.isError(infiniteError) && infiniteError.result.kind === 'error' && infiniteError.result.status === 404) {
      const detail: string = infiniteError.result.data.detail;
      void detail;
    }
    const id: string | undefined = client.getQueryData(key)?.pages[0]?.data.results[0]?.id;
    void id;
    `
    }
  `,
  );
  const registeredConfig = join(publication, 'registered-errors.json');
  await writeFile(
    registeredConfig,
    JSON.stringify({
      compilerOptions: { ...compilerOptions, noEmit: true },
      include: ['registered-errors.ts'],
    }),
  );
  await typecheck(registeredConfig);
}
