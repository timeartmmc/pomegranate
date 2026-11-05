import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { generatedWorkspace } from './generated-workspace.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';

const samples: Record<'email' | 'uri' | 'byte', [string, boolean][]> = {
  email: [
    ['a+tag@example.invalid', true],
    ['~a@example.invalid', true],
    ['a@localhost', true],
    ['Mixed.Case@EXAMPLE.INVALID', true],
    ['"a b..c@d"@example.invalid', true],
    ['""@example.invalid', true],
    ['"a\\\"b"@example.invalid', true],
    ['"a\\\\b"@example.invalid', true],
    ['a@[192.0.2.1]', true],
    ['a@[192.0.2.255]', true],
    ['a@[001.002.003.004]', true],
    ['a@[ipv6:::1]', true],
    ['a@[IPv6:::ffff:192.0.2.1]', true],
    ['a@[IPv6:::ffff:01.2.3.4]', true],
    ['a@[IPv6:1:2:3:4:5:6::]', true],
    ['a@[IPv6:1111:2222:3333:4444:5555:6666:123.123.123.123]', true],
    ['a@[IPv6:1.2.3.4::1]', false],
    ['a@[IPv6:]', false],
    ['a@[IPv6:1:2:3:4:5:6:7::]', false],
    ['a@[192.0.2.256]', false],
    ['a@[IPv6:12345::]', false],
    ['a@[IPv6:1::2::3]', false],
    ['a@[IPv6:fe80::1%eth0]', false],
    ['a@[unknown:literal]', false],
    ['a..b@example.invalid', false],
    ['.a@example.invalid', false],
    ['a.@example.invalid', false],
    ['a@-example.invalid', false],
    ['a@example-.invalid', false],
    ['a@example.invalid.', false],
    ['a@under_score.invalid', false],
    ['a@b@example.invalid', false],
    ['"a"b@example.invalid', false],
    ['"a@example.invalid', false],
    ['é@example.invalid', false],
    ['a@é.invalid', false],
    ['Display <a@example.invalid>', false],
    ['a(comment)@example.invalid', false],
    [' a@example.invalid', false],
    ['a@example.invalid\n', false],
    ['"a\tb"@example.invalid', false],
    ['"\u007f"@example.invalid', false],
    ['a'.repeat(65) + '@example.invalid', true],
  ],
  byte: [
    ['', true],
    ['Zg==', true],
    ['Zm8=', true],
    ['Zm9v', true],
    ['Zm9vYg==', true],
    ['Zm9vYmE=', true],
    ['Zm9vYmFy', true],
    ['AAEC/v8=', true],
    // RFC 4648 §3.5 permits decoders to accept nonzero unused padding bits.
    ['Zh==', true],
    ['Zm9=', true],
    ['A', false],
    ['Zg', false],
    ['Zg=', false],
    ['Zm8', false],
    ['Zg===', false],
    ['Z===', false],
    ['====', false],
    ['=Zg=', false],
    ['Z=g=', false],
    ['Zg==AAAA', false],
    ['Zg== ', false],
    [' Zg==', false],
    ['Zg==\n', false],
    ['Zg==\r\n', false],
    ['Zm9v\nYmFy', false],
    ['Zg==\t', false],
    ['Zg==\u00a0', false],
    ['Zg__', false],
    ['Zg--', false],
    ['Ｚg==', false],
    ['Zg==\0', false],
  ],
  uri: [
    ['https://EXAMPLE.invalid:443/a/../b?x=%2f#Mixed', true],
    ['mailto:a@example.invalid', true],
    ['urn:example:synthetic', true],
    ['tel:+1-555-0100', true],
    ['x:', true],
    ['x:?q#fragment', true],
    ['x:?a/b', true],
    ['x:~', true],
    ['x://', true],
    ['http:///path', true],
    ['x+1.2-3:path', true],
    ['http://999.999.999.999/', true],
    ['http://host:/', true],
    ['http://host:99999/', true],
    ['http://user:pass@host/', true],
    ['http://[::1]/', true],
    ['http://[1:2:3:4:5:6:7::]/', true],
    ['http://[::ffff:192.0.2.1]/', true],
    ['http://[1111:2222:3333:4444:5555:6666:123.123.123.123]/', true],
    ['http://[v1.a:b]/', true],
    ['x:path?q=??#fragment?', true],
    ['x:%FF', true],
    ['http://host:abc/', false],
    ['http://[::ffff:01.2.3.4]/', false],
    ['http://[1.2.3.4::1]/', false],
    ['http://[]/', false],
    ['http://[fe80::1%25eth0]/', false],
    ['http://[v1.%41]/', false],
    ['http://[vG.a]/', false],
    ['http://2001:db8::1/', false],
    ['http://a@b@host/', false],
    ['http:/[::1]', false],
    ['http://host/%', false],
    ['http://host/%A', false],
    ['http://host/%GG', false],
    ['http://host/a#b#c', false],
    ['http://host/é', false],
    ['http://host/a\\b', false],
    ['http://host/a b', false],
    ['http://host/\ud800', false],
    ['http://host/\n', false],
    ['http://host/\u007f', false],
    ['/relative', false],
    ['//host/path', false],
    ['#fragment', false],
    ['1x:path', false],
    ['x_y:path', false],
  ],
};

