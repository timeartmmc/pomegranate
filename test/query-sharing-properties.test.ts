import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { shareQueryData } from '../src/query-sharing.ts';

const names = ['__proto__', 'constructor', 'a', 'b', '', '0', 'value'];
type Entry = readonly [PropertyKey, PropertyDescriptor];

function descriptor(value: unknown): PropertyDescriptor {
  return { value, enumerable: true, writable: true, configurable: true };
}

function entries(value: object): Entry[] {
  return Reflect.ownKeys(value).map((key) => [
    key,
    Object.getOwnPropertyDescriptor(value, key)!,
  ]);
}

function rebuild(
  source: object,
  fields: readonly Entry[],
  extensible = Object.isExtensible(source),
): object {
  const prototype: unknown = Object.getPrototypeOf(source);
  assert.ok(prototype === null || typeof prototype === 'object');
  const result: object = Array.isArray(source)
    ? []
    : (Object.create(prototype) as object);
  for (const [key, field] of fields) Object.defineProperty(result, key, field);
  if (!extensible) Object.preventExtensions(result);
  return result;
}

function clone(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  return rebuild(
    value,
    entries(value).map(([key, field]) => {
      const child: unknown = field.value;
      return [key, { ...field, value: clone(child) }];
    }),
  );
}

// This model records observable data and metadata, rather than reproducing the
// sharing algorithm. Entry arrays make key order explicit; numeric leaves retain
// signed zero. Per-root reference IDs distinguish equal independent objects from
// aliases and cycles; subtree comparisons start with their own fresh ID map.
function snapshot(
  value: unknown,
  references = new Map<object, number>(),
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const known = references.get(value);
  if (known !== undefined) return { reference: known };
  const id = references.size;
  references.set(value, id);
  const prototype: unknown = Object.getPrototypeOf(value);
  return {
    id,
    array: Array.isArray(value),
    prototype,
    extensible: Object.isExtensible(value),
    fields: entries(value).map(([key, field]) => {
      const child: unknown = field.value;
      return [
        key,
        field.enumerable,
        field.writable,
        field.configurable,
        snapshot(child, references),
      ];
    }),
  };
}

function check(previous: unknown, next: unknown, label: string): void {
  const beforePrevious = snapshot(previous);
  const beforeNext = snapshot(next);
  const output = shareQueryData(previous, next);
  assert.deepEqual(snapshot(output), beforeNext, `${label}: output shape`);
  assert.deepEqual(snapshot(previous), beforePrevious, `${label}: previous`);
  assert.deepEqual(snapshot(next), beforeNext, `${label}: next`);
  const pending = [{ previous, next, output, path: '$' }];
  while (pending.length) {
    const part = pending.pop()!;
    if (part.next === null || typeof part.next !== 'object') continue;
    assert.ok(part.output !== null && typeof part.output === 'object');
    const prior =
      part.previous !== null && typeof part.previous === 'object'
        ? part.previous
        : undefined;
    if (prior && isDeepStrictEqual(snapshot(prior), snapshot(part.next))) {
      assert.equal(part.output, prior, `${label}: reuse ${part.path}`);
      continue;
    }
    for (const key of Reflect.ownKeys(part.next)) {
      const child: unknown = Object.getOwnPropertyDescriptor(
        part.next,
        key,
      )!.value;
      const old: unknown = prior
        ? Object.getOwnPropertyDescriptor(prior, key)?.value
        : undefined;
      const shared: unknown = Object.getOwnPropertyDescriptor(
        part.output,
        key,
      )!.value;
      pending.push({
        previous: old,
        next: child,
        output: shared,
        path: `${part.path}/${String(key)}`,
      });
    }
  }
}

void test('equal values with reordered fields preserve next key order and reuse equal children', () => {
  const previous = { a: { value: 1 }, b: 2 };
  check(previous, { b: 2, a: { value: 1 } }, 'reordered');
});

void test('reusing an old child preserves distinct next children across added and moved paths', () => {
  const previous = { a: { value: 1 } };
  for (const next of [
    { a: { value: 1 }, b: { value: 1 } },
    { b: { value: 1 }, a: { value: 1 } },
  ]) {
    check(previous, next, `distinct children ${Object.keys(next).join(',')}`);
    const output = shareQueryData(previous, next);
    assert.equal(output.a, previous.a);
    assert.equal(output.b, next.b);
    assert.notEqual(output.a, output.b);
  }
  // Moving the old child to b makes reusing it at a unsafe. This joint identity
  // case needs a direct control rather than the disjoint-tree reuse oracle.
  const moved = { a: { value: 1 }, b: previous.a };
  const output = shareQueryData(previous, moved);
  assert.equal(output, moved);
  assert.notEqual(output.a, output.b);
});

