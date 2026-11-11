import {
  createClient,
  operations,
} from './execution-generated/client.consumer.ts';
import type {
  Execution,
  Executor,
  ObservedResponse,
  PreparedRequest,
  RequestTypes,
  ResponseInspection,
  Responses,
} from './execution-generated/client.consumer.ts';
import { defineOperation } from './execution-generated/runtime.ts';
import type { EmptyResponse, Parse } from './execution-generated/runtime.ts';
import type { JsonResponse } from './execution-generated/endpoint-runtime.ts';
import type { QueryFactory } from './execution-generated/query-runtime.ts';
import { QueryClient, skipToken } from '@tanstack/query-core';
import type { QueryExecutor } from './execution-generated/client.consumer.queries.ts';
import type { Executor as UploadExecutor } from './multipart-generated/client.browser.ts';
import { createClient as createUploads } from './multipart-generated/client.browser.ts';
import {
  createQueries,
  createInfiniteQueries,
} from './execution-generated/client.consumer.queries.ts';

const authReadiness = { public: false, session: true } as const;

declare const unknownQuery: QueryFactory<undefined, Responses>;
// @ts-expect-error An unspecified response table may have a bodyless success.
unknownQuery.body();
declare const eitherQuery: QueryFactory<
  undefined,
  { 200: JsonResponse<Parse<string>> } | { 204: EmptyResponse }
>;
// @ts-expect-error Either response table can be selected, including a bodyless one.
eitherQuery.body();
const retryBudgets = { never: 0 } as const;
const execute: Executor = async (request, execution) => {
  const readiness: boolean = authReadiness[request.policy.auth];
  const attempts: 0 = retryBudgets[request.policy.retry];
  const audit: true | undefined = request.policy.audit;
  void [readiness, attempts, audit];
  const signal: AbortSignal = execution.signal;
  const locale: string | number | boolean | null | undefined =
    execution.context['locale'];
  void [signal, locale];
  if (request.bodyKind === 'json') JSON.stringify(request.body);
  if (request.bodyKind === 'multipart') {
    const field: string | undefined = request.multipart[0]?.name;
    void field;
  }
  return { status: 204, headers: {}, body: '' };
};
export const sharedAdapter: Executor<
  Readonly<Record<string, unknown>>
> = async (_request, execution) =>
  execution.validateResponse({ status: 204, headers: {}, body: '' });
const sharedUpload: UploadExecutor = sharedAdapter;
const sharedQuery: QueryExecutor = sharedAdapter;
const uploadClient = createUploads({
  namespace: 'shared-policy',
  execute: sharedAdapter,
});
const sharedQueryAdapter: QueryExecutor<Readonly<Record<string, unknown>>> =
  sharedAdapter;
void [sharedUpload, sharedQuery, uploadClient, sharedQueryAdapter];
// @ts-expect-error A transport declared for interactive policies cannot accept upload policy.
const narrowUpload: UploadExecutor = execute;
void narrowUpload;
export const inspectedPolicyAdapter: Executor<{
  auth: 'public' | 'session';
  retry: 'never';
  timeout: 'interactive' | 'upload';
  audit?: true;
}> = async (request, execution) => {
  const budgets = { interactive: 1000, upload: 5000 };
  const timeout: number = budgets[request.policy.timeout];
  void timeout;
  // @ts-expect-error Frozen metadata stays readonly for mutable policy overrides.
  request.policy.timeout = 'upload';
  return execution.validateResponse({ status: 204, headers: {}, body: '' });
};
const inspectedUpload: UploadExecutor = inspectedPolicyAdapter;
const inspectedQuery: QueryExecutor = inspectedPolicyAdapter;
void [inspectedUpload, inspectedQuery];
// A broad executor is assignable to the original bodyless query contract.
const bodyless: QueryExecutor = execute;
// Explicit imported Execution annotations must survive regeneration too.
const legacyRaw = async (
  _request: PreparedRequest,
  _execution: Execution,
): Promise<ObservedResponse> => ({ status: 204, headers: {}, body: '' });
const legacyBodyless = async (
  _request: PreparedRequest<Responses, 'none'>,
  _execution: Execution,
): Promise<ObservedResponse> => ({ status: 204, headers: {}, body: '' });
const compatibleRaw: Executor = legacyRaw;
const compatibleBodyless: QueryExecutor = legacyBodyless;
export const scopedAdapter = async <
  R extends Responses,
  V extends ResponseInspection<R>,