for (const format of ['email', 'uri', 'byte'] as const) {
  void test(`${format} validates the same syntax in request/response parsers and compiler literals`, async (t) => {
    const document = {
      openapi: '3.1.0',
      info: { title: 'Synthetic string formats', version: '1' },
      paths: {},
      components: { schemas: { Value: { type: 'string', format } } },
    };
    const options = {
      clients: [],
      standalone: {
        request: { schema: '#/components/schemas/Value', usage: 'request' },
        response: { schema: '#/components/schemas/Value', usage: 'response' },
      },
    } as const;
    const files = await compile(document, options);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'formats.yaml'), options),
      files,
    );
    const root = await generatedWorkspace(files);
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const usage of ['request', 'response']) {
      const { schema } = (await import(
        pathToFileURL(join(root, `standalone.${usage}.ts`)).href
      )) as StandaloneModule;
      for (const [input, expected] of samples[format]) {
        const result = schema.safeParse(input);
        assert.equal(result.success, expected, JSON.stringify(input));
        if (result.success) assert.equal(result.data, input);
      }
      for (const input of [0, false, null, [], {}])
        assert.equal(schema.safeParse(input).success, false);
    }
    for (const keyword of ['const', 'enum']) {
      for (const [input, expected] of samples[format]) {
        const literal = structuredClone(document);
        Object.assign(literal.components.schemas.Value, {
          [keyword]: keyword === 'const' ? input : [input],
        });
        if (expected) await compile(literal, options);
        else
          await assert.rejects(compile(literal, options), (error) => {
            assert.ok(error instanceof ContractError);
            assert.equal(error.location, 'components.schemas.Value');
            assert.equal(
              error.message,
              `components.schemas.Value: literal violates declared ${format} format`,
            );
            return true;
          });
      }
    }
  });
}

