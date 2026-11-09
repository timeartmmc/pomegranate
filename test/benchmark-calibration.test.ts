import assert from 'node:assert/strict';
import { cp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../dist/index.js';
import {
  analyzeCalibration,
  calibrationPlan,
  calibrationSession,
} from '../bench/calibration.ts';
import { readPlan, sha256 } from '../bench/controller.ts';
import { jsonResponseWorkload } from '../bench/cases/json-response.ts';
import { runTiming } from '../bench/timing.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { json, record } from './assertions.ts';

void describe('fixed-plan calibration analysis', () => {
  let root = '';
  let path: string;
  let study: Awaited<ReturnType<typeof readPlan>>;
  let plan: ReturnType<typeof calibrationPlan>;
  let reports: Awaited<ReturnType<typeof runTiming>>[];
  before(async () => {
    const { document, options } = jsonResponseWorkload();
    root = await generatedWorkspace(await compile(document, options));
    path = join(root, 'study.json');
    const profiles = [{ scenario: 'parsed-valid', records: 2 }];
    const policy = { warmupMs: 0, sampleMs: 1, samples: 1, batchSize: 16 };
    const input = {
      version: 1,
      rounds: 2,
      policy,
      profiles,
      reference: 'reference',
      comparisons: [
        { id: 'same', kind: 'identical' },
        { id: 'extra', kind: 'repeat', every: 2 },
      ],
      controls: ['bad'],
      sessions: [
        { id: 's1', seed: 11, report: './s1/report.json' },
        { id: 's2', seed: 12, report: './s2/report.json' },
      ],
    };
    await writeFile(path, JSON.stringify(input));
    study = await readPlan(path);
    plan = calibrationPlan(study.value);
    const pom = new URL('../bench/pom.ts', import.meta.url).href;
    const controls = new URL('../bench/controls.ts', import.meta.url).href;
    const schemas = pathToFileURL(
      join(root, 'client.consumer.schemas.ts'),
    ).href;
    for (const [name, every] of [
      ['reference', 0],
      ['extra', 2],
    ] as const) {
      await writeFile(
        join(root, `${name}.mjs`),
        `
        import {createPomAdapter} from ${JSON.stringify(pom)};
        import {repeatValidation} from ${JSON.stringify(controls)};
        export const create=async()=>repeatValidation(await createPomAdapter(new URL(${JSON.stringify(schemas)}),{name:'POM-test'}),${every});
      `,
      );
    }
    await writeFile(
      join(root, 'bad.mjs'),
      `export const create=()=>({identity:{name:'bad'},validate:input=>({success:true,data:input})});`,
    );
    const adapters = [
      { id: 'reference', module: './reference.mjs' },
      { id: 'same', module: './reference.mjs' },
      { id: 'extra', module: './extra.mjs' },
      { id: 'bad', module: './bad.mjs', expect: 'ineligible' },
    ].map((adapter) => ({
      ...adapter,
      sources: [
        path,
        join(root, 'client.consumer.schemas.ts'),
        join(root, 'runtime.ts'),
      ],
    }));
    // Freeze both session inputs before collecting either report.
    for (const session of input.sessions)
      await writeFile(
        join(root, `${session.id}.json`),
        JSON.stringify({
          version: 1,
          rounds: input.rounds,
          seed: session.seed,
          policy,
          profiles,
          adapters,
        }),
      );
    reports = [];
    for (const session of input.sessions)
      reports.push(
        await runTiming(
          join(root, `${session.id}.json`),
          join(root, session.id),
        ),
      );
  });
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  void test('analyzes complete sessions without treating windows as independent samples', async () => {
    const result = await analyzeCalibration(path, join(root, 'analysis'));
    assert.equal(result.status, 'complete');
    assert.equal(result.sessions.length, 2);
    assert.equal(result.summary.length, 2);
    for (const { cells } of result.sessions)
      for (const cell of cells) {
        assert.equal(cell.pairs, 2);
        assert.equal(cell.familySize, 2);
        assert.equal(cell.signal, 'unresolved');
        assert.equal(cell.lower, null);
        assert.equal(cell.effects.length, 2);
      }
    assert.match(result.qualification, /no CI threshold/);
    assert.equal(result.study.sha256, study.sha256);
  });

  void test('missing, duplicate, nonfinite or incompatible evidence invalidates a session', () => {
    const alterations: ((report: Record<string, unknown>) => void)[] = [
      (report) => {
        report.status = 'partial';
      },
      (report) => {
        report.seed = 99;
      },
      (report) => {
        report.rounds = 1;
      },
      (report) => {
        report.sources = [];
      },
      (report) => {
        report.controls = [];
      },
      (report) => {
        report.host = {};
      },
      (report) => {
        (report.observations as unknown[]).pop();
      },
      (report) => {
        const rows = report.observations as unknown[];
        rows[0] = rows[1];
      },
      (report) => {
        record((report.observations as unknown[])[0]).usPerOperation = NaN;
      },
      (report) => {
        report.qualified = (report.qualified as unknown[]).slice(1);
      },
      (report) => {
        const same = (report.qualified as Record<string, unknown>[]).find(
          ({ id }) => id === 'same',
        )!;
        same.module = '/other/factory.mjs';
      },
      (report) => {
        const same = (report.qualified as Record<string, unknown>[]).find(
          ({ id }) => id === 'same',
        )!;
        record(record(same.identity).adapter).name = 'different-artifact';
        same.fingerprint = sha256(JSON.stringify(same.identity));
      },
      (report) => {
        const extra = (report.qualified as Record<string, unknown>[]).find(
          ({ id }) => id === 'extra',
        )!;
        record(record(extra.identity).adapter).repeatEvery = '4';
        extra.fingerprint = sha256(JSON.stringify(extra.identity));
      },
    ];
    for (const alter of alterations) {
      const report = structuredClone(reports[0]!) as unknown as Record<
        string,
        unknown
      >;
      alter(report);
      assert.throws(() => calibrationSession(report, plan, 11, study));
    }
  });

  void test('a copied analyzer records its own provenance while preserving collection identities', async () => {
    const copied = join(root, 'copied-bench');
    await cp(fileURLToPath(new URL('../bench', import.meta.url)), copied, {
      recursive: true,
    });
    await writeFile(
      join(copied, 'unused-helper.ts'),
      'export const unused = true;\n',
    );
    const module: unknown = await import(
      pathToFileURL(join(copied, 'calibration.ts')).href
    );
    const analyze = record(module).analyzeCalibration;
    assert.equal(typeof analyze, 'function');
    const result = await (analyze as typeof analyzeCalibration)(
      path,
      join(root, 'copied-analysis'),
    );
    assert.deepEqual(result.compatibility, {
      host: reports[0]!.host,
      sources: reports[0]!.sources,
      qualified: reports[0]!.qualified,
    });
    assert.equal(result.analyzerSources[0]!.path, copied);
    const original = reports[0]!.sources.find(
      ({ path }) =>
        path === fileURLToPath(new URL('../bench', import.meta.url)),
    );
    assert.ok(original);
    assert.notEqual(result.analyzerSources[0]!.sha256, original.sha256);
  });

  void test('changing the host across sessions leaves failed-analysis evidence, without a report', async () => {
    const report = structuredClone(reports[1]!);
    report.host.cpu = 'other-host';
    await writeFile(join(root, 's2/report.json'), JSON.stringify(report));
    const output = join(root, 'incompatible');
    await assert.rejects(
      analyzeCalibration(path, output),
      /session source, host or adapter identity changed/,
    );
    const failure = record(
      json(await readFile(join(output, 'failure.json'), 'utf8')),
    );
    assert.equal(failure.stage, 'analysis');
    await assert.rejects(readFile(join(output, 'report.json')), {
      code: 'ENOENT',
    });
  });

  void test('study policy, comparisons and session seeds must be explicit and unambiguous', () => {
    for (const change of [
      { rounds: null },
      { policy: null },
      { profiles: null },
      { comparisons: [{ id: 'reference', kind: 'identical' }] },
      { comparisons: [{ id: 'extra', kind: 'repeat', every: 0 }] },
      {
        sessions: [
          { id: 'a', seed: null, report: 'a' },
          { id: 'b', seed: 1, report: 'b' },
        ],
      },
      {
        sessions: [
          { id: 'a', seed: 1, report: 'a' },
          { id: 'b', seed: 1, report: 'b' },
        ],
      },
    ])
      assert.throws(() =>
        calibrationPlan({ ...record(study.value), ...change }),
      );
  });
});
