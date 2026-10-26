import { annotations, fail, keys, record } from './diagnostics.js';

export const exampleKeys = ['example', 'examples'];
export const schemaAnnotationKeys = [
  'title',
  'description',
  'default',
  'deprecated',
  ...exampleKeys,
];

export function jsonAnnotation(input: unknown, location: string): void {
  const pending = new Set<object>();
  const checked = new WeakSet<object>();
  const stack: { source?: object; values: Iterator<unknown> }[] = [
    { values: [input].values() },
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
    const source = Array.isArray(value) ? value : record(value, location);
    if (pending.has(source))
      fail(location, 'annotation must be JSON without cycles');
    if (checked.has(source)) continue;
    pending.add(source);
    stack.push({
      source,
      values: Array.isArray(source)
        ? source.values()
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
  keys(license, ['name', 'identifier', 'url'], location);
  if (typeof license.name !== 'string')
    fail(`${location}.name`, 'expected a string');
  for (const key of ['identifier', 'url'])
    if (Object.hasOwn(license, key) && typeof license[key] !== 'string')
      fail(`${location}.${key}`, 'expected a string');
  if (Object.hasOwn(license, 'identifier') && Object.hasOwn(license, 'url'))
    fail(location, 'identifier and url are mutually exclusive');
}

export function schemaAnnotations(
  value: Record<string, unknown>,
  location: string,
): void {
  annotations(value, location);
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
    const prefix = '#/components/examples/';
    if (typeof value.$ref !== 'string' || !value.$ref.startsWith(prefix))
      fail(
        `${location}.$ref`,
        'only local component example references are supported',
      );
    const name = value.$ref.slice(prefix.length);
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
    if (name.length === 0 || /[^A-Za-z0-9._-]/.test(name))
      fail(
        `${location}.${name}`,
        'component example names must match [A-Za-z0-9._-]+',
      );
    references.set(
      name,
      exampleObject(examples[name], `${location}.${name}`, names),
    );
  }
  const checked = new Set<string>();
  for (const name of names) {
    const pending = new Set<string>();
    let current: string | undefined = name;
    while (current !== undefined && !checked.has(current)) {
      if (pending.has(current))
        fail(`${location}.${current}.$ref`, 'cyclic example reference');
      pending.add(current);
      current = references.get(current);
    }
    for (const visited of pending) checked.add(visited);
  }
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
