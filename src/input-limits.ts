import { schemaAnnotationKeys } from './annotations.js';
import { fail } from './diagnostics.js';
import { mapOpenApi } from './extensions.js';

export const maximumExpandedInputNodes = 1_000_000;
const opaqueSchemaKeys = [...schemaAnnotationKeys, 'readOnly', 'writeOnly'];

function tooLarge(location: string): never {
  fail(
    location,
    `expanded schema input exceeds the supported limit of ${maximumExpandedInputNodes} nodes; factor repeated inline schemas into components and use local $ref references`,
  );
}

/** Count data without expanding shared subtrees or evaluating accessors. */
export function checkInputExpansion(
  input: unknown,
  maximum = maximumExpandedInputNodes,
  location = 'OpenAPI',
): number {
  if (maximum < 1) tooLarge(location);
  if (input === null || typeof input !== 'object') return 1;
  const sizes = new WeakMap<object, number>();
  const active = new WeakSet<object>();
  const stack: {
    source: object;
    keys: Iterator<string>;
    array: boolean;
    size: number;
  }[] = [];
  const enter = (source: object): void => {
    const array = Array.isArray(source);
    if (array && source.length >= maximum) tooLarge(location);
    active.add(source);
    stack.push({
      source,
      keys: Object.getOwnPropertyNames(source).values(),
      array,
      size: 1,
    });
  };
  const account = (size: number): void => {
    if (stack.length === 0) return;
    const parent = stack[stack.length - 1]!;
    if ((parent.size += size) > maximum) tooLarge(location);
  };
  enter(input);
  while (stack.length) {
    const frame = stack[stack.length - 1]!;
    const next = frame.keys.next();
    if (next.done) {
      sizes.set(frame.source, frame.size);
      active.delete(frame.source);
      stack.pop();
      account(frame.size);
      continue;
    }
    if (frame.array && next.value === 'length') continue;
    if (!frame.array) account(1);
    const field = Object.getOwnPropertyDescriptor(frame.source, next.value);
    if (!field || !Object.hasOwn(field, 'value')) continue;
    const value: unknown = field.value;
    if (value === null || typeof value !== 'object') account(1);
    else {
      const known = sizes.get(value);
      if (known !== undefined) account(known);
      else if (active.has(value))
        fail(
          location,
          'schema nesting exceeds the supported limit because the declaration contains a cycle',
        );
      else enter(value);
    }
  }
  return sizes.get(input)!;
}

/** One descriptor owns one budget across its actual normalization roots. */
export function createSchemaAdmission(): (
  input: unknown,
  location: string,
) => void {
  let remaining = maximumExpandedInputNodes;
  return (input, location) => {
    if (remaining < 1) tooLarge(location);
    // Use the existing OpenAPI grammar to mask annotations in a disposable
    // view. A property named "default" is still a schema; its default payload
    // is not. Annotation owners already validate shared JSON without expansion.
    const view = mapOpenApi(
      { components: { schemas: { Root: input } } },
      (value, context) => {
        if (context !== 'schema') return value;
        if (!opaqueSchemaKeys.some((key) => Object.hasOwn(value, key)))
          return value;
        const fields = Object.getOwnPropertyDescriptors(value);
        for (const key of opaqueSchemaKeys)
          if (Object.hasOwn(fields, key))
            fields[key] = {
              value: null,
              enumerable: fields[key]!.enumerable === true,
              configurable: true,
              writable: true,
            };
        return Object.create(null, fields) as Record<string, unknown>;
      },
      false,
    ) as { components: { schemas: { Root: unknown } } };
    remaining -= checkInputExpansion(
      view.components.schemas.Root,
      remaining,
      location,
    );
  };
}
