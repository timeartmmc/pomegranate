import {
  arrayValues,
  annotations,
  fail,
  keys,
  record,
  stringArray,
  stringFields,
  validComponentName,
} from './diagnostics.js';
import {
  localComponentReference,
  validateComponentAliases,
} from './component-references.js';
import type { Server, ServerVariable } from './model.js';

export const exampleKeys = ['example', 'examples'];
export const schemaAnnotationKeys = [
  '$comment',
  'title',
  'description',
  'default',
  'deprecated',
  'externalDocs',
  ...exampleKeys,
];

export function jsonAnnotation(input: unknown, location: string): void {
  const pending = new Set<object>();
  const checked = new WeakSet<object>();
  const stack: { source: object | undefined; values: Iterator<unknown> }[] = [
    { source: undefined, values: [input].values() },
  ];
  // Annotation payloads are opaque JSON, not schemas or generated expressions.
  // Iteration and identity tracking handle deep values and shared subtrees
  // without stack overflow or exponential traversal, while rejecting cycles.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.values.next();
    if (next.done) {
      if (frame.source) {
        pending.delete(frame.source);
        checked.add(frame.source);
      }
      stack.pop();
      continue;
    }
    const value = next.value;
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
      continue;
    if (typeof value === 'number')
      fail(location, 'annotation numbers must be finite JSON values');
    if (typeof value !== 'object') fail(location, 'expected an object');
    // record() supplies an own-only view. Track the caller's identity so cycles
    // and shared annotation subtrees still refer to the same original object.
    // Check it before copying descriptors: wide shared records are read once.
    if (pending.has(value))
      fail(location, 'annotation must be JSON without cycles');
    if (checked.has(value)) continue;
    const source = Array.isArray(value) ? value : record(value, location);
    pending.add(value);
    stack.push({
      source: value,
      values: Array.isArray(source)
        ? arrayValues(source)
        : Object.values(source).values(),
    });
  }
}

export function deprecatedAnnotation(
  value: Record<string, unknown>,
  location: string,
): void {
  if (
    Object.hasOwn(value, 'deprecated') &&
    typeof value.deprecated !== 'boolean'
  )
    fail(`${location}.deprecated`, 'expected a boolean');
}

export function licenseAnnotation(info: Record<string, unknown>): void {
  if (!Object.hasOwn(info, 'license')) return;
  const location = 'info.license';
  const license = record(info.license, location);
  keys(license, ['name', 'identifier', 'url'], location, 'license');
  if (typeof license.name !== 'string')
    fail(`${location}.name`, 'expected a string');
  stringFields(license, ['identifier', 'url'], location);
  if (Object.hasOwn(license, 'identifier') && Object.hasOwn(license, 'url'))
    fail(location, 'identifier and url are mutually exclusive');
}

export function infoAnnotations(info: Record<string, unknown>): void {
  licenseAnnotation(info);
  stringFields(info, ['termsOfService'], 'info');
  if (!Object.hasOwn(info, 'contact')) return;
  const contact = record(info.contact, 'info.contact');
  const fields = ['name', 'url', 'email'];
  keys(contact, fields, 'info.contact');
  stringFields(contact, fields, 'info.contact');
}

export function externalDocsAnnotation(
  value: Record<string, unknown>,
  location: string,
): void {
  if (!Object.hasOwn(value, 'externalDocs')) return;
  const path = `${location}.externalDocs`;
  const docs = record(value.externalDocs, path);
  keys(docs, ['url', 'description'], path);
  if (typeof docs.url !== 'string') fail(`${path}.url`, 'expected a string');
  stringFields(docs, ['description'], path);
}

