import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { fileSnapshot, fixture, preparation, temporary } from './helpers.mjs';
import { annotateDocument } from './metadata-fixture.mjs';
import { multipartFixture, multipartSelection } from './multipart-fixture.mjs';
import { schemaFixture, standaloneSelection } from './schema-fixture.mjs';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const selection = { clients: ['consumer', 'staff'] };

async function project(t, source, options = selection, name = 'openapi.yaml') {
  const root = await temporary(t);
  const input = join(root, name);
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  await writeFile(input, source);
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: `./${name}`,
      output: './generated',
      ...options,
    }),
  );
  return { root, input, config, output };
}

test('YAML and JSON generate identical complete client and standalone outputs', async (t) => {
  const fetch = t.mock.method(globalThis, 'fetch', () => {
    throw new Error('local inputs must not fetch');
  });
  for (const [document, options, name] of [
    [annotateDocument(fixture()), selection, 'openapi.yaml'],
    [
      schemaFixture(),
      { clients: ['samples'], standalone: standaloneSelection },
      'openapi.yml',
    ],
    [multipartFixture(), multipartSelection, 'openapi.YAML'],
  ]) {
    const source = stringify(document);
    const { root, input, config, output } = await project(
      t,
      source,
      options,
      name,
    );
    const inputs = await fileSnapshot(root);
    await runProject(config);
    const generated = await fileSnapshot(output);
    const expected = await compile(
      JSON.parse(JSON.stringify(document)),
      options,
    );
    assert.deepEqual(
      Object.keys(generated).sort(),
      [...Object.keys(expected), '.pom-manifest.json'].sort(),
    );
    for (const [name, text] of Object.entries(expected))
      assert.equal(generated[name].source, text, name);
    assert.equal((await runProject(config, { check: true })).clean, true);
    assert.deepEqual(await fileSnapshot(output), generated);
    assert.deepEqual(await fileSnapshot(root), inputs);
    assert.equal(await readFile(input, 'utf8'), source);
  }
  assert.equal(fetch.mock.callCount(), 0);
});

test('handwritten YAML preserves scalar types, comments, block strings and shared schemas', async (t) => {
  // This expectation is authored independently of the YAML serializer/parser.
  const word = {
    type: 'string',
    enum: ['on', 'off', 'yes', 'no', '2026-10-25'],
  };
  const value = {
    type: 'object',
    required: ['word', 'enabled', 'note'],
    additionalProperties: false,
    properties: {
      word,
      copy: word,
      enabled: { type: 'boolean' },
      note: { type: ['string', 'null'] },
      count: { type: 'integer', minimum: 16, maximum: 20 },
    },
  };
  const document = {
    openapi: '3.1.2',
    info: {
      title: 'Synthetic YAML',
      version: '1',
      description: 'Folded text.',
    },
    'x-pom-policy': {
      version: 2,
      auth: { public: { transport: 'none' } },
      retry: ['never'],
      timeout: ['interactive'],
      surfaces: ['consumer'],
    },
    components: { schemas: { Value: value } },
    paths: {
      '/values': {
        post: {
          operationId: 'writeValue',
          'x-pom': {
            auth: 'public',
            retry: 'never',
            timeout: 'interactive',
            surfaces: ['consumer'],
          },
          requestBody: {
            required: true,
            content: { 'application/json': { schema: value } },
          },
          responses: {
            200: {
              description: 'Stored.\nSynthetic.\n',
              content: { 'application/json': { schema: value } },
            },
          },
        },
      },
    },
  };
  const source = `%YAML 1.2
---
# A fully synthetic contract with no external references.
openapi: 3.1.2
info:
  title: Synthetic YAML
  version: "1"
  description: >-
    Folded
    text.
x-pom-policy:
  version: 2
  auth: {public: {transport: none}}
  retry: [never]
  timeout: [interactive]
  surfaces: [consumer]
components:
  schemas:
    Value: &value
      type: object
      required: [word, enabled, note]
      additionalProperties: false
      properties:
        word: &word {type: string, enum: [on, off, yes, no, 2026-10-25]}
        copy: *word
        enabled: {type: boolean}
        note: {type: [string, "null"]}
        count: {type: integer, minimum: 0x10, maximum: 2e1}
paths:
  /values:
    post:
      operationId: writeValue
      x-pom: {auth: public, retry: never, timeout: interactive, surfaces: [consumer]}
      requestBody:
        required: true
        content:
          application/json:
            schema: *value
      responses:
        200:
          description: |
            Stored.
            Synthetic.
          content:
            application/json:
              schema: *value
...
`;
  assert.deepEqual(parseYaml(source, 'synthetic.yaml'), document);
  const options = { clients: ['consumer'] };
  const { config, output } = await project(t, source, options);
  await runProject(config);
  for (const [name, source] of Object.entries(await compile(document, options)))
    assert.equal(await readFile(join(output, name), 'utf8'), source);
});

