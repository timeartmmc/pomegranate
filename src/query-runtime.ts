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
  ObservedResponse,
  PreparedRequest,
  ProtocolResult,
  Responses,
  RequestParts,
  ProtocolIssue,
} from './runtime.ts';
import { validateOptions } from './runtime.ts';
import type { Parse } from './runtime.ts';
import { shareQueryData } from './query-sharing.ts';

import {
  contextEntries,
  dataRecord,
  executionConfig,
  executeRequest,
  operationErrorGuard,
  prepareExecution,
} from './execution-runtime.ts';
import type {
  ContextEntries,
  CancellationMapper,
  ErrorScope,
  Execution,
  ExecutionContext,
  ResponseInspection,
  InputArguments,
  Success,
  TypedQueryResponseError,
} from './execution-runtime.ts';
export { QueryResponseError } from './execution-runtime.ts';
export type { TypedQueryResponseError } from './execution-runtime.ts';

export type CacheContext = ExecutionContext;
export type {
  CancellationEvent,
  CancellationMapper,
  Execution,
  ResponseInspection,
  ValidatedResponse,
} from './execution-runtime.ts';
// The bodyless contract remains assignable from an executor supporting all body
// kinds; existing bodyless-only query executors need no change.
export type QueryExecutor = <
  R extends Responses,
  V extends ResponseInspection<R>,
>(
  request: PreparedRequest<R, 'none'>,
  execution: Execution<R, V>,
) => Promise<ObservedResponse | V>;

export type QueryConfig = Readonly<{
  namespace: string;
  execute: QueryExecutor;
  mapCancellation?: CancellationMapper;
}>;

type Arguments<Input> = InputArguments<Input>;
type SkippedArguments = Readonly<{ context: CacheContext; input: SkipToken }>;

type OperationScope =
  | Readonly<{ context: CacheContext; allContexts?: never }>
  | Readonly<{ allContexts: true; context?: never }>;

const cachePrefixes = {
  ordinary: { envelope: 'pom-query-v1', body: 'pom-query-body-v1' },
  cursor: { envelope: 'pom-infinite-v1', body: 'pom-infinite-body-v1' },
  offset: { envelope: 'pom-offset-v1', body: 'pom-offset-body-v1' },
} as const;
export type CacheRepresentation = 'envelope' | 'body';
export type Body<R extends Responses> = Success<R>['data'];
export type QueryValue<
  R extends Responses,
  M extends CacheRepresentation = 'envelope',
> = M extends 'body' ? Body<R> : Success<R>;
type QueryPrefix<M extends CacheRepresentation> =
  (typeof cachePrefixes)['ordinary'][M];

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
export interface QueryKey<
  R extends Responses,
  M extends CacheRepresentation = 'envelope',
>
  extends KeyParts<QueryPrefix<M>>, DataTag<unknown, QueryValue<R, M>> {}

export interface SkippableQueryOptions<
  R extends Responses,
  M extends CacheRepresentation = 'envelope',
> {
  readonly queryKey: QueryKey<R, M>;
  readonly retry: false;
  readonly structuralSharing: typeof shareQueryData;
  readonly queryFn:
    | ((
        context: QueryFunctionContext<QueryKey<R, M>>,
      ) => Promise<QueryValue<R, M>>)
    | SkipToken;
}

export interface QueryOptions<
  R extends Responses,
  M extends CacheRepresentation = 'envelope',
> extends SkippableQueryOptions<R, M> {
  readonly queryFn: (
    context: QueryFunctionContext<QueryKey<R, M>>,
  ) => Promise<QueryValue<R, M>>;
}

export interface OperationFilter<
  M extends CacheRepresentation = 'envelope',
> extends ScopedOperationFilter<QueryPrefix<M>> {}

export interface QueryFactory<
  Input,
  R extends Responses,
  M extends CacheRepresentation = 'envelope',
