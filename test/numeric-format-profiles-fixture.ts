import assert from 'node:assert/strict';
import { entry } from './assertions.ts';
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

export const minimumInt64String = '-9223372036854775808';
export const maximumInt64String = '9223372036854775807';
export const validInt64Strings = [
  minimumInt64String,
  maximumInt64String,
  '9007199254740992',
  '0',
  '-0',
  '000',
  '-000',
  '0009223372036854775807',
  '-0009223372036854775808',
];
export const invalidInt64Strings = [
  '',
  '-',
  '+0',
  '+1',
  ' 1',
  '1 ',
  '1\n',
  '\t1',
  '1.0',
  '1e3',
  '0x10',
  '１',
  '--1',
  '9223372036854775808',
  '-9223372036854775809',
];
const ref = (name: string): Schema => ({
  $ref: `#/components/schemas/${name}`,
});

export function numericFormatProfilesFixture(modern = true) {
  const decimal: Schema = { type: 'string', format: 'int64' };
  const single: Schema = { type: 'number', format: 'float' };
  const schemas: Record<string, Schema> = {
    Decimal: decimal,
    DecimalAlias: ref('Decimal'),
    DecimalEnum: {
      ...decimal,
      enum: [minimumInt64String, maximumInt64String, '0001'],
    },
    NullableDecimal: modern
      ? { ...decimal, type: ['string', 'null'] }
      : { ...decimal, nullable: true },
    Float: single,
    FloatAlias: ref('Float'),
    FloatEnum: { ...single, enum: [0.1, 3.4028235e38, -3.4028235e38] },
    NullableFloat: modern
      ? { ...single, type: ['number', 'null'] }
      : { ...single, nullable: true },
    Double: { type: 'number', format: 'double' },
  };
  const operation = (name: string, operationId: string) => ({
    operationId,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref(name) } },
    },
    responses: {
      200: {
        description: 'Numeric format value',
        content: { 'application/json': { schema: ref(name) } },
      },
    },
  });
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic numeric wire profiles', version: '1' },
    components: { schemas },
    paths: {
      '/decimal': { post: operation('DecimalAlias', 'decimal') },
      '/float': { post: operation('FloatAlias', 'single') },
      '/double': { post: operation('Double', 'double') },
    },
  };
}

export const numericFormatProfilesSelection = {
  clients: ['consumer'],
  surfaces: { consumer: ['decimal', 'single', 'double'] },
  standalone: {
    decimal: { schema: '#/components/schemas/DecimalAlias', usage: 'request' },
    decimalenum: {
      schema: '#/components/schemas/DecimalEnum',
      usage: 'response',
    },
    decimalnull: {
      schema: '#/components/schemas/NullableDecimal',
      usage: 'response',
    },
    single: { schema: '#/components/schemas/FloatAlias', usage: 'request' },
    singleenum: { schema: '#/components/schemas/FloatEnum', usage: 'response' },
    singlenull: {
      schema: '#/components/schemas/NullableFloat',
      usage: 'response',
    },
  },
} as const;

export function verifyNumericFormatProfiles(
  client: RuntimeClient,
  decimal: StandaloneModule,
  single: StandaloneModule,
): void {
  const decimalOperation = entry(client.operations, 'decimal');
  for (const value of validInt64Strings) {
    assert.equal(decimal.schema.parse(value), value);
    assert.equal(decimalOperation.build({ body: value }).body, value);
    const response = decimalOperation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    assert.equal(response.kind, 'success');
    if (response.kind === 'success') assert.equal(response.data, value);
  }
  for (const value of invalidInt64Strings) {
    assert.equal(
      decimal.schema.safeParse(value).success,
      false,
      JSON.stringify(value),
    );
    assert.throws(
      () => decimalOperation.build({ body: value }),
      client.RequestValidationError,
    );
  }
  const singleOperation = entry(client.operations, 'single');
  // Java Float.toString emits shortest round-tripping decimals. The usual
  // Float.MAX_VALUE spelling exceeds its exact binary32 value, but stays finite
  // when decoded as float32: https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/lang/Float.html#toString(float)
  for (const value of [
    0,
    -0,
    0.1,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    3.4028235e38,
    -3.4028235e38,
  ]) {
    assert.equal(Object.is(single.schema.parse(value), value), true);
    assert.equal(
      Object.is(singleOperation.build({ body: value }).body, value),
      true,
    );
    const response = singleOperation.parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(value),
    });
    assert.equal(response.kind, 'success');
    if (response.kind === 'success')
      assert.equal(response.data, value === 0 ? 0 : value);
  }
  for (const value of [3.4028236e38, -3.4028236e38, Number.MAX_VALUE]) {
    assert.equal(single.schema.safeParse(value).success, false);
    assert.throws(
      () => singleOperation.build({ body: value }),
      client.RequestValidationError,
    );
    assert.equal(
      entry(client.operations, 'double').build({ body: value }).body,
      value,
    );
  }
}

export const numericFormatProfilesConsumer = `
import { operations } from './client.consumer.ts';
import { schema as decimal } from './standalone.decimal.ts';
import { schema as single } from './standalone.single.ts';
const integerText: string = decimal.parse('9223372036854775807');
const floatValue: number = single.parse(0.1);
operations.decimal.build({body:'-9223372036854775808'});
operations.single.build({body:3.4028235e38});
operations.double.build({body:Number.MAX_VALUE});
// @ts-expect-error String int64 never accepts numeric inputs.
operations.decimal.build({body:1});
// @ts-expect-error Float values never accept textual numbers.
operations.single.build({body:'1'});
// @ts-expect-error String int64 is not exposed as bigint.
const integerBig: bigint = decimal.parse('1');
void [integerText, floatValue, integerBig];
`;
