import { createClient } from './.generated/serialization/client.consumer.ts';
import type { Executor } from './.generated/serialization/client.consumer.ts';

export async function runSerializationBrowser() {
  const execute: Executor = async (request, execution) => {
    const response = await fetch(request.url, {
      method: request.method,
      signal: execution.signal,
      headers: request.validateHeaders({
        ...request.headers,
        ...(request.bodyKind === 'form'
          ? { 'Content-Type': request.contentType }
          : {}),
      }),
      ...(request.bodyKind === 'form' ? { body: request.body } : {}),
    });
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    };
  };
  const client = createClient({ namespace: 'serialization-browser', execute });
  const headers = await client.headers.call({
    context: {},
    input: {
      headers: {
        'X-Count': 2,
        'X-Enabled': false,
        'X-Values': [0.5, 1],
        'X-Labels': ['a', 'b'],
      },
    },
  });
  const form = await client.submit.call({
    context: {},
    input: {
      body: {
        name: 'demo + 🌱',
        count: 0,
        enabled: false,
        tags: ['a,b', 'c d'],
        ids: [1, 2],
        csvTags: ['alpha,beta', 'c d'],
        note: 'a\nb',
      },
    },
  });
  const omitted = await client.optionalForm.call({ context: {} });
  return {
    statuses: [headers.status, form.status, omitted.status],
    count: headers.validatedHeaders['x-count'],
  };
}
