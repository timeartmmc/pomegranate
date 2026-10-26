import { fail, keys, record, safeKey, text } from './diagnostics.js';
import type { AuthTransport, Policy, PolicyVocabulary } from './model.js';

export function labels(input: unknown, location: string): readonly string[] {
  if (!Array.isArray(input) || input.length === 0)
    fail(location, 'expected a nonempty array of labels');
  // Programmatic callers can supply sparse arrays. Visit every slot so a hole
  // cannot become an unchecked label or generated client name.
  const result = Array.from(input, (label, index) =>
    text(label, `${location}[${index}]`),
  );
  if (new Set(result).size !== result.length) fail(location, 'duplicate label');
  return result;
}

export function surfaceNames(
  input: unknown,
  location: string,
): readonly string[] {
  const result = labels(input, location);
  // Each selected surface becomes client.<name>.*.ts. Lowercase names without
  // dots keep all entry/module paths distinct on case-insensitive filesystems.
  for (const name of result) {
    if (!/^[a-z][a-z0-9_-]{0,62}$/.test(name))
      fail(location, 'surface names must match [a-z][a-z0-9_-]{0,62}');
  }
  return result;
}

export function normalizeVocabulary(input: unknown): PolicyVocabulary {
  const location = 'x-pom-policy';
  const value = record(input, location);
  keys(value, ['version', 'auth', 'retry', 'timeout', 'surfaces'], location);
  if (value.version !== 2)
    fail(`${location}.version`, 'expected policy version 2');
  const auth = record(value.auth, `${location}.auth`);
  if (Object.keys(auth).length === 0)
    fail(`${location}.auth`, 'expected at least one auth label');
  const entries = Object.keys(auth)
    .sort()
    .map((label): readonly [string, AuthTransport] => {
      text(label, `${location}.auth`);
      safeKey(label, `${location}.auth.${label}`);
      const binding = record(auth[label], `${location}.auth.${label}`);
      keys(binding, ['transport'], `${location}.auth.${label}`);
      if (binding.transport !== 'none' && binding.transport !== 'bearer')
        fail(`${location}.auth.${label}.transport`, 'expected none or bearer');
      return [label, binding.transport];
    });
  return {
    version: 2,
    auth: Object.fromEntries(entries),
    retry: labels(value.retry, `${location}.retry`),
    timeout: labels(value.timeout, `${location}.timeout`),
    surfaces: surfaceNames(value.surfaces, `${location}.surfaces`),
  };
}

export function normalizeOperationPolicy(
  input: unknown,
  vocabulary: PolicyVocabulary,
  transport: AuthTransport,
  location: string,
): { policy: Policy; surfaces: readonly string[] } {
  const value = record(input, location);
  keys(value, ['auth', 'retry', 'timeout', 'surfaces'], location);
  const auth = text(value.auth, `${location}.auth`);
  if (!Object.hasOwn(vocabulary.auth, auth))
    fail(`${location}.auth`, `undeclared policy label ${JSON.stringify(auth)}`);
  if (vocabulary.auth[auth] !== transport)
    fail(
      `${location}.auth`,
      `auth label ${JSON.stringify(auth)} requires ${vocabulary.auth[auth]} transport but effective OpenAPI security requires ${transport}`,
    );
  const selection = (field: 'retry' | 'timeout'): string => {
    const label = text(value[field], `${location}.${field}`);
    if (!vocabulary[field].includes(label))
      fail(
        `${location}.${field}`,
        `undeclared policy label ${JSON.stringify(label)}`,
      );
    return label;
  };
  const surfaces = surfaceNames(value.surfaces, `${location}.surfaces`);
  for (const surface of surfaces) {
    if (!vocabulary.surfaces.includes(surface))
      fail(
        `${location}.surfaces`,
        `undeclared surface ${JSON.stringify(surface)}`,
      );
  }
  return {
    policy: {
      auth: { label: auth, transport },
      retry: selection('retry'),
      timeout: selection('timeout'),
    },
    surfaces,
  };
}
