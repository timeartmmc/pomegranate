import { componentSections } from './component-references.js';
import { fail, ownRecord, record, stringArray, text } from './diagnostics.js';
import { mapOpenApi } from './extensions.js';
import { openApiMethods, operationIdentifier } from './operations.js';
import { standaloneSelections } from './selection.js';

function plain(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype
    ? ownRecord(value as Record<string, unknown>)
    : undefined;
}

// Preserve non-enumerable declarations and frozen source records. Replacements
// happen in the descriptor table before constructing the detached copy.
function copy(
  value: Record<string, unknown>,
  removed: Iterable<string>,
  replacements: Record<string, unknown> = {},
): Record<string, unknown> {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of removed) delete descriptors[key];
  for (const [key, replacement] of Object.entries(replacements))
    descriptors[key] = {
      value: replacement,
      enumerable: descriptors[key]?.enumerable ?? true,
      configurable: true,
      writable: true,
    };
  return Object.create(null, descriptors) as Record<string, unknown>;
}

const referenceContexts = new Set([
  'schema',
  'parameter',
  'response',
  'requestBody',
  'header',
  'example',
  'link',
  'securityScheme',
]);

export function excludeOperations(
  document: Record<string, unknown>,
  input: unknown = [],
  standalone: unknown = {},
  pruneUnused: unknown = false,
): {
  document: Record<string, unknown>;
  excluded: readonly string[];
  pruned: readonly string[];
} {
  if (typeof pruneUnused !== 'boolean')
    fail('pruneUnusedComponents', 'expected a boolean');
  let remaining = 1_000_000;
  const charge = (amount: number): void => {
    if ((remaining -= amount) < 0)
      fail(
        pruneUnused ? 'pruneUnusedComponents' : 'excludeOperations',
        `${pruneUnused ? 'component pruning' : 'exclusion processing'} exceeds the supported limit of 1000000 work units; reduce or split the input contract`,
      );
  };
  if (Array.isArray(input)) charge(input.length);
  if (!stringArray(input))
    fail('excludeOperations', 'expected an array of exact operation IDs');
  const excluded = new Set<string>();
  for (const [index, id] of input.entries()) {
    const location = `excludeOperations[${index}]`;
    text(id, location);
    if (excluded.has(id))
      fail(location, `duplicate operation identifier ${JSON.stringify(id)}`);
    excluded.add(id);
  }
  if (excluded.size === 0 && !pruneUnused)
    return { document, excluded: [], pruned: [] };
  const paths = record(document.paths, 'paths');
  const operations = new Map<string, { path: string; method: string }>();
  for (const path of Object.keys(paths)) {
    if (path.startsWith('x-')) continue;
    const item = record(paths[path], `paths.${path}`);
    for (const method of openApiMethods) {
      if (!Object.hasOwn(item, method)) continue;
      charge(1);
      const id = operationIdentifier(
        record(item[method], `paths.${path}.${method}`),
        method,
        path,
      );
      const previous = operations.get(id);
      if (previous)
        fail(
          `paths.${path}.${method}.operationId`,
          `duplicate operation identifier ${JSON.stringify(id)}; first declared at paths.${previous.path}.${previous.method}.operationId`,
        );
      operations.set(id, { path, method });
    }
  }
  const removals = new Map<string, Set<string>>();
  for (const [index, id] of input.entries()) {
    const operation = operations.get(id);
    if (!operation)
      fail(
        `excludeOperations[${index}]`,
        `unknown operation identifier ${JSON.stringify(id)}`,
      );
    const methods = removals.get(operation.path) ?? new Set<string>();
    methods.add(operation.method);
    removals.set(operation.path, methods);
  }
  const keptPaths = new Map<string, unknown>();
  const removedPaths = new Map<string, unknown>();
  const emptyPaths = new Set<string>();
  for (const [path, methods] of removals) {
    const item = record(paths[path], `paths.${path}`);
    const kept = copy(item, methods);
    if (openApiMethods.some((method) => Object.hasOwn(kept, method)))
      keptPaths.set(path, kept);
    else emptyPaths.add(path);
    removedPaths.set(
      path,
      copy(
        item,
        openApiMethods.filter((method) => !methods.has(method)),
      ),
    );
  }
  let filtered = copy(document, [], {
    paths: copy(paths, emptyPaths, Object.fromEntries(keptPaths)),
  });
  const components = record(
    Object.hasOwn(document, 'components') ? document.components : {},
    'components',
  );
  const declarations = new Map<
    string,
    { section: string; name: string; value: unknown }
  >();
  for (const section of componentSections) {
    if (!Object.hasOwn(components, section)) continue;
    const values = record(components[section], `components.${section}`);
    charge(Object.keys(values).length);
    for (const name of Object.keys(values))
      declarations.set(`#/components/${section}/${name}`, {
        section,
        name,
        value: values[name],
      });
  }
  const dialect30 =
    typeof document.openapi === 'string' && document.openapi.startsWith('3.0.');
  const dependencies = (source: unknown): Set<string> => {
    const references = new Set<string>();
    const add = (value: unknown): void => {
      if (typeof value === 'string' && declarations.has(value))
        references.add(value);
    };
    mapOpenApi(source, (value, context) => {
      charge(1);
      if (referenceContexts.has(context) && Object.hasOwn(value, '$ref'))
        add(value.$ref);
      if (context === 'discriminator') {
        const mapping = plain(value.mapping) ?? {};
        charge(Object.keys(mapping).length);
        for (const reference of Object.values(mapping)) add(reference);
      }
      if (
        (context === 'document' || context === 'operation') &&
        Array.isArray(value.security)
      )
        for (const requirement of value.security) {
          const names = Object.keys(plain(requirement) ?? {});
          charge(names.length + 1);
          for (const name of names) add(`#/components/securitySchemes/${name}`);
        }
      // 3.0 schema references do not acquire dependencies from siblings.
      return dialect30 && context === 'schema' && Object.hasOwn(value, '$ref')
        ? { $ref: value.$ref }
        : value;
    });
    return references;
  };
  const edges = new Map<string, ReadonlySet<string>>();
  for (const [reference, { section, name, value }] of declarations)
    edges.set(
      reference,
      dependencies({ components: { [section]: { [name]: value } } }),
    );
  const closure = (roots: Iterable<string>): Set<string> => {
    const visited = new Set<string>();
    const pending: string[] = [];
    for (const root of roots) {
      charge(1);
      pending.push(root);
    }
    while (pending.length > 0) {
      const reference = pending.pop()!;
      if (visited.has(reference)) continue;
      charge(1);
      visited.add(reference);
      for (const dependency of edges.get(reference) ?? []) {
        charge(1);
        pending.push(dependency);
      }
    }
    return visited;
  };
  const roots = dependencies(copy(filtered, ['components']));
  for (const root of standaloneSelections(standalone))
    if (declarations.has(root.schema)) roots.add(root.schema);
  // Strict mode keeps otherwise-unused declarations and their dependencies.
  // Opt-in pruning roots only in retained document uses and standalone exports;
  // client selection must never hide dependencies of an unselected operation.
  let candidates: Iterable<string> = declarations.keys();
  if (!pruneUnused) {
    const removed = closure(
      dependencies({ paths: Object.fromEntries(removedPaths) }),
    );
    for (const reference of declarations.keys())
      if (!removed.has(reference)) roots.add(reference);
    candidates = removed;
  }
  const protectedComponents = closure(roots);
  const pruned = new Map<string, string[]>();
  const prunedReferences: string[] = [];
  for (const reference of candidates) {
    if (pruneUnused) charge(1);
    if (protectedComponents.has(reference)) continue;
    const { section, name } = declarations.get(reference)!;
    const names = pruned.get(section) ?? [];
    names.push(name);
    pruned.set(section, names);
    if (pruneUnused)
      prunedReferences.push(
        `#/components/${section}/${name.replace(/~/g, '~0').replace(/\//g, '~1')}`,
      );
  }
  if (pruned.size > 0) {
    const replacements = Object.fromEntries(
      [...pruned].map(([section, names]) => [
        section,
        copy(record(components[section], `components.${section}`), names),
      ]),
    );
    filtered = copy(filtered, [], {
      components: copy(components, [], replacements),
    });
  }
  return {
    document: filtered,
    excluded: [...excluded].sort(),
    pruned: prunedReferences.sort(),
  };
}
