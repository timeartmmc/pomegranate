import assert from 'node:assert/strict';

export function record(value: unknown): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
  );
  return value as Record<string, unknown>;
}

export function json(source: string): unknown {
  return JSON.parse(source) as unknown;
}

// Runtime tables and rejection tests cross generated input types with unknown
// data. Keep that boundary explicit; fixed valid calls and all returned values
// retain generated signatures. Consumer fixtures check static rejection.
export function runtimeInput<F extends (...args: never[]) => unknown>(
  build: F,
  input: unknown,
): ReturnType<F> {
  return (build as unknown as (input: unknown) => ReturnType<F>)(input);
}

export function invalidOptions<F extends (...args: never[]) => unknown>(
  call: F,
  input: Parameters<F>[0],
  options: unknown,
): ReturnType<F> {
  return (
    call as unknown as (
      input: Parameters<F>[0],
      options: unknown,
    ) => ReturnType<F>
  )(input, options);
}

export function entry<T extends object>(
  values: T,
  key: PropertyKey,
): T[keyof T] {
  assert.ok(
    Object.hasOwn(values, key),
    `Missing fixture entry: ${String(key)}`,
  );
  return values[key as keyof T];
}

export function present<T>(value: T): NonNullable<T> {
  assert.ok(value !== undefined && value !== null);
  return value;
}

export function member(value: unknown, key: PropertyKey): unknown {
  assert.ok(value !== null && typeof value === 'object');
  return Reflect.get(value, key) as unknown;
}

export function commandError(
  error: unknown,
): Error & { stdout: string; stderr: string; code: unknown } {
  assert.ok(error instanceof Error);
  const details = record(error);
  assert.ok(typeof details.stdout === 'string');
  assert.ok(typeof details.stderr === 'string');
  return error as Error & { stdout: string; stderr: string; code: unknown };
}

export function commandFailure(code: number, stderr: RegExp) {
  return (error: unknown): boolean => {
    const failure = commandError(error);
    return failure.code === code && stderr.test(failure.stderr);
  };
}

export function presentObject(value: unknown): object {
  assert.ok(value !== null && typeof value === 'object');
  return value;
}
