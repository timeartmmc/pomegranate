import assert from 'node:assert/strict';
import test from 'node:test';
import { ContractError } from '../dist/index.js';
import { projectSchemas, schemaAccess } from '../dist/directional.js';
import {
  normalizeSchema,
  orderSchemas,
  schemaValidation,
  validateSchema,
} from '../dist/schemas.js';
import type { Schema, SchemaTable } from '../dist/model.js';
import type { Schema as InputSchema } from './schema-helpers.ts';
import { present } from './assertions.ts';

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
function source(input: Record<string, InputSchema>): SchemaTable {
  const schemas = Object.fromEntries(
    Object.entries(input).map(([name, schema]) => [
      name,
      normalizeSchema(schema, `components.schemas.${name}`),
    ]),
  );
  const cache = schemaValidation();
  for (const name of orderSchemas(schemas))
    validateSchema(
      present(schemas[name]),
      schemas,
      `components.schemas.${name}`,
      'component',
      cache,
    );
  return schemas;
}
function object(schema: Schema) {
  assert.ok(schema.kind === 'object');
  return schema;
}
function shared() {
  return source({
    Id: { type: 'integer', readOnly: true },
    IdAlias: { ...ref('Id'), readOnly: false },
    Secret: { type: 'string', writeOnly: true, default: 'annotation only' },
    Payload: {
      type: 'object',
      properties: {
        id: ref('IdAlias'),
        password: ref('Secret'),
        label: { type: 'string' },
        nested: {
          type: 'object',
          required: ['secret'],
          properties: { secret: { type: 'string', writeOnly: true } },
        },
      },
      required: ['id', 'password', 'label', 'nested'],
    },
  });
}

void test('directional graphs remove fields and requiredness consistently through reference aliases', () => {
  const raw = shared();
  const before = structuredClone(raw);
  const { schemas } = projectSchemas(raw);
  const request = object(present(schemas.request.Payload));
  const response = object(present(schemas.response.Payload));
  assert.deepEqual(Object.keys(request.properties), [
    'label',
    'nested',
    'password',
  ]);
  assert.deepEqual(request.required, ['label', 'nested', 'password']);
  assert.deepEqual(request.forbidden, ['id']);
  assert.deepEqual(Object.keys(response.properties), ['id', 'label', 'nested']);
  assert.deepEqual(response.required, ['id', 'label', 'nested']);
  assert.equal(response.forbidden, undefined);
  assert.deepEqual(raw, before);
  assert.deepEqual(schemaAccess(present(raw.IdAlias), raw), {
    readOnly: true,
    writeOnly: false,
  });
});

void test('all-excluded properties leave a fixed object and an empty required list', () => {
  const { schemas } = projectSchemas(shared());
  const nested = object(
    present(object(present(schemas.response.Payload)).properties.nested),
  );
  assert.deepEqual(nested.properties, {});
  assert.deepEqual(nested.required, []);
  assert.equal(nested.kind, 'object');
});

void test('projection preserves alias identity and annotations while separating directional cache identities', () => {
  const raw = shared();
  const projection = projectSchemas(raw);
  for (const name of Object.keys(raw)) {
    assert.notEqual(projection.schemas.request[name], raw[name]);
    assert.notEqual(projection.schemas.response[name], raw[name]);
    assert.notEqual(
      projection.schemas.request[name],
      projection.schemas.response[name],
    );
    assert.equal(
      projection.schema(present(raw[name]), 'request'),
      projection.schemas.request[name],
    );
  }
  const alias = present(projection.schemas.response.IdAlias);
  assert.ok(alias.kind === 'ref');
  assert.equal(alias.name, 'Id');
  assert.equal(alias.location, 'components.schemas.IdAlias.$ref');
  assert.equal(projection.schemas.request.Secret?.hasDefault, true);
  assert.equal(projection.schemas.response.Secret?.writeOnly, true);
});

