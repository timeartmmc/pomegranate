import { QueryClient } from '@tanstack/query-core';
import { useQuery } from '@tanstack/react-query';
import { createQueries } from './query-generated/client.consumer.queries.ts';
import { createQueries as createStaff } from './query-generated/client.staff.queries.ts';

const queries = createQueries({
  namespace: 'synthetic',
  execute: async () => ({ status: 200, headers: {}, body: '' }),
});
const args = {
  context: { session: 'public', locale: 'en' },
  input: { path: { id: 'item' } },
};
const client = new QueryClient();
const cached = client.getQueryData(queries.readItem.key(args));
if (cached) {
  const status: 200 = cached.status;
  const label: string = cached.data.label;
  void [status, label];
  // @ts-expect-error DataTag preserves the item response shape.
  void cached.data.reference;
}
queries.health.options({ context: {} });
queries.health.options({ context: {}, input: undefined });
// @ts-expect-error Required operation input cannot be omitted.
queries.readItem.options({ context: {} });
// @ts-expect-error Cache context must be explicit.
queries.readItem.options({ input: args.input });
// @ts-expect-error Path types remain generated from the operation.
queries.readItem.options({ context: {}, input: { path: { id: 7 } } });
queries.readItem.options({
  context: {},
  input: {
    path: { id: 'item' },
    headers: {
      // @ts-expect-error Transport-supplied headers cannot be supplied as endpoint input.
      'X-Language': 'en',
    },
  },
});
// @ts-expect-error Context contains scalar identity values, not mutable object graphs.
queries.health.key({ context: { session: { id: 'user' } } });
// @ts-expect-error The health query has no request body.
queries.health.options({ context: {}, input: { body: {} } });
const staffQueries = createStaff({
  namespace: 'staff',
  execute: async () => ({ status: 200, headers: {}, body: '' }),
});
// @ts-expect-error Query selection preserves client-surface isolation.
void staffQueries.readOutcome;

export function useSyntheticQuery() {
  const query = useQuery({
    ...queries.readItem.options(args),
    enabled: true,
    staleTime: 1000,
    select: (result) => result.data.label,
  });
  const label: string | undefined = query.data;
  void label;
  // @ts-expect-error The application select result is inferred.
  const invalid: number = query.data;
  void invalid;
  return query;
}

export async function exactStatus() {
  const result = await client.fetchQuery(
    queries.readOutcome.options({ context: {} }),
  );
  if (result.status === 202) {
    const reference: string = result.data.reference;
    void reference;
    // @ts-expect-error Other success statuses do not leak into the 202 response.
    void result.data.value;
  } else {
    const value: number = result.data.value;
    void value;
    // @ts-expect-error HTTP errors are rejected, not returned as success data.
    const errorStatus: 409 = result.status;
    void errorStatus;
  }
}
