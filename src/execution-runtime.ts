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
import type {
  DeclaredResponse,
  ObservedResponse,
  PreparedRequest,
  ProtocolFailure,
  ProtocolIssue,
  ProtocolResult,
  Responses,
} from './runtime.ts';

export type ExecutionContext = Readonly<
  Record<string, string | number | boolean | null>
>;
export type ContextEntries = readonly (readonly [
  string,
  ExecutionContext[string],
])[];
type Inspection<Value> = Value extends object
  ? { readonly [Key in keyof Value]: Inspection<Value[Key]> }
  : Value;
export type ResponseInspection<R extends Responses = Responses> = Inspection<
  ProtocolResult<R>
>;
declare const receipt: unique symbol;
// Direct handle annotations distinguish validated inspections from public parser
// results. Executors carry this distinction through V; runtime provenance still
// comes only from the invocation's identity map, never this type-only marker.
export type ValidatedResponse<R extends Responses = Responses> =
  ResponseInspection<R> & Readonly<{ [receipt]: true }>;

export type Execution<
  R extends Responses = Responses,
  V extends ResponseInspection<R> = ResponseInspection<R>,
> = Readonly<{
  signal: AbortSignal;
  context: ExecutionContext;
  validateResponse: (observed: ObservedResponse) => V;
}>;

// The caller supplies the receipt type, so one adapter works across independent
// generated outputs without importing their private brands. The unbranded
// Execution default also preserves explicitly annotated raw adapters.
// P lets a shared adapter accept the policy vocabularies of several outputs;
// the default retains this output's exact declaration in factory callbacks.
export type Executor<P = PreparedRequest['policy']> = <
  R extends Responses,
  V extends ResponseInspection<R>,
>(
  request: PreparedRequest<R, PreparedRequest['bodyKind'], unknown, P>,
  execution: Execution<R, V>,
) => Promise<ObservedResponse | V>;
export type CancellationEvent = Readonly<{
  namespace: string;
  client: string;
  operationId: string;
  context: ExecutionContext;
  reason: unknown;
  executorInvoked: boolean;
  rejection?: Readonly<{ error: unknown }>;
}>;
export type CancellationMapper = (
  event: CancellationEvent,
) => Readonly<{ error: unknown }>;
export type ClientConfig = Readonly<{
  namespace: string;
  execute: Executor;
  mapCancellation?: CancellationMapper;
}>;

export type Success<R extends Responses> = DeclaredResponse<R> &
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

export type ErrorScope<R extends Responses = Responses> = Readonly<{
  operation: Readonly<{
    parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
  }>;
  namespace: string;
  client: string;
  operationId: string;
}>;
const responseErrors = new WeakMap<
  object,
  Readonly<{ scope: ErrorScope; result: Failure }>
>();