> {
  readonly isError: (error: unknown) => error is TypedQueryResponseError<R>;
  readonly key: (args: Arguments<Input>) => QueryKey<R, M>;
  readonly options: {
    (args: Arguments<Input>): QueryOptions<R, M>;
    (args: Arguments<Input> | SkippedArguments): SkippableQueryOptions<R, M>;
  };
  readonly invalidationFilter: (
    scope: OperationScope,
  ) => OperationInvalidationFilter;
  readonly filter: (scope: OperationScope) => OperationFilter<M>;
  readonly body: undefined extends Body<R>
    ? never
    : () => QueryFactory<Input, R, 'body'>;
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

export function queryConfig(
  config: QueryConfig,
): ReturnType<typeof executionConfig<QueryExecutor>> {
  return executionConfig(config, 'query');
}

type FactoryConfig = Readonly<{
  execute: QueryExecutor;
  namespace: string;
  client: string;
  // The emitter supplies identity without building a request with fake inputs.
  operationId: string;
  mapCancellation?: CancellationMapper;
  bodyCache?: boolean;
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
  const context = contextEntries(fields['context'], 'query context');
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

function createQueryFunction<
  R extends Responses,
  Execution extends Pick<QueryFunctionContext, 'signal' | 'queryKey'>,
  M extends CacheRepresentation,
>(
  queryKey: Execution['queryKey'],
  prepare: (execution: Execution) => PreparedQuery<R>,
  execute: QueryExecutor,
  executionContext: CacheContext,
  scope: ErrorScope<R>,
  representation: M,
  mapCancellation?: CancellationMapper,
): (execution: Execution) => Promise<QueryValue<R, M>> {
  const identity = JSON.stringify(queryKey);
  return async (execution) => {
    const { signal } = execution;
    const { request, responseIssues } = prepareExecution(
      () => {
        if (JSON.stringify(execution.queryKey) !== identity)
          throw new TypeError('query key does not match the prepared request');
        return prepare(execution);
      },
      signal,
      executionContext,
      scope,
      mapCancellation,
    );
    const result = await executeRequest(
      request,
      execute,
      executionContext,
      signal,
      scope,
      responseIssues,
      mapCancellation,
    );
    if (representation === 'body' && result.data === undefined)
      throw new TypeError('body query cannot cache undefined response data');
    return queryValue(result, representation);
  };
}

// Conditional types preserve each cache's public DataTag. These two private
// adapters implement the corresponding projection after complete validation.
function queryValue<R extends Responses, M extends CacheRepresentation>(
  page: Success<R>,
  representation: M,
): QueryValue<R, M> {
  return (representation === 'body' ? page.data : page) as QueryValue<R, M>;
}

function responseBody<R extends Responses, M extends CacheRepresentation>(
  page: QueryValue<R, M>,
  representation: M,
): Body<R> {
  return (
    representation === 'body' ? page : (page as Success<R>).data
  ) as Body<R>;
}

type PreparedQuery<R extends Responses> = Readonly<{
  request: PreparedRequest<R, 'none'>;
  responseIssues?: (page: Success<R>) => readonly ProtocolIssue[];
}>;

export interface OperationInvalidationFilter {
  readonly predicate: NonNullable<QueryFilters['predicate']>;
}

const cacheFamilies = new Set<string>(
  Object.values(cachePrefixes).flatMap((profile) => Object.values(profile)),
);

function canonicalEntries(
  value: unknown,
  validValue: (item: unknown) => boolean,
): boolean {
  if (!Array.isArray(value)) return false;
  let previous: string | undefined;
  for (const entry of value as readonly unknown[]) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== 'string' ||
      (previous !== undefined && entry[0] <= previous) ||
      !validValue(entry[1])
    )
      return false;
    previous = entry[0];
  }
  return true;
}

function canonicalContext(value: unknown): boolean {
  return canonicalEntries(
    value,
    (item) =>
      item === null ||
      typeof item === 'string' ||
      typeof item === 'boolean' ||
      (typeof item === 'number' &&
        Number.isFinite(item) &&
        !Object.is(item, -0)),
  );
}

function supportedCacheKey(key: readonly unknown[]): boolean {
  return (
    key.length === 7 &&
    typeof key[0] === 'string' &&
    cacheFamilies.has(key[0]) &&
    canonicalContext(key[4]) &&
    (key[5] === null || typeof key[5] === 'string') &&
    canonicalEntries(key[6], (item) => typeof item === 'string')
  );
}

function operationInvalidationFilter(
  namespace: string,
  client: string,
  operationId: string,
  scope: OperationScope,
): OperationInvalidationFilter {
  const matchesContext = contextPredicate(scope);
  return Object.freeze({
    predicate: (query: Query) => {
      const key = query.queryKey;
      return (
        key[1] === namespace &&
        key[2] === client &&
        key[3] === operationId &&
        supportedCacheKey(key) &&
        matchesContext(query)
      );
    },
  });
}

