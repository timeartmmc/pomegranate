import assert from 'node:assert/strict';
import { jsonResponseExpected, jsonResponseInput } from './json-response.ts';

// The contract/preflight case remains v2. This separately versions measured
// data construction and consumption; old reports describe their prior profile.
export const jsonResponseRuntime = Object.freeze({
  id: 'json-response-runtime',
  version: 1,
});
export const scenarios = [
  'parsed-valid',
  'json-valid',
  'parsed-invalid-first',
  'parsed-invalid-last',
  'parsed-invalid-many',
] as const;
export type Scenario = (typeof scenarios)[number];
export interface RuntimeProfile {
  readonly scenario: Scenario;
  readonly records: number;
}
export const poolSize = 64;
// At most 16 independent invalid leaves. This workflow requires all those paths
// and stays below POM's documented 100-issue cap; overflow is a different profile.
const manyErrors = 16;

export const defaultProfiles: readonly RuntimeProfile[] = Object.freeze([
  { scenario: 'parsed-valid', records: 2 },
  { scenario: 'json-valid', records: 2 },
  { scenario: 'parsed-invalid-last', records: 2 },
]);

export const collectionProfiles: readonly RuntimeProfile[] = Object.freeze(
  [0, 1, 16, 128].flatMap((records): RuntimeProfile[] => [
    { scenario: 'parsed-valid', records },
    { scenario: 'json-valid', records },
    ...(records > 0
      ? [
          { scenario: 'parsed-invalid-first' as const, records },
          { scenario: 'parsed-invalid-last' as const, records },
        ]
      : []),
    ...(records > 1
      ? [{ scenario: 'parsed-invalid-many' as const, records }]
      : []),
  ]),
);

export function runtimeProfiles(value: unknown): RuntimeProfile[] {
  assert.ok(
    Array.isArray(value) && value.length > 0 && value.length <= 32,
    'profiles: expected between 1 and 32 explicit selections',
  );
  const profiles = value.map((entry: unknown): RuntimeProfile => {
    assert.ok(
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
    assert.deepEqual(Object.keys(entry).sort(), ['records', 'scenario']);
    const scenario: unknown = Reflect.get(entry, 'scenario');
    const records: unknown = Reflect.get(entry, 'records');
    assert.ok(
      typeof scenario === 'string' && scenarios.includes(scenario as Scenario),
      'unknown runtime scenario',
    );
    assert.ok(
      typeof records === 'number' &&
        Number.isSafeInteger(records) &&
        records >= 0 &&
        records <= 128,
      'records: expected an integer between 0 and 128',
    );
    assert.ok(
      !scenario.startsWith('parsed-invalid-') ||
        records >= (scenario === 'parsed-invalid-many' ? 2 : 1),
      'invalid profiles require records, and many requires at least two',
    );
    return { scenario: scenario as Scenario, records };
  });
  assert.equal(
    new Set(profiles.map(profileKey)).size,
    profiles.length,
    'profiles must be unique',
  );
  return profiles;
}

export function profileKey(profile: RuntimeProfile): string {
  return `${profile.scenario}-${profile.records}`;
}

function repeat<T extends { id: number; label: string }>(
  templates: readonly T[],
  count: number,
  offset: number,
): T[] {
  return Array.from({ length: count }, (_, index) => {
    const value = structuredClone(templates[index % templates.length]!);
    value.id = offset + index + 1;
    value.label += ` ${offset}`;
    return value;
  });
}

export function runtimePool(seed: number, profile: RuntimeProfile) {
  runtimeProfiles([profile]);
  assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffffffff);
  return Array.from({ length: poolSize }, (_, variant) => {
    const source = jsonResponseInput();
    const visible = jsonResponseExpected();
    const offset = (seed % 1024) * 128 + variant * profile.records;
    // Expected rows come from the independent hand-written visible fixture,
    // never from a schema projector or a candidate's output.
    const expected = {
      ...visible,
      items: repeat(visible.items, profile.records, offset),
    };
    const input = {
      ...source,
      items: repeat(source.items, profile.records, offset),
    };
    const positions =
      profile.scenario === 'parsed-invalid-first'
        ? [0]
        : profile.scenario === 'parsed-invalid-last'
          ? [profile.records - 1]
          : profile.scenario === 'parsed-invalid-many'
            ? Array.from(
                { length: Math.min(profile.records, manyErrors) },
                (_, index) => index,
              )
            : [];
    for (const position of positions)
      input.items[position]!.details.tags = [''];
    const paths = positions.map(
      (position) => ['items', position, 'details', 'tags', 0] as const,
    );
    return { input, expected, paths, text: JSON.stringify(input) };
  });
}
