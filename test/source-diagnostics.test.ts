import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { parseJson } from '../dist/json.js';
import type { Schema } from './schema-helpers.ts';

const selection = {
  clients: [],
  standalone: {
    root: { schema: '#/components/schemas/Root', usage: 'response' },
  },
} as const;

function document(version: string, Root: Schema = { type: 'string' }) {
  return {
    openapi: version,
    info: { title: 'Synthetic source diagnostics', version: '1' },
    paths: {},
    components: { schemas: { Root } },
  };
}

void test('schema key hints describe the source dialect for scalars, nullable schemas, containers and unions', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    const modern = version.startsWith('3.1.');
    const nullBranch = modern
      ? { type: 'null' }
      : { type: 'string', nullable: true, enum: [null] };
    const cases: Schema[] = [
      { type: 'string' },
      modern
        ? { type: ['string', 'null'] }
        : { type: 'string', nullable: true },
      { type: 'number' },
      { type: 'array', items: { type: 'string' } },
      { type: 'object', properties: {}, additionalProperties: false },
      { anyOf: [{ type: 'string' }, nullBranch] },
      { type: 'string', format: 'binary' },
    ];
    for (const schema of cases)
      await assert.rejects(
        compile(document(version, { ...schema, typo: true }), selection),
        (error: unknown) => {
          assert.ok(error instanceof ContractError);
          assert.equal(error.location, 'components.schemas.Root.typo');
          assert.match(error.message, /supported keys:/);
          if (modern) {
            assert.match(error.message, /"\$comment"/);
            assert.match(error.message, /"examples"/);
            assert.doesNotMatch(error.message, /"nullable"/);
          } else {
            assert.match(error.message, /"nullable"/);
            assert.match(error.message, /"exclusiveMinimum"/);
            assert.match(error.message, /"exclusiveMaximum"/);
            assert.doesNotMatch(
              error.message,
              /"(?:const|examples|\$comment|contentMediaType)"/,
            );
          }
          return true;
        },
      );
  }
  // The recommended source spelling must itself compile in 3.0.
  await compile(
    document('3.0.4', {
      type: 'string',
      nullable: true,
      exclusiveMinimum: false,
      exclusiveMaximum: false,
    }),
    selection,
  );
});

void test('info and license key hints omit fields unavailable in OpenAPI 3.0', async () => {
  for (const version of ['3.0.4', '3.1.2'])
    for (const location of ['info', 'info.license']) {
      const input = document(version);
      Object.assign(
        input.info,
        location === 'info'
          ? { typo: true }
          : { license: { name: 'Synthetic license', typo: true } },
      );
      await assert.rejects(compile(input, selection), (error: unknown) => {
        assert.ok(error instanceof ContractError);
        assert.equal(error.location, `${location}.typo`);
        const field = location === 'info' ? /"summary"/ : /"identifier"/;
        if (version.startsWith('3.0.'))
          assert.doesNotMatch(error.message, field);
        else assert.match(error.message, field);
        return true;
      });
    }
});

void test('source dialect hints preserve reference restrictions and unrelated policy field names', async () => {
  const reference = document('3.0.4', {
    $ref: '#/components/schemas/Text',
    typo: true,
  });
  Object.assign(reference.components.schemas, { Text: { type: 'string' } });
  await assert.rejects(compile(reference, selection), {
    name: 'ContractError',
    location: 'components.schemas.Root.typo',
    message:
      'components.schemas.Root.typo: unsupported keyword; supported keys: "$ref"',
  });
  const policy = {
    ...document('3.0.4'),
    'x-pom-policy': {
      version: 3,
      fields: { $comment: { type: 'string' }, const: { type: 'string' } },
      surfaces: ['audit'],
    },
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          'x-pom': { surfaces: ['audit'], typo: true },
          responses: { 200: { description: 'Synthetic response' } },
        },
      },
    },
  };
  await assert.rejects(compile(policy, selection), (error: unknown) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, 'paths./health.get.x-pom.typo');
    assert.match(error.message, /"\$comment"/);
    assert.match(error.message, /"const"/);
    assert.doesNotMatch(error.message, /"nullable"/);
    return true;
  });
});

void test('mutual TLS is recognized but unsupported in 3.1 and receives a version-specific diagnostic in 3.0', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    const input = document(version);
    Object.assign(input.components, {
      securitySchemes: { TLS: { type: 'mutualTLS' } },
    });
    await assert.rejects(compile(input, selection), {
      name: 'ContractError',
      location: version.startsWith('3.0.')
        ? 'components.securitySchemes.TLS.type'
        : 'components.securitySchemes.TLS',
      message: version.startsWith('3.0.')
        ? 'components.securitySchemes.TLS.type: mutualTLS is not supported in OpenAPI 3.0; only HTTP bearer schemes are supported'
        : 'components.securitySchemes.TLS: security scheme type "mutualTLS" is not supported in this version; only HTTP bearer schemes are supported',
    });
    Object.assign(input.components, {
      securitySchemes: { TLS: { type: 'mutualTls' } },
    });
    await assert.rejects(compile(input, selection), (error: unknown) => {
      assert.ok(error instanceof ContractError);
      assert.match(error.message, /unrecognized security scheme type/);
      if (version.startsWith('3.0.'))
        assert.doesNotMatch(error.message, /"mutualTLS"/);
      else assert.match(error.message, /"mutualTLS"/);
      return true;
    });
  }
});

void test('overflowing JSON default annotations identify the non-finite number at its source field', async () => {
  for (const version of ['3.0.4', '3.1.2']) {
    const source = JSON.stringify(
      document(version, { type: 'number', default: 'OVERFLOW' }),
    ).replace('"OVERFLOW"', '1e400');
    await assert.rejects(
      compile(parseJson(source, 'default.json'), selection),
      {
        name: 'ContractError',
        location: 'components.schemas.Root.default',
        message:
          'components.schemas.Root.default: annotation numbers must be finite JSON values',
      },
    );
  }
});
