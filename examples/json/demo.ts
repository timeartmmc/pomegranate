import { operations } from './generated/client.consumer.js';
import { execute } from './transport.js';

const request = operations.prepareWidget.build({
  path: { widgetId: 'demo/widget' },
  headers: { 'Idempotency-Key': 'demo-attempt-1' },
  body: { acknowledged: true, label: 'Example widget' },
});

// An injected response keeps the example local and deterministic.
const result = await execute(
  request,
  async (_url, options) => {
    if (
      new Headers(options?.headers).get('Authorization') !==
      'Bearer synthetic-token'
    )
      throw new Error(
        'The application transport did not apply bearer credentials',
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
  async (label) => {
    if (label !== 'session') throw new Error('Unknown example auth label');
    return 'synthetic-token';
  },
  'https://example.invalid',
);

if (result.kind !== 'success' || result.status !== 202)
  throw new Error('Expected a pending preparation');
console.log(
  `${request.method} ${request.url} → ${result.status} ${result.data.reference}`,
);
