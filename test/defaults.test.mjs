import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import { fixture, preparation } from './helpers.mjs';

function documentWithDefault(value) {
  const document = fixture();
  preparation(document).requestBody.content['application/json'].schema = {
    type: 'object',
    additionalProperties: true,
    default: value,
  };
  return document;
}

test('deep request defaults are annotations and do not change generated output', async () => {
  const baseline = await compile(documentWithDefault({}), {
    clients: ['consumer'],
  });
  for (const [open, close] of [
    ['[', ']'],
    ['{"child":', '}'],
  ]) {
    const value = JSON.parse(open.repeat(10000) + '0' + close.repeat(10000));
    assert.deepEqual(
      await compile(documentWithDefault({ key: value }), {
        clients: ['consumer'],
      }),
      baseline,
    );
  }
});

test('non-JSON and cyclic request defaults fail at the annotation location', async () => {
  const cycle = {};
  cycle.self = cycle;
  const sparse = [];
  sparse.length = 1;
  for (const value of [
    undefined,
    Infinity,
    NaN,
    1n,
    () => 1,
    new Date(),
    sparse,
    cycle,
  ]) {
    await assert.rejects(
      compile(documentWithDefault(value), { clients: ['consumer'] }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(
          error.location,
          'paths./api/widgets/{widgetId}/preparations.post.requestBody.content.application/json.schema.default',
        );
        return true;
      },
    );
  }
});

test('shared default values validate without exponential expansion', async () => {
  await promisify(execFile)(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    import {compile} from './dist/index.js';
    import {fixture,preparation} from './test/helpers.mjs';
    let value={leaf:0};
    for(let depth=0;depth<40;depth++) value={left:value,right:value};
    const document=fixture();
    preparation(document).requestBody.content['application/json'].schema={type:'object',additionalProperties:true,default:value};
    await compile(document,{clients:['consumer']});
  `,
    ],
    { cwd: new URL('..', import.meta.url), timeout: 5000 },
  );
});
