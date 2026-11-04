import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile, ContractError, runProject } from '../dist/index.js';
import { fileSnapshot, fixture, temporary } from './helpers.ts';
import type { StandaloneModule } from './runtime-types.ts';

const rejectedPatterns = [
  ['inline modifiers', '(?i:abc)'],
  ['nested modifiers', 'a(?s:b.c)'],
  ['duplicate names', '(?<part>a)|(?<part>b)'],
  ['escaped duplicate names', '(?<\\u0061>x)|(?<a>y)'],
  ['Unicode 17 script', '\\p{Script=Beria_Erfe}'],
  ['Unicode 17 script extension alias', '\\p{scx=Sidt}'],
  ['Unicode 17 capture group name', '(?<\\u{16EA0}>x)'],
  ['Unicode sets syntax', '[\\q{ab}]'],
  ['legacy identity escape', '\\a'],
  ['unterminated class', '['],
  ['virtual script rejected by engines', '\\p{Script=Hrkt}'],
] as const;

for (const [name, pattern] of rejectedPatterns) {
  for (const context of ['component', 'reference', 'null-only'] as const) {
    void test(`${context} rejects ${name} before client selection`, async () => {
      const document = fixture();
      const schema =
        context === 'reference'
          ? { $ref: '#/components/schemas/WidgetId', pattern }
          : context === 'null-only'
            ? { type: ['string', 'null'], const: null, pattern }
            : { type: 'string', pattern };
      Object.assign(document.components.schemas, {
        UnsupportedPattern: schema,
      });
      await assert.rejects(
        compile(document, { clients: ['staff'] }),
        (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(
            error.location,
            'components.schemas.UnsupportedPattern.pattern',
          );
          assert.match(error.message, /ECMAScript 2024.*Unicode 16\.0/);
          return true;
        },
      );
    });
  }
}

for (const [pattern, offset, reason] of [
  ['[', 1, 'Unterminated character class'],
  ['a(?<name>b', 10, 'Unterminated group'],
  ['[z-a]', 4, 'Range out of order in character class'],
  ['(?<x>a)|(?<x>b)', 13, 'Duplicate capture group name'],
  ['💡[', 3, 'Unterminated character class'],
  ['x/u: injected[', 14, 'Unterminated character class'],
  ['a\n[', 3, 'Unterminated character class'],
] as const) {
  void test(`pattern diagnostics preserve the reason and UTF-16 offset for ${JSON.stringify(pattern)}`, async () => {
    const document = fixture();
    Object.assign(document.components.schemas, {
      MalformedPattern: { type: 'string', pattern },
    });
    await assert.rejects(compile(document, { clients: ['staff'] }), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(
        error.location,
        'components.schemas.MalformedPattern.pattern',
      );
      assert.ok(
        error.message.endsWith(`at UTF-16 offset ${offset}: ${reason}`),
      );
      assert.equal(error.message.includes('\n'), false);
      return true;
    });
  });
}

void test('native pattern rejection retains its reason without inventing an offset or echoing source', async () => {
  const document = fixture();
  Object.assign(document.components.schemas, {
    NativePattern: { type: 'string', pattern: '\\p{Script=Hrkt}' },
  });
  await assert.rejects(compile(document, { clients: ['staff'] }), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.NativePattern.pattern');
    assert.match(
      error.message,
      /Invalid property name|invalid property expression/,
    );
    assert.equal(error.message.includes('offset'), false);
    assert.equal(error.message.includes('Hrkt'), false);
    return true;
  });
});

void test('long malformed patterns retain a bounded diagnostic without source echo', async () => {
  const document = fixture();
  const pattern = 'a'.repeat(1024 * 1024) + '[';
  Object.assign(document.components.schemas, {
    LongPattern: { type: 'string', pattern },
  });
  await assert.rejects(compile(document, { clients: ['staff'] }), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'components.schemas.LongPattern.pattern');
    assert.ok(
      error.message.endsWith(
        `at UTF-16 offset ${pattern.length}: Unterminated character class`,
      ),
    );
    assert.ok(error.message.length < 300);
    assert.equal(error.message.includes('a'.repeat(64)), false);
    return true;
  });
});

void test('portable patterns execute in generated request and response roots without compiler dependencies', async (t) => {
  const root = await temporary(t);
  const cases = [
    { name: 'empty', pattern: '', valid: '', invalid: 42 },
    {
      name: 'constructorform',
      pattern: '^a/b\nc$',
      valid: 'a/b\nc',
      invalid: 'a/b c',
    },
    {
      name: 'unicode',
      pattern: '^\\p{Script=Todhri}+$',
      valid: '\u{105C0}',
      invalid: 'abc',
    },
    {
      name: 'unicodealias',
      pattern: '^\\p{scx=Todr}+$',
      valid: '\u{105C0}',
      invalid: 'abc',
    },
    {
      name: 'named',
      pattern: '^(?<\\u0061>a)\\k<a>$',
      valid: 'aa',
      invalid: 'ab',
    },
    {
      name: 'unicodegroup',
      pattern: '^(?<\\u{105C0}>a)\\k<\\u{105C0}>$',
      valid: 'aa',
      invalid: 'ab',
    },
    {
      name: 'lookaround',
      pattern: '(?<=prefix)[a-z]+(?=suffix)',
      valid: 'prefixmiddlesuffix',
      invalid: 'middle',
    },
    {
      name: 'negative',
      pattern: '^(?!bad)[a-z]+(?<!z)$',
      valid: 'okay',
      invalid: 'bad',
    },
    {
      name: 'unicodeclass',
      pattern: '^[a-z&&b]+$',
      valid: '&',
      invalid: 'A',
    },
  ];
  const document = fixture();
  Object.assign(
    document.components.schemas,
    Object.fromEntries(
      cases.map(({ name, pattern }) => [name, { type: 'string', pattern }]),
    ),
  );
  const files = await compile(document, {
    clients: [],
    standalone: Object.fromEntries(
      cases.flatMap(({ name }) =>
        (['request', 'response'] as const).map((usage) => [
          `${name}-${usage}`,
          { schema: `#/components/schemas/${name}`, usage },
        ]),
      ),
    ),
  });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
  for (const { name, valid, invalid } of cases) {
    for (const usage of ['request', 'response']) {
      const { schema } = (await import(
        pathToFileURL(join(root, `standalone.${name}-${usage}.ts`)).href
      )) as StandaloneModule;
      assert.equal(schema.parse(valid), valid, name);
      assert.equal(schema.safeParse(invalid).success, false, name);
    }
  }
});

void test('unsupported pattern syntax preserves existing outputs in generation and check', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  const document = fixture();
  await writeFile(input, JSON.stringify(document));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      clients: ['consumer'],
    }),
  );
  await runProject(config);
  const before = await fileSnapshot(output);
  Object.assign(document.components.schemas, {
    UnsupportedPattern: { type: 'string', pattern: '(?i:abc)' },
  });
  await writeFile(input, JSON.stringify(document));
  for (const check of [false, true]) {
    await assert.rejects(runProject(config, { check }), /ECMAScript 2024/);
    assert.deepEqual(await fileSnapshot(output), before);
  }
});
