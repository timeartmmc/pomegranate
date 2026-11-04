import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import { fileSnapshot, temporary } from './helpers.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import {
  ipCommentConsumer,
  ipCommentFixture as fixture,
  ipCommentSchemaTargets,
  ipCommentSelection as selection,
  verifyIpComment,
} from './ip-comment-fixture.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
const samples: Record<'ipv4' | 'ipv6', readonly [string, boolean][]> = {
  ipv4: [
    ['0.0.0.0', true],
    ['255.255.255.255', true],
    ['192.0.2.1', true],
    ['001.002.003.004', true],
    ['00.00.00.00', true],
    ['010.020.030.040', true],
    ['000.0.0.255', true],
    ['256.0.0.1', false],
    ['1.256.0.1', false],
    ['1.2.256.1', false],
    ['1.2.3.256', false],
    ['1.2.3.0000', false],
    ['127.1', false],
    ['1.2.3', false],
    ['1.2.3.4.5', false],
    ['2130706433', false],
    ['0x7f.0.0.1', false],
    ['0o10.0.0.1', false],
    ['1e2.0.0.1', false],
    ['+1.2.3.4', false],
    ['-1.2.3.4', false],
    ['.1.2.3', false],
    ['1.2.3.', false],
    ['1..2.3', false],
    ['1.2.3.4/24', false],
    ['[1.2.3.4]', false],
    ['1.2.3.4:80', false],
    [' 1.2.3.4', false],
    ['1.2.3.4\n', false],
    ['１.2.3.4', false],
    ['1.2.3.٤', false],
    ['', false],
  ],
  ipv6: [
    ['::', true],
    ['::1', true],
    ['1::', true],
    ['2001:DB8::1', true],
    ['2001:0db8:0000:0000:0000:0000:0000:0001', true],
    ['1:2:3:4:5:6:7:8', true],
    ['1:2:3:4:5:6:7::', true],
    ['::1:2:3:4:5:6:7', true],
    ['::ffff:192.0.2.1', true],
    ['1:2:3:4:5:6:192.0.2.1', true],
    ['ffff:ffff:ffff:ffff:ffff:ffff:255.255.255.255', true],
    ['::1:2:3:4:5:192.0.2.1', true],
    ['1:2:3:4:5:6:7', false],
    ['1:2:3:4:5:6:7:8:9', false],
    ['1:2:3:4:5:6:7:8::', false],
    ['::1:2:3:4:5:6:7:8', false],
    ['1::2::3', false],
    [':::', false],
    [':1:2:3:4:5:6:7', false],
    ['1:2:3:4:5:6:7:', false],
    ['12345::', false],
    ['::gggg', false],
    ['192.0.2.1', false],
    ['::ffff:192.0.2.256', false],
    ['::ffff:192.0.2.01', false],
    ['::ffff:001.2.3.4', false],
    ['192.0.2.1::', false],
    ['1:2:3:4:5:192.0.2.1:6', false],
    ['[::1]', false],
    ['fe80::1%eth0', false],
    ['fe80::1%25eth0', false],
    ['::1/128', false],
    [' ::1', false],
    ['::1\n', false],
    ['::１', false],
    ['', false],
  ],
};

function standaloneDocument(schema: Schema) {
  return {
    openapi: '3.1.1',
    info: { title: 'Synthetic IP boundary', version: '1' },
    paths: {},
    components: { schemas: { Value: schema } },
  };
}
const roots = {
  clients: [],
  standalone: {
    request: { schema: '#/components/schemas/Value', usage: 'request' },
    response: { schema: '#/components/schemas/Value', usage: 'response' },
  },
} as const;

void test('IP formats preserve JSON/YAML bytes, input documents and protocol validation', async (t) => {
  const document = fixture();
  const before = structuredClone(document);
  const files = await compile(document, selection);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'ip.yaml'), selection),
    files,
  );
  assert.deepEqual(document, before);
  const root = await generatedTestWorkspace(t, files);
  verifyIpComment(
    await importGenerated<RuntimeClient>(root, 'client.consumer.ts'),
    await importGenerated<StandaloneModule>(root, 'standalone.ipv4.ts'),
    await importGenerated<StandaloneModule>(root, 'standalone.ipv6.ts'),
  );
  const { schema: nullable } = await importGenerated<StandaloneModule>(
    root,
    'standalone.nullable.ts',
  );
  assert.equal(nullable.parse(null), null);
  assert.equal(nullable.parse('001.002.003.004'), '001.002.003.004');
  assert.equal(nullable.safeParse('256.0.0.1').success, false);
  const { schema: narrow } = await importGenerated<StandaloneModule>(
    root,
    'standalone.narrow.ts',
  );
  assert.equal(narrow.parse('2001:DB8::1'), '2001:DB8::1');
  assert.equal(narrow.safeParse('::1').success, false);
  assert.equal(narrow.safeParse('2001:db8:0::1').success, false);
});