>(
  request: PreparedRequest<R>,
  execution: Execution<R, V>,
): Promise<ObservedResponse | V> =>
  execution.validateResponse(await legacyRaw(request, execution));
const compatibleScoped: Executor = scopedAdapter;
const compatibleScopedQuery: QueryExecutor = scopedAdapter;
void [
  bodyless,
  compatibleRaw,
  compatibleBodyless,
  compatibleScoped,
  compatibleScopedQuery,
];
const config = { namespace: 'synthetic-types', execute };
const client = createClient(config);
const queries = createQueries(config);
const infinite = createInfiniteQueries(config);
const context = { revision: 'one', locale: 'en' };
const input = {
  headers: { 'Idempotency-Key': 'one' },
  body: { label: 'Valid', values: [] },
};
const cache = new QueryClient();
export const bodyFactory = queries.readItem.body();
export const bodyOptions = bodyFactory.options({
  context,
  input: { path: { id: 'item' } },
});
export const bodyKey = bodyOptions.queryKey;
export const operationInvalidation = bodyFactory.invalidationFilter({
  context,
});
export const cursorBodyFactory = infinite.listItems.body();
export const cursorBodyOptions = cursorBodyFactory.options({
  context,
  input: { path: { collection: 'items' } },
});
export const offsetBodyFactory = infinite.listRecords.body();
export const offsetBodyOptions = offsetBodyFactory.options({
  context,
  input: { path: { category: 'records' } },
});
type ReadResponses =
  ReturnType<typeof operations.readItem.build> extends PreparedRequest<infer R>
    ? R
    : never;

export function inspectionTypes(inspection: ResponseInspection<ReadResponses>) {
  if (inspection.kind === 'success') {
    const label: string = inspection.data.label;
    void label;
    // @ts-expect-error Execution inspection data is immutable until handoff.
    inspection.data.label = 'Changed';
  }
}

type OptionalResponses =
  ReturnType<typeof operations.maybeCreate.build> extends PreparedRequest<
    infer R
  >
    ? R
    : never;

export function optionalInspectionTypes(
  inspection: ResponseInspection<OptionalResponses>,
) {
  if (inspection.kind !== 'protocol') {
    const status: 204 = inspection.status;
    const data: undefined = inspection.data;
    void [status, data];
  }
}

export async function optionalRequestTypes() {
  operations.maybeCreate.build();
  operations.maybeCreate.build({});
  operations.maybeCreate.build({ body: undefined });
  operations.maybeCreate.build({ body: input.body });
  const request = operations.maybeCreate.build();
  const annotated: PreparedRequest<
    OptionalResponses,
    'json' | 'none',
    RequestTypes['WriteInput']
  > = request;
  // @ts-expect-error An optional JSON body can produce a bodyless request.
  const alwaysJson: 'json' = operations.maybeCreate.build().bodyKind;
  void [annotated, alwaysJson];
  if (request.bodyKind === 'json') {
    const body: RequestTypes['WriteInput'] = request.body;
    const included: typeof request.body = input.body;
    // @ts-expect-error Included JSON bodies exclude undefined.
    const missing: typeof request.body = undefined;
    void [body, included, missing];
  } else {
    // @ts-expect-error Bodyless prepared requests expose no body property.
    void request.body;
  }
  const nullable = operations.maybeCreateNullable.build({ body: null });
  if (nullable.bodyKind === 'json') {
    const body: RequestTypes['WriteInput'] | null = nullable.body;
    const explicitNull: typeof nullable.body = null;
    // @ts-expect-error Nullable JSON bodies still exclude undefined when included.
    const missing: typeof nullable.body = undefined;
    void [body, explicitNull, missing];
  }
  // @ts-expect-error Optionality does not make a nonnullable schema nullable.
  operations.maybeCreate.build({ body: null });
  // @ts-expect-error Included JSON bodies retain their schema.
  operations.maybeCreate.build({ body: { label: 'Valid', values: [1] } });
  const update = { path: { id: 'item' }, headers: input.headers };
  operations.maybeUpdate.build(update);
  operations.maybeUpdate.build({ ...update, body: undefined });
  // @ts-expect-error Optional bodies do not make path parameters optional.
  operations.maybeUpdate.build({ headers: input.headers });
  // @ts-expect-error Optional bodies do not make endpoint headers optional.
  operations.maybeUpdate.build({ path: update.path });
  const requiredKind: 'json' = operations.createWidget.build(input).bodyKind;
  void requiredKind;
  // @ts-expect-error Required JSON bodies remain required.
  operations.createWidget.build({ headers: input.headers });
  const result = await client.maybeCreate.call({ context });
  const status: 204 = result.status;
  const data: undefined = result.data;
  void [status, data];
  await client.maybeCreate.call({ context, input: { body: undefined } });
  await client.maybeCreateNullable.call({ context, input: { body: null } });
  await client.maybeUpdate.call({ context, input: update });
  // @ts-expect-error Optional JSON calls preserve nonnullable schemas.
  await client.maybeCreate.call({ context, input: { body: null } });
  // @ts-expect-error An operation with required parameters still needs input.
  await client.maybeUpdate.call({ context });
}