void test('inline roots use the same projected tables without retaining caller data', () => {
  const raw = shared();
  const projection = projectSchemas(raw);
  const inline = normalizeSchema(
    {
      type: 'object',
      properties: { id: ref('IdAlias'), name: { type: 'string' } },
      required: ['id', 'name'],
    },
    'requestBody',
  );
  validateSchema(inline, raw, 'requestBody', 'component');
  const request = object(projection.schema(inline, 'request'));
  assert.deepEqual(Object.keys(request.properties), ['name']);
  assert.deepEqual(request.required, ['name']);
  assert.deepEqual(request.forbidden, ['id']);
  const response = object(projection.schema(inline, 'response'));
  assert.deepEqual(response.required, ['id', 'name']);
});

for (const flag of ['readOnly', 'writeOnly']) {
  for (const value of [undefined, null, 'true', 1]) {
    void test(`${flag} must be a boolean rather than ${JSON.stringify(value) ?? 'undefined'}`, () => {
      assert.throws(
        () => normalizeSchema({ type: 'string', [flag]: value }, 'field'),
        (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(error.location, `field.${flag}`);
          return true;
        },
      );
    });
  }
}

void test('false annotations are neutral and direct or alias-combined contradictions reject', () => {
  const neutral = normalizeSchema(
    { type: 'string', readOnly: false, writeOnly: false },
    'field',
  );
  assert.deepEqual(neutral, { kind: 'string' });
  assert.throws(
    () =>
      normalizeSchema(
        { type: 'string', readOnly: true, writeOnly: true },
        'field',
      ),
    /cannot both be true/,
  );
  assert.throws(
    () =>
      source({
        Base: { type: 'string', readOnly: true },
        Alias: { ...ref('Base'), writeOnly: true },
      }),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, 'components.schemas.Alias');
      assert.match(error.message, /cannot both be true through references/);
      return true;
    },
  );
});

void test('source validation still rejects malformed and missing declarations that projection would exclude', () => {
  assert.throws(
    () =>
      source({
        Payload: {
          type: 'object',
          properties: {
            hidden: { type: 'string', format: 'idn-email', writeOnly: true },
          },
        },
      }),
    /unsupported format/,
  );
  assert.throws(
    () =>
      source({
        Payload: {
          type: 'object',
          properties: { hidden: { ...ref('Missing'), writeOnly: true } },
        },
      }),
    /unresolved reference Missing/,
  );
  assert.throws(
    () => source({ Alias: { ...ref('Alias'), readOnly: true } }),
    /recursive schemas/,
  );
});

void test('nullable wrapper annotations apply to the whole property without becoming conditional branch flags', () => {
  const raw = source({
    Payload: {
      type: 'object',
      required: ['id'],
      properties: { id: { type: ['integer', 'null'], readOnly: true } },
    },
  });
  const projection = projectSchemas(raw);
  const request = object(present(projection.schemas.request.Payload));
  assert.deepEqual(request.properties, {});
  assert.deepEqual(request.required, []);
  const response = object(present(projection.schemas.response.Payload));
  const field = present(response.properties.id);
  assert.ok(field.kind === 'union');
  assert.equal(field.readOnly, true);
  assert.ok(field.branches.every((branch) => branch.readOnly === undefined));
  validateSchema(
    present(projection.schemas.response.Payload),
    projection.schemas.response,
    'reply',
    'response',
  );
});

void test('conditional branch annotations reject before projection, including referenced annotations', () => {
  for (const branch of [{ type: 'string', readOnly: true }, ref('ReadValue')]) {
    assert.throws(
      () =>
        source({
          ReadValue: { type: 'string', readOnly: true },
          Choice: { anyOf: [branch, { type: 'null' }] },
        }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, 'components.schemas.Choice.anyOf[0]');
        assert.match(error.message, /union branches are unsupported/);
        return true;
      },
    );
  }
});

