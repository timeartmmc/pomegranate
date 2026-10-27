import { dehydrate } from '@tanstack/query-core';
import type { DehydratedState, QueryClient } from '@tanstack/query-core';
import { json } from './assertions.ts';

export function dehydrateJson(client: QueryClient): DehydratedState {
  // These synthetic caches contain JSON-compatible payloads. Serialization
  // preserves TanStack's state containers and omits optional undefined fields;
  // callers verify the hydrated keys and values after this round trip.
  return json(JSON.stringify(dehydrate(client))) as DehydratedState;
}