void test('sharing preserves both directions of an extensibility-only change', () => {
  check(
    { a: { value: 1 } },
    Object.preventExtensions({ a: { value: 1 } }),
    'closed',
  );
  check(
    Object.preventExtensions({ a: { value: 1 } }),
    { a: { value: 1 } },
    'open',
  );
});

void test('equal field values preserve independent writable and configurable changes', () => {
  for (const flag of ['writable', 'configurable'] as const) {
    const changed = Object.defineProperty({}, 'value', {
      ...descriptor(1),
      [flag]: false,
    });
    check({ value: 1 }, changed, flag);
    check(changed, { value: 1 }, `${flag} restored`);
  }
});

void test('sharing distinguishes nested signed-zero changes and reuses equal zero subtrees', () => {
  for (const [previous, next] of [
    [-0, 0],
    [0, -0],
  ] as const) {
    const label = Object.is(previous, -0) ? '-0 to +0' : '+0 to -0';
    check(
      { child: { value: previous } },
      { child: { value: next } },
      `object ${label}`,
    );
    check([[previous]], [[next]], `array ${label}`);
  }
  for (const zero of [-0, 0]) {
    const label = Object.is(zero, -0) ? '-0' : '+0';
    check(
      { child: { value: zero } },
      { child: { value: zero } },
      `equal object ${label}`,
    );
    check([[zero]], [[zero]], `equal array ${label}`);
    check(
      { child: { value: zero }, changed: 1 },
      { child: { value: zero }, changed: 2 },
      `partial object ${label}`,
    );
    check([[zero], 1], [[zero], 2], `partial array ${label}`);
  }
});

void test('edit-derived trees preserve complete shape and reuse every equal same-path subtree', () => {
  // Deliberately excludes aliases, cycles, accessors and special object classes.
  // The graph and generated-query integration tests retain those guarantees.
  const initialSeed = 0x706f6d;
  let seed = initialSeed;
  const random = (size: number): number => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % size;
  };
  function finish(value: object): object {
    const choice = random(12);
    if (choice === 0) return Object.freeze(value);
    if (choice === 1) return Object.seal(value);
    if (choice === 2) return Object.preventExtensions(value);
    if (choice === 3 && Array.isArray(value))
      Object.defineProperty(value, 'length', { writable: false });
    return value;
  }
  function tree(depth: number): unknown {
    const choice = random(depth === 0 ? 4 : 7);
    if (choice === 0) return null;
    if (choice === 1) return random(4) === 0 ? -0 : random(3);
    if (choice === 2) return random(2) === 0;
    if (choice === 3) return `s${random(3)}`;
    if (choice === 4)
      return finish(Array.from({ length: random(4) }, () => tree(depth - 1)));
    const value = Object.create(
      choice === 5 ? null : Object.prototype,
    ) as object;
    for (let count = random(4); count > 0; count--)
      Object.defineProperty(value, names[random(names.length)]!, {
        ...descriptor(tree(depth - 1)),
        writable: random(8) !== 0,
      });
    return finish(value);
  }
  function edit(value: unknown): unknown {
    if (value === null || typeof value !== 'object')
      return random(5) === 0 ? tree(2) : value;
    const choice = random(16);
    if (choice === 0) return tree(2);
    const array = Array.isArray(value);
    let fields = entries(value)
      .filter(([key]) => !array || key !== 'length')
      .map(([key, field]): Entry => {
        const child: unknown = field.value;
        return [key, { ...field, value: edit(child) }];
      });
    if (choice === 1) {
      const key = array ? String(fields.length) : names[random(names.length)]!;
      fields = fields.filter(([name]) => name !== key);
      fields.push([key, descriptor(tree(1))]);
    }
    if (choice === 2) fields.pop();
    if (choice === 3 && !array) fields.reverse();
    if ((choice === 4 || choice === 5) && fields.length) {
      const [key, field] = fields[0]!;
      const flag = choice === 4 ? 'writable' : 'configurable';
      fields[0] = [key, { ...field, [flag]: !field[flag] }];
    }
    if (array) {
      const length = Object.getOwnPropertyDescriptor(value, 'length')!;
      const writable = length.writable === true;
      fields.push([
        'length',
        {
          ...length,
          value: fields.length,
          writable: choice === 6 ? !writable : writable,
        },
      ]);
    }
    const extensible =
      choice === 7 ? !Object.isExtensible(value) : Object.isExtensible(value);
    return rebuild(value, fields, extensible);
  }
  for (let index = 0; index < 1_024; index++) {
    const pairSeed = seed >>> 0;
    const previous = tree(4);
    const next = index % 4 === 0 ? clone(previous) : edit(previous);
    check(
      previous,
      next,
      `seed ${initialSeed}, pair ${index}, state ${pairSeed}`,
    );
  }
});
