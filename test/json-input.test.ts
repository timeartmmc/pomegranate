import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseJson } from '../dist/json.js';
import { json } from './assertions.ts';
import { fileSnapshot, fixture, temporary } from './helpers.ts';

void test('JSON duplicate detection compares decoded keys within each object', () => {
  for (const source of [
    '{"key": 1, "key": 2}',
    '{"key": 1, "k\\u0065y": 2}',
    '{"/item": {}, "\\/item": {}}',
    '{"": 1, "": 2}',
    '{"__proto__": {}, "__proto__": {}}',
    '{"constructor": {}, "constructor": {}}',
    '{"outer": [{"inner": 1, "inner": 2}]}',
    '{"a\\\"b": 1, "a\\u0022b": 2}',
    '{"😀": 1, "\\ud83d\\ude00": 2}',
  ]) {
    assert.throws(
      () => parseJson(source, 'input.json'),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(
          error.message,
          /^input.json:1:\d+: invalid JSON: duplicate key /,
        );
        return true;
      },
    );
  }
  assert.throws(
    () => parseJson('{\n  "key": 1,\n  "key": 2\n}', 'input.json'),
    /input.json:3:3: invalid JSON: duplicate key "key"/,
  );
});

void test('JSON scanning preserves native values, escaped punctuation and separate object scopes', () => {
  for (const source of [
    'null',
    'true',
    '12.5',
    '-0',
    '"scalar"',
    '{"a":[{"key":1},{"key":2}],"b":{"key":3}}',
    '{"key":["key",{},["key"],{"key":1}],"next":2}',
    '{"left":{},"right":[],"text":"{ \\\"key\\\": \\\"value\\\", [ ] }"}',
    '{"slash\\\\": "\\\\\\\"", "quote\\\"": "[,:{}]"}',
    '{"__proto__":{"safe":true},"constructor":null}',
    '{"é":1,"é":2,"A":3,"a":4}',
    '{"text":"\u0085 \u2028 \u2029 \\ud800", "n":9007199254740993}',
  ]) {
    assert.deepEqual(parseJson(source, 'input.json'), json(source));
  }
});

void test('JSON scanning preserves the native parser across nested values and escaped key vocabularies', () => {
  const keys = [
    '',
    '__proto__',
    'constructor',
    'quote"slash\\',
    '[,:{}]',
    '😀',
    '\ud800',
    '\u0000',
    'line\nbreak',
    'é',
    'é',
  ];
  const values = [
    null,
    true,
    false,
    0,
    -0,
    1.25,
    Number.MAX_VALUE,
    '',
    '{"key":[1,2]}',
    '\\"',
    '😀',
    '\ud800',
    '\u2028',
  ];
  for (const key of keys) {
    for (const value of values) {
      const entry = Object.fromEntries([[key, value]]);
      const source = JSON.stringify({
        first: entry,
        nested: [entry, { second: entry }],
      });
      for (const prefix of ['', '\ufeff'])
        assert.deepEqual(
          parseJson(`${prefix}${source}`, 'nested.json'),
          json(source),
        );
    }
    // Escape code units, retaining both surrogates in astral keys. A second
    // spelling of the same decoded key must fail at every object/array depth.
    const escaped = `"${key
      .split('')
      .map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, '0')}`)
      .join('')}"`;
    for (const depth of [0, 1, 8, 32]) {
      let source = `{${JSON.stringify(key)}:1,${escaped}:2}`;
      for (let index = 0; index < depth; index++)
        source = index % 2 === 0 ? `[${source}]` : `{"scope":${source}}`;
      assert.throws(
        () => parseJson(`\ufeff${source}`, 'duplicate.json'),
        (error) => {
          assert.ok(error instanceof ContractError);
          assert.match(error.location, /^duplicate\.json:1:\d+$/);
          assert.ok(
            error.message.endsWith(
              `invalid JSON: duplicate key ${JSON.stringify(key)}`,
            ),
          );
          return true;
        },
      );
    }
  }
});

void test('JSON syntax remains strict before the duplicate scan', () => {
  for (const source of [
    '{',
    '{"key":1,}',
    '// comment\n{}',
    '{key:1}',
    "{'key':1}",
    '{"number":01}',
    '{"text":"\\x61"}',
    '{} {}',
    '\ufeff\ufeff{}',
    ' \ufeff{}',
  ]) {
    assert.throws(() => parseJson(source, 'input.json'), /invalid JSON/);
  }
});

