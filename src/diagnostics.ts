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
  return value as Record<string, unknown>;
}

export function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  location: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      fail(`${location}.${key}`, 'unsupported keyword');
  }
}

export function text(value: unknown, location: string): string {
  if (typeof value !== 'string' || value.length === 0)
    fail(location, 'expected a nonempty string');
  return value;
}

export function safeKey(value: string, location: string): string {
  if (['__proto__', 'prototype', 'constructor'].includes(value)) {
    fail(location, `unsupported object key ${JSON.stringify(value)}`);
  }
  return value;
}

export function contractField(value: string, location: string): string {
  safeKey(value, location);
  // Zod reads inherited properties, and TypeScript even rejects {} as
  // {toString?: string}. Supporting these fields needs an explicit own-property
  // type policy; weakening generated inputs would hide the contract instead.
  if (Object.hasOwn(Object.prototype, value))
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
  for (const key of ['title', 'description', 'summary']) {
    if (Object.hasOwn(value, key) && typeof value[key] !== 'string') {
      fail(`${location}.${key}`, 'expected a string');
    }
  }
}