export function operationErrorGuard<R extends Responses>(scope: ErrorScope<R>) {
  const identity = { ...scope };
  return (error: unknown): error is TypedQueryResponseError<R> => {
    if (error === null || typeof error !== 'object') return false;
    const origin = responseErrors.get(error);
    if (
      !origin ||
      origin.scope.operation !== identity.operation ||
      origin.scope.namespace !== identity.namespace ||
      origin.scope.client !== identity.client ||
      origin.scope.operationId !== identity.operationId
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

function throwIfAborted(signal: AbortSignal, aborted: boolean): void {
  if (!aborted) return;
  // oxlint-disable-next-line typescript/only-throw-error -- AbortSignal reasons can be any value; cancellation preserves them exactly.
  throw cancellationReason(signal);
}

function cancellationReason(signal: AbortSignal): unknown {
  // Native polyfills may lack throwIfAborted and reason. Keep a defined
  // cancellation reason verbatim and supply a portable error only if absent.
  const reason: unknown = 'reason' in signal ? signal.reason : undefined;
  if (reason !== undefined) return reason;
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

type CancellationScope = Pick<
  ErrorScope,
  'namespace' | 'client' | 'operationId'
>;
type Rejection = Readonly<{ error: unknown }>;

function cancelExecution(
  signal: AbortSignal,
  context: ExecutionContext,
  scope: CancellationScope,
  executorInvoked: boolean,
  mapCancellation: CancellationMapper | undefined,
  rejection?: Rejection,
): never {
  const reason = cancellationReason(signal);
  let error = reason;
  if (mapCancellation) {
    const event: CancellationEvent = Object.freeze({
      namespace: scope.namespace,
      client: scope.client,
      operationId: scope.operationId,
      context,
      reason,
      executorInvoked,
      ...(rejection ? { rejection: Object.freeze(rejection) } : {}),
    });
    const result = dataRecord(
      mapCancellation(event),
      'cancellation mapper result',
    );
    if (Object.keys(result).length !== 1 || !Object.hasOwn(result, 'error'))
      throw new TypeError(
        'cancellation mapper must return exactly one error field',
      );
    error = result['error'];
  }
  // oxlint-disable-next-line typescript/only-throw-error -- The mapper and AbortSignal may deliberately supply any thrown value.
  throw error;
}

// Direct-call builders and query guards run before there is a prepared request.
// Keep their cancellation exit identical to execution, without catching and
// remapping an exception from the mapper itself.
export function prepareExecution<Value>(
  prepare: () => Value,
  signal: AbortSignal,
  context: ExecutionContext,
  scope: CancellationScope,
  mapCancellation?: CancellationMapper,
): Value {
  if (signal.aborted)
    cancelExecution(signal, context, scope, false, mapCancellation);
  let value!: Value;
  let rejection: Rejection | undefined;
  try {
    value = prepare();
  } catch (error) {
    rejection = { error };
  }
  if (signal.aborted)
    cancelExecution(signal, context, scope, false, mapCancellation, rejection);
  if (rejection) {
    // oxlint-disable-next-line typescript/only-throw-error -- Application failures retain their original thrown value.
    throw rejection.error;
  }
  return value;
}

export function dataRecord(
  value: unknown,
  location: string,
): Record<string, unknown> {
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

export function contextEntries(
  input: unknown,
  location: string,
): ContextEntries {
  const context = dataRecord(input, location);
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
            `${location}.${name} must be a finite JSON scalar`,
          );
        // Entry arrays retain names such as __proto__ that an object-based
        // TanStack hash can drop while rebuilding sorted object properties.
        // JSON hashing and hydration turn -0 into 0. Normalize the shared
        // snapshot so execute observes the same value represented by its key.
        return Object.freeze([name, value === 0 ? 0 : value] as const);
      }),
  );
}

// Only generated, validated JSON and issue paths enter this copier. A frame per
// open container avoids a JS call-stack limit; own-data construction preserves
// map keys such as __proto__. Freeze on frame exit while still inside the
// application's validation budget. The saved response stays privately mutable.
function inspectionCopy(input: unknown): unknown {
  type Frame = {
    target: object;
    entries: Iterator<readonly [string, unknown]>;
  };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [
    { target: root, entries: [['value', input] as const].values() },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const entry = frame.entries.next();
    if (entry.done) {
      Object.freeze(frame.target);
      stack.pop();
      continue;
    }
    const [key, value] = entry.value;
    let copy = value;
    if (value !== null && typeof value === 'object') {
      copy = Array.isArray(value) ? [] : {};
      stack.push({
        target: copy as object,
        entries: Object.entries(value).values(),
      });
    }
    // Existing names can include __proto__ or an application-installed inherited
    // setter. Assignment is safe only for absent keys on these fresh containers.
    if (key in frame.target)
      Object.defineProperty(frame.target, key, {
        value: copy,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    else (frame.target as Record<string, unknown>)[key] = copy;
  }
  return root['value'];
}

function inspectResponse<R extends Responses>(
  result: ProtocolResult<R>,
): ValidatedResponse<R> {
  // Header records are already immutable. Every other mutable descendant is
  // copied before the result crosses into application recovery code.
  return Object.freeze(
    result.kind === 'protocol'
      ? { ...result, issues: inspectionCopy(result.issues) }
      : { ...result, data: inspectionCopy(result.data) },
  ) as ValidatedResponse<R>;
}

export async function executeRequest<
  R extends Responses,
  B extends PreparedRequest['bodyKind'],
>(
  request: PreparedRequest<R, B>,
  execute: (
    request: PreparedRequest<R, B>,
    execution: Execution<R, ValidatedResponse<R>>,
  ) => Promise<ObservedResponse | ValidatedResponse<R>>,
  context: ExecutionContext,
  signal: AbortSignal,
  scope: ErrorScope<R>,
  responseIssues?: (page: Success<R>) => readonly ProtocolIssue[],
  mapCancellation?: CancellationMapper,
): Promise<Success<R>> {
  let identity = scope;
  // Platform signals are monotonic. Latch observations so a nonconforming
  // polyfill cannot skip validation and later reopen the success path.
  let aborted = false;
  const isAborted = (): boolean => (aborted ||= signal.aborted);
  if (isAborted())
    cancelExecution(signal, context, identity, false, mapCancellation);
  let accepting = true;
  let executorInvoked = false;
  // Raw executors never use receipt tracking. Allocate it only on inspection.
  let accepted: WeakMap<object, ProtocolResult<R>> | undefined;
  let inspected: WeakSet<object> | undefined;
  // An unassigned result exits below through a latched abort or rejection.
  let success!: Success<R>;
  let rejection: Rejection | undefined;
  try {
    identity = { ...scope };
    // Capture the function as well as its owner: aliases cannot replace a parser
    // while application transport is awaiting an attempt or recovery.
    const parseResponse = identity.operation.parseResponse;
    const interpret = (observed: ObservedResponse): ProtocolResult<R> => {
      const result = parseResponse(observed);
      if (isAborted() || isFailure(result)) return result;
      const issues = responseIssues?.(result as Success<R>);
      return issues?.length
        ? Object.freeze({
            kind: 'protocol',
            operationId: result.operationId,
            status: result.status,
            headers: result.headers,
            validatedHeaders: result.validatedHeaders,
            issues: Object.freeze([...issues]),
          })
        : result;
    };
    const validateResponse = (
      observed: ObservedResponse,
    ): ValidatedResponse<R> => {
      throwIfAborted(signal, isAborted());
      if (!accepting)
        throw new TypeError('response validation invocation has completed');
      if (observed === null || typeof observed !== 'object')
        throw new TypeError('response evidence must be an object');
      if (inspected?.has(observed))
        throw new TypeError(
          'response evidence was already validated; use a fresh evidence object',
        );
      (inspected ??= new WeakSet()).add(observed);
      const result = interpret(observed);
      throwIfAborted(signal, isAborted());
      const validated = inspectResponse(result);
      (accepted ??= new WeakMap()).set(validated, result);
      return validated;
    };
    // Scope/parser getters can abort while being captured above.
    throwIfAborted(signal, isAborted());
    let returned: ObservedResponse | ValidatedResponse<R>;
    try {
      executorInvoked = true;
      returned = await execute(
        request,
        Object.freeze({ signal, context, validateResponse }),
      );
    } finally {
      // Close before consuming even a rejected executor outcome.
      accepting = false;
    }
    if (!isAborted()) {
      let result: ProtocolResult<R>;
      if (
        returned !== null &&
        typeof returned === 'object' &&
        accepted?.has(returned)
      )
        result = accepted.get(returned)!;
      else {
        if (returned !== null && typeof returned === 'object') {
          if (inspected?.has(returned))
            throw new TypeError(
              'return the validated response instead of already inspected raw evidence',
            );
          if (Object.hasOwn(returned, 'kind') && !('body' in returned))
            throw new TypeError(
              'validated response must belong to this invocation',
            );
        }
        // Public tags and extra transport metadata never attest parsed data.
        result = interpret(returned as ObservedResponse);
      }
      if (!isAborted()) {
        assertSuccess(result, identity);
        success = result;
      }
    }
  } catch (error) {
    rejection = { error };
  } finally {
    accepting = false;
    // A retained expired callback must not retain saved response trees.
    accepted = undefined;
    inspected = undefined;
  }
  // Mapper failures are outside the catch and therefore cannot be mapped twice.
  if (isAborted())
    cancelExecution(
      signal,
      context,
      identity,
      executorInvoked,
      mapCancellation,
      rejection,
    );
  if (rejection) {
    // oxlint-disable-next-line typescript/only-throw-error -- Preserve application rejection identity, including non-Error values.
    throw rejection.error;
  }
  return success;
}

// Keep the existing query constructor (including its name and instanceof) while
// exposing a transport-neutral spelling for direct calls. Both share provenance.
export { QueryResponseError as ResponseError };
export type { TypedQueryResponseError as TypedResponseError };

export type InputArguments<Input> = Readonly<{ context: ExecutionContext }> &
  (undefined extends Input
    ? Readonly<{ input?: Input }>
    : Readonly<{ input: Input }>);
export function executionConfig<Execute extends (...args: never[]) => unknown>(
  config: Readonly<{
    namespace: string;
    execute: Execute;
    mapCancellation?: CancellationMapper;
  }>,
  label = 'execution',
): {
  namespace: string;
  execute: Execute;
  mapCancellation?: CancellationMapper;
} {
  const { namespace, execute, mapCancellation } = config;
  if (typeof namespace !== 'string' || namespace.length === 0)
    throw new TypeError(`${label} namespace must be a nonempty string`);
  if (typeof execute !== 'function')
    throw new TypeError(`${label} executor must be a function`);
  if (mapCancellation !== undefined && typeof mapCancellation !== 'function')
    throw new TypeError(`${label} cancellation mapper must be a function`);
  return {
    namespace,
    execute,
    ...(mapCancellation ? { mapCancellation } : {}),
  };
}