void test('standalone IP validators check decimal octets, compression and embedded addresses without normalization', async (t) => {
  for (const format of ['ipv4', 'ipv6'] as const) {
    const root = await generatedTestWorkspace(
      t,
      await compile(standaloneDocument({ type: 'string', format }), roots),
    );
    for (const usage of ['request', 'response']) {
      const { schema } = await importGenerated<StandaloneModule>(
        root,
        `standalone.${usage}.ts`,
      );
      for (const [input, expected] of samples[format]) {
        const result = schema.safeParse(input);
        assert.equal(
          result.success,
          expected,
          `${format}/${usage}/${JSON.stringify(input)}`,
        );
        if (result.success) assert.equal(result.data, input);
      }
      for (const input of [null, false, 0, [], {}, undefined])
        assert.equal(schema.safeParse(input).success, false);
    }
  }
});

void test('IP syntax agrees with independent octet and native IPv6 oracles over generated neighboring values', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const { schema: ipv4 } = await importGenerated<StandaloneModule>(
    root,
    'standalone.ipv4.ts',
  );
  const { schema: ipv6 } = await importGenerated<StandaloneModule>(
    root,
    'standalone.ipv6.ts',
  );
  for (const octet of [
    '0',
    '00',
    '000',
    '1',
    '01',
    '001',
    '9',
    '99',
    '100',
    '249',
    '250',
    '255',
    '256',
    '999',
    '0000',
    '-1',
    '+1',
    '1e2',
    '',
  ])
    for (let position = 0; position < 4; position++) {
      const parts = ['192', '0', '2', '1'];
      parts[position] = octet;
      const value = parts.join('.');
      const expected = /^\d{1,3}$/.test(octet) && Number(octet) <= 255;
      assert.equal(ipv4.safeParse(value).success, expected, value);
    }
  const values = new Set(samples.ipv6.map(([value]) => value));
  let seed = 0x53a9bc12;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let index = 0; index < 350; index++) {
    const groups = Array.from({ length: 8 }, () =>
      (next() >>> 16).toString(16),
    );
    values.add(groups.join(':'));
    const start = index % 8;
    const end = start + 1 + (index % (8 - start));
    const compressed = `${groups.slice(0, start).join(':')}::${groups.slice(end).join(':')}`;
    values.add(compressed);
    values.add(`${compressed}:ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff`);
    values.add(compressed.replace('::', ':::'));
  }
  // Node also accepts scoped addresses; JSON Schema's bare-address format does
  // not. No scope identifier is sent to the independent address oracle.
  for (const value of values)
    if (!value.includes('%'))
      assert.equal(ipv6.safeParse(value).success, isIP(value) === 6, value);
});

void test('compiler IP literals use the runtime predicates and retain nullable/default and reference rules', async () => {
  for (const format of ['ipv4', 'ipv6'] as const) {
    for (const keyword of ['const', 'enum'])
      for (const [input, valid] of samples[format].filter(
        (_, index) => index < 7 || index % 5 === 0,
      )) {
        const document = standaloneDocument({
          type: 'string',
          format,
          [keyword]: keyword === 'const' ? input : [input],
        });
        if (valid) await compile(document, roots);
        else
          await assert.rejects(compile(document, roots), (error) => {
            assert.ok(error instanceof ContractError);
            assert.equal(error.location, 'components.schemas.Value');
            assert.match(
              error.message,
              new RegExp(`literal violates declared ${format} format`),
            );
            return true;
          });
      }
    await compile(
      standaloneDocument({ type: ['string', 'null'], format, const: null }),
      roots,
    );
    await assert.rejects(
      compile(standaloneDocument({ type: 'integer', format }), roots),
      /unsupported integer format/,
    );
    const document = fixture();
    document.components.schemas.Invalid = {
      type: 'string',
      format,
      const: 'not an address',
    };
    await assert.rejects(
      compile(document, selection),
      /components.schemas.Invalid.*literal violates declared/,
    );
  }
  const document = fixture();
  document.components.schemas.Invalid = {
    $ref: '#/components/schemas/Ipv4',
    format: 'ipv4',
  };
  await assert.rejects(
    compile(document, selection),
    /components.schemas.Invalid.format.*unsupported keyword/,
  );
});