void test('JSON accepts one leading BOM and retains original diagnostic positions', () => {
  for (const source of [
    '{}',
    'null',
    'false',
    '0',
    '"text"',
    '{"nested":[1,2]}',
  ])
    assert.deepEqual(parseJson(`\ufeff${source}`, 'bom.json'), json(source));
  assert.throws(
    () => parseJson('\ufeff{"a":1,"a":2}', 'bom.json'),
    /bom.json:1:9: invalid JSON: duplicate key "a"/,
  );
  assert.throws(
    () => parseJson('\ufeff{\n  "a":1,\n  "a":2\n}', 'bom.json'),
    /bom.json:3:3: invalid JSON: duplicate key "a"/,
  );
  assert.throws(
    () => parseJson('\ufeff{\n "key": }', 'bom.json'),
    /bom.json:\d+:\d+: invalid JSON/,
  );
});

void test('BOM-prefixed JSON inputs and configuration generate and check without altering inputs', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const source = JSON.stringify(fixture());
  const settings = JSON.stringify({
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    clients: ['consumer', 'staff'],
  });
  await writeFile(input, `\ufeff${source}`);
  await writeFile(config, `\ufeff${settings}`);
  const before = await fileSnapshot(root);
  await runProject(config);
  const output = join(root, 'generated');
  const generated = await fileSnapshot(output);
  assert.equal((await runProject(config, { check: true })).clean, true);
  assert.deepEqual(await fileSnapshot(output), generated);
  assert.deepEqual(await fileSnapshot(root), before);
  for (const [contract, configuration] of [
    [`\ufeff${source.slice(0, -1)},"openapi":"3.1.0"}`, `\ufeff${settings}`],
    [`\ufeff${source}`, `\ufeff${settings.slice(0, -1)},"version":2}`],
  ] satisfies [string, string][]) {
    await writeFile(input, contract);
    await writeFile(config, configuration);
    const invalid = await fileSnapshot(root);
    for (const check of [false, true]) {
      await assert.rejects(
        runProject(config, { check }),
        /invalid JSON: duplicate key/,
      );
      assert.deepEqual(await fileSnapshot(root), invalid);
      assert.deepEqual(await fileSnapshot(output), generated);
    }
  }
});

void test('duplicate JSON paths, responses and configuration reject before outputs change', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  const document = fixture();
  const source = JSON.stringify(document);
  const configuration = JSON.stringify({
    version: 2,
    openapi: './openapi.json',
    output: './generated',
    clients: ['consumer', 'staff'],
  });
  await writeFile(input, source);
  await writeFile(config, configuration);
  await runProject(config);
  const before = await fileSnapshot(output);
  const lostOperation = {
    ...document.paths['/api/staff/reports'].get,
    operationId: 'silentlyDroppedOperation',
  };
  const duplicatedPath = source.replace(
    '"paths":{',
    `"paths":{"/api/staff/reports":${JSON.stringify({ post: lostOperation })},`,
  );
  // Native JSON parsing silently deletes this operation, producing an otherwise
  // valid contract. The file loader must diagnose it before that loss escapes.
  assert.deepEqual(json(duplicatedPath), document);
  await compile(json(duplicatedPath), { clients: ['consumer', 'staff'] });
  for (const [contract, settings] of [
    [duplicatedPath, configuration],
    [
      source.replace(
        '"responses":{',
        '"responses":{"200":{"description":"Lost response"},',
      ),
      configuration,
    ],
    [
      source,
      configuration.replace(
        '"output":',
        '"output":"./elsewhere","out\\u0070ut":',
      ),
    ],
  ] satisfies [string, string][]) {
    await writeFile(input, contract);
    await writeFile(config, settings);
    const inputs = await fileSnapshot(root);
    for (const check of [false, true]) {
      await assert.rejects(
        runProject(config, { check }),
        /invalid JSON: duplicate key/,
      );
      assert.deepEqual(await fileSnapshot(output), before);
      assert.deepEqual(await fileSnapshot(root), inputs);
    }
  }
});

void test('JSON loading retains deeply nested opaque annotations without recursive scanning', async (t) => {
  const root = await temporary(t);
  const document = fixture();
  Object.assign(document.components.schemas.Widget, {
    example: 'DEEP_ANNOTATION',
  });
  const source = JSON.stringify(document).replace(
    '"DEEP_ANNOTATION"',
    `${'['.repeat(10000)}{"key":"value"}${']'.repeat(10000)}`,
  );
  await writeFile(join(root, 'openapi.json'), source);
  const config = join(root, 'pom.json');
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
  const expected = await compile(fixture(), { clients: ['consumer'] });
  for (const [name, text] of Object.entries(expected))
    assert.equal(await readFile(join(root, 'generated', name), 'utf8'), text);
});
