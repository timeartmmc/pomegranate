import {
  ContractError,
  fail,
  ownRecord,
  safeKey,
  text,
  validComponentName,
} from './diagnostics.js';
import { mapOpenApi, openApiContext, openApiLocation } from './extensions.js';
import type { OpenApiRoot } from './extensions.js';

export type SchemaSource = Readonly<{
  schema: unknown;
  path: readonly string[];
}>;
export type SchemaSources = ReadonlyMap<string, SchemaSource>;

export function schemaPointer(
  path: readonly string[],
  location = 'schema reference',
): string {
  try {
    return (
      '#' +
      path
        .map(
          (token) =>
            '/' +
            encodeURIComponent(
              token.replaceAll('~', '~0').replaceAll('/', '~1'),
            ),
        )
        .join('')
    );
  } catch {
    fail(location, 'local schema reference contains invalid Unicode');
  }
}

export function schemaPointerPath(
  input: unknown,
  location: string,
): readonly string[] {
  const reference = text(input, location);
  if (!reference.startsWith('#'))
    fail(location, 'only local JSON Pointer schema references are supported');
  let pointer: string;
  try {
    // A reference is a URI fragment first. Decode it before interpreting JSON
    // Pointer separators and escapes (RFC 6901 sections 4 and 6).
    pointer = decodeURIComponent(reference.slice(1));
  } catch {
    fail(location, 'malformed URI fragment encoding in local schema reference');
  }
  if (pointer === '') return [];
  if (!pointer.startsWith('/'))
    fail(
      location,
      'local schema references require a JSON Pointer; anchors are unsupported',
    );
  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      if (/~(?![01])/u.test(token))
        fail(
          location,
          'malformed JSON Pointer escape; use ~0 for ~ and ~1 for /',
        );
      return token.replace(/~[01]/g, (escape) => (escape === '~0' ? '~' : '/'));
    });
}

const nonSchemaPosition = (input: unknown, location: string): never =>
  fail(
    location,
    `local reference ${JSON.stringify(input)} does not target a supported schema position`,
  );

function pointerName(
  input: unknown,
  path: readonly string[],
  location: string,
): string {
  if (path.length === 3 && path[0] === 'components') {
    // Another component section never holds a schema. Diagnose it here: the
    // registry skips documents whose references all have this shape.
    if (path[1] !== 'schemas') nonSchemaPosition(input, location);
    const name = path[2]!;
    if (!validComponentName(name))
      fail(location, 'component schema names must match [A-Za-z0-9._-]+');
    return safeKey(name, location);
  }
  return schemaPointer(path, location);
}

export const schemaReferenceName = (input: unknown, location: string): string =>
  pointerName(input, schemaPointerPath(input, location), location);

// Component names exclude '#', keeping source names and virtual pointer targets
// in disjoint namespaces without reserving a previously valid component name.
export const isSchemaFragment = (name: string): boolean => name.startsWith('#');
export const schemaReference = (name: string): string =>
  isSchemaFragment(name)
    ? name
    : schemaPointer(['components', 'schemas', name]);

// Display location of a schema table entry. A fragment reads as the source
// position it was declared at, never as its private canonical identity.
export function schemaLocation(name: string): string {
  return isSchemaFragment(name)
    ? openApiLocation(schemaPointerPath(name, 'schema reference'))
    : `components.schemas.${name}`;
}

function plain(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? ownRecord(value as Record<string, unknown>)
    : undefined;
}

// Most contracts reference only named components. Establish that from data
// properties alone before paying for the grammar walk that locates and
// validates fragment targets. Any other local $ref or mapping target, in
// whatever position, takes the full walk: this check may overapproximate but
// never misses a fragment. Any accessor defers to the grammar walk without
// reading it here; the walk distinguishes data names from opaque extensions.
const componentReference = /^#\/components\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
function mayReferenceFragments(document: unknown): boolean {
  const candidate = (value: unknown): boolean =>
    typeof value === 'string' &&
    value.startsWith('#') &&
    !componentReference.test(value);
  const seen = new Set<object>();
  const pending: { value: unknown; mapping: boolean }[] = [
    { value: document, mapping: false },
  ];
  while (pending.length > 0) {
    const { value, mapping } = pending.pop()!;
    if (value === null || typeof value !== 'object' || seen.has(value))
      continue;
    seen.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (!('value' in descriptor)) return true;
      const child: unknown = descriptor.value;
      if ((mapping || key === '$ref') && candidate(child)) return true;
      pending.push({ value: child, mapping: key === 'mapping' });
    }
  }
  return false;
}

