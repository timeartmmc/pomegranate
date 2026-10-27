import { QueryClient, skipToken } from '@tanstack/query-core';
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
const skipped = queries.readItem.options({ context: {}, input: skipToken });
const skippedData = client.getQueryData(skipped.queryKey);
if (skippedData) {
  const label: string = skippedData.data.label;
  void label;
  // @ts-expect-error Skipping retains the operation response, not any data.
  void skippedData.data.reference;
}
client.invalidateQueries(queries.readItem.filter({ context: {} }));
client.invalidateQueries(queries.readItem.filter({ allContexts: true }));
// @ts-expect-error Context stays explicit when skipping.
queries.readItem.options({ input: skipToken });
// @ts-expect-error Only the actual TanStack skip token bypasses input validation.
queries.readItem.options({ context: {}, input: Symbol() });
// @ts-expect-error A key describes a validated real request.
queries.readItem.key({ context: {}, input: skipToken });
// @ts-expect-error A filter requires an explicit scope.
queries.readItem.filter();
// @ts-expect-error Cross-context matching must be explicit.
queries.readItem.filter({});
// @ts-expect-error Exact and cross-context scopes are mutually exclusive.
queries.readItem.filter({ context: {}, allContexts: true });
// @ts-expect-error Context values are scalars for filters too.
queries.readItem.filter({ context: { tenant: [] } });
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

export function useWaitingQuery(id: string | undefined) {
  const options = queries.readItem.options({
    context: { session: 'public' },
    input: id === undefined ? skipToken : { path: { id } },
  });
  const query = useQuery({ ...options, select: (result) => result.data.label });
  const label: string | undefined = query.data;
  void label;
  // @ts-expect-error Union options still infer the select result.
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

export function typedQueryError(error: unknown) {
  if (!queries.readItem.isError(error)) return;
  if (error.result.kind === 'protocol') {
    const status: number = error.result.status;
    void status;
    // @ts-expect-error Protocol failures never expose validated body data.
    void error.result.data;
  } else if (error.result.status === 404) {
    const detail: string = error.result.data.detail;
    void detail;
    // @ts-expect-error The declared 404 body is not an item response.
    void error.result.data.label;
  } else {
    const status: 410 = error.result.status;
    const data: undefined = error.result.data;
    void [status, data];
  }
}