// Shapes only: POM never parses URLs or expands variables. The document's list
// is the application's endpoint configuration and stays out of generated
// output. A Path Item or Operation list replaces it for those operations, so
// their requests carry it to the transport (OAS 3.1.1 §4.8.9, §4.8.10).
export function serverList(
  input: unknown,
  location: string,
): readonly Server[] {
  if (!Array.isArray(input)) fail(location, 'expected an array');
  return Array.from(arrayValues(input), (entry, index) => {
    const path = `${location}[${index}]`;
    const server = record(entry, path);
    keys(server, ['url', 'description', 'variables'], path);
    if (typeof server.url !== 'string')
      fail(`${path}.url`, 'expected a string');
    stringFields(server, ['description'], path);
    const variables = new Map<string, ServerVariable>();
    if (Object.hasOwn(server, 'variables')) {
      const declared = record(server.variables, `${path}.variables`);
      // Variables are a map: sorted names keep output independent of their order.
      for (const name of Object.keys(declared).sort()) {
        const variablePath = `${path}.variables.${name}`;
        const variable = record(declared[name], variablePath);
        keys(variable, ['default', 'enum', 'description'], variablePath);
        if (typeof variable.default !== 'string')
          fail(`${variablePath}.default`, 'expected a string');
        stringFields(variable, ['description'], variablePath);
        let values: readonly string[] | undefined;
        if (Object.hasOwn(variable, 'enum')) {
          if (!stringArray(variable.enum) || variable.enum.length === 0)
            fail(
              `${variablePath}.enum`,
              'expected a nonempty array of strings',
            );
          if (!variable.enum.includes(variable.default))
            fail(`${variablePath}.default`, 'default must be a member of enum');
          values = [...variable.enum];
        }
        variables.set(name, { default: variable.default, enum: values });
      }
    }
    return { url: server.url, variables };
  });
}

export function schemaAnnotations(
  value: Record<string, unknown>,
  location: string,
): void {
  // Author comments never enter normalized schemas or generated output.
  stringFields(value, ['$comment'], location);
  annotations(value, location);
  externalDocsAnnotation(value, location);
  deprecatedAnnotation(value, location);
  if (Object.hasOwn(value, 'example'))
    jsonAnnotation(value.example, `${location}.example`);
  // Schema.examples is a JSON Schema array. Unlike Parameter/Media Type examples,
  // it may coexist with the older OpenAPI schema.example annotation.
  if (Object.hasOwn(value, 'examples')) {
    if (!Array.isArray(value.examples))
      fail(`${location}.examples`, 'expected an array of example values');
    jsonAnnotation(value.examples, `${location}.examples`);
  }
}

function exampleObject(
  input: unknown,
  location: string,
  names: ReadonlySet<string>,
): string | undefined {
  const value = record(input, location);
  annotations(value, location);
  if (Object.hasOwn(value, '$ref')) {
    keys(value, ['$ref', 'summary', 'description'], location);
    const name = localComponentReference(
      value.$ref,
      'examples',
      `${location}.$ref`,
    );
    if (!names.has(name))
      fail(`${location}.$ref`, `unresolved example reference ${name}`);
    return name;
  }
  keys(value, ['summary', 'description', 'value', 'externalValue'], location);
  if (Object.hasOwn(value, 'value') && Object.hasOwn(value, 'externalValue'))
    fail(location, 'value and externalValue are mutually exclusive');
  if (Object.hasOwn(value, 'value'))
    jsonAnnotation(value.value, `${location}.value`);
  // This is a documentation URI only: it is never resolved or fetched.
  if (
    Object.hasOwn(value, 'externalValue') &&
    typeof value.externalValue !== 'string'
  )
    fail(`${location}.externalValue`, 'expected a string');
  return undefined;
}

export function exampleComponents(input: unknown): ReadonlySet<string> {
  const location = 'components.examples';
  const examples = record(input, location);
  const names = new Set(Object.keys(examples).sort());
  const references = new Map<string, string | undefined>();
  for (const name of names) {
    if (!validComponentName(name))
      fail(
        `${location}.${name}`,
        'component example names must match [A-Za-z0-9._-]+',
      );
    references.set(
      name,
      exampleObject(examples[name], `${location}.${name}`, names),
    );
  }
  validateComponentAliases(references, 'examples');
  return names;
}

export function exampleAnnotations(
  value: Record<string, unknown>,
  location: string,
  names: ReadonlySet<string>,
): void {
  if (Object.hasOwn(value, 'example') && Object.hasOwn(value, 'examples'))
    fail(location, 'example and examples are mutually exclusive');
  if (Object.hasOwn(value, 'example'))
    jsonAnnotation(value.example, `${location}.example`);
  if (Object.hasOwn(value, 'examples')) {
    const examples = record(value.examples, `${location}.examples`);
    for (const [name, example] of Object.entries(examples))
      exampleObject(example, `${location}.examples.${name}`, names);
  }
}