test('JSON-compatible explicit tags, string keys and anchor shadowing keep their values', () => {
  const source = `200: !!str false
01: yes
true: no
null: ~
str: !!str 12
int: !!int 12
float: !!float 12.5
bool: !!bool true
nil: !!null null
map: !!map {}
seq: !!seq []
first: &value one
firstCopy: *value
second: &value two
secondCopy: *value
__proto__: {polluted: true}
constructor: {prototype: {polluted: true}}
"<<": literal data
`;
  const parsed = parseYaml(source, 'values.yaml');
  assert.deepEqual(
    parsed,
    JSON.parse(`{
    "200":"false", "01":"yes", "true":"no", "null":null,
    "str":"12", "int":12, "float":12.5, "bool":true, "nil":null,
    "map":{}, "seq":[], "first":"one", "firstCopy":"one",
    "second":"two", "secondCopy":"two", "__proto__":{"polluted":true},
    "constructor":{"prototype":{"polluted":true}}, "<<":"literal data"
  }`),
  );
  assert.equal(Object.getPrototypeOf(parsed), Object.prototype);
  assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false);
});

const excessiveAliases = ['a0: &a0 [value]'];
for (let i = 1; i <= 20; i++)
  excessiveAliases.push(`a${i}: &a${i} [*a${i - 1}, *a${i - 1}]`);

const nestedAliases = ['a0: &a0 []'];
for (let i = 1; i <= 256; i++) nestedAliases.push(`a${i}: &a${i} [*a${i - 1}]`);

