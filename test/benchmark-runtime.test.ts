import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import {
  jsonResponseSubject,
  jsonResponseWorkload,
  verifyJsonResponseRejection,
  verifyJsonResponseValue,
} from '../bench/cases/json-response.ts';
import {
  collectionProfiles,
  defaultProfiles,
  profileKey,
  runtimePool,
  runtimeProfiles,
} from '../bench/cases/json-response-runtime.ts';
import { measureValidation, runTiming, timingWorker } from '../bench/timing.ts';
import { generatedWorkspace, importGenerated } from './generated-workspace.ts';
import { json, record } from './assertions.ts';

const policy = { warmupMs: 0, sampleMs: 1, samples: 1, batchSize: 16 };

void test('runtime selections reject impossible, duplicate and out-of-contract profiles', () => {
  assert.equal(runtimeProfiles(collectionProfiles).length, 16);
  assert.deepEqual(runtimeProfiles(defaultProfiles), defaultProfiles);
  for (const profiles of [
    [],
    [{ scenario: 'bad', records: 1 }],
    [{ scenario: 'parsed-valid', records: 129 }],
    [{ scenario: 'parsed-valid', records: -1 }],
    [{ scenario: 'parsed-valid', records: 1.5 }],
    [{ scenario: 'parsed-valid', records: 1, extra: true }],
    [{ scenario: 'parsed-invalid-last', records: 0 }],
    [{ scenario: 'parsed-invalid-many', records: 1 }],
    [defaultProfiles[0], defaultProfiles[0]],
  ])
    assert.throws(() => runtimeProfiles(profiles));
});

void test('collection data has explicit cardinality, independent objects and the declared invalid positions', () => {
  for (const profile of collectionProfiles) {
    const pool = runtimePool(0, profile);
    assert.equal(pool.length, 64);
    assert.equal(new Set(pool.map(({ input }) => input)).size, 64);
    const first = pool[0]!;
    assert.equal(first.input.items.length, profile.records);
    assert.equal(first.expected.items.length, profile.records);
    assert.deepEqual(
      first.input.items.map(({ id }) => id),
      Array.from({ length: profile.records }, (_, i) => i + 1),
    );
    assert.deepEqual(JSON.parse(first.text) as unknown, first.input);
    if (profile.records) {
      assert.equal(first.expected.items[0]!.label, 'Alpha 0');
      assert.equal(record(first.expected.items[0]).note, 'First record');
      assert.equal(Object.hasOwn(first.expected.items[0]!, 'secret'), false);
      assert.notEqual(
        first.input.items[0]!.details.tags,
        first.expected.items[0]!.details.tags,
      );
      assert.notEqual(first.input.items[0], pool[1]!.input.items[0]);
    }
    if (profile.records > 1) {
      assert.equal(first.expected.items[1]!.label, 'Beta 0');
      assert.equal(Object.hasOwn(first.expected.items[1]!, 'note'), false);
    }
    const invalid = first.input.items.flatMap((item, i) =>
      item.details.tags.some((tag: string) => tag === '') ? [i] : [],
    );
    const positions =
      profile.scenario === 'parsed-invalid-first'
        ? [0]
        : profile.scenario === 'parsed-invalid-last'
          ? [profile.records - 1]
          : profile.scenario === 'parsed-invalid-many'
            ? Array.from({ length: Math.min(16, profile.records) }, (_, i) => i)
            : [];
    assert.deepEqual(invalid, positions);
    assert.deepEqual(
      first.paths,
      positions.map((i) => ['items', i, 'details', 'tags', 0]),
    );
    assert.ok(
      first.expected.items.every(
        ({ details }) => !details.tags.some((tag: string) => tag === ''),
      ),
    );
  }
});

