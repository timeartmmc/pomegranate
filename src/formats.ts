import { constraintRecord } from './schema-node.js';
import type { Constraints } from './model.js';
import type { StringFormat } from './runtime.js';

// Compiler metadata stays separate from copied runtime predicates so selecting
// one format does not retain every format helper in generated applications.
export const stringFormatHelpers = {
  int64: 'int64StringFormat',
  byte: 'byteFormat',
  date: 'dateFormat',
  'date-time': 'dateTimeFormat',
  uuid: 'uuidFormat',
  email: 'emailFormat',
  uri: 'uriFormat',
  ipv4: 'ipv4Format',
  ipv6: 'ipv6Format',
} satisfies Record<StringFormat, keyof typeof import('./runtime.js')>;

const numericFormats: Readonly<
  Record<'number' | 'integer', ReadonlyMap<string, Constraints>>
> = {
  number: new Map([
    ['float', constraintRecord({ float: true })],
    ['double', constraintRecord()],
  ]),
  integer: new Map([
    [
      'int32',
      constraintRecord({ minimum: -2_147_483_648, maximum: 2_147_483_647 }),
    ],
    // Numeric int64 uses the exactly representable safe-integer range.
    [
      'int64',
      constraintRecord({
        minimum: Number.MIN_SAFE_INTEGER,
        maximum: Number.MAX_SAFE_INTEGER,
      }),
    ],
  ]),
};

export function numericFormatRules(
  kind: 'number' | 'integer',
  name: string,
): Constraints | undefined {
  const rules = numericFormats[kind];
  return rules.get(name);
}

export function builtInFormat(name: string): boolean {
  return (
    Object.hasOwn(stringFormatHelpers, name) ||
    numericFormats.integer.has(name) ||
    numericFormats.number.has(name) ||
    name === 'binary' ||
    name === 'password'
  );
}

function alternatives(names: readonly string[]): string {
  return `${names.slice(0, -1).join(', ')} or ${names.at(-1)}`;
}

export const numericFormatMessages = {
  number: `unsupported numeric format; number schemas support ${alternatives([...numericFormats.number.keys()])}`,
  integer: `unsupported integer format; expected ${alternatives([...numericFormats.integer.keys()])}`,
};
export const expectedStringFormats = alternatives([
  ...Object.keys(stringFormatHelpers),
  'password',
]);
