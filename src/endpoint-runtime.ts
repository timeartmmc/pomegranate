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
import { defineOperation, ownFields } from './runtime.ts';
import type {
  ContentResponse,
  EmptyResponse,
  Parse,
  PreparedRequest,
  RequestParts,
  ResponseHeader,
  ResponseMedia,
  Responses,
} from './runtime.ts';

type BodyKind = PreparedRequest['bodyKind'];
type Definition<
  O extends RequestParts | undefined,
  R extends Responses,
  B extends BodyKind,
> = Parameters<typeof defineOperation<O, R, B>>[0];
type Headers = Responses[number]['headers'];
export type EndpointProfile = Pick<
  Definition<undefined, Responses, 'none'>,
  'security' | 'policy' | 'headers'
>;
type Settings<B extends BodyKind> = Pick<
  Definition<undefined, Responses, B>,
  'bodyKind' | 'contentType' | 'multipart'
> & {
  readonly parameters?: Definition<undefined, Responses, B>['parameters'];
};

// These are compiler-owned declarations. Preserve absent metadata slots before
// defaults, and pass parameter records to the existing normalizer exactly once.
export function endpoint<
  O extends RequestParts | undefined,
  R extends Responses,
  B extends BodyKind,
>(
  operationId: string,
  method: string,
  path: string,
  profile: EndpointProfile,
  options: Parse<O>,
  responses: R,
  settings: Settings<B>,
): ReturnType<typeof defineOperation<O, R, B>> {
  const shared = ownFields(profile);
  const metadata = ownFields(settings);
  return defineOperation<O, R, B>({
    operationId,
    method,
    path,
    security: shared.security,
    policy: shared.policy,
    headers: shared.headers,
    options,
    responses,
    bodyKind: metadata.bodyKind,
    parameters: metadata.parameters ?? [],
    ...(metadata.contentType === undefined
      ? {}
      : { contentType: metadata.contentType }),
    ...(metadata.multipart === undefined
      ? {}
      : { multipart: metadata.multipart }),
  });
}

export type JsonResponse<
  P extends Parse<unknown>,
  H extends Headers = {},
> = ContentResponse<{ readonly 'application/json': ResponseMedia<P> }, H>;
export type ResponseStatuses<
  S extends number,
  Entry extends Responses[number],
> = Readonly<Record<S, Entry>>;

export function jsonResponse<P extends Parse<unknown>>(
  schema: P,
): JsonResponse<P> {
  return {
    bodyKind: 'content',
    headers: {},
    content: { 'application/json': { bodyKind: 'json', schema } },
  };
}
export function jsonHeaders<P extends Parse<unknown>, H extends Headers>(
  schema: P,
  headers: H,
): JsonResponse<P, H> {
  return {
    bodyKind: 'content',
    headers,
    content: { 'application/json': { bodyKind: 'json', schema } },
  };
}
export function emptyResponse(): EmptyResponse {
  return { bodyKind: 'none', headers: {} };
}
export function emptyHeaders<H extends Headers>(headers: H): EmptyResponse<H> {
  return { bodyKind: 'none', headers };
}
export function requiredHeader<P extends Parse<string>>(
  schema: P,
): ResponseHeader<P, true> {
  return { schema, required: true };
}
export function optionalHeader<P extends Parse<string>>(
  schema: P,
): ResponseHeader<P> {
  return { schema, required: false };
}

// The emitter supplies exact own data maps partitioned into non-2xx and 2xx
// statuses. The constraint also rejects visible overlap; structural TS types
// alone cannot establish closed runtime key sets for arbitrary external maps.
export function mergeResponses<
  E extends Responses,
  S extends Responses & Partial<Record<keyof E, never>>,
>(errors: E, success: S): E & S {
  return { ...errors, ...success };
}
