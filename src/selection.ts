import {
  fail,
  keys,
  record,
  stringArray,
  text,
  validHeaderName,
} from './diagnostics.js';
import type { Direction, InfiniteQueryBinding } from './model.js';
import { surfaceNames } from './policy.js';

export type CompileOptions = Readonly<{
  clients: readonly string[];
  transportHeaders?: readonly string[];
  targets?: Readonly<Record<string, 'browser' | 'native'>>;
  queries?: Readonly<Record<string, readonly string[]>>;
  infiniteQueries?: Readonly<
    Record<string, Readonly<Record<string, InfiniteQueryBinding>>>
  >;
  standalone?: Readonly<
    Record<string, { readonly schema: string; readonly usage: Direction }>
  >;
}>;
export const selectionKeys = [
  'clients',
  'transportHeaders',
  'standalone',
  'targets',
  'queries',
  'infiniteQueries',
] as const;
export type RootSelection = Readonly<{
  name: string;
  schema: string;
  usage: Direction;
}>;
export type Selection = Readonly<{
  clients: readonly string[];
  transportHeaders: readonly string[];
  targets: Readonly<Record<string, 'browser' | 'native'>>;
  queries: Readonly<Record<string, readonly string[]>>;
  infiniteQueries: Readonly<
    Record<string, Readonly<Record<string, InfiniteQueryBinding>>>
  >;
  standalone: readonly RootSelection[];
}>;

function standaloneSelections(input: unknown = {}): readonly RootSelection[] {
  const selections = record(input, 'standalone');
  const names = Object.keys(selections);
  if (names.length === 0) return [];
  surfaceNames(names, 'standalone');
  return names.sort().map((name) => {
    const location = `standalone.${name}`;
    const value = record(selections[name], location);
    keys(value, ['schema', 'usage'], location);
    if (value.usage !== 'request' && value.usage !== 'response')
      fail(`${location}.usage`, 'expected request or response');
    return {
      name,
      schema: text(value.schema, `${location}.schema`),
      usage: value.usage,
    };
  });
}

export function parseSelection(value: Record<string, unknown>): Selection {
  // File configuration and programmatic options share this boundary. Projection
  // receives typed selections, rather than positional unknowns and mode flags.
  const standalone = standaloneSelections(value.standalone);
  const clients =
    standalone.length > 0 &&
    Array.isArray(value.clients) &&
    value.clients.length === 0
      ? []
      : surfaceNames(value.clients, 'clients');
  const headerInput =
    value.transportHeaders === undefined ? [] : value.transportHeaders;
  if (
    !stringArray(headerInput) ||
    headerInput.some((name) => !validHeaderName(name))
  )
    fail('transportHeaders', 'expected an array of declared header names');
  const transportHeaders = headerInput.map((name) => name.toLowerCase());
  if (new Set(transportHeaders).size !== transportHeaders.length)
    fail('transportHeaders', 'duplicate case-insensitive header');
  const rawTargets = record(
    value.targets === undefined ? {} : value.targets,
    'targets',
  );
  const targets = Object.fromEntries(
    Object.entries(rawTargets).map(
      ([name, target]): [string, 'browser' | 'native'] => {
        if (!clients.includes(name))
          fail(`targets.${name}`, 'target must name a selected client');
        if (target !== 'browser' && target !== 'native')
          fail(`targets.${name}`, 'expected browser or native');
        return [name, target];
      },
    ),
  );
  const rawQueries = record(
    value.queries === undefined ? {} : value.queries,
    'queries',
  );
  const queries = Object.fromEntries(
    Object.entries(rawQueries).map(([name, operations]) => {
      const location = `queries.${name}`;
      if (!clients.includes(name))
        fail(location, 'queries must name a selected client');
      if (!stringArray(operations) || operations.length === 0)
        fail(location, 'expected a nonempty array of operation identifiers');
      if (new Set(operations).size !== operations.length)
        fail(location, 'duplicate query operation');
      return [name, [...operations].sort()];
    }),
  );
  const rawInfinite = record(
    value.infiniteQueries === undefined ? {} : value.infiniteQueries,
    'infiniteQueries',
  );
  const infiniteQueries = Object.fromEntries(
    Object.keys(rawInfinite)
      .sort()
      .map((name) => {
        const location = `infiniteQueries.${name}`;
        if (!clients.includes(name))
          fail(location, 'infinite queries must name a selected client');
        const operations = record(rawInfinite[name], location);
        if (Object.keys(operations).length === 0)
          fail(location, 'expected at least one infinite query');
        return [
          name,
          Object.fromEntries(
            Object.keys(operations)
              .sort()
              .map((id) => {
                const path = `${location}.${id}`;
                const binding = record(operations[id], path);
                keys(binding, ['cursor', 'nextCursor', 'items'], path);
                return [
                  id,
                  {
                    cursor: text(binding.cursor, `${path}.cursor`),
                    nextCursor: text(binding.nextCursor, `${path}.nextCursor`),
                    items: text(binding.items, `${path}.items`),
                  },
                ];
              }),
          ),
        ];
      }),
  );
  return {
    clients,
    transportHeaders,
    targets,
    standalone,
    queries,
    infiniteQueries,
  };
}
