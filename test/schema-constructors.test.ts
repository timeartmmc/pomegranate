import assert from 'node:assert/strict';
import test from 'node:test';
import {
  invalid,
  report,
  validator,
  ValidationError,
  map,
  stringValue,
  union,
  nullValue,
  list,
  formats,
} from '../dist/runtime.js';
import type { Issues } from '../dist/runtime.js';
import { browserFile } from '../dist/runtime.browser.js';
void test('native facade rejects either invalid returns or recorded issues', () => {
  assert.equal(
    validator((_input, issues) => report(issues, 'bad', true)).safeParse(0)
      .success,
    false,
  );
  assert.equal(validator(() => invalid).safeParse(0).success, false);
  const dirty = validator((_input, issues) => {
    report(issues, 'bad', false);
    return 1;
  });
  assert.equal(dirty.safeParse(0).success, false);
  assert.throws(() => dirty.parse(0), ValidationError);
  assert.equal(Object.isFrozen(dirty), true);
});
void test('native maps, nullable unions and arrays copy and validate special keys', () => {
  const mapped = validator((input, issues) => map(input, issues, stringValue));
  const input: unknown = JSON.parse(
    '{"__proto__":"data","constructor":"field"}',
  );
  assert.deepEqual(mapped.parse(input), input);
  for (const value of [new Date(), [], JSON.parse('{"__proto__":42}')])
    assert.equal(mapped.safeParse(value).success, false);
  const nullable = validator((input, issues) =>
    union(input, issues, stringValue, nullValue),
  );
  assert.equal(nullable.parse(null), null);
  assert.equal(nullable.safeParse(3).success, false);
  const array = validator((input, issues) => list(input, issues, stringValue));
  const source = ['a'];
  assert.deepEqual(array.parse(source), source);
  assert.notEqual(array.parse(source), source);
});
void test('native facade preserves nested failure paths and aggregate item issues', () => {
  const array = validator((input, issues) => list(input, issues, stringValue));
  const result = array.safeParse([1, 2]);
  assert.equal(result.success, false);
  if (!result.success)
    assert.deepEqual(
      result.error.issues.map((issue) => issue.path),
      [[0], [1]],
    );
});

void test('browser File rejection is a type failure', () => {
  const issues: Issues = [];
  assert.equal(browserFile({ name: 'not a File' }, issues), invalid);
  assert.deepEqual(issues, [
    { path: [], message: 'expected a browser File', fatal: true },
  ]);
});

void test('date-time accepts ASCII case variants and rejects invalid calendar, time and zone neighbors', () => {
  for (const date of ['2000-02-29', '2024-02-29'])
    for (const t of ['T', 't'])
      for (const z of ['Z', 'z', '+23:59', '-00:00'])
        for (const fraction of ['', '.123456'])
          assert.equal(
            formats['date-time'](`${date}${t}23:59:59${fraction}${z}`),
            true,
          );
  for (const input of [
    '1900-02-29T23:59:59Z',
    '2023-02-29T23:59:59Z',
    '2024-02-29T24:00:00Z',
    '2024-02-29T23:60:00Z',
    '2024-02-29T23:59:60Z',
    '2024-02-29T23:59Z',
    '2024-02-29T23:59:59',
    '2024-02-29T23:59:59+24:00',
    '2024-02-29T23:59:59+23:60',
    '2024-02-29T23:59:59+0000',
    '2024-02-29 23:59:59Z',
    ' 2024-02-29T23:59:59Z',
    '2024-02-29T23:59:59Z extra',
    '2024-02-29T23:59:59.Z',
  ])
    assert.equal(formats['date-time'](input), false, input);
});