// Index source targets before filtering, rather than expanding references after
// their containing operation/component may already have been removed. A target
// is an additional private declaration: its inline occurrence stays part of its
// container, so pointing at a schema never changes how that container compiles.
export function createSchemaPointerRegistry(
  document: Record<string, unknown>,
  standalone: readonly Readonly<{ name: string; schema: string }>[],
  charge: (amount: number) => void,
) {
  const sources = new Map<string, SchemaSource>();
  const parsed = new Map<string, { name: string; path: readonly string[] }>();
  // Detached-schema diagnostics retain the exact registered root, even for a
  // nested failure. Raw token keys also preserve malformed Unicode in ordinary
  // operation owners without requiring URI encoding during error attribution.
  const owners = new Map<string, string>();
  const openApi30 =
    typeof document.openapi === 'string' && document.openapi.startsWith('3.0.');
  const documentRoot = { context: 'document', path: [], openApi30 } as const;
  let hasFragments = false;

  function reference(
    input: unknown,
    location: string,
    strict = false,
  ): string | undefined {
    let target = typeof input === 'string' ? parsed.get(input) : undefined;
    if (!target) {
      // Reserve work before decoding/splitting an untrusted URI fragment. Keep
      // this outside the recoverable syntax boundary so limits always escape.
      charge(typeof input === 'string' ? input.length + 1 : 1);
      try {
        const path = schemaPointerPath(input, location);
        target = { name: pointerName(input, path, location), path };
      } catch (error) {
        if (strict || !(error instanceof ContractError)) throw error;
        return undefined;
      }
      // Work-limit exceptions are outside the recoverable syntax boundary.
      charge(target.path.length + 1);
      parsed.set(input as string, target);
    }
    const { name, path } = target;
    if (!isSchemaFragment(name)) return schemaReference(name);
    hasFragments = true;
    // Messages quote the author's spelling, not the canonical private identity.
    const written = JSON.stringify(input);
    try {
      if (sources.has(name)) return name;
      let value: unknown = document;
      for (const token of path) {
        if (
          value === null ||
          typeof value !== 'object' ||
          (Array.isArray(value) &&
            (!/^(?:0|[1-9][0-9]*)$/.test(token) ||
              Number(token) >= value.length)) ||
          !Object.hasOwn(value, token)
        )
          fail(location, `unresolved local schema reference ${written}`);
        value = Reflect.get(value, token);
      }
      if (openApiContext(path) !== 'schema') nonSchemaPosition(input, location);
      if (typeof value === 'boolean')
        fail(location, `boolean schema targets are unsupported (${written})`);
      if (value === null || typeof value !== 'object' || !plain(value))
        fail(
          location,
          `local reference ${written} must target a Schema Object`,
        );
      sources.set(name, { schema: value, path });
      owners.set(JSON.stringify(path), name);
      return name;
    } catch (error) {
      // Filtering may remove malformed declarations. Diagnose only uses that
      // survive selection; compiler/programming errors are never swallowed.
      if (strict || !(error instanceof ContractError)) throw error;
      return undefined;
    }
  }

  function scan(input: unknown, root?: OpenApiRoot): void {
    mapOpenApi(
      input,
      (value, context, location) => {
        charge(1);
        if (context === 'schema' && Object.hasOwn(value, '$ref'))
          reference(value.$ref, `${location}.$ref`);
        if (context === 'discriminator') {
          const mapping = plain(value.mapping);
          if (mapping) {
            charge(Object.keys(mapping).length);
            for (const [tag, target] of Object.entries(mapping))
              reference(target, `${location}.mapping.${tag}`);
          }
        }
        return openApi30 && context === 'schema' && Object.hasOwn(value, '$ref')
          ? { $ref: value.$ref }
          : value;
      },
      true,
      root ?? documentRoot,
    );
  }
  if (mayReferenceFragments(document)) scan(document);
  for (const root of standalone)
    reference(root.schema, `standalone.${root.name}.schema`);
  // A target can be under an otherwise ignored Reference Object sibling. Its
  // own schema is still a valid independently addressable source declaration.
  for (const { schema, path } of sources.values())
    scan(schema, { context: 'schema', path, openApi30 });

  function owner(path: readonly string[]): string | undefined {
    return owners.get(JSON.stringify(path));
  }
  // Spell every retained reference as its canonical declaration name. With
  // `errors`, each unusable reference is recorded under its own declaration so
  // one audit attempt reports all of them; the copy is then incomplete.
  function rewrite(
    input: unknown,
    root?: OpenApiRoot,
    errors?: ContractError[],
  ): unknown {
    // Ordinary component references already normalize directly; cloning the
    // document again would charge every audit retry without changing a schema.
    if (!hasFragments) return input;
    return mapOpenApi(
      input,
      (value, context, location) => {
        charge(1);
        if (context === 'schema' && Object.hasOwn(value, '$ref'))
          return {
            ...value,
            $ref: reference(value.$ref, `${location}.$ref`, true)!,
          };
        if (context !== 'discriminator') return value;
        const mapping = plain(value.mapping);
        if (!mapping) return value;
        charge(Object.keys(mapping).length);
        return {
          ...value,
          mapping: Object.fromEntries(
            Object.entries(mapping).map(([tag, target]) => [
              tag,
              reference(target, `${location}.mapping.${tag}`, true)!,
            ]),
          ),
        };
      },
      true,
      root ?? documentRoot,
      errors && ((error) => errors.push(error)),
    );
  }
  function selectSources(
    needed: ReadonlySet<string>,
    errors?: ContractError[],
  ): SchemaSources {
    const selected = new Map<string, SchemaSource>();
    for (const [id, value] of sources) {
      if (!needed.has(id)) continue;
      selected.set(id, {
        schema: rewrite(
          value.schema,
          { context: 'schema', path: value.path, openApi30 },
          errors,
        ),
        path: value.path,
      });
    }
    return selected;
  }
  return {
    sources: sources as SchemaSources,
    hasFragments,
    reference,
    owner,
    rewrite,
    selectSources,
  };
}