function operationFilter<Prefix extends string>(
  prefix: Prefix,
  namespace: string,
  client: string,
  operationId: string,
  scope: OperationScope,
): ScopedOperationFilter<Prefix> {
  return Object.freeze({
    queryKey: Object.freeze([prefix, namespace, client, operationId] as const),
    predicate: contextPredicate(scope),
  });
}

function contextPredicate(
  scope: OperationScope,
): NonNullable<QueryFilters['predicate']> {
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
    names[0] === 'context'
      ? contextEntries(fields['context'], 'query context')
      : undefined;
  // TanStack's partial key matching accepts context prefixes (including an
  // empty context). Compare complete canonical entries to avoid widening a
  // scope to extra fields; entry arrays also retain special property names.
  return (query: Query) => {
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
  };
}

export function defineQuery<Input, const R extends Responses>(
  config: FactoryConfig &
    Readonly<{
      operation: {
        build: (input: Input) => PreparedRequest<R, 'none'>;
        parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
      };
    }>,
): QueryFactory<Input, R> {
  return queryFactory(config, 'envelope');
}

function queryFactory<
  Input,
  R extends Responses,
  M extends CacheRepresentation,
>(
  config: FactoryConfig &
    Readonly<{
      operation: {
        build: (input: Input) => PreparedRequest<R, 'none'>;
        parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
      };
    }>,
  representation: M,
): QueryFactory<Input, R, M> {
  const { operation, execute, namespace, client, operationId } = config;
  const scope: ErrorScope<R> = { operation, namespace, client, operationId };
  const prefix = cachePrefixes.ordinary[representation];
  let bodyFactory: QueryFactory<Input, R, 'body'> | undefined;
  function prepare(args: Arguments<Input> | SkippedArguments) {
    const { input, context, executionContext } = queryArguments(args);
    // The conditional argument type permits omission only when Input includes
    // undefined. The operation builder validates JavaScript callers as well.
    const request =
      input === skipToken ? undefined : operation.build(input as Input);
    const key = keyParts(
      prefix,
      namespace,
      client,
      operationId,
      context,
      request,
    ) as QueryKey<R, M>;
    return { request, key, context: executionContext };
  }

  function key(args: Arguments<Input>): QueryKey<R, M> {
    const prepared = prepare(args);
    if (!prepared.request) throw new TypeError('query keys require real input');
    return prepared.key;
  }

  function filter(scope: OperationScope): OperationFilter<M> {
    return operationFilter(prefix, namespace, client, operationId, scope);
  }

  function options(args: Arguments<Input>): QueryOptions<R, M>;
  function options(
    args: Arguments<Input> | SkippedArguments,
  ): SkippableQueryOptions<R, M>;
  function options(
    args: Arguments<Input> | SkippedArguments,
  ): SkippableQueryOptions<R, M> {
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
              () => ({ request }),
              execute,
              executionContext,
              scope,
              representation,
              config.mapCancellation,
            ),
    });
  }
  const factory: QueryFactory<Input, R, M> = Object.freeze({
    key,
    options,
    filter,
    invalidationFilter: (scope: OperationScope) =>
      operationInvalidationFilter(namespace, client, operationId, scope),
    isError: operationErrorGuard<R>(scope),
    body: (() => {
      if (!config.bodyCache)
        throw new TypeError(
          `${operationId} has a bodyless success; use an envelope query`,
        );
      if (representation === 'body')
        return factory as unknown as QueryFactory<Input, R, 'body'>;
      return (bodyFactory ??= queryFactory(config, 'body'));
    }) as QueryFactory<Input, R, M>['body'],
  });
  return factory;
}

type Cursor = string | null;
type Pagination = string | number;
type PageParameter<P extends Pagination> = P extends number ? number : Cursor;
type InitialPageParameter<P extends Pagination> = P extends number ? 0 : null;
type InfinitePrefix<
  P extends Pagination,
  M extends CacheRepresentation = 'envelope',
> = (typeof cachePrefixes)[P extends number ? 'offset' : 'cursor'][M];

export interface InfiniteQueryKey<
  R extends Responses,
  P extends Pagination = string,
  M extends CacheRepresentation = 'envelope',
>
  extends
    KeyParts<InfinitePrefix<P, M>>,
    DataTag<unknown, InfiniteData<QueryValue<R, M>, PageParameter<P>>> {}

export interface InfiniteOperationFilter<
  P extends Pagination = string,
  M extends CacheRepresentation = 'envelope',
> extends ScopedOperationFilter<InfinitePrefix<P, M>> {}

export interface SkippableInfiniteQueryOptions<
  R extends Responses,
  P extends Pagination = string,
  M extends CacheRepresentation = 'envelope',