void test('schema comments are validated and discarded at schema roots, children, references and unused declarations', async () => {
  const document = fixture();
  const baseline = await compile(document, selection);
  for (const value of ipCommentSchemaTargets(document))
    value.$comment =
      'Synthetic author note: x-unlisted, $ref and executable-looking text stay inert.';
  const before = structuredClone(document);
  assert.deepEqual(await compile(document, selection), baseline);
  assert.deepEqual(
    await compile(parseYaml(stringify(document), 'comments.yaml'), selection),
    baseline,
  );
  assert.deepEqual(document, before);
  const composite = standaloneDocument({
    type: 'object',
    properties: {
      array: { type: 'array', items: { type: 'integer' } },
      map: { type: 'object', additionalProperties: { type: 'boolean' } },
      nullable: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    },
  });
  const compositeBaseline = await compile(composite, roots);
  const value = composite.components.schemas.Value;
  const children = present(value.properties);
  const commentTargets = [
    value,
    ...Object.values(children),
    present(present(children.array).items),
    record(present(children.map).additionalProperties),
    ...present(present(children.nullable).anyOf),
  ];
  for (const target of commentTargets) target.$comment = 'Container or branch';
  assert.deepEqual(await compile(composite, roots), compositeBaseline);
  present(present(children.nullable).anyOf)[1]!.$comment = false;
  await assert.rejects(
    compile(composite, roots),
    /components.schemas.Value.properties.nullable.anyOf\[1\].\$comment.*expected a string/,
  );
  for (const value of ['', '\ud800', 'x'.repeat(50_000)]) {
    present(document.components.schemas.Unused).$comment = value;
    assert.deepEqual(await compile(document, selection), baseline);
  }
  for (const invalid of [null, false, 1, [], {}, undefined]) {
    const bad = fixture();
    present(bad.components.schemas.Unused).$comment = invalid;
    await assert.rejects(compile(bad, selection), (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'components.schemas.Unused.$comment');
      return true;
    });
  }
  const alias = fixture();
  Object.assign(present(alias.components.schemas.Narrow), { $comment: 1 });
  await assert.rejects(
    compile(alias, selection),
    /components.schemas.Narrow.\$comment.*expected a string/,
  );
});

void test('schema comments do not consume same-named data or inspect opaque annotation payloads', async (t) => {
  const document = fixture();
  for (const schema of ipCommentSchemaTargets(document))
    schema.$comment = 'Author note';
  const root = await generatedTestWorkspace(
    t,
    await compile(document, selection),
  );
  const { schema } = await importGenerated<StandaloneModule>(
    root,
    'standalone.data.ts',
  );
  assert.deepEqual(schema.parse({ $comment: 'kept' }), { $comment: 'kept' });
  assert.equal(schema.safeParse({}).success, false);
  assert.equal(schema.safeParse({ $comment: 1 }).success, false);
  for (const target of [
    (d: ReturnType<typeof fixture>) => record(d),
    (d: ReturnType<typeof fixture>) => record(d.paths['/ip/{v4}'].post),
    (d: ReturnType<typeof fixture>) =>
      record(d.paths['/ip/{v4}'].post.requestBody),
  ]) {
    const invalid = fixture();
    target(invalid).$comment = 'Only schema comments are supported';
    await assert.rejects(
      compile(invalid, selection),
      /\$comment.*unsupported keyword/,
    );
  }
});

void test('IP-only browser bundles retain their validator without retaining unrelated format implementations', async (t) => {
  for (const format of ['ipv4', 'ipv6']) {
    const root = await generatedTestWorkspace(
      t,
      await compile(standaloneDocument({ type: 'string', format }), roots),
    );
    const bundled = await build({
      entryPoints: [join(root, 'standalone.request.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2022',
      minify: true,
      write: false,
      logLevel: 'silent',
    });
    const code = present(bundled.outputFiles[0]).text;
    assert.doesNotMatch(
      code,
      /expected (?:an email address|a URI|a calendar date|a UUID)/,
    );
    if (format === 'ipv4') assert.doesNotMatch(code, /IPv6/);
    await writeFile(join(root, 'bundle.js'), code);
    const { schema } = await importGenerated<StandaloneModule>(
      root,
      'bundle.js',
    );
    assert.equal(
      schema.safeParse(
        format === 'ipv4' ? '001.002.003.004' : '1:2:3:4:5:6:7::',
      ).success,
      true,
    );
  }
});

void test('IP format contracts retain their string types through source and declaration-only consumers', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  await writeFile(join(root, 'consumer.ts'), ipCommentConsumer);
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        types: [],
        allowImportingTsExtensions: true,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await writeFile(
    join(root, 'published.ts'),
    `
    import {operations} from './declarations/client.consumer.js';
    const request = operations.exchange.build({path:{v4:'192.0.2.1'},body:{v4:'192.0.2.1',v6:'::1'}});
    const body: string = request.body.v4;
    // @ts-expect-error Declaration output preserves string bodies.
    operations.exchange.build({path:{v4:'192.0.2.1'},body:{v4:1,v6:'::1'}});
    void body;
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        noEmit: true,
      },
      include: ['./published.ts', './declarations/*.d.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});

void test('invalid IP formats and schema comments leave generated output unchanged during generate and drift checks', async (t) => {
  const root = await temporary(t);
  const input = join(root, 'openapi.json');
  const config = join(root, 'pom.json');
  const output = join(root, 'generated');
  await writeFile(input, JSON.stringify(fixture()));
  await writeFile(
    config,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...selection,
    }),
  );
  await runProject(config);
  const snapshot = await fileSnapshot(output);
  for (const schema of [
    { type: 'string', format: 'ipv4', const: '256.0.0.1' },
    { type: 'string', format: 'ipv6', const: '::ffff:01.2.3.4' },
    { type: 'boolean', $comment: false },
  ]) {
    const document = fixture();
    document.components.schemas.Unused = schema;
    await writeFile(input, JSON.stringify(document));
    for (const check of [false, true])
      await assert.rejects(runProject(config, { check }), ContractError);
    assert.deepEqual(await fileSnapshot(output), snapshot);
  }
});