export function optionalDefinitionTypes(
  options: Parse<{ body?: RequestTypes['WriteInput'] | undefined } | undefined>,
) {
  const definition = {
    operationId: 'inferredOptional',
    method: 'POST',
    path: '/inferred-optional',
    security: { transport: 'none' },
    policy: { auth: 'public', retry: 'never', timeout: 'interactive' },
    bodyKind: 'json',
    parameters: [],
    options,
    headers: {},
    responses: { 204: { bodyKind: 'none', headers: {} } },
  } as const;
  const operation = defineOperation(definition);
  const request = operation.build();
  const kind: 'json' | 'none' = request.bodyKind;
  // @ts-expect-error Low-level inference must also retain the bodyless case.
  const alwaysJson: 'json' = request.bodyKind;
  void [kind, alwaysJson];
  if (request.bodyKind === 'json') {
    const body: RequestTypes['WriteInput'] = request.body;
    const included: typeof request.body = input.body;
    void [body, included];
  }
  const noOptions = defineOperation({
    ...definition,
    options: () => undefined,
  });
  // @ts-expect-error An undefined options parser cannot promise an included body.
  const absentKind: 'json' = noOptions.build().bodyKind;
  void absentKind;
}

export function cachedBodyTypes() {
  const cached = cache.getQueryData(bodyKey);
  const skipped = cache.getQueryData(
    bodyFactory.options({ context, input: skipToken }).queryKey,
  );
  if (cached && skipped) {
    const label: string = cached.label;
    skipped.label = label;
    // @ts-expect-error Body caches do not contain response envelopes.
    void cached.data;
  }
  cache.setQueryData(bodyKey, { id: 'item', label: 'Warm' });
  const envelope = {
    kind: 'success',
    data: { id: 'item', label: 'Warm' },
  };
  // @ts-expect-error A body cache writer must supply the body shape.
  cache.setQueryData(bodyKey, envelope);
  // @ts-expect-error Any declared bodyless success makes body storage unavailable.
  queries.health.body();
  const cursor = cache.getQueryData(cursorBodyOptions.queryKey);
  if (cursor) {
    const pageParameter: string | null | undefined = cursor.pageParams[0];
    const initial: (typeof cursor.pageParams)[number] = null;
    const resumed: (typeof cursor.pageParams)[number] = 'next';
    // @ts-expect-error Nullable request cursors do not widen page parameters to numbers.
    const invalid: (typeof cursor.pageParams)[number] = 1;
    const first = cursor.pages[0];
    const next: string | null | undefined = first?.continuation;
    const selected = cursorBodyFactory.items(cursor);
    void [pageParameter, initial, resumed, invalid, next, selected];
    // @ts-expect-error Cursor body pages have no status envelope.
    void first?.status;
  }
  const offset = cache.getQueryData(offsetBodyOptions.queryKey);
  if (offset) {
    const pageParameter: number | undefined = offset.pageParams[0];
    const start: number | undefined = offset.pages[0]?.start;
    const selected = offsetBodyFactory.items(offset);
    void [pageParameter, start, selected];
    // @ts-expect-error Offset body page parameters remain numeric.
    const invalid: string = offset.pageParams[0]!;
    void invalid;
  }
  cache.setQueriesData(operationInvalidation, (previous) => {
    const mixed: unknown = previous;
    void mixed;
    // @ts-expect-error An operation-wide filter has no single stored-data type.
    void previous?.label;
    return previous;
  });
}

