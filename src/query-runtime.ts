/*!
 * MIT License
 *
 * Copyright (c) 2026 Jamil Kazimzade
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
import { skipToken } from '@tanstack/query-core';
import type {
  DataTag,
  InfiniteData,
  Query,
  QueryFilters,
  QueryFunctionContext,
  SkipToken,
} from '@tanstack/query-core';
import type {
  DeclaredResponse,
  ObservedResponse,
  PreparedRequest,
  ProtocolFailure,
  ProtocolResult,
  Responses,
  RequestParts,
  ProtocolIssue,
} from './runtime.ts';
import { validateOptions } from './runtime.ts';
import type { z } from 'zod';
import { shareQueryData } from './query-sharing.ts';

export type CacheContext = Readonly<
  Record<string, string | number | boolean | null>
>;
type ContextEntries = readonly (readonly [string, CacheContext[string]])[];

// Return raw HTTP evidence so the generated parser remains the authority for
// status/body/header agreement. Credentials and network policy stay in execute.
export type QueryExecutor = (
  request: PreparedRequest<Responses, 'none'>,
  execution: Readonly<{ signal: AbortSignal; context: CacheContext }>,
) => Promise<ObservedResponse>;

type Success<R extends Responses> = DeclaredResponse<R> &
  Readonly<{ kind: 'success' }>;
type Failure<R extends Responses = Responses> =
  | ProtocolFailure
  | (DeclaredResponse<R> & Readonly<{ kind: 'error' }>);

export class QueryResponseError extends Error {
  readonly result: Failure;

  constructor(result: Failure) {
    super(`${result.operationId}: ${result.kind} response (${result.status})`);
    this.name = 'QueryResponseError';
    this.result = result;
  }
}

export interface TypedQueryResponseError<
  R extends Responses,
> extends QueryResponseError {
  readonly result: Failure<R>;
}

type ErrorScope = Readonly<{
  operation: object;
  namespace: string;
  client: string;
  operationId: string;
}>;
const responseErrors = new WeakMap<
  object,
  Readonly<{ scope: ErrorScope; result: Failure }>
>();

function operationErrorGuard<R extends Responses>(scope: ErrorScope) {
  return (error: unknown): error is TypedQueryResponseError<R> => {
    if (error === null || typeof error !== 'object') return false;
    const origin = responseErrors.get(error);
    if (
      !origin ||
      origin.scope.operation !== scope.operation ||
      origin.scope.namespace !== scope.namespace ||
      origin.scope.client !== scope.client ||
      origin.scope.operationId !== scope.operationId
    )
      return false;
    // Only the parser records provenance. A public constructor, copied error,
    // transport rejection or replaced result cannot mint a typed response.
    const result: unknown = Object.getOwnPropertyDescriptor(
      error,
      'result',
    )?.value;
    return result === origin.result;
  };
}

function isFailure<R extends Responses>(
  result: ProtocolResult<R>,
): result is Failure<R> {
  return result.kind !== 'success';
}

function assertSuccess<R extends Responses>(
  result: ProtocolResult<R>,
  scope: ErrorScope,
): asserts result is Success<R> {
  if (isFailure(result)) {
    const error = new QueryResponseError(result);
    responseErrors.set(error, { scope, result });
    throw error;
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  // Native polyfills may lack throwIfAborted and reason. Keep a defined
  // cancellation reason verbatim and supply a portable error only if absent.
  const reason: unknown = 'reason' in signal ? signal.reason : undefined;
  if (reason !== undefined) {
    // oxlint-disable-next-line typescript/only-throw-error -- AbortSignal reasons can be any value; cancellation must preserve them exactly.
    throw reason;
  }
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  throw error;
}

type Arguments<Input> = Readonly<{ context: CacheContext }> &
  (undefined extends Input
    ? Readonly<{ input?: Input }>
    : Readonly<{ input: Input }>);
type SkippedArguments = Readonly<{ context: CacheContext; input: SkipToken }>;

type OperationScope =
  | Readonly<{ context: CacheContext; allContexts?: never }>
  | Readonly<{ allContexts: true; context?: never }>;

type KeyParts<Prefix extends string = 'pom-query-v1'> = readonly [
  Prefix,
  string,
  string,
  string,
  ContextEntries,
  string | null,
  readonly (readonly [string, string])[],
];

// Interfaces preserve named boundaries even when an application publishes
// inferred exports of factories, options or keys. Readonly object aliases can
// instead inline DataTag's unique symbols without importing them.
export interface QueryKey<R extends Responses>
  extends KeyParts, DataTag<unknown, Success<R>> {}

export interface SkippableQueryOptions<R extends Responses> {
  readonly queryKey: QueryKey<R>;
  readonly retry: false;
  readonly structuralSharing: typeof shareQueryData;
  readonly queryFn:
    | ((context: QueryFunctionContext<QueryKey<R>>) => Promise<Success<R>>)
    | SkipToken;
}

export interface QueryOptions<
  R extends Responses,
> extends SkippableQueryOptions<R> {
  readonly queryFn: (
    context: QueryFunctionContext<QueryKey<R>>,
  ) => Promise<Success<R>>;
}

export interface OperationFilter extends ScopedOperationFilter<'pom-query-v1'> {}

export interface QueryFactory<Input, R extends Responses> {
  readonly isError: (error: unknown) => error is TypedQueryResponseError<R>;
  readonly key: (args: Arguments<Input>) => QueryKey<R>;
  readonly options: {
    (args: Arguments<Input>): QueryOptions<R>;
    (args: Arguments<Input> | SkippedArguments): SkippableQueryOptions<R>;
  };
  readonly filter: (scope: OperationScope) => OperationFilter;
}

type QueryOperation = Readonly<{
  build: (input: never) => PreparedRequest<Responses, 'none'>;
}>;

export type QueryFactories<
  Operations extends Readonly<Record<string, QueryOperation>>,
> = Readonly<{
  [Name in keyof Operations]: Operations[Name] extends {
    build: (input: infer Input) => PreparedRequest<infer R, 'none'>;
  }
    ? QueryFactory<Input, R>
    : never;
}>;

function dataRecord(value: unknown, location: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== 'object' ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  )
    throw new TypeError(`${location} must be a plain record`);
  return Object.fromEntries(
    Reflect.ownKeys(value).map((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name)!;
      if (
        typeof name !== 'string' ||
        !descriptor.enumerable ||
        !Object.hasOwn(descriptor, 'value')
      )
        throw new TypeError(`${location} must contain enumerable data fields`);
      const item: unknown = descriptor.value;
      return [name, item];
    }),
  );
}

function cacheContext(input: unknown): ContextEntries {
  const context = dataRecord(input, 'query context');
  return Object.freeze(
    Object.keys(context)
      .sort()
      .map((name) => {
        const value = context[name];
        if (
          value !== null &&
          typeof value !== 'string' &&
          typeof value !== 'boolean' &&
          !(typeof value === 'number' && Number.isFinite(value))
        )
          throw new TypeError(
            `query context.${name} must be a finite JSON scalar`,
          );
        // Entry arrays retain names such as __proto__ that an object-based
        // TanStack hash can drop while rebuilding sorted object properties.
        // JSON hashing and hydration turn -0 into 0. Normalize the shared
        // snapshot so execute observes the same value represented by its key.
        return Object.freeze([name, value === 0 ? 0 : value] as const);
      }),
  );
}

export function queryNamespace(value: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new TypeError('query namespace must be a nonempty string');
  return value;
}

export function queryConfig(
  config: Readonly<{ namespace: string; execute: QueryExecutor }>,
) {
  const namespace = queryNamespace(config.namespace);
  const execute = config.execute;
  if (typeof execute !== 'function')
    throw new TypeError('query executor must be a function');
  return { namespace, execute };
}

type FactoryConfig = Readonly<{
  execute: QueryExecutor;
  namespace: string;
  client: string;
  // The emitter supplies identity without building a request with fake inputs.
  operationId: string;
}>;

interface ScopedOperationFilter<Prefix extends string> {
  readonly queryKey: readonly [Prefix, string, string, string];
  readonly predicate: NonNullable<QueryFilters['predicate']>;
}

function queryArguments(args: unknown) {
  const fields = dataRecord(args, 'query arguments');
  for (const name of Object.keys(fields))
    if (name !== 'context' && name !== 'input')
      throw new TypeError(`unknown query argument ${name}`);
  const context = cacheContext(fields['context']);
  return {
    input: fields['input'],
    context,
    executionContext: Object.freeze(Object.fromEntries(context)),
  };
}

function keyParts<Prefix extends string>(
  prefix: Prefix,
  namespace: string,
  client: string,
  operationId: string,
  context: ContextEntries,
  request: PreparedRequest<Responses, 'none'> | undefined,
): KeyParts<Prefix> {
  const headers = Object.freeze(
    Object.entries(request?.headers ?? {})
      .map(([name, value]) =>
        Object.freeze([name.toLowerCase(), value] as const),
      )
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  // Both URL and endpoint headers come from the validated initial request.
  // Transport state belongs in the explicit nonsecret context.
  return Object.freeze([
    prefix,
    namespace,
    client,
    operationId,
    context,
    request?.url ?? null,
    headers,
  ] as const);
}

async function executeRequest<R extends Responses>(
  request: PreparedRequest<R, 'none'>,
  execute: QueryExecutor,
  context: CacheContext,
  signal: AbortSignal,
  scope: ErrorScope,
): Promise<Success<R>> {
  throwIfAborted(signal);
  let observed: ObservedResponse;
  try {
    observed = await execute(request, Object.freeze({ signal, context }));
  } catch (error) {
    throwIfAborted(signal);
    throw error;
  }
  // Executors may ignore cancellation; never deliver their late result.
  throwIfAborted(signal);
  const result = request.parseResponse(observed);
  // Evidence getters may synchronously cancel while the parser snapshots them.
  throwIfAborted(signal);
  assertSuccess(result, scope);
  return result;
}

function createQueryFunction<
  R extends Responses,
  Execution extends Pick<QueryFunctionContext, 'signal' | 'queryKey'>,
>(
  queryKey: Execution['queryKey'],
  request: (execution: Execution) => PreparedRequest<R, 'none'>,
  execute: QueryExecutor,
  executionContext: CacheContext,
  scope: ErrorScope,
): (execution: Execution) => Promise<Success<R>> {
  const identity = JSON.stringify(queryKey);
  return async (execution) => {
    const { signal } = execution;
    throwIfAborted(signal);
    if (JSON.stringify(execution.queryKey) !== identity)
      throw new TypeError('query key does not match the prepared request');
    // Inspecting the key or assembling a page can synchronously abort. The
    // executor boundary checks again before invoking application transport.
    return executeRequest(
      request(execution),
      execute,
      executionContext,
      signal,
      scope,
    );
  };
}

function operationFilter<Prefix extends string>(
  prefix: Prefix,
  namespace: string,
  client: string,
  operationId: string,
  scope: OperationScope,
): ScopedOperationFilter<Prefix> {
  const fields = dataRecord(scope, 'query filter');
  const names = Object.keys(fields);
  if (
    names.length !== 1 ||
    (names[0] !== 'context' && names[0] !== 'allContexts') ||
    (names[0] === 'allContexts' && fields['allContexts'] !== true)
  )
    throw new TypeError(
      'query filter must specify context or allContexts: true',
    );
  const context =
    names[0] === 'context' ? cacheContext(fields['context']) : undefined;
  return Object.freeze({
    queryKey: Object.freeze([prefix, namespace, client, operationId] as const),
    // TanStack's partial key matching accepts context prefixes (including an
    // empty context). Compare complete canonical entries to avoid widening a
    // scope to extra fields; entry arrays also retain special property names.
    predicate: (query: Query) => {
      if (context === undefined) return true;
      const candidate: unknown = query.queryKey[4];
      if (!Array.isArray(candidate) || candidate.length !== context.length)
        return false;
      const entries: readonly unknown[] = candidate;
      return context.every(([name, value], index) => {
        const entry = entries[index];
        return (
          Array.isArray(entry) &&
          entry.length === 2 &&
          entry[0] === name &&
          entry[1] === value
        );
      });
    },
  });
}

export function defineQuery<Input, const R extends Responses>(
  config: FactoryConfig &
    Readonly<{
      operation: { build: (input: Input) => PreparedRequest<R, 'none'> };
    }>,
): QueryFactory<Input, R> {
  const { operation, execute, namespace, client, operationId } = config;
  const scope: ErrorScope = { operation, namespace, client, operationId };
  function prepare(args: Arguments<Input> | SkippedArguments) {
    const { input, context, executionContext } = queryArguments(args);
    // The conditional argument type permits omission only when Input includes
    // undefined. The operation builder validates JavaScript callers as well.
    const request =
      input === skipToken ? undefined : operation.build(input as Input);
    const key = keyParts(
      'pom-query-v1',
      namespace,
      client,
      operationId,
      context,
      request,
    ) as QueryKey<R>;
    return { request, key, context: executionContext };
  }

  function key(args: Arguments<Input>): QueryKey<R> {
    const prepared = prepare(args);
    if (!prepared.request) throw new TypeError('query keys require real input');
    return prepared.key;
  }

  function filter(scope: OperationScope): OperationFilter {
    return operationFilter(
      'pom-query-v1',
      namespace,
      client,
      operationId,
      scope,
    );
  }

  function options(args: Arguments<Input>): QueryOptions<R>;
  function options(
    args: Arguments<Input> | SkippedArguments,
  ): SkippableQueryOptions<R>;
  function options(
    args: Arguments<Input> | SkippedArguments,
  ): SkippableQueryOptions<R> {
    const { request, key: queryKey, context: executionContext } = prepare(args);
    return Object.freeze({
      queryKey,
      // Executors own retries, deadlines, and authentication recovery. A second
      // automatic retry loop would restart their complete attempt budget.
      retry: false as const,
      structuralSharing: shareQueryData,
      queryFn:
        request === undefined
          ? skipToken
          : createQueryFunction(
              queryKey,
              () => request,
              execute,
              executionContext,
              scope,
            ),
    });
  }
  return Object.freeze({
    key,
    options,
    filter,
    isError: operationErrorGuard<R>(scope),
  });
}

type Cursor = string | null;
type Pagination = string | number;
type PageParameter<P extends Pagination> = P extends number ? number : Cursor;
type InitialPageParameter<P extends Pagination> = P extends number ? 0 : null;
type InfinitePrefix<P extends Pagination> = P extends number
  ? 'pom-offset-v1'
  : 'pom-infinite-v1';

export interface InfiniteQueryKey<
  R extends Responses,
  P extends Pagination = string,
>
  extends
    KeyParts<InfinitePrefix<P>>,
    DataTag<unknown, InfiniteData<Success<R>, PageParameter<P>>> {}

export interface InfiniteOperationFilter<
  P extends Pagination = string,
> extends ScopedOperationFilter<InfinitePrefix<P>> {}

export interface SkippableInfiniteQueryOptions<
  R extends Responses,
  P extends Pagination = string,
> {
  readonly queryKey: InfiniteQueryKey<R, P>;
  readonly initialPageParam: InitialPageParameter<P>;
  readonly retry: false;
  readonly structuralSharing: typeof shareQueryData;
  readonly queryFn:
    | ((
        context: QueryFunctionContext<InfiniteQueryKey<R, P>, PageParameter<P>>,
      ) => Promise<Success<R>>)
    | SkipToken;
  readonly getNextPageParam: (
    lastPage: Success<R>,
    pages: Success<R>[],
    lastPageParam: PageParameter<P>,
    pageParams: PageParameter<P>[],
  ) => Exclude<PageParameter<P>, null> | undefined;
}

export interface InfiniteQueryOptions<
  R extends Responses,
  P extends Pagination = string,
> extends SkippableInfiniteQueryOptions<R, P> {
  readonly queryFn: (
    context: QueryFunctionContext<InfiniteQueryKey<R, P>, PageParameter<P>>,
  ) => Promise<Success<R>>;
}

export interface InfiniteQueryFactory<
  Input,
  R extends Responses,
  Item,
  P extends Pagination = string,
> {
  readonly isError: (error: unknown) => error is TypedQueryResponseError<R>;
  readonly key: (args: Arguments<Input>) => InfiniteQueryKey<R, P>;
  readonly options: {
    (args: Arguments<Input>): InfiniteQueryOptions<R, P>;
    (
      args: Arguments<Input> | SkippedArguments,
    ): SkippableInfiniteQueryOptions<R, P>;
  };
  readonly filter: (scope: OperationScope) => InfiniteOperationFilter<P>;
  readonly items: (
    data: InfiniteData<Success<R>, PageParameter<P>> | undefined,
  ) => Item[];
}

type OperationResponses<Operation> = Operation extends {
  build: (input: never) => PreparedRequest<infer R, 'none'>;
}
  ? R
  : never;
type PageItem<Page, Field extends string> = Page extends {
  data: Readonly<Record<Field, readonly (infer Item)[]>>;
}
  ? Item
  : never;
export type InfiniteQueryFactoryFor<
  Operation extends QueryOperation,
  Input,
  Field extends string,
  P extends Pagination = string,
> = InfiniteQueryFactory<
  Input,
  OperationResponses<Operation>,
  PageItem<Success<OperationResponses<Operation>>, Field>,
  P
>;

export function defineInfiniteQuery<
  O extends z.ZodType<RequestParts | undefined>,
  const R extends Responses,
  Items extends readonly unknown[],
>(
  config: FactoryConfig &
    Readonly<{
      operation: { build: (input: never) => PreparedRequest<R, 'none'> };
      input: O;
      cursor: string;
      nextCursor: (page: Success<R>) => Cursor;
      items: (page: Success<R>) => Items;
    }>,
): InfiniteQueryFactory<z.input<O>, R, Items[number]> {
  return infiniteFactory<O, R, Items, string>({
    ...config,
    parameter: config.cursor,
    prefix: 'pom-infinite-v1',
    initialPageParam: null,
    parsePageParam: (value) => {
      if (value !== null && typeof value !== 'string')
        throw new TypeError('page cursor must be a string or null');
      return value;
    },
    nextPageParam: (page) => config.nextCursor(page) ?? undefined,
  });
}

type OffsetPage<Items extends readonly unknown[]> = Readonly<{
  offset: number;
  limit: number;
  total: number;
  items: Items;
}>;
type OffsetFields = Readonly<
  Record<'offset' | 'limit' | 'total' | 'items', string>
>;

function offsetIssues(
  page: OffsetPage<readonly unknown[]>,
  expected: number,
  fields: OffsetFields,
): ProtocolIssue[] {
  const issues: ProtocolIssue[] = [];
  const issue = (field: keyof OffsetFields, message: string) => {
    issues.push({ part: 'body', path: [fields[field]], message });
  };
  for (const field of ['offset', 'limit', 'total'] as const)
    if (
      !Number.isSafeInteger(page[field]) ||
      page[field] < (field === 'limit' ? 1 : 0)
    )
      issue(
        field,
        `expected a ${field === 'limit' ? 'positive' : 'nonnegative'} safe integer`,
      );
  if (issues.length) return issues;
  if (page.offset !== expected)
    issue('offset', 'response offset does not match the requested page');
  if (page.items.length > page.limit)
    issue('items', 'returned item count exceeds the response limit');
  if (!Number.isSafeInteger(page.offset + page.items.length))
    issue('offset', 'next offset exceeds the safe integer range');
  return issues;
}

export function defineOffsetQuery<
  O extends z.ZodType<RequestParts | undefined>,
  const R extends Responses,
  Items extends readonly unknown[],
>(
  config: FactoryConfig &
    Readonly<{
      operation: { build: (input: never) => PreparedRequest<R, 'none'> };
      input: O;
      offset: string;
      fields: OffsetFields;
      page: (page: Success<R>) => OffsetPage<Items>;
    }>,
): InfiniteQueryFactory<z.input<O>, R, Items[number], number> {
  return infiniteFactory<O, R, Items, number>({
    ...config,
    parameter: config.offset,
    prefix: 'pom-offset-v1',
    initialPageParam: 0,
    parsePageParam: (value) => {
      if (
        typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < 0
      )
        throw new TypeError('page offset must be a nonnegative safe integer');
      return value === 0 ? 0 : value;
    },
    items: (page) => config.page(page).items,
    responseIssues: (page, offset) =>
      offsetIssues(config.page(page), offset, config.fields),
    nextPageParam: (page, offset) => {
      const data = config.page(page);
      // Metadata can also come from application cache updates. Recheck before
      // arithmetic; advancing from the response survives retained-page eviction.
      const issues = offsetIssues(data, offset, config.fields);
      if (issues.length)
        throw new TypeError(
          `invalid offset pagination metadata: ${issues.map((issue) => issue.message).join('; ')}`,
        );
      const next = data.offset + data.items.length;
      return data.items.length > 0 && next < data.total ? next : undefined;
    },
  });
}

function infiniteFactory<
  O extends z.ZodType<RequestParts | undefined>,
  const R extends Responses,
  Items extends readonly unknown[],
  P extends Pagination,
>(
  config: FactoryConfig &
    Readonly<{
      operation: { build: (input: never) => PreparedRequest<R, 'none'> };
      input: O;
      parameter: string;
      prefix: InfinitePrefix<P>;
      initialPageParam: InitialPageParameter<P>;
      parsePageParam: (value: unknown) => PageParameter<P>;
      nextPageParam: (
        page: Success<R>,
        parameter: PageParameter<P>,
      ) => Exclude<PageParameter<P>, null> | undefined;
      items: (page: Success<R>) => Items;
      responseIssues?: (
        page: Success<R>,
        parameter: PageParameter<P>,
      ) => readonly ProtocolIssue[];
    }>,
): InfiniteQueryFactory<z.input<O>, R, Items[number], P> {
  const scope: ErrorScope = {
    operation: config.operation,
    namespace: config.namespace,
    client: config.client,
    operationId: config.operationId,
  };
  // The emitter removes the pagination parameter from base inputs. Each page is
  // still passed through the ordinary builder, the authority for request types
  // and constraints (including literal parameter schemas).
  const build = config.operation.build as (
    input: unknown,
  ) => PreparedRequest<R, 'none'>;
  const responseIssues = config.responseIssues;
  function pageRequest(input: z.output<O>, parameter: unknown) {
    const value = config.parsePageParam(parameter);
    const request = build({
      ...input,
      query: {
        ...input?.query,
        ...(value === null ? {} : { [config.parameter]: value }),
      },
    });
    if (!responseIssues) return request;
    return Object.freeze({
      ...request,
      parseResponse: (observed: ObservedResponse): ProtocolResult<R> => {
        const result = request.parseResponse(observed);
        if (result.kind !== 'success') return result;
        // Responses is a generic status map; the discriminant proves success
        // even though TypeScript cannot reduce its conditional mapped union.
        const issues = responseIssues(result as Success<R>, value);
        if (!issues.length) return result;
        return Object.freeze({
          kind: 'protocol',
          operationId: result.operationId,
          status: result.status,
          headers: result.headers,
          validatedHeaders: result.validatedHeaders,
          issues: Object.freeze([...issues]),
        });
      },
    });
  }
  function prepare(args: Arguments<z.input<O>> | SkippedArguments) {
    const { input, context, executionContext } = queryArguments(args);
    let request: PreparedRequest<R, 'none'> | undefined;
    let fetchPage:
      | ((parameter: unknown) => PreparedRequest<R, 'none'>)
      | undefined;
    if (input !== skipToken) {
      const snapshot = validateOptions(config.input, input, config.operationId);
      const initial = pageRequest(snapshot, config.initialPageParam);
      request = initial;
      fetchPage = (parameter) =>
        Object.is(parameter, config.initialPageParam)
          ? initial
          : pageRequest(snapshot, parameter);
    }
    const key = keyParts(
      config.prefix,
      config.namespace,
      config.client,
      config.operationId,
      context,
      request,
    ) as InfiniteQueryKey<R, P>;
    return { fetchPage, key, executionContext };
  }
  function key(args: Arguments<z.input<O>>): InfiniteQueryKey<R, P> {
    const prepared = prepare(args);
    if (!prepared.fetchPage)
      throw new TypeError('query keys require real input');
    return prepared.key;
  }
  function options(args: Arguments<z.input<O>>): InfiniteQueryOptions<R, P>;
  function options(
    args: Arguments<z.input<O>> | SkippedArguments,
  ): SkippableInfiniteQueryOptions<R, P>;
  function options(
    args: Arguments<z.input<O>> | SkippedArguments,
  ): SkippableInfiniteQueryOptions<R, P> {
    const { fetchPage, key: queryKey, executionContext } = prepare(args);
    // Query Core installs its infinite-query behavior on this object before
    // copying options. Keep the outer container extensible; identities and the
    // captured input/context snapshots remain isolated from caller mutation.
    return {
      queryKey,
      initialPageParam: config.initialPageParam,
      retry: false,
      structuralSharing: shareQueryData,
      queryFn:
        fetchPage === undefined
          ? skipToken
          : createQueryFunction(
              queryKey,
              (
                context: QueryFunctionContext<
                  InfiniteQueryKey<R, P>,
                  PageParameter<P>
                >,
              ) => {
                if (context.direction === 'backward')
                  throw new TypeError('backward pagination is unsupported');
                return fetchPage(context.pageParam);
              },
              config.execute,
              executionContext,
              scope,
            ),
      getNextPageParam: (
        lastPage: Success<R>,
        _pages: Success<R>[],
        lastPageParam: PageParameter<P>,
        pageParams: PageParameter<P>[],
      ) => {
        const next = config.nextPageParam(lastPage, lastPageParam);
        // Empty strings are real cursors. Repeated retained cursors stop a
        // broken endpoint from appending the same page indefinitely.
        return next === undefined || pageParams.includes(next)
          ? undefined
          : next;
      },
    };
  }
  return Object.freeze({
    key,
    options,
    isError: operationErrorGuard<R>(scope),
    filter: (scope: OperationScope) =>
      operationFilter(
        config.prefix,
        config.namespace,
        config.client,
        config.operationId,
        scope,
      ),
    items: (
      data: InfiniteData<Success<R>, PageParameter<P>> | undefined,
    ): Items[number][] => {
      const items: Items[number][] = [];
      for (const page of data?.pages ?? [])
        for (const item of config.items(page)) items.push(item);
      return items;
    },
  });
}
