import {
  fail,
  keys,
  record,
  stringArray,
  text,
  validHeaderName,
} from './diagnostics.js';
import type {
  Direction,
  InfiniteQueryBinding,
  InfiniteQueryBindingInput,
} from './model.js';
import { surfaceNames } from './policy.js';

export type CompileOptions = Readonly<{
  clients: readonly string[];
  recursiveWorkLimit?: number;
  formats?: Readonly<
    Record<string, Readonly<{ type: 'string'; pattern: string }>>
  >;
  ignoreExtensions?: readonly string[];
  surfaces?: Readonly<Record<string, readonly string[]>>;
  executionClients?: readonly string[];
  transportHeaders?: readonly string[];
  targets?: Readonly<Record<string, 'browser' | 'native'>>;
  queries?: Readonly<Record<string, readonly string[]>>;
  infiniteQueries?: Readonly<
    Record<string, Readonly<Record<string, InfiniteQueryBindingInput>>>
  >;
  standalone?: Readonly<
    Record<string, { readonly schema: string; readonly usage: Direction }>
  >;
}>;
export const selectionKeys = [
  'clients',
  'recursiveWorkLimit',
  'formats',
  'ignoreExtensions',
  'surfaces',
  'executionClients',
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
  recursiveWorkLimit: number | undefined;
  executionClients: readonly string[];
  transportHeaders: readonly string[];
  targets: ReadonlyMap<string, 'browser' | 'native'>;
  queries: ReadonlyMap<string, readonly string[]>;
  infiniteQueries: ReadonlyMap<
    string,
    ReadonlyMap<string, InfiniteQueryBinding>
  >;
  standalone: readonly RootSelection[];
}>;

export function parseIgnoredExtensions(
  input: unknown = [],
): ReadonlySet<string> {
  if (!stringArray(input))
    fail('ignoreExtensions', 'expected an array of exact x- extension names');
  const names = new Set<string>();
  for (const [index, name] of input.entries()) {
    const location = `ignoreExtensions[${index}]`;
    if (
      !name.startsWith('x-') ||
      name.length === 2 ||
      ['*', '?', '[', ']', '{', '}'].some((character) =>
        name.includes(character),
      )
    )
      fail(location, 'expected an exact x- extension name without wildcards');
    if (name === 'x-pom' || name === 'x-pom-policy')
      fail(location, 'POM extensions x-pom and x-pom-policy cannot be ignored');
    if (names.has(name))
      fail(location, `duplicate extension name ${JSON.stringify(name)}`);
    names.add(name);
  }
  return names;
}

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

export function parseSelection(input: unknown): Selection {
  const value = record(input, 'compile options');
  const recursiveWorkLimit = value.recursiveWorkLimit;
  if (
    recursiveWorkLimit !== undefined &&
    (typeof recursiveWorkLimit !== 'number' ||
      !Number.isSafeInteger(recursiveWorkLimit) ||
      recursiveWorkLimit <= 0)
  )
    fail('recursiveWorkLimit', 'expected a positive safe integer');
  // File configuration and programmatic options share this boundary. Projection
  // receives typed selections, rather than positional unknowns and mode flags.
  // Config memberships were consumed by the complete descriptor before selection.
  const standalone = standaloneSelections(value.standalone);
  const clients =
    standalone.length > 0 &&
    Array.isArray(value.clients) &&
    value.clients.length === 0
      ? []
      : surfaceNames(value.clients, 'clients');
  const executionClients =
    value.executionClients === undefined ||
    (Array.isArray(value.executionClients) &&
      value.executionClients.length === 0)
      ? []
      : surfaceNames(value.executionClients, 'executionClients');
  for (const name of executionClients)
    if (!clients.includes(name))
      fail(
        'executionClients',
        `execution client ${JSON.stringify(name)} must name a selected client`,
      );
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
  const targets = new Map(
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
  const queries = new Map(
    Object.entries(rawQueries).map(
      ([name, operations]): [string, readonly string[]] => {
        const location = `queries.${name}`;
        if (!clients.includes(name))
          fail(location, 'queries must name a selected client');
        if (!stringArray(operations) || operations.length === 0)
          fail(location, 'expected a nonempty array of operation identifiers');
        if (new Set(operations).size !== operations.length)
          fail(location, 'duplicate query operation');
        return [name, [...operations].sort()];
      },
    ),
  );
  const rawInfinite = record(
    value.infiniteQueries === undefined ? {} : value.infiniteQueries,
    'infiniteQueries',
  );
  const infiniteQueries = new Map(
    Object.keys(rawInfinite)
      .sort()
      .map((name): [string, ReadonlyMap<string, InfiniteQueryBinding>] => {
        const location = `infiniteQueries.${name}`;
        if (!clients.includes(name))
          fail(location, 'infinite queries must name a selected client');
        const operations = record(rawInfinite[name], location);
        if (Object.keys(operations).length === 0)
          fail(location, 'expected at least one infinite query');
        return [
          name,
          // Generated registry ordering follows object enumeration for numeric IDs.
          new Map(
            Object.entries(
              Object.fromEntries(
                Object.keys(operations)
                  .sort()
                  .map((id): [string, InfiniteQueryBinding] => {
                    const path = `${location}.${id}`;
                    const binding = record(operations[id], path);
                    if (Object.hasOwn(binding, 'offset')) {
                      keys(
                        binding,
                        [
                          'offset',
                          'responseOffset',
                          'responseLimit',
                          'total',
                          'items',
                        ],
                        path,
                      );
                      return [
                        id,
                        {
                          kind: 'offset',
                          offset: text(binding.offset, `${path}.offset`),
                          responseOffset: text(
                            binding.responseOffset,
                            `${path}.responseOffset`,
                          ),
                          responseLimit: text(
                            binding.responseLimit,
                            `${path}.responseLimit`,
                          ),
                          total: text(binding.total, `${path}.total`),
                          items: text(binding.items, `${path}.items`),
                        },
                      ];
                    }
                    keys(binding, ['cursor', 'nextCursor', 'items'], path);
                    return [
                      id,
                      {
                        kind: 'cursor',
                        cursor: text(binding.cursor, `${path}.cursor`),
                        nextCursor: text(
                          binding.nextCursor,
                          `${path}.nextCursor`,
                        ),
                        items: text(binding.items, `${path}.items`),
                      },
                    ];
                  }),
              ),
            ),
          ),
        ];
      }),
  );
  return {
    clients,
    recursiveWorkLimit,
    executionClients,
    transportHeaders,
    targets,
    standalone,
    queries,
    infiniteQueries,
  };
}
