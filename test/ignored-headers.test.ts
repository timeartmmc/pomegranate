import assert from 'node:assert/strict';
import test from 'node:test';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { fixture, preparation } from './helpers.ts';
import type { Fixture, Parameter } from './helpers.ts';

const selection = { clients: ['consumer', 'staff'] };
const header = (name: string, required = false): Parameter => ({
  name,
  in: 'header',
  required,
  schema: { type: 'string' },
});
// Every operation under these paths sends the bearer credentials the example
// declares for the whole document.
const path = '/api/widgets/{widgetId}/preparations';

void test('Accept, Content-Type and Authorization header parameters leave the generated output unchanged', async () => {
  const expected = await compile(fixture(), selection);
  const sites: ((document: Fixture, parameter: Parameter) => void)[] = [
    (document, parameter) => {
      preparation(document).parameters.push(parameter);
    },
    (document, parameter) => {
      Object.assign(document.paths[path], { parameters: [parameter] });
    },
    (document, parameter) => {
      Object.assign(document.components, {
        parameters: {
          Ignored: parameter,
          Alias: { $ref: '#/components/parameters/Ignored' },
        },
      });
      Object.assign(document.paths[path], {
        parameters: [{ $ref: '#/components/parameters/Alias' }],
      });
    },
  ];
  for (const name of [
    'Accept',
    'accept',
    'ACCEPT',
    'Content-Type',
    'content-type',
    'CONTENT-TYPE',
    'Authorization',
    'authorization',
    'AUTHORIZATION',
  ])
    for (const required of [false, true])
      for (const declare of sites) {
        const document = fixture();
        declare(document, header(name, required));
        const before = structuredClone(document);
        assert.deepEqual(await compile(document, selection), expected, name);
        assert.deepEqual(document, before);
      }
  const yaml = fixture();
  preparation(yaml).parameters.push(header('Authorization', true));
  assert.deepEqual(
    await compile(parseYaml(stringify(yaml), 'headers.yaml'), selection),
    expected,
  );
});

void test('ignored header parameters are not declared headers but keep their declaration checks', async () => {
  const rejects = async (
    change: (document: Fixture) => void,
    message: RegExp,
    options: Parameters<typeof compile>[1] = selection,
  ) => {
    const document = fixture();
    change(document);
    await assert.rejects(compile(document, options), (error) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, message);
      return true;
    });
  };
  // The transport owns these headers without naming them in configuration.
  for (const name of ['Accept', 'content-type', 'AUTHORIZATION'])
    await rejects(
      (document) => {
        preparation(document).parameters.push(header(name));
      },
      /^transportHeaders: request header .* is undeclared or ignored by OpenAPI$/,
      { ...selection, transportHeaders: [name] },
    );
  await rejects(
    () => {},
    /request header "x-not-declared" is undeclared or ignored by OpenAPI$/,
    { ...selection, transportHeaders: ['X-Not-Declared'] },
  );
  await rejects((document) => {
    preparation(document).parameters.push({
      ...header('Accept'),
      schema: { type: 'integer' },
    });
  }, /parameters\[\d\]\.schema: header parameters require string schemas$/);
  await rejects((document) => {
    preparation(document).parameters.push({
      ...header('Content-Type'),
      style: 'form',
    });
  }, /parameters\[\d\]\.style: unsupported parameter serialization$/);
  // OpenAPI identifies parameters by case-sensitive name, so only an exact
  // repeat is a duplicate. Headers that are sent still collide ignoring case.
  await rejects((document) => {
    preparation(document).parameters.push(header('Accept'), header('Accept'));
  }, /parameters: duplicate parameter header:Accept$/);
  await rejects((document) => {
    preparation(document).parameters.push(header('X-Trace'), header('x-trace'));
  }, /parameters: duplicate parameter header:x-trace$/);
  const expected = await compile(fixture(), selection);
  const sameList = fixture();
  preparation(sameList).parameters.push(header('Accept'), header('ACCEPT'));
  assert.deepEqual(await compile(sameList, selection), expected);
  const inherited = fixture();
  Object.assign(inherited.paths[path], {
    parameters: [header('Authorization'), header('Content-Type')],
  });
  preparation(inherited).parameters.push(
    header('authorization'),
    header('content-type'),
  );
  assert.deepEqual(await compile(inherited, selection), expected);
});

