import assert from 'node:assert/strict';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import {
  jsonResponseSubject,
  jsonResponseWorkload,
} from '../bench/cases/json-response.ts';
import {
  defaultPolicy,
  measureValidation,
  runTiming,
  samplingPolicy,
  timingSettings,
  timingWorker,
  workerDeadline,
} from '../bench/timing.ts';
import { scenarios } from '../bench/cases/json-response-runtime.ts';
import { record } from './assertions.ts';
import { generatedWorkspace, importGenerated } from './generated-workspace.ts';
import { temporary } from './helpers.ts';

const shortPolicy = { warmupMs: 0, sampleMs: 1, samples: 2, batchSize: 128 };

void test('sampling policy requires bounded explicit durations and counts', () => {
  assert.deepEqual(samplingPolicy(defaultPolicy), defaultPolicy);
  for (const [value, message] of [
    [{}, /policy: expected warmupMs/],
    [{ ...defaultPolicy, extra: 1 }, /policy: expected warmupMs/],
    [
      { ...defaultPolicy, sampleMs: 0 },
      /policy.sampleMs: expected an integer between 1 and 10000/,
    ],
    [{ ...defaultPolicy, samples: 1.5 }, /policy.samples:/],
    [{ ...defaultPolicy, batchSize: 0 }, /policy.batchSize:/],
    [{ ...defaultPolicy, warmupMs: -1 }, /policy.warmupMs:/],
    [{ ...defaultPolicy, sampleMs: Infinity }, /policy.sampleMs:/],
  ] as const)
    assert.throws(() => samplingPolicy(value), message);
  for (const [value, message] of [
    [{ round: 12 }, /settings: unknown field round/],
    [{ rounds: 0 }, /rounds: expected an integer between 1 and 100/],
    [{ seed: -1 }, /seed: expected an integer between 0 and 4294967295/],
  ] as const)
    assert.throws(() => timingSettings(value), message);
});

void test('every accepted duration fits its worker deadline with setup allowance', () => {
  const policy = samplingPolicy({
    warmupMs: 10_000,
    sampleMs: 10_000,
    samples: 50,
    batchSize: 128,
  });
  assert.ok(
    workerDeadline(policy) > policy.warmupMs + policy.samples * policy.sampleMs,
  );
});

