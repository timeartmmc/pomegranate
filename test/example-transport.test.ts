import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createClient,
  operations,
} from '../examples/json/generated/client.consumer.ts';
import { createExecutor, execute } from '../examples/json/transport.ts';

const widgetId = 'a/b?c#d%';
const contractPath = '/api/widgets/a%2Fb%3Fc%23d%25?limit=3';

for (const [baseUrl, basePath] of [
  ['https://example.invalid', ''],
  ['https://example.invalid/', ''],
  ['https://example.invalid/v1', '/v1'],
  ['https://example.invalid/v1/', '/v1'],
  [
    new URL('https://example.invalid/v1/nested?old=value#old-fragment'),
    '/v1/nested',
  ],
  [
    new URL('https://example.invalid/v1%3Fpreview%23tag/'),
    '/v1%3Fpreview%23tag',
  ],
] satisfies [string | URL, string][]) {
  void test(`example transports append contract paths to server ${String(baseUrl)}`, async () => {
    const before = String(baseUrl);
    const sent: string[] = [];
    const send: typeof fetch = async (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      sent.push(url.href);
      assert.equal(options?.method, 'GET');
      assert.equal(
        new Headers(options?.headers).get('Authorization'),
        'Bearer synthetic-token',
      );
      return new Response(JSON.stringify({ id: widgetId, label: 'Widget' }), {
        headers: { 'Content-Type': 'application/json' },
      });
    };
    const tokenFor = async (label: string) => {
      assert.equal(label, 'session');
      return 'synthetic-token';
    };
    const input = { path: { widgetId }, query: { limit: 3 } };
    const parsed = await execute(
      operations.getWidget.build(input),
      send,
      tokenFor,
      baseUrl,
    );
    assert.equal(parsed.kind, 'success');
    assert.deepEqual(parsed.data, { id: widgetId, label: 'Widget' });
    const client = createClient({
      namespace: 'example-transport',
      execute: createExecutor(send, tokenFor, baseUrl),
    });
    const result = await client.getWidget.call({ context: {}, input });
    assert.deepEqual(result.data, { id: widgetId, label: 'Widget' });
    const expected = `https://example.invalid${basePath}${contractPath}`;
    assert.deepEqual(sent, [expected, expected]);
    assert.equal(String(baseUrl), before);
  });
}

void test('example transports clear server query and fragment when the contract has no query', async () => {
  const sent: string[] = [];
  const send: typeof fetch = async (input) => {
    sent.push(new URL(input instanceof Request ? input.url : input).href);
    return new Response(null, { status: 204 });
  };
  const tokenFor = async () =>
    assert.fail('public requests do not resolve tokens');
  const baseUrl = new URL('https://example.invalid/v1/?old=value#fragment');
  const parsed = await execute(
    operations.checkHealth.build(),
    send,
    tokenFor,
    baseUrl,
  );
  assert.equal(parsed.kind, 'success');
  const client = createClient({
    namespace: 'example-transport',
    execute: createExecutor(send, tokenFor, baseUrl),
  });
  assert.equal((await client.checkHealth.call({ context: {} })).status, 204);
  assert.deepEqual(sent, [
    'https://example.invalid/v1/api/health',
    'https://example.invalid/v1/api/health',
  ]);
});