void test('URI response fields require an absolute URI at the protocol boundary', async (t) => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Synthetic URI response', version: '1' },
    paths: {
      '/link': {
        get: {
          operationId: 'readLink',
          responses: {
            200: {
              description: 'A link',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: { url: { type: 'string', format: 'uri' } },
                    required: ['url'],
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const root = await generatedWorkspace(
    await compile(document, {
      clients: ['consumer'],
      surfaces: { consumer: ['readLink'] },
    }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const { operations } = (await import(
    pathToFileURL(join(root, 'client.consumer.ts')).href
  )) as RuntimeClient;
  const operation = operations['readLink'];
  assert.ok(operation);
  const request = operation.build();
  const observed = {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  };
  const invalid = request.parseResponse({
    ...observed,
    body: JSON.stringify({ url: 'example.invalid' }),
  });
  assert.equal(invalid.kind, 'protocol');
  if (invalid.kind === 'protocol')
    assert.deepEqual(invalid.issues, [
      { part: 'body', path: ['url'], message: 'expected a URI' },
    ]);
  const valid = request.parseResponse({
    ...observed,
    body: JSON.stringify({ url: 'https://example.invalid' }),
  });
  assert.equal(valid.kind, 'success');
  if (valid.kind === 'success')
    assert.deepEqual(valid.data, { url: 'https://example.invalid' });
});

void test('format references intersect constraints and defaults remain annotations', async (t) => {
  const document = {
    openapi: '3.1.0',
    info: { title: 'Synthetic format boundaries', version: '1' },
    paths: {},
    components: {
      schemas: {
        Email: {
          type: 'string',
          format: 'email',
          enum: ['a@example.invalid', 'b@example.invalid'],
        },
        Alias: { $ref: '#/components/schemas/Email', pattern: '^a' },
        Defaults: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              format: 'email',
              default: 'annotation only',
            },
          },
        },
      },
    },
  };
  const options = {
    clients: [],
    standalone: {
      alias: { schema: '#/components/schemas/Alias', usage: 'response' },
      defaults: { schema: '#/components/schemas/Defaults', usage: 'request' },
    },
  } as const;
  const root = await generatedWorkspace(await compile(document, options));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { schema: alias } = (await import(
    pathToFileURL(join(root, 'standalone.alias.ts')).href
  )) as StandaloneModule;
  assert.equal(alias.parse('a@example.invalid'), 'a@example.invalid');
  for (const input of ['b@example.invalid', 'a@other.invalid', 'invalid'])
    assert.equal(alias.safeParse(input).success, false);
  const { schema: defaults } = (await import(
    pathToFileURL(join(root, 'standalone.defaults.ts')).href
  )) as StandaloneModule;
  assert.deepEqual(defaults.parse({}), {});
  assert.equal(defaults.safeParse({ email: 'annotation only' }).success, false);
  await compile(document, {
    clients: [],
    standalone: {
      defaults: { schema: '#/components/schemas/Defaults', usage: 'response' },
    },
  });
  for (const format of ['idn-email', 'iri', 'uri-reference', 'url']) {
    const input = structuredClone(document);
    Object.assign(input.components.schemas.Email, { format });
    await assert.rejects(compile(input, options), /unsupported format/);
  }
  const sibling = structuredClone(document);
  Object.assign(sibling.components.schemas.Alias, { format: 'email' });
  await assert.rejects(
    compile(sibling, options),
    /format.*unsupported keyword/,
  );
});

void test('password is a string presentation hint and preserves nullable constraints without generated checks', async () => {
  for (const modern of [true, false]) {
    const value = {
      type: 'string',
      format: 'password',
      minLength: 2,
      maxLength: 8,
      pattern: '^ok',
      enum: ['ok', 'okay'],
    };
    const document = {
      openapi: modern ? '3.1.2' : '3.0.4',
      info: { title: 'Synthetic password hints', version: '1' },
      paths: {},
      components: {
        schemas: {
          Value: value,
          Alias: { $ref: '#/components/schemas/Value' },
          Nullable: modern
            ? { type: ['string', 'null'], format: 'password' }
            : { type: 'string', nullable: true, format: 'password' },
        },
      },
    };
    const options = {
      clients: [],
      standalone: {
        alias: { schema: '#/components/schemas/Alias', usage: 'request' },
        nullable: {
          schema: '#/components/schemas/Nullable',
          usage: 'response',
        },
      },
    } as const;
    const expected = structuredClone(document);
    Reflect.deleteProperty(expected.components.schemas.Value, 'format');
    Reflect.deleteProperty(expected.components.schemas.Nullable, 'format');
    assert.deepEqual(
      await compile(document, options),
      await compile(expected, options),
    );
    for (const format of ['password', 'byte'])
      for (const type of ['number', 'integer', 'boolean', 'object', 'array']) {
        const invalid = structuredClone(document);
        Object.assign(invalid.components.schemas, { Value: { type, format } });
        await assert.rejects(compile(invalid, options), (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(error.location, 'components.schemas.Value.format');
          return true;
        });
      }
  }
});
