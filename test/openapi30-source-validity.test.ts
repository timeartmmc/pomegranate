import assert from 'node:assert/strict';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import type { Schema } from './schema-helpers.ts';

const selection = {
  clients: [],
  standalone: {
    root: { schema: '#/components/schemas/Root', usage: 'request' },
  },
} as const;

function document(version: string, schemas: Record<string, Schema>) {
  return {
    openapi: version,
    info: { title: 'Synthetic dialect source validity', version: '1' },
    paths: {},
    components: { schemas },
  };
}

void test('OpenAPI 3.0 rejects empty required arrays in selected, unused and shared source schemas', async () => {
  for (const version of ['3.0.0', '3.0.4']) {
    const empty: Schema = {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: [],
    };
    for (const schemas of [
      { Root: empty },
      { Root: { type: 'string' }, Unused: empty },
      { Root: { type: 'string' }, First: empty, Second: empty },
    ]) {
      const input = document(version, schemas);
      const before = structuredClone(input);
      await assert.rejects(compile(input, selection), (error) => {
        assert.ok(error instanceof ContractError);
        assert.match(
          error.location,
          /^components\.schemas\.(Root|Unused|First|Second)\.required$/,
        );
        assert.match(error.message, /OpenAPI 3\.0.*at least one/);
        return true;
      });
      assert.deepEqual(input, before);
    }
  }
});

void test('OpenAPI 3.1 empty required arrays preserve the generated contract of omission', async () => {
  const base: Schema = {
    type: 'object',
    properties: { value: { type: 'string' } },
  };
  const explicit = document('3.1.2', { Root: { ...base, required: [] } });
  const omitted = document('3.1.2', { Root: base });
  assert.deepEqual(
    await compile(explicit, selection),
    await compile(omitted, selection),
  );
  assert.deepEqual(
    await compile(document('3.0.4', { Root: base }), selection),
    await compile(omitted, selection),
  );
});

void test('OpenAPI 3.0 defaults must match the same-object type, including in unused properties', async () => {
  for (const schema of [
    { type: 'string', default: false },
    { type: 'string', default: null },
    { type: 'number', default: '1' },
    { type: 'integer', default: 1.5 },
    { type: 'boolean', default: 0 },
    { type: 'array', items: { type: 'string' }, default: {} },
    { type: 'object', default: [] },
  ] satisfies Schema[]) {
    for (const version of ['3.0.0', '3.0.4'])
      for (const schemas of [
        { Root: schema },
        {
          Root: { type: 'string' },
          Unused: {
            type: 'object',
            properties: { value: { ...schema, readOnly: true } },
          },
        },
      ]) {
        const input = document(version, schemas);
        const before = structuredClone(input);
        await assert.rejects(compile(input, selection), (error) => {
          assert.ok(error instanceof ContractError);
          assert.match(
            error.location,
            /^components\.schemas\.(Root|Unused\.properties\.value)\.default$/,
          );
          assert.match(
            error.message,
            /OpenAPI 3\.0 default must match its declared type/,
          );
          return true;
        });
        assert.deepEqual(input, before);
      }
    // 3.1 keeps defaults as arbitrary JSON annotations.
    await compile(document('3.1.2', { Root: schema }), selection);
  }
});

void test('valid 3.0 default types remain annotations without enforcing other schema assertions', async () => {
  for (const schema of [
    { type: 'string', default: '' },
    { type: 'number', default: 1.5 },
    { type: 'integer', default: 0 },
    { type: 'boolean', default: false },
    { type: 'array', items: { type: 'string' }, default: [] },
    {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
      default: {},
    },
    { type: 'string', nullable: true, enum: ['value'], default: null },
    { type: 'integer', minimum: 10, enum: [20], default: 0 },
    { default: false },
  ] satisfies Schema[]) {
    const base: Schema = { ...schema };
    delete base.default;
    assert.deepEqual(
      await compile(document('3.0.4', { Root: schema }), selection),
      await compile(document('3.0.4', { Root: base }), selection),
    );
  }
});