const schemes = {
  Bearer: { type: 'http', scheme: 'bearer' },
  Basic: { type: 'http', scheme: 'Basic' },
  OAuth: {
    type: 'oauth2',
    flows: {
      clientCredentials: { tokenUrl: '/token', scopes: { read: 'Read' } },
    },
  },
  HeaderKey: { type: 'apiKey', in: 'header', name: 'authorization' },
  OtherHeaderKey: { type: 'apiKey', in: 'header', name: 'X-API-Key' },
  QueryKey: { type: 'apiKey', in: 'query', name: 'key' },
  CookieKey: { type: 'apiKey', in: 'cookie', name: 'session' },
};
type Requirement = Partial<Record<keyof typeof schemes, string[]>>;

function secured(
  security: {
    document?: Requirement[];
    read?: Requirement[];
    write?: Requirement[];
  },
  headers: readonly string[],
  modern = true,
) {
  const operation = (operationId: 'read' | 'write') => ({
    operationId,
    ...(security[operationId] ? { security: security[operationId] } : {}),
    responses: { 204: { description: 'Done' } },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic Authorization parameters', version: '1' },
    ...(security.document ? { security: security.document } : {}),
    components: { securitySchemes: schemes },
    paths: {
      '/items': {
        // One declaration applies to both operations of the path.
        parameters: headers.map((name) => header(name, true)),
        get: operation('read'),
        post: operation('write'),
      },
    },
  };
}
const securedSelection = {
  clients: ['client'],
  surfaces: { client: ['read', 'write'] },
};

void test('an Authorization header parameter is ignored only where security sends that header', async () => {
  const sending: Requirement[][] = [
    [{ Bearer: [] }],
    [{ Basic: [] }],
    [{ OAuth: ['read'] }],
    [{ HeaderKey: [] }],
    [{ QueryKey: [], Basic: [] }],
    [{ QueryKey: [] }, { Bearer: [] }],
    [{ Bearer: [] }, {}],
  ];
  for (const modern of [true, false])
    for (const security of sending)
      for (const declared of [
        { document: security },
        { read: security, write: security },
        { document: [{ QueryKey: [] }], read: security, write: security },
      ])
        assert.deepEqual(
          await compile(
            secured(declared, ['Authorization'], modern),
            securedSelection,
          ),
          await compile(secured(declared, [], modern), securedSelection),
          JSON.stringify(declared),
        );
  const silent: Requirement[][] = [
    [],
    [{}],
    [{ QueryKey: [] }],
    [{ CookieKey: [] }],
    [{ OtherHeaderKey: [] }],
    [{ QueryKey: [] }, { CookieKey: [], OtherHeaderKey: [] }],
  ];
  const rejects = async (
    declared: Parameters<typeof secured>[0],
    method: 'get' | 'post',
  ) => {
    for (const modern of [true, false])
      await assert.rejects(
        compile(secured(declared, ['Authorization'], modern), securedSelection),
        (error) => {
          assert.ok(error instanceof ContractError, JSON.stringify(declared));
          assert.equal(error.location, `paths./items.${method}.parameters`);
          assert.match(
            error.message,
            /an Authorization header parameter is ignored, as OpenAPI requires, but this operation's security sends no Authorization credentials; declare them as a security scheme$/,
          );
          return true;
        },
      );
    // The same security is valid once the parameter is gone.
    await compile(secured(declared, []), securedSelection);
  };
  // Accept and Content-Type never depend on security, in either dialect.
  for (const modern of [true, false])
    assert.deepEqual(
      await compile(
        secured({}, ['Accept', 'CONTENT-TYPE'], modern),
        securedSelection,
      ),
      await compile(secured({}, [], modern), securedSelection),
    );
  await rejects({}, 'get');
  for (const security of silent) {
    await rejects({ document: security }, 'get');
    await rejects({ read: security, write: security }, 'get');
    // Each operation is checked against its own effective security.
    await rejects({ document: [{ Bearer: [] }], write: security }, 'post');
    await rejects({ document: security, read: [{ Bearer: [] }] }, 'post');
  }
});