void describe('collection family uses the existing oracle and process runner', () => {
  let root = '';
  let subject: ReturnType<typeof jsonResponseSubject>;
  let sources: string[];
  let adapter: string;
  let importLine: string;
  before(async () => {
    const { document, options } = jsonResponseWorkload();
    const files = await compile(document, options);
    root = await generatedWorkspace(files);
    sources = Object.keys(files).map((name) => join(root, name));
    subject = jsonResponseSubject(
      await importGenerated<unknown>(root, 'client.consumer.ts'),
      await importGenerated<unknown>(root, 'client.consumer.schemas.ts'),
    );
    importLine = `import {responseSchemas} from ${JSON.stringify(pathToFileURL(join(root, 'client.consumer.schemas.ts')).href)};\n`;
    adapter = join(root, 'adapter.mjs');
    await writeFile(
      adapter,
      importLine +
        'export const create=()=>({identity:{name:"POM"},validate:responseSchemas.RecordList.safeParse});\n',
    );
  });
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  for (const profile of collectionProfiles)
    void test(profileKey(profile), () => {
      const sample = runtimePool(1, profile)[0]!;
      if (sample.paths.length)
        verifyJsonResponseRejection(subject, sample.input, sample.paths);
      else verifyJsonResponseValue(subject, sample.input, sample.expected);
      const result = measureValidation(
        subject.validate,
        profile.scenario,
        1,
        policy,
        profile.records,
      );
      assert.equal(result.observations.length, 1);
      assert.ok(result.operations > 0 && result.usPerOperation > 0);
    });

  void test('the honest adapter passes complete qualification for all collection profiles', async () => {
    const result = await timingWorker(adapter, 'preflight', {
      seed: 1,
      policy,
      profiles: collectionProfiles,
    });
    assert.equal(record(result).behavior, 'verified');
  });

  void test('every selected profile is qualified before any cell is measured', async () => {
    const corrupt = join(root, 'large-shortcut.mjs');
    await writeFile(
      corrupt,
      importLine +
        `export const create=()=>({identity:{name:'bad'},validate(input){
      const result=responseSchemas.RecordList.safeParse(input);
      if(result.success&&result.data.items.length===128)result.data.items.pop();
      return result;
    }});`,
    );
    const result = await timingWorker(corrupt, 'preflight', {
      seed: 1,
      policy,
      profiles: collectionProfiles,
    });
    assert.equal(record(result).behavior, 'rejected');
    assert.match(String(record(result).reason), /deep-equal/);
  });

  void test('discarded diagnostics and corruption of escaping large results fail the checks', () => {
    const firstOnly = (input: unknown) => {
      const result = record(subject.validate(input));
      if (result.success === false) {
        const issues = record(result.error).issues;
        assert.ok(Array.isArray(issues));
        record(result.error).issues = issues.slice(0, 1);
      }
      return result;
    };
    const invalid = runtimePool(1, {
      scenario: 'parsed-invalid-many',
      records: 128,
    })[0]!;
    assert.throws(
      () =>
        verifyJsonResponseRejection(
          { validate: firstOnly },
          invalid.input,
          invalid.paths,
        ),
      /expected issue path/,
    );
    assert.throws(
      () => measureValidation(firstOnly, 'parsed-invalid-many', 1, policy, 128),
      /expected issue path/,
    );
    const corrupt = (input: unknown) => {
      const result = record(subject.validate(input));
      if (result.success) {
        const items = record(result.data).items;
        assert.ok(Array.isArray(items));
        record(items[127]).label = 'corrupt';
      }
      return result;
    };
    assert.throws(
      () => measureValidation(corrupt, 'parsed-valid', 1, policy, 128),
      /deep-equal/,
    );
  });

  void test('size-specific frozen results and cloned stale snapshots fail qualification', async () => {
    for (const [name, code, reason] of [
      [
        'frozen-empty',
        `const result=responseSchemas.RecordList.safeParse(input);
        if(result.success&&result.data.items.length===0)Object.freeze(result.data);return result;`,
        /read only|not extensible/,
      ],
      [
        'frozen-small-array',
        `const result=responseSchemas.RecordList.safeParse(input);if(result.success&&result.data.items.length<2)Object.freeze(result.data.items);return result;`,
        /read only|not extensible/,
      ],
      [
        'frozen-large',
        `const result=responseSchemas.RecordList.safeParse(input);
        if(result.success&&result.data.items.length===128)Object.freeze(result.data.items[127].details.tags);return result;`,
        /read only|not extensible/,
      ],
      [
        'stale-large',
        `if(cache.has(input))return structuredClone(cache.get(input));
        const result=responseSchemas.RecordList.safeParse(input);
        if(result.success&&result.data.items.length>=16)cache.set(input,structuredClone(result));return result;`,
        /deep-equal/,
      ],
      [
        'stale-error-large',
        `if(cache.has(input))return cache.get(input);
         const result=responseSchemas.RecordList.safeParse(input);
         if(!result.success&&Array.isArray(input?.items)&&input.items.length>=16)cache.set(input,result);return result;`,
        /false !== true/,
      ],
      [
        'read-excluded-large',
        `if(input?.items?.length>=16)for(const item of input.items)void item.secret;
        return responseSchemas.RecordList.safeParse(input);`,
        /excluded response field was read/,
      ],
    ] as const) {
      const module = join(root, `${name}.mjs`);
      await writeFile(
        module,
        importLine +
          `export const create=()=>{const cache=new WeakMap();return {identity:{name:${JSON.stringify(name)}},validate(input){${code}}}};`,
      );
      const result = await timingWorker(module, 'preflight', {
        seed: 1,
        policy,
        profiles: collectionProfiles,
      });
      assert.equal(record(result).behavior, 'rejected', name);
      assert.match(String(record(result).reason), reason, name);
    }
  });

  void test('fresh workers keep cardinalities distinct in raw records and summaries', async () => {
    const profiles = [
      { scenario: 'parsed-valid', records: 0 },
      { scenario: 'parsed-valid', records: 16 },
      { scenario: 'parsed-invalid-many', records: 128 },
    ];
    const plan = join(root, 'plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        seed: 1,
        rounds: 1,
        policy,
        profiles,
        adapters: [{ id: 'POM', module: adapter, sources }],
      }),
    );
    const output = join(root, 'run');
    const report = await runTiming(plan, output);
    assert.equal(report.schemaVersion, 2);
    assert.equal(report.status, 'complete');
    assert.deepEqual(report.profiles, profiles);
    assert.equal(report.summary.length, 3);
    assert.deepEqual(
      report.observations
        .map(({ profilePosition }) => profilePosition)
        .sort((a, b) => a - b),
      [0, 1, 2],
    );
    assert.equal(new Set(report.observations.map(({ file }) => file)).size, 3);
    for (const row of report.observations) {
      const raw = record(json(await readFile(join(output, row.file), 'utf8')));
      assert.equal(raw.records, row.records);
      assert.equal(raw.mode, row.scenario);
      assert.deepEqual(record(raw.identity).profiles, profiles);
      assert.ok(
        report.summary.some(
          (s) => s.records === row.records && s.scenario === row.scenario,
        ),
      );
    }
  });
});