export async function executionTypes(error: unknown) {
  const result = await client.createWidget.call({ context, input });
  if (result.status === 201) {
    const id: string = result.data.id;
    void id;
    // @ts-expect-error The 201 schema is not the 202 schema.
    void result.data.reference;
  } else {
    const status: 202 = result.status;
    const reference: string = result.data.reference;
    void [status, reference];
    // @ts-expect-error HTTP failures reject instead of entering success data.
    const denial: 403 = result.status;
    void denial;
  }
  const empty: undefined = (await client.health.call({ context })).data;
  void empty;
  const read = await client.readItem.call({
    context,
    input: {
      path: { id: 'item' },
      query: { tags: ['one'], count: 0, filter: null },
      headers: { 'X-View': null },
    },
  });
  const label: string = read.data.label;
  void label;
  operations.readItem.build({ path: { id: 'item' } });
  queries.readItem.options({ context, input: { path: { id: 'item' } } });
  operations.listItems.build({
    path: { collection: 'items' },
    query: { after: null },
  });
  queries.listItems.options({
    context,
    input: { path: { collection: 'items' }, query: { after: null } },
  });
  const cursor = await client.listItems.call({
    context,
    input: { path: { collection: 'items' }, query: { after: null } },
  });
  if (cursor.status === 206) {
    const code: number | undefined = cursor.data.results[0]?.code;
    void code;
    // @ts-expect-error The 206 page contains a different item type.
    void cursor.data.results[0]?.label;
  } else {
    const id: string | undefined = cursor.data.results[0]?.id;
    void id;
  }
  infinite.listItems.options({
    context,
    input: { path: { collection: 'items' } },
  });
  infinite.listItems.options({
    context,
    input: {
      path: { collection: 'items' },
      // @ts-expect-error Pagination owns nullable cursors in envelope mode too.
      query: { after: null },
    },
  });
  cursorBodyFactory.options({
    context,
    input: {
      path: { collection: 'items' },
      // @ts-expect-error Body storage does not expose the pagination-owned cursor.
      query: { after: null },
    },
  });
  infinite.listRecords.options({
    context,
    input: { path: { category: 'records' } },
  });
  if (client.createWidget.isError(error)) {
    if (error.result.kind === 'protocol') {
      // @ts-expect-error A protocol error never exposes data.
      void error.result.data;
    } else if (error.result.status === 409) {
      const detail: string = error.result.data.detail;
      void detail;
      // @ts-expect-error Declared failure types do not widen to success bodies.
      void error.result.data.id;
    } else {
      const status: 403 = error.result.status;
      const data: undefined = error.result.data;
      void [status, data];
    }
  }
  // @ts-expect-error Every direct call requires context.
  await client.health.call({});
  // @ts-expect-error Required paths stay required.
  await client.readItem.call({ context });
  // @ts-expect-error JSON command bodies stay required.
  await client.createWidget.call({ context });
  // @ts-expect-error Endpoint headers stay required.
  await client.createWidget.call({ context, input: { body: input.body } });
  await client.createWidget.call({
    context,
    // @ts-expect-error Body values retain their declared type.
    input: { ...input, body: { label: 'Valid', values: [1] } },
  });
  // @ts-expect-error Context values must be JSON scalars.
  await client.health.call({ context: { nested: {} } });
  // @ts-expect-error Readiness is explicit at query sites, not on direct calls.
  await client.health.call({ context, enabled: false });
}

export function queryOnlyExecutor(executeQuery: QueryExecutor) {
  createQueries({ namespace: 'existing-query-api', execute: executeQuery });
  // @ts-expect-error A bodyless-only executor cannot execute writes and uploads.
  createClient({ namespace: 'requires-all-bodies', execute: executeQuery });
}