> {
  readonly queryKey: InfiniteQueryKey<R, P, M>;
  readonly initialPageParam: InitialPageParameter<P>;
  readonly retry: false;
  readonly structuralSharing: typeof shareQueryData;
  readonly queryFn:
    | ((
        context: QueryFunctionContext<
          InfiniteQueryKey<R, P, M>,
          PageParameter<P>
        >,
      ) => Promise<QueryValue<R, M>>)
    | SkipToken;
  readonly getNextPageParam: (
    lastPage: QueryValue<R, M>,
    pages: QueryValue<R, M>[],
    lastPageParam: PageParameter<P>,
    pageParams: PageParameter<P>[],
  ) => Exclude<PageParameter<P>, null> | undefined;
}

export interface InfiniteQueryOptions<
  R extends Responses,
  P extends Pagination = string,
  M extends CacheRepresentation = 'envelope',
> extends SkippableInfiniteQueryOptions<R, P, M> {
  readonly queryFn: (
    context: QueryFunctionContext<InfiniteQueryKey<R, P, M>, PageParameter<P>>,
  ) => Promise<QueryValue<R, M>>;
}

export interface InfiniteQueryFactory<
  Input,
  R extends Responses,
  Item,
  P extends Pagination = string,
  M extends CacheRepresentation = 'envelope',
