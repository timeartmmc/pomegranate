import { isAlias, isMap, isScalar, LineCounter, parseDocument } from 'yaml';
import type { Alias, ParsedNode, Scalar } from 'yaml';
import { fail } from './diagnostics.js';
import type { JsonValue } from './runtime.js';

const maximumExpandedNodes = 1_000_000;
const maximumCollectionNesting = 256;
type CollectionNode = Exclude<ParsedNode, Alias | Scalar>;

function* children(node: ParsedNode): IterableIterator<ParsedNode | null> {
  if (isMap(node)) {
    for (const pair of node.items) {
      yield pair.key;
      yield pair.value;
    }
  } else if (!isScalar(node) && !isAlias(node)) {
    yield* node.items;
  }
}

export function parseYaml(source: string, path: string): unknown {
  const lines = new LineCounter();
  function at(offset: number, detail: string): never {
    const { line, col } = lines.linePos(offset);
    fail(`${path}:${line}:${col}`, `invalid YAML: ${detail}`);
  }
  const document = parseDocument(source, {
    version: '1.2',
    schema: 'core',
    // OpenAPI keys use the failsafe string rules, including numeric status keys.
    // Values still use YAML 1.2 types: strings are never coerced to fit a schema.
    stringKeys: true,
    uniqueKeys: true,
    strict: true,
    merge: false,
    resolveKnownTags: false,
    customTags: [],
    lineCounter: lines,
    prettyErrors: false,
  });
  // Unresolved tags/directives are warnings in the parser, but accepting their
  // fallback interpretation here could silently change the contract.
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem?.code === 'RESOURCE_EXHAUSTION')
    at(problem.pos[0], 'input exceeds the supported parser complexity limit');
  if (problem)
    at(
      problem.pos[0],
      problem.code === 'MULTIPLE_DOCS'
        ? 'expected a single document'
        : problem.message,
    );
  if (document.directives.yaml.version !== '1.2')
    at(0, 'only YAML 1.2 is supported');

  const anchors = new Map<string, ParsedNode>();
  const pending = new Set<ParsedNode>();
  const values = new WeakMap<ParsedNode, JsonValue>();
  const sizes = new WeakMap<ParsedNode, { size: number; depth: number }>();
  const stack: {
    node?: CollectionNode;
    values: Iterator<ParsedNode | null>;
    size: number;
    depth: number;
  }[] = [{ values: [document.contents].values(), size: 0, depth: 0 }];
  const valueOf = (node: ParsedNode | null): JsonValue =>
    node === null ? null : values.get(node)!;
  const account = (size: number, depth: number, offset: number): void => {
    const parent = stack[stack.length - 1]!;
    parent.size += size;
    parent.depth = Math.max(parent.depth, depth + (parent.node ? 1 : 0));
    if (parent.size > maximumExpandedNodes)
      at(
        offset,
        `expanded document exceeds the supported limit of ${maximumExpandedNodes} nodes`,
      );
    if (parent.depth > maximumCollectionNesting)
      at(
        offset,
        `expanded collection nesting exceeds the supported limit of ${maximumCollectionNesting}`,
      );
  };
  // Convert the core syntax tree once, retaining shared values. Account for
  // their expanded size/depth without expanding them: ordinary policy reuse
  // stays cheap, while alias bombs cannot multiply downstream schema work.
  // Resolving anchors here also avoids the parser's repeated alias-list scans.
  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    const next = frame.values.next();
    if (next.done) {
      stack.pop();
      if (frame.node) {
        const node = frame.node;
        const value: JsonValue = isMap(node)
          ? Object.fromEntries(
              node.items.map(({ key, value }) => {
                if (!isScalar(key) || typeof key.value !== 'string')
                  at(
                    key?.range[0] ?? node.range[0],
                    'mapping keys must be strings',
                  );
                return [key.value, valueOf(value)];
              }),
            )
          : node.items.map(valueOf);
        values.set(node, value);
        sizes.set(node, { size: frame.size, depth: frame.depth });
        pending.delete(node);
        account(frame.size, frame.depth, node.range[0]);
      }
      continue;
    }
    const node = next.value;
    if (!node) {
      account(1, 0, 0);
      continue;
    }
    if (isAlias(node)) {
      const target = anchors.get(node.source);
      if (!target) at(node.range[0], `unresolved alias ${node.source}`);
      if (pending.has(target))
        at(node.range[0], 'aliases must not create cycles');
      const size = sizes.get(target)!;
      values.set(node, values.get(target)!);
      account(size.size, size.depth, node.range[0]);
      continue;
    }
    if (node.anchor) anchors.set(node.anchor, node);
    if (isScalar(node)) {
      if (typeof node.value === 'number' && !Number.isFinite(node.value))
        at(node.range[0], 'numbers must be finite JSON values');
      const value: unknown = node.value;
      if (
        value !== null &&
        typeof value !== 'string' &&
        typeof value !== 'boolean' &&
        typeof value !== 'number'
      )
        at(node.range[0], 'scalars must be JSON values');
      values.set(node, value);
      sizes.set(node, { size: 1, depth: 0 });
      account(1, 0, node.range[0]);
      continue;
    }
    if (stack.length > maximumCollectionNesting)
      at(
        node.range[0],
        `collection nesting exceeds the supported limit of ${maximumCollectionNesting}`,
      );
    if (isMap(node)) {
      for (const { key } of node.items) {
        if (
          isScalar(key) &&
          key.value === '<<' &&
          key.type === 'PLAIN' &&
          !key.tag
        )
          at(
            key.range[0],
            'merge keys are unsupported; expand the mapping or quote a literal << key',
          );
      }
    }
    pending.add(node);
    stack.push({ node, values: children(node), size: 1, depth: 1 });
  }
  return valueOf(document.contents);
}
