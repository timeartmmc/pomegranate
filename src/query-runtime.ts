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
import type { DataTag, QueryFunctionContext } from '@tanstack/query-core';
import type {
  DeclaredResponse,
  ObservedResponse,
  PreparedRequest,
  ProtocolFailure,
  ProtocolResult,
  Responses,
} from './runtime.js';

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
type Failure =
  | ProtocolFailure
  | (DeclaredResponse<Responses> & { kind: 'error' });

export class QueryResponseError extends Error {
  readonly result: Failure;

  constructor(result: Failure) {
    super(`${result.operationId}: ${result.kind} response (${result.status})`);
    this.name = 'QueryResponseError';
    this.result = result;
  }
}

function assertSuccess<R extends Responses>(
  result: ProtocolResult<R>,
): asserts result is Success<R> {
  if (result.kind === 'protocol') throw new QueryResponseError(result);
  if (result.kind === 'error')
    throw new QueryResponseError({ ...result, kind: 'error' });
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

type Key<R extends Responses> = DataTag<
  readonly [
    'pom-query-v1',
    string,
    string,
    string,
    ContextEntries,
    string,
    readonly (readonly [string, string])[],
  ],
  Success<R>,
  Error
>;

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

export function defineQuery<Input, const R extends Responses>(
  operation: { build: (input: Input) => PreparedRequest<R, 'none'> },
  execute: QueryExecutor,
  namespace: string,
  client: string,
) {
  function prepare(args: Arguments<Input>) {
    const fields = dataRecord(args, 'query arguments');
    for (const name of Object.keys(fields))
      if (name !== 'context' && name !== 'input')
        throw new TypeError(`unknown query argument ${name}`);
    const context = cacheContext(fields['context']);
    const executionContext = Object.freeze(Object.fromEntries(context));
    // The conditional argument type permits omission only when Input includes
    // undefined. The operation builder validates JavaScript callers as well.
    const request = operation.build(fields['input'] as Input);
    const headers = Object.freeze(
      Object.entries(request.headers)
        .map(([name, value]) =>
          Object.freeze([name.toLowerCase(), value] as const),
        )
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
    );
    // URL and endpoint headers come from this same validated request snapshot.
    // Transport headers are deliberately absent; applications must represent all
    // response-changing transport state with explicit, nonsecret cache context.
    const key = Object.freeze([
      'pom-query-v1',
      namespace,
      client,
      request.operationId,
      context,
      request.url,
      headers,
    ] as const) as Key<R>;
    return { request, key, context: executionContext };
  }

  function key(args: Arguments<Input>): Key<R> {
    return prepare(args).key;
  }

  function options(args: Arguments<Input>) {
    const { request, key: queryKey, context: executionContext } = prepare(args);
    const identity = JSON.stringify(queryKey);
    return Object.freeze({
      queryKey,
      // Executors own retries, deadlines, and authentication recovery. A second
      // automatic retry loop would restart their complete attempt budget.
      retry: false as const,
      // TanStack's default structural sharing rebuilds objects by assignment.
      // That can drop legal map keys or reject constructor:null on refetch.
      // Keep the complete value that passed the generated response validator.
      structuralSharing: false as const,
      queryFn: async (
        context: QueryFunctionContext<Key<R>>,
      ): Promise<Success<R>> => {
        const { signal } = context;
        throwIfAborted(signal);
        if (JSON.stringify(context.queryKey) !== identity)
          throw new TypeError('query key does not match the prepared request');
        let observed: ObservedResponse;
        try {
          observed = await execute(
            request,
            Object.freeze({ signal, context: executionContext }),
          );
        } catch (error) {
          throwIfAborted(signal);
          throw error;
        }
        // Executors can ignore cancellation. Never deliver their late result.
        throwIfAborted(signal);
        const result = request.parseResponse(observed);
        assertSuccess(result);
        // Returning the envelope also represents bodyless success without the
        // undefined query data forbidden by TanStack. Status narrowing survives.
        return result;
      },
    });
  }
  return Object.freeze({ key, options });
}