void test('excluded defaults and binaries do not enter response usage, while retained request binaries require multipart', () => {
  const raw = source({
    Payload: {
      type: 'object',
      required: ['password', 'file'],
      properties: {
        password: { type: 'string', default: 'annotation', writeOnly: true },
        file: { type: 'string', format: 'binary', writeOnly: true },
      },
    },
  });
  const projection = projectSchemas(raw);
  validateSchema(
    present(projection.schemas.response.Payload),
    projection.schemas.response,
    'reply',
    'response',
  );
  validateSchema(
    present(projection.schemas.request.Payload),
    projection.schemas.request,
    'upload',
    'multipart',
  );
  assert.throws(
    () =>
      validateSchema(
        present(projection.schemas.request.Payload),
        projection.schemas.request,
        'json',
        'request',
      ),
    /only supported in multipart/,
  );
  const retained = projectSchemas(
    source({ Value: { type: 'string', default: 'annotation' } }),
  );
  assert.throws(
    () =>
      validateSchema(
        present(retained.schemas.response.Value),
        retained.schemas.response,
        'reply',
        'response',
      ),
    /must not declare defaults/,
  );
});

void test('active annotations outside object properties reject in the direction that cannot omit the value', () => {
  const projection = projectSchemas(
    source({
      ReadValue: { type: 'string', readOnly: true },
      Array: { type: 'array', items: ref('ReadValue') },
      Map: { type: 'object', additionalProperties: ref('ReadValue') },
    }),
  );
  for (const name of ['ReadValue', 'Array', 'Map']) {
    assert.throws(
      () =>
        validateSchema(
          present(projection.schemas.request[name]),
          projection.schemas.request,
          name,
          'request',
        ),
      /readOnly.*object properties/,
    );
    validateSchema(
      present(projection.schemas.response[name]),
      projection.schemas.response,
      name,
      'response',
    );
  }
});

for (const [annotation, excluded, permitted] of [
  ['readOnly', 'request', 'response'],
  ['writeOnly', 'response', 'request'],
] as const) {
  void test(`${annotation} discriminator tags identify the excluded direction and a remedy`, () => {
    const raw = source({
      A: {
        type: 'object',
        required: ['kind', 'value'],
        properties: {
          kind: { type: 'string', const: 'a', [annotation]: true },
          value: { type: 'string' },
        },
      },
      B: {
        type: 'object',
        required: ['kind', 'value'],
        properties: {
          kind: { type: 'string', const: 'b', [annotation]: true },
          value: { type: 'integer' },
        },
      },
      Choice: {
        oneOf: [ref('A'), ref('B')],
        discriminator: {
          propertyName: 'kind',
          mapping: { a: '#/components/schemas/A', b: '#/components/schemas/B' },
        },
      },
    });
    const projection = projectSchemas(raw);
    assert.throws(
      () =>
        validateSchema(
          present(projection.schemas[excluded].Choice),
          projection.schemas[excluded],
          'choice',
          excluded,
        ),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, 'choice.discriminator.propertyName');
        assert.equal(
          error.message,
          `choice.discriminator.propertyName: discriminator property "kind" must remain present and required in ${excluded}s; ${annotation} excludes it, so remove that annotation or use separate request and response schemas`,
        );
        return true;
      },
    );
    validateSchema(
      present(projection.schemas[permitted].Choice),
      projection.schemas[permitted],
      'choice',
      permitted,
    );
  });
}

void test('long alias chains preserve access annotations without recursive traversal', () => {
  const input: Record<string, InputSchema> = {
    Value: { type: 'string', readOnly: true },
  };
  for (let index = 4095; index >= 0; index--)
    input[`Alias${index}`] = ref(
      index === 4095 ? 'Value' : `Alias${index + 1}`,
    );
  input.Payload = {
    type: 'object',
    required: ['id'],
    properties: { id: ref('Alias0') },
  };
  const raw = source(input);
  const request = object(present(projectSchemas(raw).schemas.request.Payload));
  assert.deepEqual(request.required, []);
  assert.deepEqual(request.forbidden, ['id']);
});
