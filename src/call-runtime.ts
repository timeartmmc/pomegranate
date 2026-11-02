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
  ObservedResponse,
  PreparedRequest,
  ProtocolResult,
  Responses,
} from './runtime.ts';
import {
  contextEntries,
  dataRecord,
  executeRequest,
  operationErrorGuard,
  prepareExecution,
} from './execution-runtime.ts';
import type {
  ClientConfig,
  ErrorScope,
  InputArguments,
  Success,
  TypedQueryResponseError,
} from './execution-runtime.ts';

// Default-signal construction belongs only to direct calls. Query-only output
// receives signals from its caller and must not require AbortController.
export type CallArguments<Input> = InputArguments<Input> &
  Readonly<{ signal?: AbortSignal }>;

export interface OperationCall<Input, R extends Responses> {
  readonly call: (args: CallArguments<Input>) => Promise<Success<R>>;
  readonly isError: (error: unknown) => error is TypedQueryResponseError<R>;
}

type ExecutableOperation = Readonly<{
  build: (input: never) => PreparedRequest;
}>;
export type ExecutionClient<
  Operations extends Readonly<Record<string, ExecutableOperation>>,
> = Readonly<{
  [Name in keyof Operations]: Operations[Name] extends {
    build: (input: infer Input) => PreparedRequest<infer R>;
  }
    ? OperationCall<Input, R>
    : never;
}>;

function callSignal(value: unknown): AbortSignal {
  if (value === undefined) return new AbortController().signal;
  // Accept platform AbortSignal implementations, including native polyfills.
  if (
    value === null ||
    typeof value !== 'object' ||
    !('aborted' in value) ||
    typeof value.aborted !== 'boolean' ||
    !('addEventListener' in value) ||
    typeof value.addEventListener !== 'function' ||
    !('removeEventListener' in value) ||
    typeof value.removeEventListener !== 'function'
  )
    throw new TypeError('call signal must be an AbortSignal');
  // The platform owns the remaining EventTarget surface. No instanceof check
  // can recognize every cross-realm signal or native implementation.
  return value as AbortSignal;
}

export function defineCall<Input, const R extends Responses>(
  config: ClientConfig &
    Readonly<{
      operation: {
        build: (input: Input) => PreparedRequest<R>;
        parseResponse: (response: ObservedResponse) => ProtocolResult<R>;
      };
      client: string;
      operationId: string;
    }>,
): OperationCall<Input, R> {
  const {
    operation,
    namespace,
    execute,
    client,
    operationId,
    mapCancellation,
  } = config;
  const scope: ErrorScope<R> = { operation, namespace, client, operationId };
  return Object.freeze({
    isError: operationErrorGuard<R>(scope),
    call: async (args: CallArguments<Input>): Promise<Success<R>> => {
      const fields = dataRecord(args, 'call arguments');
      for (const name of Object.keys(fields))
        if (name !== 'context' && name !== 'input' && name !== 'signal')
          throw new TypeError(`unknown call argument ${name}`);
      const context = Object.freeze(
        Object.fromEntries(
          contextEntries(fields['context'], 'execution context'),
        ),
      );
      const signal = callSignal(fields['signal']);
      // Build synchronously before yielding: the parser snapshots JSON and native file
      // references, and browser File bytes are immutable. No caller state is
      // reread when application transport later runs recovery or retries.
      const request = prepareExecution(
        () => operation.build(fields['input'] as Input),
        signal,
        context,
        scope,
        mapCancellation,
      );
      return executeRequest(
        request,
        execute,
        context,
        signal,
        scope,
        undefined,
        mapCancellation,
      );
    },
  });
}
