export class ContractError extends Error {
  constructor(
    readonly location: string,
    detail: string,
  ) {
    super(`${location}: ${detail}`);
    this.name = 'ContractError';
  }
}

export function fail(location: string, detail: string): never {
  throw new ContractError(location, detail);
}

export type CompileWarning = Readonly<{
  code: 'ignored-schema-keyword';
  path: string;
  message: string;
}>;

export type WarnSchema = (path: string, message: string) => void;

// Reasons contain only supported keyword/type names, never source paths. One
// exporter template can repeat thousands of times without flooding diagnostics.
export function schemaWarnings() {
  const groups = new Map<string, { path: string; count: number }>();
  return {
    warn: (path: string, message: string): void => {
      const previous = groups.get(message);
      if (previous) previous.count++;
      else groups.set(message, { path, count: 1 });
    },
    values(): CompileWarning[] {
      return [...groups].map(([message, { path, count }]) => ({
        code: 'ignored-schema-keyword',
        path,
        message:
          message +
          (count > 1 ? ` (${count} occurrences; first location shown)` : ''),
      }));
    },
  };
}

// Model extensions must identify every pass that needs to handle the new kind.
export function assertNever(value: never): never {
  throw new Error('unhandled compiler variant', { cause: value });
}

type KeywordContext = 'schema' | 'info' | 'license';

function keywordDetail(allowed: readonly string[]): string {
  return `unsupported keyword; supported keys: ${allowed.length ? allowed.map((name) => JSON.stringify(name)).join(', ') : '(none)'}`;
}

class KeywordError extends ContractError {
  constructor(
    location: string,
    readonly allowed: readonly string[],
    readonly context: KeywordContext | undefined,
  ) {
    super(location, keywordDetail(allowed));
  }
}

// Lowering changes accepted syntax before canonical validation. Keep the owning
// grammar's key list structured so a source dialect can present its own spelling
// without parsing messages or changing which declarations pass validation.
export function mapKeywordError(
  error: unknown,
  mapper: (
    allowed: readonly string[],
    context: KeywordContext | undefined,
  ) => readonly string[],
): unknown {
  if (!(error instanceof KeywordError)) return error;
  const allowed = mapper(error.allowed, error.context);
  return allowed === error.allowed
    ? error
    : new ContractError(error.location, keywordDetail(allowed));
}

// Compiler inputs are plain data: every own string key of a source object is a
// declaration, whatever its enumerability, and inherited keys never are. A
// record is a detached null-prototype view that enumerates all of those keys,
// so every pass can enumerate, spread and reject unknown keys the same way.
// Accessors stay accessors: taking a view neither invokes a getter nor mutates
// the caller's object.
export function ownDescriptors(value: object): PropertyDescriptorMap {
  const descriptors: PropertyDescriptorMap =
    Object.getOwnPropertyDescriptors(value);
  for (const key of Object.getOwnPropertyNames(descriptors))
    descriptors[key]!.enumerable = true;
  return descriptors;
}

// Only compiler-created views may skip normalization. Caller-owned records can
// also have null prototypes while still containing hidden declarations.
const ownViews = new WeakSet<object>();

export function createOwnRecord(
  descriptors: PropertyDescriptorMap = {},
): Record<string, unknown> {
  const view = Object.create(null, descriptors) as Record<string, unknown>;
  ownViews.add(view);
  return view;
}

export function ownRecord<T extends object>(value: T): T {
  return ownViews.has(value)
    ? value
    : (createOwnRecord(ownDescriptors(value)) as T);
}

export function record(
  value: unknown,
  location: string,
): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(location, 'expected an object');
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail(location, 'expected a plain object');
  }
  return ownRecord(value as Record<string, unknown>);
}

export function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
  context?: KeywordContext,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new KeywordError(`${location}.${key}`, allowed, context);
  }
}

export function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0)
    fail(location, 'expected a nonempty string');
  return value;
}

export function stringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (let index = 0; index < value.length; index++)
    if (!Object.hasOwn(value, index) || typeof value[index] !== 'string')
      return false;
  return true;
}

// A source array hole is missing data, even if a prototype supplies that index.
export function* arrayValues(
  value: readonly unknown[],
): IterableIterator<unknown> {
  for (let index = 0; index < value.length; index++)
    yield Object.hasOwn(value, index) ? value[index] : undefined;
}

export function wellFormedUnicode(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

export function validHeaderName(name: string): boolean {
  return name.length > 0 && !/[^!#$%&'*+.^_`|~0-9A-Za-z-]/.test(name);
}

export function validComponentName(name: string): boolean {
  return name.length > 0 && !/[^A-Za-z0-9._-]/.test(name);
}

export function safeKey(value: string, location: string): string {
  if (['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail(location, `unsupported object key ${JSON.stringify(value)}`);
  }
  return value;
}

const objectPrototypeFields = new Set([
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  'toString',
  'valueOf',
]);

export function contractField(value: string, location: string): string {
  safeKey(value, location);
  // Fixed parsers read inherited properties, and TypeScript even rejects {} as
  // {toString?: string}. Supporting these fields needs an explicit own-property
  // type policy; weakening generated inputs would hide the contract instead.
  // This policy must not change when another library adds a prototype property.
  if (objectPrototypeFields.has(value))
    fail(
      location,
      'Object.prototype property names are unsupported as contract fields',
    );
  return value;
}

export function annotations(
  value: Record<string, unknown>,
  location: string,
): void {
  stringFields(value, ['title', 'description', 'summary'], location);
}

export function stringFields(
  value: Record<string, unknown>,
  names: readonly string[],
  location: string,
): void {
  for (const name of names)
    if (Object.hasOwn(value, name) && typeof value[name] !== 'string')
      fail(`${location}.${name}`, 'expected a string');
}