void test('timing plans reject case aliases, oversized input and invalid UTF-8 before creating output', async (t) => {
  const root = await temporary(t);
  const plan = join(root, 'plan.json');
  const output = join(root, 'run');
  const adapter = { id: 'valid', module: './never-read.mjs', sources: [] };
  for (const [value, message] of [
    [
      { version: 1, round: 12, adapters: [adapter] },
      /plan: unknown field round/,
    ],
    [
      { version: 1, adapters: [{ ...adapter, id: 'zod.v4' }] },
      /plan.adapters\[0\].id: expected ASCII letters/,
    ],
    [
      { version: 1, adapters: [{ ...adapter, sources: 'bad' }] },
      /plan.adapters\[0\].sources: expected an array/,
    ],
  ] as const) {
    await writeFile(plan, JSON.stringify(value));
    await assert.rejects(runTiming(plan, output), message);
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
  await writeFile(
    plan,
    JSON.stringify({
      version: 1,
      adapters: ['native', 'NATIVE'].map((id) => ({
        id,
        module: './never-read.mjs',
        sources: [],
      })),
    }),
  );
  await assert.rejects(runTiming(plan, output), /unique ignoring ASCII case/);
  await writeFile(plan, ' '.repeat(64 * 1024 + 1));
  await assert.rejects(runTiming(plan, output), /exceeds/);
  await writeFile(plan, Buffer.from([0xff]));
  await assert.rejects(runTiming(plan, output), /UTF-8/);
  await assert.rejects(stat(output), { code: 'ENOENT' });
});

void describe('timing validates actual seeded inputs and keeps complete process observations', () => {
  let root = '';
  let adapter: string;
  let importLine: string;
  let generatedSources: string[];
  let subject: ReturnType<typeof jsonResponseSubject>;
  before(async () => {
    const { document, options } = jsonResponseWorkload();
    const outputs = await compile(document, options);
    root = await generatedWorkspace(outputs);
    generatedSources = Object.keys(outputs).map((name) => join(root, name));
    const client = await importGenerated<unknown>(root, 'client.consumer.ts');
    const schemas = await importGenerated<unknown>(
      root,
      'client.consumer.schemas.ts',
    );
    subject = jsonResponseSubject(client, schemas);
    adapter = join(root, 'adapter.mjs');
    importLine =
      'import { responseSchemas } from ' +
      JSON.stringify(
        pathToFileURL(join(root, 'client.consumer.schemas.ts')).href,
      ) +
      ';\n';
    await writeFile(
      adapter,
      importLine +
        'export const create=()=>({identity:{name:"POM test",version:"test"},validate:responseSchemas.RecordList.safeParse});\n',
    );
  });
  // Suite cleanup waits for asynchronous children on every supported Node line.
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });
  for (const scenario of scenarios)
    void test(scenario, () => {
      const result = measureValidation(
        subject.validate,
        scenario,
        1,
        shortPolicy,
      );
      assert.equal(result.observations.length, 2);
      assert.equal(
        result.operations,
        result.observations.reduce((sum, value) => sum + value.operations, 0),
      );
      assert.equal(
        result.elapsedMs,
        result.observations.reduce((sum, value) => sum + value.elapsedMs, 0),
      );
      assert.ok(
        result.operations > 0 &&
          result.elapsedMs > 0 &&
          result.usPerOperation > 0,
      );
      for (const value of result.observations)
        assert.equal(value.operations % shortPolicy.batchSize, 0);
    });
  void test('detects corruption in the formerly unchecked half of the pool', () => {
    const corrupt = (input: unknown) => {
      const result = record(subject.validate(input));
      if (result.success === true) {
        const items = record(result.data).items;
        assert.ok(Array.isArray(items));
        if (record(items[0]).id === 129) record(items[0]).label = 'corrupt';
      }
      return result;
    };
    assert.throws(
      () => measureValidation(corrupt, 'parsed-valid', 1, shortPolicy),
      assert.AssertionError,
    );
  });

  void test('preflight checks the same seed-specific values as the timed worker', async () => {
    const corrupt = join(root, 'corrupt.mjs');
    await writeFile(
      corrupt,
      importLine +
        `export const create=()=>({identity:{name:'corrupt'},validate(input){
      const result=responseSchemas.RecordList.safeParse(input);
      if(result.success&&result.data.items[0]?.id===129)result.data.items[0].label='corrupt';
      return result;
    }});`,
    );
    const result = record(
      await timingWorker(corrupt, 'preflight', {
        seed: 1,
        policy: shortPolicy,
      }),
    );
    assert.equal(result.behavior, 'rejected');
  });
  void test('controller serializes fresh workers and retains their raw samples', async () => {
    const plan = join(root, 'plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        seed: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [{ id: 'pom', module: adapter, sources: generatedSources }],
      }),
    );
    const output = join(root, 'run');
    const result = await runTiming(plan, output);
    assert.equal(result.status, 'complete');
    assert.equal(result.summary.length, 3);
    assert.equal(result.observations.length, 3);
    for (const row of result.observations) {
      const raw: unknown = JSON.parse(
        await readFile(join(output, row.file), 'utf8'),
      );
      assert.ok(Array.isArray(record(raw).observations));
      assert.equal(record(raw).mode, row.scenario);
    }
    await assert.rejects(runTiming(plan, output), { code: 'EEXIST' });
  });
  void test('qualification and measurement logs cannot collide through valid adapter IDs', async () => {
    const plan = join(root, 'log-names-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: ['0-parsed-valid-2-x', 'x-preflight'].map((id) => ({
          id,
          module: adapter,
          sources: generatedSources,
        })),
      }),
    );
    const output = join(root, 'log-names-run');
    const result = await runTiming(plan, output);
    assert.equal(result.status, 'complete');
    assert.equal(result.qualified.length, 2);
    assert.equal(result.observations.length, 6);
    const logs = (await readdir(output)).filter((name) =>
      name.endsWith('.stdout.log'),
    );
    assert.equal(
      logs.length,
      8,
      'retain both qualifications and every measurement',
    );
  });

  void test('adapter logging stays separate from qualification and measurement results', async () => {
    const logging = join(root, 'logging.mjs');
    await writeFile(
      logging,
      importLine +
        `
      console.log('validator ready');
      export const create=()=>({
        identity:{name:'logging'},
        validate:responseSchemas.RecordList.safeParse,
        dispose(){console.log('validator disposed');console.error('cleanup diagnostic');}
      });
    `,
    );
    const plan = join(root, 'logging-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        profiles: [{ scenario: 'parsed-valid', records: 2 }],
        adapters: [
          { id: 'logging', module: logging, sources: generatedSources },
        ],
      }),
    );
    const output = join(root, 'logging-run');
    const report = await runTiming(plan, output);
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.ineligible, []);
    assert.equal(report.observations.length, 1);
    const raw = record(
      JSON.parse(
        await readFile(join(output, report.observations[0]!.file), 'utf8'),
      ) as unknown,
    );
    assert.equal(raw.mode, 'parsed-valid');
    for (const prefix of [
      'preflight-logging',
      'measurement-0-parsed-valid-2-logging',
    ]) {
      const stdout = await readFile(
        join(output, `${prefix}.stdout.log`),
        'utf8',
      );
      assert.match(stdout, /validator ready/);
      assert.match(stdout, /validator disposed/);
      assert.match(
        await readFile(join(output, `${prefix}.stderr.log`), 'utf8'),
        /cleanup diagnostic/,
      );
    }
  });

  void test('a missing shared source fails setup without misclassifying a valid adapter', async () => {
    const plan = join(root, 'missing-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [
          { id: 'valid', module: adapter, sources: generatedSources },
          { id: 'missing', module: join(root, 'missing.mjs'), sources: [] },
        ],
      }),
    );
    const output = join(root, 'missing-run');
    await assert.rejects(runTiming(plan, output), { code: 'ENOENT' });
    const failure = record(
      JSON.parse(
        await readFile(join(output, 'failure.json'), 'utf8'),
      ) as unknown,
    );
    assert.equal(failure.stage, 'source-setup');
    assert.equal(failure.status, 'invalid');
    await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
    assert.equal(
      (await readdir(output)).filter((name) => name.endsWith('.log')).length,
      0,
    );
  });

  void test('failed qualification prevents timing and cannot produce a complete report', async () => {
    const weak = join(root, 'weak.mjs');
    const marker = join(root, 'timing-started');
    await writeFile(
      weak,
      'import {writeFileSync} from "node:fs";\nexport const create=()=>{if(process.argv[4]!=="preflight")writeFileSync(' +
        JSON.stringify(marker) +
        ',"bad");return {identity:{name:"weak"},validate:input=>({success:true,data:input})}};',
    );
    const plan = join(root, 'weak-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [{ id: 'weak', module: weak, sources: [] }],
      }),
    );
    const result = await runTiming(plan, join(root, 'weak-run'));
    assert.equal(result.status, 'partial');
    assert.equal(result.ineligible.length, 1);
    assert.equal(result.observations.length, 0);
    await assert.rejects(stat(marker), { code: 'ENOENT' });
  });
  void test('changed identities invalidate measurement rather than mixing observations', async () => {
    const changing = join(root, 'changing.mjs');
    await writeFile(
      changing,
      importLine +
        'export const create=()=>({identity:{name:process.argv[4]},validate:responseSchemas.RecordList.safeParse});',
    );
    const plan = join(root, 'changing-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [
          { id: 'changing', module: changing, sources: generatedSources },
        ],
      }),
    );
    const output = join(root, 'changing-run');
    await assert.rejects(runTiming(plan, output), /identity changed/);
    await assert.rejects(stat(join(output, 'report.json')), {
      code: 'ENOENT',
    });
    assert.ok(
      (await readFile(join(output, 'failure.json'), 'utf8')).includes(
        'invalid',
      ),
    );
  });
  void test('adapter methods retain their factory receiver and disposal state', async () => {
    const stateful = join(root, 'stateful.mjs');
    const disposed = join(root, 'disposed');
    await writeFile(
      stateful,
      importLine +
        'import {writeFileSync} from "node:fs";\nexport const create=()=>({schema:responseSchemas.RecordList,identity:{name:"stateful"},validate(input){return this.schema.safeParse(input)},dispose(){writeFileSync(' +
        JSON.stringify(disposed) +
        ',this.identity.name)}});',
    );
    assert.equal(
      record(
        await timingWorker(stateful, 'preflight', {
          seed: 1,
          policy: shortPolicy,
        }),
      ).behavior,
      'verified',
    );
    assert.equal(await readFile(disposed, 'utf8'), 'stateful');
  });
  void test('declared dependency changes invalidate an unchanged adapter entry', async () => {
    const helper = join(root, 'helper.mjs');
    const helperSource =
      importLine +
      'export const validate=responseSchemas.RecordList.safeParse;\n';
    const changing = join(root, 'dependency-change.mjs');
    const plan = join(root, 'dependency-plan.json');
    const mutator = {
      id: 'change',
      module: changing,
      sources: [helper, ...generatedSources],
    };
    const good = { id: 'good', module: adapter, sources: generatedSources };
    for (const crash of [false, true]) {
      await writeFile(
        changing,
        'import {validate} from "./helper.mjs";import {appendFileSync} from "node:fs";\n' +
          'export const create=()=>({identity:{name:"stable"},validate,dispose(){appendFileSync(' +
          JSON.stringify(helper) +
          ',"// changed dependency\\n");' +
          (crash
            ? 'throw new Error("setup failure after source mutation");'
            : '') +
          '}});',
      );
      for (const [order, adapters] of [
        [mutator, good],
        [good, mutator],
      ].entries()) {
        await writeFile(helper, helperSource);
        await writeFile(
          plan,
          JSON.stringify({
            version: 1,
            rounds: 1,
            policy: shortPolicy,
            adapters,
          }),
        );
        const output = join(root, `dependency-run-${crash}-${order}`);
        await assert.rejects(
          runTiming(plan, output),
          /shared declared sources changed/,
        );
        const failure = record(
          JSON.parse(
            await readFile(join(output, 'failure.json'), 'utf8'),
          ) as unknown,
        );
        assert.equal(failure.status, 'invalid');
        assert.equal(failure.stage, 'qualification');
        await assert.rejects(stat(join(output, 'report.json')), {
          code: 'ENOENT',
        });
        assert.equal(
          (await readdir(output)).filter((name) =>
            name.startsWith('measurement-'),
          ).length,
          0,
        );
      }
    }
  });
  void test('an expected semantic rejection preserves valid measurements', async () => {
    const weak = join(root, 'expected-weak.mjs');
    await writeFile(
      weak,
      'export const create=()=>({identity:{name:"weak"},validate:input=>({success:true,data:input})});',
    );
    const plan = join(root, 'expected-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [
          { id: 'good', module: adapter, sources: generatedSources },
          { id: 'weak', module: weak, sources: [], expect: 'ineligible' },
        ],
      }),
    );
    const result = await runTiming(plan, join(root, 'expected-run'));
    assert.equal(result.status, 'complete');
    assert.equal(result.qualified.length, 1);
    assert.equal(result.controls[0]!.status, 'rejected-as-expected');
    assert.equal(result.ineligible.length, 0);
    assert.equal(result.observations.length, 3);
  });
  void test('negative-control setup failure cannot satisfy semantic rejection', async () => {
    const broken = join(root, 'broken-control.mjs');
    await writeFile(
      broken,
      'export const create=()=>{throw new Error("setup failure")};',
    );
    const plan = join(root, 'broken-control-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [
          { id: 'good', module: adapter, sources: generatedSources },
          { id: 'broken', module: broken, sources: [], expect: 'ineligible' },
        ],
      }),
    );
    const output = join(root, 'broken-control-run');
    await assert.rejects(
      runTiming(plan, output),
      /negative control failed before oracle/,
    );
    await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
    assert.equal(
      (await readdir(output)).filter((name) => name.startsWith('measurement-'))
        .length,
      0,
    );
  });
  void test('a negative control unexpectedly passing blocks all timing', async () => {
    const plan = join(root, 'negative-plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        rounds: 1,
        policy: shortPolicy,
        adapters: [
          {
            id: 'negative',
            module: adapter,
            sources: generatedSources,
            expect: 'ineligible',
          },
        ],
      }),
    );
    const output = join(root, 'negative-run');
    await assert.rejects(
      runTiming(plan, output),
      /negative control unexpectedly qualified/,
    );
    await assert.rejects(stat(join(output, 'report.json')), {
      code: 'ENOENT',
    });
  });
});
