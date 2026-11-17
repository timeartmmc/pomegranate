import {
  ContractError,
  fail,
  ownRecord,
  safeKey,
  text,
  validComponentName,
} from './diagnostics.js';
import { mapOpenApi, openApiContext } from './extensions.js';
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

function pointerName(path: readonly string[], location: string): string {
  if (path.length === 3 && path[0] === 'components' && path[1] === 'schemas') {
    const name = path[2]!;
    if (!validComponentName(name))
      fail(location, 'component schema names must match [A-Za-z0-9._-]+');
    return safeKey(name, location);
  }
  return schemaPointer(path, location);
}

export const schemaReferenceName = (input: unknown, location: string): string =>
  pointerName(schemaPointerPath(input, location), location);

// Component names exclude '#', keeping source names and virtual pointer targets
// in disjoint namespaces without reserving a previously valid component name.
export const isSchemaFragment = (name: string): boolean => name.startsWith('#');
export const schemaReference = (name: string): string =>
  isSchemaFragment(name)
    ? name
    : schemaPointer(['components', 'schemas', name]);

function plain(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? ownRecord(value as Record<string, unknown>)
    : undefined;
}

// Index source targets before filtering, rather than expanding references after
// their containing operation/component may already have been removed. The graph
// keeps these virtual declarations independently of their document containers.
export function createSchemaPointerRegistry(
  document: Record<string, unknown>,
  standalone: readonly Readonly<{ name: string; schema: string }>[],
  charge: (amount: number) => void,
) {
  const sources = new Map<string, SchemaSource>();
  const parsed = new Map<string, { name: string; path: readonly string[] }>();
  // Walker copies are cached by physical object identity. Redirect every alias
  // of a targeted object, including descendants under a shared parent, so the
  // first visited path cannot leave a duplicate inline normalization behind.
  const identities = new WeakMap<object, string>();
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
        target = { name: pointerName(path, location), path };
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
          fail(
            location,
            `unresolved local schema reference ${JSON.stringify(name)}`,
          );
        value = Reflect.get(value, token);
      }
      if (openApiContext(path) !== 'schema')
        fail(
          location,
          `local reference ${JSON.stringify(name)} does not target a supported schema position`,
        );
      if (typeof value === 'boolean')
        fail(
          location,
          `boolean schema targets are unsupported (${JSON.stringify(name)})`,
        );
      if (value === null || typeof value !== 'object' || !plain(value))
        fail(
          location,
          `local reference ${JSON.stringify(name)} must target a Schema Object`,
        );
      const canonical = identities.get(value);
      sources.set(name, {
        schema: canonical === undefined ? value : { $ref: canonical },
        path,
      });
      if (canonical === undefined) identities.set(value, name);
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
  scan(document);
  for (const root of standalone)
    reference(root.schema, `standalone.${root.name}.schema`);
  // A target can be under an otherwise ignored Reference Object sibling. Its
  // own schema is still a valid independently addressable source declaration.
  for (const { schema, path } of sources.values())
    scan(schema, { context: 'schema', path, openApi30 });

  function targetAt(original: object): string | undefined {
    return identities.get(original);
  }
  function owner(path: readonly string[]): string | undefined {
    return owners.get(JSON.stringify(path));
  }
  function rewrite(
    input: unknown,
    root?: OpenApiRoot,
    ownTarget?: string,
  ): unknown {
    // Ordinary component references already normalize directly; cloning the
    // document again would charge every audit retry without changing a schema.
    if (!hasFragments) return input;
    let first = true;
    return mapOpenApi(
      input,
      (value, context, location, original) => {
        charge(1);
        if (context === 'schema') {
          const ownRoot = first && ownTarget !== undefined;
          first = false;
          const target = ownRoot ? undefined : targetAt(original);
          if (target) return { $ref: target };
          if (Object.hasOwn(value, '$ref'))
            return {
              ...value,
              $ref: reference(value.$ref, `${location}.$ref`, true)!,
            };
        }
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
    );
  }
  function selectSources(needed: ReadonlySet<string>): SchemaSources {
    const selected = new Map<string, SchemaSource>();
    for (const [id, value] of sources) {
      if (!needed.has(id)) continue;
      selected.set(id, {
        schema: rewrite(
          value.schema,
          { context: 'schema', path: value.path, openApi30 },
          id,
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
    targetAt,
    owner,
    rewrite,
    selectSources,
  };
}
