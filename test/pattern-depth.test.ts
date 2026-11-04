import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { promisify } from 'node:util';
import { compile, ContractError } from '../dist/index.js';
import { normalizeSchema } from '../dist/schemas.js';
import { fixture } from './helpers.ts';

const exec = promisify(execFile);
const location = 'components.schemas.Pattern';
const nested = (open: string, depth: number) =>
  open.repeat(depth) + 'x' + ')'.repeat(depth);

for (const [kind, open] of [
  ['noncapturing', '(?:'],
  ['capturing', '('],
  ['lookahead', '(?='],
  ['negative lookahead', '(?!'],
  ['lookbehind', '(?<='],
  ['negative lookbehind', '(?<!'],
] as const) {
  void test(`${kind} patterns accept 128 levels and diagnose excess nesting`, () => {
    assert.doesNotThrow(() =>
      normalizeSchema({ type: 'string', pattern: nested(open, 128) }, location),
    );
    for (const depth of [129, 2500, 5000]) {
      assert.throws(
        () =>
          normalizeSchema(
            { type: 'string', pattern: nested(open, depth) },
            location,
          ),
        (error) => {
          assert.ok(error instanceof ContractError);
          assert.equal(error.location, `${location}.pattern`);
          assert.match(error.message, /pattern nesting.*limit of 128/);
          assert.doesNotMatch(error.message, /expected a valid/);
          return true;
        },
      );
    }
  });
}

void test('named captures and mixed lookarounds share one nesting budget', () => {
  const opens = Array.from({ length: 128 }, (_, index) =>
    index % 2 ? '(?=' : `(?<group${index}>`,
  ).join('');
  const pattern = opens + 'x' + ')'.repeat(128);
  assert.doesNotThrow(() =>
    normalizeSchema({ type: 'string', pattern }, location),
  );
  assert.throws(
    () =>
      normalizeSchema({ type: 'string', pattern: `(?:${pattern})` }, location),
    /pattern nesting.*limit of 128/,
  );
});

void test('flat groups, escaped parentheses and class members do not accumulate nesting', () => {
  for (const pattern of [
    '(?:x)'.repeat(5000),
    String.raw`\(\)`.repeat(5000),
    '[()]'.repeat(5000),
    'a'.repeat(1024 * 1024),
  ])
    assert.doesNotThrow(() =>
      normalizeSchema({ type: 'string', pattern }, location),
    );
});

void test('the nesting diagnostic applies before selecting clients', async () => {
  const document = fixture();
  Object.assign(document.components.schemas, {
    Pattern: { type: 'string', pattern: nested('(?:', 5000) },
  });
  await assert.rejects(compile(document, { clients: ['staff'] }), (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.location, `${location}.pattern`);
    assert.match(error.message, /pattern nesting.*limit of 128/);
    return true;
  });
});

void test('the explicit nesting bound holds with a reduced parser stack', async () => {
  const schemas = new URL('../dist/schemas.js', import.meta.url).href;
  const { stdout } = await exec(
    process.execPath,
    [
      '--stack-size=256',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import {normalizeSchema} from ${JSON.stringify(schemas)};
       for (const open of ['(?:', '(', '(?=', '(?<=']) {
         const nested = depth => open.repeat(depth)+'x'+')'.repeat(depth);
         normalizeSchema({type:'string',pattern:nested(128)},'schema');
         for (const depth of [129,5000])
           assert.throws(() => normalizeSchema({type:'string',pattern:nested(depth)},'schema'),
             error => error.name==='ContractError' && /pattern nesting.*128/.test(error.message));
       }
       console.log('bounded');`,
    ],
    { timeout: 10_000 },
  );
  assert.equal(stdout.trim(), 'bounded');
});

void test('unexpected parser resource failures do not claim invalid syntax', (t) => {
  t.mock.method(
    globalThis,
    'RegExp',
    new Proxy(RegExp, {
      construct() {
        throw new RangeError('synthetic resource exhaustion');
      },
    }),
  );
  assert.throws(
    () => normalizeSchema({ type: 'string', pattern: 'a' }, location),
    (error) => {
      assert.ok(error instanceof ContractError);
      assert.equal(error.location, `${location}.pattern`);
      assert.match(error.message, /exceeded available parser resources/);
      assert.doesNotMatch(error.message, /expected a valid/);
      return true;
    },
  );
});
