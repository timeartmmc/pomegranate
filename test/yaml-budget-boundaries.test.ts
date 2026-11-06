import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';

type Measure = { nodes: number; depth: number };

// Count the parsed JSON graph independently of YAML syntax. Memoization keeps
// alias sharing compact while each incoming edge contributes its expanded size.
function measure(value: unknown, memo: Map<object, Measure>): Measure {
  if (value === null || typeof value !== 'object')
    return { nodes: 1, depth: 0 };
  const known = memo.get(value);
  if (known) return known;
  const array = Array.isArray(value);
  const children: readonly unknown[] = array ? value : Object.values(value);
  let nodes = 1;
  let depth = 1;
  for (const child of children) {
    const result = measure(child, memo);
    nodes += result.nodes + (array ? 0 : 1); // A mapping key is a node too.
    depth = Math.max(depth, result.depth + 1);
  }
  const result = { nodes, depth };
  memo.set(value, result);
  return result;
}

function expandedNodes(target: number): string {
  const lines: string[] = [];
  let total = 1; // Root mapping.
  // Binary anchor values have odd size; each mapping entry then has even size.
  // A single two-node value supplies the opposite parity when needed.
  if (target % 2 === 0) {
    lines.push('padding: [0]');
    total += 3;
  }
  lines.push('a0: &a0 0');
  const sizes = [1];
  total += 2;
  for (;;) {
    const previous = sizes.length - 1;
    const size = 2 * sizes[previous]! + 1;
    if (total + size + 1 > target) break;
    lines.push(
      `a${previous + 1}: &a${previous + 1} [*a${previous}, *a${previous}]`,
    );
    sizes.push(size);
    total += size + 1;
  }
  let remaining = target - total;
  let copy = 0;
  for (let index = sizes.length - 1; index >= 0; index--) {
    const entrySize = sizes[index]! + 1;
    while (remaining >= entrySize) {
      lines.push(`copy${copy++}: *a${index}`);
      remaining -= entrySize;
    }
  }
  assert.equal(remaining, 0);
  return `${lines.join('\n')}\n`;
}

void test('YAML accepts the exact expanded-node limit and rejects its next node using a compact alias graph', () => {
  for (const count of [999_999, 1_000_000]) {
    const source = expandedNodes(count);
    assert.ok(Buffer.byteLength(source) < 2048);
    const memo = new Map<object, Measure>();
    assert.equal(measure(parseYaml(source, 'nodes.yaml'), memo).nodes, count);
    assert.ok(
      memo.size < 100,
      'aliases must stay shared instead of expanding a million objects',
    );
  }
  assert.throws(
    () => parseYaml(expandedNodes(1_000_001), 'nodes.yaml'),
    (error) =>
      error instanceof ContractError &&
      error.location.startsWith('nodes.yaml:') &&
      /expanded document exceeds the supported limit of 1000000 nodes/.test(
        error.message,
      ),
  );
});

function nestedCollections(depth: number): string {
  return `${'['.repeat(depth)}0${']'.repeat(depth)}`;
}

function aliasCollections(depth: number): string {
  const lines = ['- &a0 0'];
  // The root sequence supplies one level, each subsequent anchor one more.
  for (let index = 1; index < depth; index++)
    lines.push(`- &a${index} [*a${index - 1}]`);
  return `${lines.join('\n')}\n`;
}

for (const [name, source, reason] of [
  [
    'direct',
    nestedCollections,
    /collection nesting exceeds the supported limit of 256/,
  ],
  [
    'aliases',
    aliasCollections,
    /expanded collection nesting exceeds the supported limit of 256/,
  ],
] as const) {
  void test(`YAML ${name} accepts exactly 256 collection levels and rejects 257`, () => {
    for (const depth of [255, 256])
      assert.equal(
        measure(parseYaml(source(depth), 'depth.yaml'), new Map()).depth,
        depth,
      );
    assert.throws(
      () => parseYaml(source(257), 'depth.yaml'),
      (error) =>
        error instanceof ContractError &&
        error.location.startsWith('depth.yaml:') &&
        reason.test(error.message),
    );
  });
}