const invalidYaml = [
  ['syntax error', 'openapi: [', /Flow sequence/],
  ['duplicate key', 'openapi: 3.1.0\nopenapi: 3.1.2', /keys must be unique/],
  [
    'nested duplicate',
    'info: {title: first, title: last}',
    /keys must be unique/,
  ],
  [
    'escaped duplicate',
    'info: {title: first, "ti\\u0074le": last}',
    /keys must be unique/,
  ],
  [
    'numeric duplicate',
    'responses: {200: {}, "200": {}}',
    /keys must be unique/,
  ],
  [
    'multiple documents',
    'openapi: 3.1.0\n---\nopenapi: 3.1.2',
    /single document/,
  ],
  ['trailing empty document', 'openapi: 3.1.0\n---\n', /single document/],
  ['old YAML version', '%YAML 1.1\n---\nopenapi: 3.1.0', /only YAML 1.2/],
  [
    'unknown directive',
    '%UNKNOWN test\n---\nopenapi: 3.1.0',
    /Unknown directive/,
  ],
  ['custom scalar tag', 'example: !include file.yaml', /Unresolved tag/],
  ['custom collection tag', 'example: !custom {value: 1}', /Unresolved tag/],
  ['timestamp tag', 'example: !!timestamp 2026-10-25', /Unresolved tag/],
  ['binary tag', 'example: !!binary YQ==', /Unresolved tag/],
  ['set tag', 'example: !!set {value: null}', /Unresolved tag/],
  ['ordered map tag', 'example: !!omap [{value: 1}]', /Unresolved tag/],
  ['sequence key', '? [a, b]\n: value', /keys must be strings/],
  ['mapping key', '? {a: b}\n: value', /keys must be strings/],
  [
    'explicit numeric key',
    'responses: {!!int 200: {}}',
    /keys must be strings/,
  ],
  ['alias key', 'key: &key name\n*key: value', /keys must be strings/],
  ['nonfinite number', 'example: .inf', /finite JSON/],
  ['not a number', 'example: .nan', /finite JSON/],
  ['overflow number', 'example: 1e9999', /finite JSON/],
  ['unresolved alias', 'example: *missing', /unresolved alias/],
  ['forward alias', 'example: *later\nother: &later {}', /unresolved alias/],
  ['self cycle', 'example: &self [*self]', /must not create cycles/],
  [
    'ancestor cycle',
    '&root {example: {back: *root}}',
    /must not create cycles/,
  ],
  ['merge key', 'example: {<<: {value: 1}}', /merge keys are unsupported/],
  [
    'excessive aliases',
    excessiveAliases.join('\n'),
    /expanded document.*1000000 nodes/,
  ],
  [
    'alias-amplified depth',
    nestedAliases.join('\n'),
    /expanded collection nesting.*256/,
  ],
  [
    'wide alias expansion',
    `a: &a [${Array(100).fill('0').join(',')}]\nb: [${Array(10000).fill('*a').join(',')}]`,
    /expanded document.*1000000 nodes/,
  ],
  [
    'excessive nesting',
    `example: ${'['.repeat(256)}0${']'.repeat(256)}`,
    /supported limit of 256/,
  ],
  [
    'parser exhaustion',
    `example: ${'['.repeat(3000)}0${']'.repeat(3000)}`,
    /supported parser complexity limit/,
  ],
];

test('thousands of operations can reuse one small YAML policy anchor', async (t) => {
  const document = fixture();
  document.security = [];
  const policy = {
    auth: 'public',
    retry: 'never',
    timeout: 'interactive',
    surfaces: ['consumer'],
  };
  document.paths = Object.fromEntries(
    Array.from({ length: 1001 }, (_, index) => [
      `/operation${index}`,
      {
        get: {
          operationId: `operation${index}`,
          'x-pom': policy,
          responses: { 200: { description: 'Synthetic success' } },
        },
      },
    ]),
  );
  const source = stringify(document);
  assert.equal((source.match(/\*a\d+/g) ?? []).length, 1000);
  const parsed = parseYaml(source, 'shared-policy.yaml');
  assert.equal(
    parsed.paths['/operation0'].get['x-pom'],
    parsed.paths['/operation1000'].get['x-pom'],
  );
  const { config, output } = await project(t, source, {
    clients: ['consumer'],
  });
  await runProject(config);
  const generated = await fileSnapshot(output);
  const expected = await compile(JSON.parse(JSON.stringify(document)), {
    clients: ['consumer'],
  });
  for (const [name, source] of Object.entries(expected))
    assert.equal(generated[name].source, source);
  assert.equal((await runProject(config, { check: true })).clean, true);
  assert.deepEqual(await fileSnapshot(output), generated);
});

test('unquoted YAML null type names explain the required quoted string', async () => {
  const document = fixture();
  document.components.schemas.Unselected = { type: ['string', null] };
  await assert.rejects(
    compile(parseYaml(stringify(document), 'unquoted.yaml'), selection),
    /components.schemas.Unselected.type:.*"null".*quote it in YAML/,
  );
  document.components.schemas.Unselected.type[1] = 'null';
  await compile(parseYaml(stringify(document), 'quoted.yaml'), selection);
});

