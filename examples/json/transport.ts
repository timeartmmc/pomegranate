import type {
  PreparedRequest,
  ProtocolResult,
  Responses,
} from './generated/client.consumer.js';

// This is application code. POM never calls fetch or resolves tokens/providers.
export async function execute<R extends Responses>(
  request: PreparedRequest<R, 'none' | 'json'>,
  send: typeof fetch,
  tokenFor: (authLabel: string) => Promise<string>,
  baseUrl: string | URL,
): Promise<ProtocolResult<R>> {
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
  if (request.policy.auth.transport === 'bearer') {
    const token = await tokenFor(request.policy.auth.label);
    if (!token)
      throw new Error('The example transport requires a bearer token');
    authHeaders['Authorization'] = `Bearer ${token}`;
  }
  // Generated paths are root-relative. An explicit application origin makes
  // the same transport usable by Node fetch and browser fetch.
  const response = await send(new URL(request.url, baseUrl), {
    method: request.method,
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
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return request.parseResponse({
    status: response.status,
    headers,
    body: await response.text(),
  });
}
