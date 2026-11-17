import { componentSections } from './component-references.js';
import {
  createOwnRecord,
  fail,
  ownDescriptors,
  ownRecord,
  record,
  stringArray,
  text,
} from './diagnostics.js';
import { mapOpenApi, referenceContexts } from './extensions.js';
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

// Source records may be frozen. Removals and replacements happen in the
// descriptor table before constructing the detached own-key view.
function copy(
  value: Record<string, unknown>,
  removed: Iterable<string>,
  replacements: Record<string, unknown> = {},
): Record<string, unknown> {
  const descriptors = ownDescriptors(value);
  for (const key of removed) delete descriptors[key];
  for (const [key, replacement] of Object.entries(replacements))
    descriptors[key] = {
      value: replacement,
      enumerable: true,
      configurable: true,
      writable: true,
    };
  return createOwnRecord(descriptors);
}

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
  return operationFilter(document, standalone, charge).select(
    excluded,
    pruneUnused,
  );
}

export function operationFilter(
  document: Record<string, unknown>,
  standalone: unknown,
  charge: (amount: number) => void,
) {
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
  const standaloneRoots = standaloneSelections(standalone).map(
    (root) => root.schema,
  );

  function select(excluded: ReadonlySet<string>, pruneUnused: boolean) {
    const removals = new Map<string, Set<string>>();
    for (const [index, id] of [...excluded].entries()) {
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
    const roots = dependencies(copy(filtered, ['components']));
    for (const root of standaloneRoots)
      if (declarations.has(root)) roots.add(root);
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

  // Compute ownership only for diagnostics. Normal exclusions share the same
  // dependency grammar and closure without paying for reverse reachability.
  let ownership:
    | {
        owners: Map<string, Set<string>>;
        parents: Map<string, Set<string>>;
        protectedRoots: Set<string>;
      }
    | undefined;
  function affected(location: string): readonly string[] {
    const within = (prefix: string, value: string) =>
      value === prefix ||
      value.startsWith(`${prefix}.`) ||
      value.startsWith(`${prefix}[`) ||
      // Validation follows aliases in the same value and records that hop in
      // the location. Attribute it to its source, just like an inline child.
      value.startsWith(`${prefix} -> `);
    if (location.startsWith('paths.')) {
      const rest = location.slice('paths.'.length);
      const candidates = Object.keys(paths).filter((name) =>
        within(name, rest),
      );
      if (candidates.length > 1)
        fail(
          'audit',
          `cannot safely attribute ${JSON.stringify(location)}: declared path names make this diagnostic ambiguous; no exclusions were proposed`,
        );
      const path = candidates[0];
      if (path === undefined) return [];
      const tail = rest.slice(path.length + 1);
      const method = openApiMethods.find((name) => within(name, tail));
      if (
        method === undefined &&
        tail &&
        !['parameters', 'servers', 'summary', 'description'].some((name) =>
          within(name, tail),
        )
      )
        return [];
      return [...operations]
        .filter(
          ([, operation]) =>
            operation.path === path &&
            (method === undefined || operation.method === method),
        )
        .map(([id]) => id);
    }
    const candidates = [...declarations].filter(([, { section, name }]) =>
      within(`components.${section}.${name}`, location),
    );
    // Location strings cannot distinguish a dotted declaration name from a
    // child path in another declaration. Never recommend excluding a healthy
    // operation by guessing the longest textual prefix.
    if (candidates.length > 1)
      fail(
        'audit',
        `cannot safely attribute ${JSON.stringify(location)}: declared component names make this diagnostic ambiguous; no exclusions were proposed`,
      );
    const reference = candidates[0]?.[0];
    if (reference === undefined) return [];
    if (ownership === undefined) {
      const owners = new Map<string, Set<string>>();
      const parents = new Map<string, Set<string>>();
      for (const [source, dependencies] of edges)
        for (const dependency of dependencies) {
          charge(1);
          const values = parents.get(dependency) ?? new Set<string>();
          values.add(source);
          parents.set(dependency, values);
        }
      for (const [id, { path, method }] of operations) {
        const item = record(paths[path], `paths.${path}`);
        const roots = dependencies({
          paths: {
            [path]: copy(
              item,
              openApiMethods.filter((name) => name !== method),
            ),
          },
        });
        for (const root of roots) {
          const values = owners.get(root) ?? new Set<string>();
          values.add(id);
          owners.set(root, values);
        }
      }
      const roots = dependencies(copy(document, ['components', 'paths']));
      for (const root of standaloneRoots)
        if (declarations.has(root)) roots.add(root);
      // Publish only a complete index: a work limit may interrupt any build step.
      ownership = { owners, parents, protectedRoots: closure(roots) };
    }
    const { owners, parents, protectedRoots } = ownership;
    // Excluding operations cannot repair global security or a standalone root.
    if (protectedRoots.has(reference)) return [];
    const result = new Set<string>();
    const pending = [reference];
    const visited = new Set<string>();
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (visited.has(current)) continue;
      charge(1);
      visited.add(current);
      for (const id of owners.get(current) ?? []) result.add(id);
      for (const parent of parents.get(current) ?? []) pending.push(parent);
    }
    return [...result].sort();
  }
  return {
    operations: operations as ReadonlyMap<
      string,
      { path: string; method: string }
    >,
    select,
    affected,
  };
}
