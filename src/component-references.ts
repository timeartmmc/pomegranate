import { annotations, fail, keys, record, safeKey } from './diagnostics.js';

const kinds = {
  parameter: { section: 'parameters', label: 'parameter' },
  response: { section: 'responses', label: 'response' },
  requestBody: { section: 'requestBodies', label: 'request body' },
  header: { section: 'headers', label: 'header' },
} as const;
type Kind = keyof typeof kinds;

function componentName(name: string, kind: Kind, location: string): string {
  if (name.length === 0 || /[^A-Za-z0-9._-]/.test(name))
    fail(
      location,
      `component ${kinds[kind].label} names must match [A-Za-z0-9._-]+`,
    );
  return safeKey(name, location);
}

export function componentReference(
  value: Record<string, unknown>,
  kind: Kind,
  location: string,
): string | undefined {
  if (!Object.hasOwn(value, '$ref')) return undefined;
  const { section, label } = kinds[kind];
  // Reference annotations never override contract fields. Terminal declarations
  // still receive their own validation even when an alias supplies documentation.
  keys(value, ['$ref', 'summary', 'description'], location);
  annotations(value, location);
  const prefix = `#/components/${section}/`;
  if (typeof value.$ref !== 'string' || !value.$ref.startsWith(prefix))
    fail(
      `${location}.$ref`,
      `only local component ${label} references are supported`,
    );
  return componentName(
    value.$ref.slice(prefix.length),
    kind,
    `${location}.$ref`,
  );
}

export function normalizeComponents<T>(
  input: unknown,
  kind: Kind,
  normalize: (value: Record<string, unknown>, location: string) => T,
): ReadonlyMap<string, T> {
  const { section, label } = kinds[kind];
  const location = `components.${section}`;
  const components = record(input, location);
  const values = new Map<string, T>();
  const references = new Map<string, string>();
  for (const name of Object.keys(components).sort()) {
    const path = `${location}.${name}`;
    componentName(name, kind, path);
    const value = record(components[name], path);
    const target = componentReference(value, kind, path);
    if (target === undefined) {
      // Normalize unused terminals too. Each caller owns its direction-specific
      // validation; references cannot hide an unsupported declaration.
      values.set(name, normalize(value, path));
    } else {
      if (!Object.hasOwn(components, target))
        fail(`${path}.$ref`, `unresolved ${label} reference ${target}`);
      references.set(name, target);
    }
  }
  for (const name of references.keys()) {
    const pending = new Set<string>();
    let current = name;
    // Alias depth does not add schema nesting. Iteration and caching every
    // visited alias keep long chains/shared tails linear without recursion.
    while (!values.has(current)) {
      if (pending.has(current))
        fail(`${location}.${current}.$ref`, `cyclic ${label} reference`);
      pending.add(current);
      current = references.get(current)!;
    }
    const value = values.get(current)!;
    for (const alias of pending) values.set(alias, value);
  }
  return values;
}
