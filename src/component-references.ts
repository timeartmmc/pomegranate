import {
  annotations,
  fail,
  keys,
  record,
  safeKey,
  validComponentName,
} from './diagnostics.js';

const labels = {
  schemas: 'schema',
  parameters: 'parameter',
  responses: 'response',
  requestBodies: 'request body',
  headers: 'header',
  securitySchemes: 'security scheme',
  examples: 'example',
} as const;
type Section = keyof typeof labels;
type ReusableSection =
  | 'parameters'
  | 'responses'
  | 'requestBodies'
  | 'headers'
  | 'securitySchemes';

function componentName(
  name: string,
  section: ReusableSection,
  location: string,
): string {
  if (!validComponentName(name))
    fail(
      location,
      `component ${labels[section]} names must match [A-Za-z0-9._-]+`,
    );
  return safeKey(name, location);
}

export function localComponentReference(
  input: unknown,
  section: Section,
  location: string,
): string {
  const prefix = `#/components/${section}/`;
  if (typeof input !== 'string' || !input.startsWith(prefix))
    fail(
      location,
      `only local component ${labels[section]} references are supported`,
    );
  // Declaration owners retain their own name restrictions and target checks.
  return input.slice(prefix.length);
}

export function validateComponentAliases(
  references: ReadonlyMap<string, string | undefined>,
  section: 'examples',
): void {
  const checked = new Set<string>();
  // Targets were checked at their declarations. These are pure alias chains;
  // schema references retain separate constraint and directional traversal.
  for (const name of references.keys()) {
    const pending = new Set<string>();
    let current: string | undefined = name;
    while (current !== undefined && !checked.has(current)) {
      if (pending.has(current))
        fail(
          `components.${section}.${current}.$ref`,
          `cyclic ${labels[section]} reference`,
        );
      pending.add(current);
      current = references.get(current);
    }
    for (const visited of pending) checked.add(visited);
  }
}

export function componentReference(
  value: Record<string, unknown>,
  section: ReusableSection,
  location: string,
): string | undefined {
  if (!Object.hasOwn(value, '$ref')) return undefined;
  // Reference annotations never override contract fields. Terminal declarations
  // still receive their own validation even when an alias supplies documentation.
  keys(value, ['$ref', 'summary', 'description'], location);
  annotations(value, location);
  return componentName(
    localComponentReference(value.$ref, section, `${location}.$ref`),
    section,
    `${location}.$ref`,
  );
}

export function normalizeComponents<T>(
  input: unknown,
  section: ReusableSection,
  normalize: (value: Record<string, unknown>, location: string) => T,
): ReadonlyMap<string, T> {
  const label = labels[section];
  const location = `components.${section}`;
  const components = record(input, location);
  const values = new Map<string, T>();
  const references = new Map<string, string>();
  for (const name of Object.keys(components).sort()) {
    const path = `${location}.${name}`;
    componentName(name, section, path);
    const value = record(components[name], path);
    const target = componentReference(value, section, path);
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
