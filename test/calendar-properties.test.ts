import assert from 'node:assert/strict';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { formats } from '../dist/runtime.js';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { StandaloneModule } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
function monthLength(year: number, month: number): number {
  const date = new Date(0);
  // Date.UTC remaps years 0..99 to 1900..1999. The setter preserves the
  // proleptic Gregorian year and asks for day zero of the following month.
  date.setUTCFullYear(year, month, 0);
  return date.getUTCDate();
}
const calendar = (y: number, m: number, d: number) =>
  m >= 1 && m <= 12 && d >= 1 && d <= monthLength(y, m);

const years = Array.from({ length: 10_000 }, (_, year) => year);

void test('dates agree with the Date calendar for every four-digit year and invalid month/day neighbors', () => {
  for (const y of years)
    for (let m = 0; m <= 13; m++)
      for (let d = 0; d <= 32; d++) {
        const date = `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
        const expected = calendar(y, m, d);
        if (formats.date(date) !== expected) assert.fail(`date ${date}`);
        const instant = `${date}T12:34:56Z`;
        if (formats['date-time'](instant) !== expected)
          assert.fail(`date-time ${instant}`);
      }
});

void test('each date-time numeric token requires its exact field width', () => {
  const tokens = ['2024', '01', '01', '01', '01', '01', '01', '01'];
  for (let field = 0; field < tokens.length; field++)
    for (let width = 0; width <= 6; width++) {
      const parts = [...tokens];
      parts[field] = width === 0 ? '' : '1'.padStart(width, '0');
      const date = `${parts[0]}-${parts[1]}-${parts[2]}`;
      const instant = `${date}T${parts[3]}:${parts[4]}:${parts[5]}+${parts[6]}:${parts[7]}`;
      // Every represented number is one, so only the selected token's width
      // changes validity: four digits for the year and two for every other field.
      const expected = width === (field === 0 ? 4 : 2);
      assert.equal(formats['date-time'](instant), expected, instant);
      if (field <= 2) assert.equal(formats.date(date), expected, date);
    }
});

void test('times and offsets agree with their numeric ranges, with no leap seconds', () => {
  for (let h = 0; h <= 25; h++)
    for (let mi = 0; mi <= 61; mi++)
      for (const s of [0, 29, 58, 59, 60, 61]) {
        const value = `2024-02-29T${pad(h)}:${pad(mi)}:${pad(s)}Z`;
        assert.equal(
          formats['date-time'](value),
          h <= 23 && mi <= 59 && s <= 59,
          value,
        );
      }
  for (const sign of ['+', '-'])
    for (let h = 0; h <= 25; h++)
      for (let mi = 0; mi <= 61; mi++) {
        const value = `2024-02-29T23:59:59${sign}${pad(h)}:${pad(mi)}`;
        assert.equal(formats['date-time'](value), h <= 23 && mi <= 59, value);
      }
});

// Each syntax part is labeled independently; a value is valid iff every part is.
type Part = readonly (readonly [string, boolean])[];
const prefixes: Part = [
  ['', true],
  [' ', false],
  ['x', false],
  ['\n', false],
];
const suffixes: Part = [
  ['', true],
  [' ', false],
  ['x', false],
  ['\n', false],
  [' extra', false],
];
const dates: Part = [
  ['2024-02-29', true],
  ['2024-2-29', false],
  ['2024-02-9', false],
  ['02024-02-29', false],
  ['024-02-29', false],
  ['２０２４-02-29', false],
  ['2024/02/29', false],
  ['20240229', false],
];
const separators: Part = [
  ['T', true],
  ['t', true],
  [' ', false],
  ['', false],
  ['_', false],
];
const times: Part = [
  ['23:59:59', true],
  ['23:59', false],
  ['23:5:59', false],
  ['2:59:59', false],
];
const fractions: Part = [
  ['', true],
  ['.0', true],
  ['.001', true],
  ['.1', true],
  ['.123456', true],
  ['.123456789', true],
  ['.1234567890', true],
  ['.000000000000000000000000000001', true],
  ['.', false],
  [',5', false],
];
const zones: Part = [
  ['Z', true],
  ['z', true],
  ['+00:00', true],
  ['-00:00', true],
  ['+23:59', true],
  ['', false],
  ['+0000', false],
  ['+00', false],
  ['UTC', false],
  ['ZZ', false],
];

void test('date and date-time syntax agrees with a compositional part oracle', () => {
  for (const [p, pv] of prefixes)
    for (const [d, dv] of dates)
      for (const [x, xv] of suffixes) {
        assert.equal(
          formats.date(p + d + x),
          pv && dv && xv,
          JSON.stringify(p + d + x),
        );
        for (const [s, sv] of separators)
          for (const [t, tv] of times)
            for (const [f, fv] of fractions)
              for (const [z, zv] of zones) {
                const value = p + d + s + t + f + z + x;
                if (
                  formats['date-time'](value) !==
                  (pv && dv && sv && tv && fv && zv && xv)
                )
                  assert.fail(JSON.stringify(value));
              }
      }
});

// Boundary sample for generated parsers and compile-time literal checks.
function sample(): [string, boolean][] {
  const out: [string, boolean][] = [];
  for (const y of [
    0, 4, 99, 100, 400, 1900, 2000, 2022, 2023, 2024, 2025, 2100, 2200, 2400,
  ])
    for (let m = 1; m <= 12; m++)
      for (const d of [monthLength(y, m), monthLength(y, m) + 1])
        out.push([`${pad(y, 4)}-${pad(m)}-${pad(d)}`, calendar(y, m, d)]);
  for (const [v, ok] of [
    ['2024-00-01', false],
    ['2024-13-01', false],
    ['2024-01-00', false],
    ['2024-01-32', false],
    ['2024-1-01', false],
    ['x2024-01-01', false],
    ['2024-01-01\n', false],
  ] as const)
    out.push([v, ok]);
  return out;
}

void test('generated request/response parsers and compile-time literals use the same calendar', async (t) => {
  const doc = (schemas: Record<string, unknown>) => ({
    openapi: '3.1.2',
    info: { title: 'calendar', version: '1' },
    paths: {},
    components: { schemas },
  });
  const root = await generatedTestWorkspace(
    t,
    await compile(
      doc({
        D: { type: 'string', format: 'date' },
        I: { type: 'string', format: 'date-time' },
      }),
      {
        clients: [],
        standalone: {
          dq: { schema: '#/components/schemas/D', usage: 'request' },
          ds: { schema: '#/components/schemas/D', usage: 'response' },
          iq: { schema: '#/components/schemas/I', usage: 'request' },
          is: { schema: '#/components/schemas/I', usage: 'response' },
        },
      },
    ),
  );
  const [dq, ds, iq, is] = await Promise.all(
    ['dq', 'ds', 'iq', 'is'].map(
      async (name) =>
        (await importGenerated<StandaloneModule>(root, `standalone.${name}.ts`))
          .schema,
    ),
  );
  const validLiterals: Record<string, Schema> = {};
  let index = 0;
  for (const [date, expected] of sample()) {
    const instant = `${date}T12:34:56.123+04:00`;
    for (const [validator, value] of [
      [dq, date],
      [ds, date],
      [iq, instant],
      [is, instant],
    ] as const) {
      const result = validator!.safeParse(value);
      assert.equal(result.success, expected, value);
      if (result.success) assert.equal(result.data, value);
    }
    for (const [format, value, assertion] of [
      ['date', date, { const: date }],
      ['date-time', instant, { enum: [instant] }],
    ] as const) {
      const schema = { type: 'string', format, ...assertion };
      if (expected) validLiterals[`Case${index++}`] = schema;
      else
        await assert.rejects(
          compile(doc({ Invalid: schema }), {
            clients: [],
            standalone: {
              literal: {
                schema: '#/components/schemas/Invalid',
                usage: 'request',
              },
            },
          }),
          {
            name: 'ContractError',
            location: 'components.schemas.Invalid',
            message: new RegExp(`literal violates declared ${format} format`),
          },
          `${format} literal ${JSON.stringify(value)}`,
        );
    }
  }
  // Invalid declarations need individual locations. Valid literals can share
  // one document because source validation visits every component.
  await assert.doesNotReject(
    compile(doc(validLiterals), {
      clients: [],
      standalone: {
        literal: { schema: '#/components/schemas/Case0', usage: 'request' },
      },
    }),
  );
});
