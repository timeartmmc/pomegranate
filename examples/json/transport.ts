import type {
  PreparedRequest,
  ProtocolResult,
  Responses,
  Executor,
  ObservedResponse,
} from './generated/client.consumer.js';

// This is application code. POM never calls fetch or resolves tokens/providers.
export async function execute<R extends Responses>(
  request: PreparedRequest<R, 'none' | 'json'>,
  send: typeof fetch,
  tokenFor: (authLabel: string) => Promise<string>,
  baseUrl: string | URL,
): Promise<ProtocolResult<R>> {
  return request.parseResponse(
    await executeRaw(
      request,
      { signal: new AbortController().signal, context: {} },
      send,
      tokenFor,
      baseUrl,
    ),
  );
}

export function createExecutor(
  send: typeof fetch,
  tokenFor: (authLabel: string) => Promise<string>,
  baseUrl: string | URL,
): Executor {
  return (request, execution) =>
    executeRaw(request, execution, send, tokenFor, baseUrl);
}

// Existing parsed callers and executable clients share this raw boundary. A
// final success body is read here and parsed once by the generated caller.
async function executeRaw(
  request: PreparedRequest,
  execution: Pick<Parameters<Executor>[1], 'signal' | 'context'>,
  send: typeof fetch,
  tokenFor: (authLabel: string) => Promise<string>,
  baseUrl: string | URL,
): Promise<ObservedResponse> {
  if (request.bodyKind !== 'none' && request.bodyKind !== 'json')
    throw new Error(
      'The JSON example transport does not support multipart uploads',
    );
  if (
    request.policy.retry !== 'never' ||
    request.policy.timeout !== 'interactive'
  ) {
    throw new Error('The example transport does not implement this policy');
  }
  const authHeaders: Record<string, string> = {};
  if (request.security.transport === 'bearer') {
    const token = await tokenFor(request.policy.auth);
    if (!token)
      throw new Error('The example transport requires a bearer token');
    authHeaders['Authorization'] = `Bearer ${token}`;
  }
  // Append the contract path to the selected server's base path. Assign only
  // pathname so encoded path data stays separate from the request's query.
  const server = new URL(baseUrl);
  const url = new URL(request.url, server);
  url.pathname = `${server.pathname.replace(/\/$/, '')}${url.pathname}`;
  const response = await send(url, {
    method: request.method,
    signal: execution.signal,
    headers: request.validateHeaders({
      ...request.headers,
      ...authHeaders,
      Accept: 'application/json',
      ...(request.bodyKind === 'json'
        ? { 'Content-Type': 'application/json' }
        : {}),
    }),
    ...(request.bodyKind === 'json'
      ? { body: JSON.stringify(request.body) }
      : {}),
    redirect: 'error',
  });
  const headers: [string, string][] = [];
  response.headers.forEach((value, name) => {
    headers.push([name, value]);
  });
  return {
    status: response.status,
    headers: Object.fromEntries(headers),
    body: await response.text(),
  };
}