> {
  readonly isError: (error: unknown) => error is TypedQueryResponseError<R>;
  readonly key: (args: Arguments<Input>) => InfiniteQueryKey<R, P, M>;
  readonly options: {
    (args: Arguments<Input>): InfiniteQueryOptions<R, P, M>;
    (
      args: Arguments<Input> | SkippedArguments,
    ): SkippableInfiniteQueryOptions<R, P, M>;
  };
  readonly invalidationFilter: (
    scope: OperationScope,
  ) => OperationInvalidationFilter;
  readonly filter: (scope: OperationScope) => InfiniteOperationFilter<P, M>;
  readonly items: (
    data: InfiniteData<QueryValue<R, M>, PageParameter<P>> | undefined,
  ) => Item[];
  readonly body: undefined extends Body<R>
    ? never
    : () => InfiniteQueryFactory<Input, R, Item, P, 'body'>;
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
  O extends RequestParts | undefined,
  const R extends Responses,
  Items extends readonly unknown[],
>(
  config: FactoryConfig &
    Readonly<{
      operation: {
        build: (input: never) => PreparedRequest<R, 'none'>;
        parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
      };
      input: Parse<O>;
      cursor: string;
      nextCursor: (page: Body<R>) => Cursor;
      items: (page: Body<R>) => Items;
    }>,
): InfiniteQueryFactory<O, R, Items[number]> {
  return infiniteFactory<O, R, Items, string, 'envelope'>(
    {
      ...config,
      parameter: config.cursor,
      profile: 'cursor',
      initialPageParam: null,
      parsePageParam: (value) => {
        if (value !== null && typeof value !== 'string')
          throw new TypeError('page cursor must be a string or null');
        return value;
      },
      nextPageParam: (page) => config.nextCursor(page) ?? undefined,
    },
    'envelope',
  );
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
  O extends RequestParts | undefined,
  const R extends Responses,
  Items extends readonly unknown[],
>(
  config: FactoryConfig &
    Readonly<{
      operation: {
        build: (input: never) => PreparedRequest<R, 'none'>;
        parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
      };
      input: Parse<O>;
      offset: string;
      fields: OffsetFields;
      page: (page: Body<R>) => OffsetPage<Items>;
    }>,
): InfiniteQueryFactory<O, R, Items[number], number> {
  return infiniteFactory<O, R, Items, number, 'envelope'>(
    {
      ...config,
      parameter: config.offset,
      profile: 'offset',
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
    },
    'envelope',
  );
}

function infiniteFactory<
  O extends RequestParts | undefined,
  const R extends Responses,
  Items extends readonly unknown[],
  P extends Pagination,
  M extends CacheRepresentation,
>(
  config: FactoryConfig &
    Readonly<{
      operation: {
        build: (input: never) => PreparedRequest<R, 'none'>;
        parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
      };
      input: Parse<O>;
      parameter: string;
      profile: P extends number ? 'offset' : 'cursor';
      initialPageParam: InitialPageParameter<P>;
      parsePageParam: (value: unknown) => PageParameter<P>;
      nextPageParam: (
        page: Body<R>,
        parameter: PageParameter<P>,
      ) => Exclude<PageParameter<P>, null> | undefined;
      items: (page: Body<R>) => Items;
      responseIssues?: (
        page: Body<R>,
        parameter: PageParameter<P>,
      ) => readonly ProtocolIssue[];
    }>,
  representation: M,
): InfiniteQueryFactory<O, R, Items[number], P, M> {
  let bodyFactory:
    | InfiniteQueryFactory<O, R, Items[number], P, 'body'>
    | undefined;
  const prefix = cachePrefixes[config.profile][
    representation
  ] as InfinitePrefix<P, M>;
  const scope: ErrorScope<R> = {
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
  function pageRequest(input: O, parameter: unknown): PreparedQuery<R> {
    const value = config.parsePageParam(parameter);
    const request = build({
      ...input,
      query: {
        ...input?.query,
        ...(value === null ? {} : { [config.parameter]: value }),
      },
    });
    return {
      request,
      ...(responseIssues
        ? {
            responseIssues: (page: Success<R>) =>
              responseIssues(page.data, value),
          }
        : {}),
    };
  }
  function prepare(args: Arguments<O> | SkippedArguments) {
    const { input, context, executionContext } = queryArguments(args);
    let request: PreparedRequest<R, 'none'> | undefined;
    let fetchPage: ((parameter: unknown) => PreparedQuery<R>) | undefined;
    if (input !== skipToken) {
      const snapshot = validateOptions(config.input, input, config.operationId);
      const initial = pageRequest(snapshot, config.initialPageParam);
      request = initial.request;
      fetchPage = (parameter) =>
        Object.is(parameter, config.initialPageParam)
          ? initial
          : pageRequest(snapshot, parameter);
    }
    const key = keyParts(
      prefix,
      config.namespace,
      config.client,
      config.operationId,
      context,
      request,
    ) as InfiniteQueryKey<R, P, M>;
    return { fetchPage, key, executionContext };
  }
  function key(args: Arguments<O>): InfiniteQueryKey<R, P, M> {
    const prepared = prepare(args);
    if (!prepared.fetchPage)
      throw new TypeError('query keys require real input');
    return prepared.key;
  }
  function options(args: Arguments<O>): InfiniteQueryOptions<R, P, M>;
  function options(
    args: Arguments<O> | SkippedArguments,
  ): SkippableInfiniteQueryOptions<R, P, M>;
  function options(
    args: Arguments<O> | SkippedArguments,
  ): SkippableInfiniteQueryOptions<R, P, M> {
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
                  InfiniteQueryKey<R, P, M>,
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
              representation,
              config.mapCancellation,
            ),
      getNextPageParam: (
        lastPage: QueryValue<R, M>,
        _pages: QueryValue<R, M>[],
        lastPageParam: PageParameter<P>,
        pageParams: PageParameter<P>[],
      ) => {
        const next = config.nextPageParam(
          responseBody(lastPage, representation),
          lastPageParam,
        );
        // Empty strings are real cursors. Repeated retained cursors stop a
        // broken endpoint from appending the same page indefinitely.
        return next === undefined || pageParams.includes(next)
          ? undefined
          : next;
      },
    };
  }
  const factory: InfiniteQueryFactory<O, R, Items[number], P, M> =
    Object.freeze({
      key,
      options,
      isError: operationErrorGuard<R>(scope),
      invalidationFilter: (scope: OperationScope) =>
        operationInvalidationFilter(
          config.namespace,
          config.client,
          config.operationId,
          scope,
        ),
      filter: (scope: OperationScope) =>
        operationFilter(
          prefix,
          config.namespace,
          config.client,
          config.operationId,
          scope,
        ),
      items: (
        data: InfiniteData<QueryValue<R, M>, PageParameter<P>> | undefined,
      ): Items[number][] => {
        const items: Items[number][] = [];
        for (const page of data?.pages ?? [])
          for (const item of config.items(responseBody(page, representation)))
            items.push(item);
        return items;
      },
      body: (() => {
        if (!config.bodyCache)
          throw new TypeError(
            `${config.operationId} has a bodyless success; use an envelope query`,
          );
        if (representation === 'body')
          return factory as unknown as InfiniteQueryFactory<
            O,
            R,
            Items[number],
            P,
            'body'
          >;
        return (bodyFactory ??= infiniteFactory(config, 'body'));
      }) as InfiniteQueryFactory<O, R, Items[number], P, M>['body'],
    });
  return factory;
}