test('invalid YAML diagnoses before generation or drift checking can write', async (t) => {
  const { root, input, config, output } = await project(
    t,
    stringify(fixture()),
  );
  await runProject(config);
  const before = await fileSnapshot(output);
  for (const [name, source, diagnostic] of invalidYaml) {
    await t.test(name, async () => {
      await writeFile(input, source);
      const inputs = await fileSnapshot(root);
      for (const check of [false, true]) {
        await assert.rejects(runProject(config, { check }), (error) => {
          assert.ok(error instanceof ContractError);
          assert.ok(error.location.startsWith(input));
          assert.match(error.message, /invalid YAML/);
          assert.match(error.message, diagnostic);
          return true;
        });
        assert.deepEqual(await fileSnapshot(output), before);
        assert.deepEqual(await fileSnapshot(root), inputs);
      }
    });
  }
});

test('YAML uses the existing semantic diagnostics, including unselected declarations', async (t) => {
  for (const change of [
    (d) => {
      d.openapi = '3.0.3';
    },
    (d) => {
      d.components.schemas.Unselected = { allOf: [{ type: 'string' }] };
    },
    (d) => {
      d.components.schemas.Unselected = { type: ['string', null] };
    },
    (d) => {
      preparation(d).deprecated = 'false';
    },
    (d) => {
      preparation(d).responses.default = { description: 'Unsupported' };
    },
    (d) => {
      d.components.schemas.Unselected = {
        $ref: 'https://example.invalid/schema.json',
      };
    },
  ]) {
    const document = fixture();
    change(document);
    let expected;
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError);
      expected = error;
      return true;
    });
    const { config, output } = await project(t, stringify(document));
    await assert.rejects(runProject(config), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.message, expected.message);
      return true;
    });
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

test('YAML CLI paths are config-relative and parse errors include line and column without writes', async (t) => {
  const { root, input, config, output } = await project(
    t,
    stringify(fixture()),
  );
  const elsewhere = join(root, 'another directory');
  await mkdir(elsewhere);
  const inputs = await fileSnapshot(root);
  const missing = await runProject(config, { check: true });
  assert.equal(missing.clean, false);
  await assert.rejects(stat(output), { code: 'ENOENT' });
  await exec(process.execPath, [cli, 'generate', '--config', config], {
    cwd: elsewhere,
  });
  await exec(process.execPath, [cli, 'check', '--config', config], {
    cwd: elsewhere,
  });
  assert.deepEqual(await fileSnapshot(root), inputs);
  const before = await fileSnapshot(output);
  await writeFile(input, 'openapi: 3.1.0\nopenapi: 3.1.2\n');
  await assert.rejects(
    exec(process.execPath, [cli, 'check', '--config', config], {
      cwd: elsewhere,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.ok(error.stderr.includes(`${input}:2:1: invalid YAML:`));
      assert.doesNotMatch(error.stderr, /at parseYaml/);
      return true;
    },
  );
  assert.deepEqual(await fileSnapshot(output), before);
});

test('YAML input symlinks stay protected from generated output replacement', async (t) => {
  const { input, config, output } = await project(t, stringify(fixture()));
  await mkdir(output);
  const referent = join(output, 'runtime.ts');
  await writeFile(referent, await readFile(input));
  const alias = join(output, '..', 'linked.yaml');
  await symlink(referent, alias);
  const configuration = JSON.parse(await readFile(config, 'utf8'));
  configuration.openapi = './linked.yaml';
  await writeFile(config, JSON.stringify(configuration));
  const before = await fileSnapshot(output);
  for (const check of [false, true]) {
    await assert.rejects(runProject(config, { check }), /protected input/);
    assert.deepEqual(await fileSnapshot(output), before);
  }
});

test('JSON inputs retain their filename flexibility and never fall back to YAML', async (t) => {
  const { input, config, output } = await project(
    t,
    JSON.stringify(fixture()),
    selection,
    'contract.data',
  );
  await runProject(config);
  const before = await fileSnapshot(output);
  await writeFile(input, stringify(fixture()));
  await assert.rejects(runProject(config), /invalid JSON/);
  assert.deepEqual(await fileSnapshot(output), before);
  await writeFile(
    config,
    'version: 2\nopenapi: contract.data\noutput: generated',
  );
  await assert.rejects(runProject(config), /invalid JSON/);
  assert.deepEqual(await fileSnapshot(output), before);
});
