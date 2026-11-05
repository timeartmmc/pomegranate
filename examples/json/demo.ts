import { QueryClient } from '@tanstack/query-core';
import { createClient } from './generated/client.consumer.js';
import { createQueries } from './generated/client.consumer.queries.js';
import { createExecutor } from './transport.js';

// An injected response keeps the example local and deterministic.
let sent = '';
const execute = createExecutor(
  async (_url, options) => {
    if (
      new Headers(options?.headers).get('Authorization') !==
      'Bearer synthetic-token'
    )
      throw new Error(
        'The application transport did not apply bearer credentials',
      );
    const url = new URL(_url instanceof Request ? _url.url : _url);
    sent = `${options?.method} ${url.pathname}`;
    if (options?.method === 'GET')
      return new Response(
        JSON.stringify({ id: 'demo/widget', label: 'Example widget' }),
        { headers: { 'Content-Type': 'application/json' } },
      );
    return new Response(
      JSON.stringify({ state: 'pending', reference: 'synthetic-123' }),
      {
        status: 202,
        headers: {
          'Content-Type': 'application/json',
          'X-Request-ID': 'example-request',
        },
      },
    );
  },
  async (scheme, label) => {
    if (scheme !== 'WidgetSession' || label !== 'session')
      throw new Error('Unknown example bearer scheme or auth label');
    return 'synthetic-token';
  },
  'https://example.invalid',
);

const runtime = { namespace: 'synthetic-widgets-v1', execute };
const client = createClient(runtime);
const queries = createQueries(runtime);
const context = { sessionRevision: 'demo-one', locale: 'en' };
const cache = new QueryClient();
try {
  await client.getWidget.call({
    context,
    input: { path: { widgetId: 'demo/widget' } },
  });
  await cache.fetchQuery(
    queries.getWidget.options({
      context,
      input: { path: { widgetId: 'demo/widget' } },
    }),
  );
} finally {
  cache.clear();
}
const result = await client.prepareWidget.call({
  context,
  input: {
    path: { widgetId: 'demo/widget' },
    headers: { 'Idempotency-Key': 'demo-attempt-1' },
    body: { acknowledged: true, label: 'Example widget' },
  },
});
if (result.status !== 202) throw new Error('Expected a pending preparation');
console.log(`${sent} → ${result.status} ${result.data.reference}`);
