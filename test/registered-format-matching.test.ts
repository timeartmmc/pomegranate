import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const formats = {
  currency: { type: 'string', pattern: 'USD' },
  alternative: { type: 'string', pattern: 'a|abc' },
  lazy: { type: 'string', pattern: 'a*?' },
  named: { type: 'string', pattern: String.raw`(?<part>[a-z])\k<part>` },
  numbered: { type: 'string', pattern: String.raw`([a-z])\1` },
  newline: { type: 'string', pattern: String.raw`USD\n` },
  unicode: { type: 'string', pattern: String.raw`\p{L}+` },
} as const;

function fixture() {
  const schemas: Record<string, Schema> = Object.fromEntries(
    Object.keys(formats).map((name) => [
      name,
      { type: 'string', format: name },
    ]),
  );
  schemas['search'] = { type: 'string', pattern: 'USD' };
  schemas['intersection'] = {
    type: 'string',
    format: 'currency',
    pattern: 'S',
  };
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic whole-value format predicates', version: '1' },
    paths: {},
    components: { schemas },
  };
}
const standalone = Object.fromEntries(
  [...Object.keys(formats), 'search', 'intersection'].map((name) => [
    name,
    { schema: `#/components/schemas/${name}`, usage: 'response' as const },
  ]),
);
const selection = { clients: [], formats, standalone };

void test('registered formats match complete values while preserving alternatives, quantifiers and backreferences', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const cases: readonly [string, readonly string[], readonly string[]][] = [
    ['currency', ['USD'], ['', 'xxUSDxx', 'USD\n', 'USD\r\n']],
    ['alternative', ['a', 'abc'], ['ab', 'abcd', 'xabc', 'abc\n']],
    ['lazy', ['', 'a', 'aaa'], ['aaab', 'baaa', 'aaa\n']],
    ['named', ['aa', 'zz'], ['ab', 'aaa', 'xaa', 'aa\n']],
    ['numbered', ['aa', 'zz'], ['ab', 'aaa', 'xaa', 'aa\n']],
    ['newline', ['USD\n'], ['USD', 'USD\r\n', 'xUSD\n', 'USD\n\n']],
    ['unicode', ['abc', 'Éclair'], ['1abc', 'abc1', 'abc\n']],
  ];
  for (const [name, accepted, rejected] of cases) {
    const module = await importGenerated<StandaloneModule>(
      root,
      `standalone.${name}.ts`,
    );
    for (const value of accepted)
      assert.equal(module.schema.parse(value), value, name);
    for (const value of rejected)
      assert.equal(
        module.schema.safeParse(value).success,
        false,
        `${name}: ${JSON.stringify(value)}`,
      );
  }
  const search = await importGenerated<StandaloneModule>(
    root,
    'standalone.search.ts',
  );
  assert.equal(search.schema.parse('xxUSDxx'), 'xxUSDxx');
  const intersection = await importGenerated<StandaloneModule>(
    root,
    'standalone.intersection.ts',
  );
  assert.equal(intersection.schema.parse('USD'), 'USD');
  assert.equal(intersection.schema.safeParse('xxUSDxx').success, false);
});

void test('compile-time literal validation uses the same whole-value format semantics', async () => {
  for (const value of ['xxUSDxx', 'USD\n']) {
    const document = fixture();
    document.components.schemas['UnusedLiteral'] = {
      type: 'string',
      format: 'currency',
      const: value,
    };
    await assert.rejects(
      compile(document, selection),
      /literal violates declared currency format/,
    );
  }
  const document = fixture();
  Object.assign(document.components.schemas, {
    AlternativeLiteral: { type: 'string', format: 'alternative', const: 'abc' },
    LazyLiteral: { type: 'string', format: 'lazy', const: 'aaa' },
    NamedLiteral: { type: 'string', format: 'named', const: 'aa' },
    NumberedLiteral: { type: 'string', format: 'numbered', const: 'aa' },
    SearchLiteral: { type: 'string', pattern: 'USD', const: 'xxUSDxx' },
  });
  await compile(document, selection);
});
