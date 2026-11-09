import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before, describe } from 'node:test';
import { compile } from '../dist/index.js';
import {
  outputGrowthProfiles,
  outputGrowthWorkload,
  verifyOutputGrowth,
} from '../bench/cases/output-growth.ts';
import type { OutputGrowthProfile } from '../bench/cases/output-growth.ts';
import {
  inspectOutput,
  runOutputGrowth as collectOutputGrowth,
  OutputGrowthError,
  verifyOutputBudgets,
} from '../bench/output-growth.ts';
import { json, record } from './assertions.ts';
import { temporary } from './helpers.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';

const exec = promisify(execFile);
const tsc = fileURLToPath(
  new URL('../node_modules/typescript/bin/tsc', import.meta.url),
);
const failedDirectories = new Set<string>();
async function runOutputGrowth(
  ...args: Parameters<typeof collectOutputGrowth>
) {
  try {
    return await collectOutputGrowth(...args);
  } catch (error) {
    if (error instanceof OutputGrowthError)
      failedDirectories.add(error.evidenceDirectory);
    throw error;
  }
}
after(async () => {
  for (const directory of failedDirectories)
    await rm(directory, { recursive: true, force: true });
});

void test('source sizes count UTF-8 bytes and preserve real filenames without ambiguous logical keys', () => {
  const source = '// café 🥑';
  const measured = inspectOutput({ 'example.ts': source }).metrics;
  assert.equal(measured.totalBytes, Buffer.byteLength(source));
  assert.notEqual(measured.totalBytes, source.length);
  assert.equal(measured.files[0]!.name, 'example.ts');
  for (const value of [
    null,
    {},
    { '../escape.ts': 'bad' },
    { 'nested/file.ts': 'bad' },
    { 'file.ts': 1 },
    { 'file.ts': '' },
  ])
    assert.throws(() => inspectOutput(value));
  assert.throws(
    () =>
      inspectOutput({
        [`schema-types.${'a'.repeat(64)}.ts`]: 'export {};',
        [`schema-types.${'b'.repeat(64)}.ts`]: 'export {};',
      }),
    /ambiguous output budget keys/,
  );
});

void describe('deterministic contract-output budgets', () => {
  const fixtures = new Map<
    string,
    { profile: OutputGrowthProfile; files: Readonly<Record<string, string>> }
  >();
  let cells: Parameters<typeof verifyOutputBudgets>[0];
  before(async () => {
    const collected = [];
    for (const profile of outputGrowthProfiles) {
      const workload = outputGrowthWorkload(profile);
      const files = await compile(workload.document, workload.options);
      fixtures.set(JSON.stringify(workload.document), { profile, files });
      collected.push({ profile, metrics: inspectOutput(files).metrics });
    }
    cells = collected;
  });

  function candidate(
    alter: (
      files: Record<string, string>,
      profile: OutputGrowthProfile,
    ) => void,
  ) {
    return async (document: unknown) => {
      const fixture = fixtures.get(JSON.stringify(document));
      assert.ok(fixture);
      const files = { ...fixture.files };
      alter(files, fixture.profile);
      return files;
    };
  }

  void test('the public compiler passes all four semantic/type qualifications and budgets', async () => {
    const report = await runOutputGrowth(compile, tsc);
    assert.equal(report.behavior, 'verified');
    assert.equal(report.generatedTypes, 'verified');
    assert.equal(report.sourceBudgets, 'passed');
    assert.equal(report.cells.length, 4);
    assert.ok(
      report.growth.interactionBytes <= report.growth.maximumInteractionBytes,
    );
    assert.deepEqual(
      report.cells.map(({ metrics }) => metrics.files.length),
      [7, 7, 7, 7],
    );
  });

  void test('duplicating real emitted code as inert data fails a named file budget after qualification', async () => {
    await assert.rejects(
      runOutputGrowth(
        candidate((files, profile) => {
          if (profile.id === 'combined') {
            const name = 'client.consumer.operations.ts';
            files[name] += `\nvoid ${JSON.stringify(files[name])};\n`;
          }
        }),
        tsc,
      ),
      /combined: client.consumer.operations.ts exceeds generated-source byte budget/,
    );
  });

  void test('small fixed boilerplate growth is allowed without weakening the interaction check', async () => {
    const report = await runOutputGrowth(
      candidate((files) => {
        files['client.consumer.ts'] +=
          `\nvoid ${JSON.stringify('x'.repeat(100))};\n`;
      }),
      tsc,
    );
    assert.equal(report.sourceBudgets, 'passed');
    assert.equal(report.growth.interactionBytes, 0);
  });

  void test('cross-axis output growth fails even inside each individual file allowance', async () => {
    await assert.rejects(
      runOutputGrowth(
        candidate((files, profile) => {
          if (profile.id === 'combined')
            files['client.consumer.operations.ts'] +=
              `\nvoid ${JSON.stringify('x'.repeat(1030))};\n`;
        }),
        tsc,
      ),
      /interaction exceeds output growth budget/,
    );
  });

  void test('extra generated files and missing measurement cells cannot evade the complete inventory', async () => {
    await assert.rejects(
      runOutputGrowth(
        candidate((files) => {
          files['extra.ts'] = 'export {};';
        }),
        tsc,
      ),
      /generated output inventory changed/,
    );
    assert.throws(
      () => verifyOutputBudgets(cells.slice(1)),
      /all output-growth profiles/,
    );
  });

  void test('smaller output cannot qualify by silently omitting an operation', async () => {
    await assert.rejects(
      runOutputGrowth(
        candidate((files, profile) => {
          if (profile.id === 'operations')
            files['client.consumer.ts'] =
              `import {operations as all} from './client.consumer.operations.ts';
      export const operations=Object.fromEntries(Object.entries(all).slice(0,-1));`;
        }),
        tsc,
      ),
      /deep-equal/,
    );
  });

  void test('runtime-correct output cannot qualify after discarding shared type declarations', async () => {
    await assert.rejects(
      runOutputGrowth(
        candidate((files) => {
          const types = Object.keys(files).find((name) =>
            name.startsWith('schema-types.'),
          )!;
          files[types] = 'export {};';
        }),
        tsc,
      ),
      /generated consumer types failed/,
    );
  });

  void test('a typecheck failure retains generated files, inputs and diagnostics at the reported path', async () => {
    let directory = '';
    await assert.rejects(
      runOutputGrowth(
        candidate((files) => {
          files['client.consumer.ts'] +=
            '\nexport const broken: number = "wrong";\n';
        }),
        tsc,
      ),
      (error: unknown) => {
        assert.ok(error instanceof OutputGrowthError);
        directory = error.evidenceDirectory;
        assert.ok(error.message.includes(directory));
        return true;
      },
    );
    assert.ok(directory);
    const failure = record(
      json(await readFile(join(directory, 'failure.json'), 'utf8')),
    );
    assert.equal(failure.stage, 'typecheck');
    assert.match(
      await readFile(join(directory, 'typecheck.stdout.log'), 'utf8'),
      /TS2322/,
    );
    assert.ok(
      (await stat(join(directory, 'small/client.consumer.ts'))).isFile(),
    );
    const input = record(
      json(await readFile(join(directory, 'small/input.json'), 'utf8')),
    );
    assert.deepEqual(record(input.options).clients, ['consumer']);
  });

  void test('each distinct section rejects a validator that omits its kind constraint', async (t) => {
    const fixture = [...fixtures.values()].find(
      ({ profile }) => profile.id === 'schemas',
    )!;
    const root = await generatedTestWorkspace(t, fixture.files);
    const client = await importGenerated<unknown>(root, 'client.consumer.ts');
    const schemas = record(
      await importGenerated<unknown>(root, 'client.consumer.schemas.ts'),
    );
    const responses = record(schemas.responseSchemas);
    const honest = record(responses.Summary);
    assert.ok(typeof honest.safeParse === 'function');
    const safeParse = honest.safeParse;
    verifyOutputGrowth(fixture.profile, client, schemas);
    for (let i = 0; i < 8; i++) {
      const name = `section${String(i).padStart(3, '0')}`;
      const mutant = {
        ...schemas,
        responseSchemas: {
          ...responses,
          Summary: {
            ...honest,
            safeParse(input: unknown) {
              const copy = record(structuredClone(input));
              record(record(copy.sections)[name]).kind = name;
              const result: unknown = Reflect.apply(safeParse, honest, [copy]);
              return result;
            },
          },
        },
      };
      assert.throws(
        () => verifyOutputGrowth(fixture.profile, client, mutant),
        /invalid section kind/,
      );
    }
  });

  void test('a malformed tiny compiler result is rejected before accepting its small size', async () => {
    await assert.rejects(
      runOutputGrowth(
        candidate((files) => {
          for (const name of Object.keys(files)) files[name] = 'export {};';
        }),
        tsc,
      ),
      /expected an object/,
    );
  });

  void test('input mutation and nondeterministic output fail before size acceptance', async () => {
    const cached = candidate(() => {});
    await assert.rejects(
      runOutputGrowth(async (document) => {
        const output = await cached(document);
        record(record(document).info).title = 'mutated';
        return output;
      }, tsc),
      /compilation must preserve input/,
    );
    let invocation = 0;
    await assert.rejects(
      runOutputGrowth(async (document) => {
        const output = await cached(document);
        output['client.consumer.ts'] += `\n// ${invocation++}`;
        return output;
      }, tsc),
      /identical compilation must produce identical complete output/,
    );
    const shared = { ...fixtures.values().next().value!.files };
    await assert.rejects(
      runOutputGrowth(async () => {
        shared['client.consumer.ts'] +=
          '\n// changed after returning the same object';
        return shared;
      }, tsc),
      /identical compilation must produce identical complete output/,
    );
  });
});

void test('the output checker CLI runs the same qualified public-compiler family', async () => {
  const { stdout } = await exec(
    process.execPath,
    [fileURLToPath(new URL('../bench/check-output.ts', import.meta.url))],
    { timeout: 30_000 },
  );
  const report = record(json(stdout));
  assert.equal(report.sourceBudgets, 'passed');
  assert.equal(report.generatedTypes, 'verified');
  assert.equal(record(report.case).id, 'shared-contract-output');
  assert.equal(report.node, process.version);
  const controller = record(report.controller);
  assert.ok(Array.isArray(controller.files) && controller.files.length > 0);
  assert.match(String(controller.sha256), /^[a-f0-9]{64}$/);
  const metadata = record(
    json(await readFile(new URL('../package.json', import.meta.url), 'utf8')),
  );
  const typescript = record(
    json(
      await readFile(
        new URL('../node_modules/typescript/package.json', import.meta.url),
        'utf8',
      ),
    ),
  );
  assert.equal(report.compilerVersion, metadata.version);
  assert.equal(report.typescriptVersion, typescript.version);
  assert.equal(
    typeof record(record(report.referenceBytes).small)['client.consumer.ts'],
    'number',
  );
});

void test('loose compiler and TypeScript entries run without package metadata and attribute enclosing metadata explicitly', async (t) => {
  const root = await temporary(t);
  const compiler = join(root, 'compiler.mjs');
  const typescript = join(root, 'typescript.cjs');
  await writeFile(
    compiler,
    `export {compile} from ${JSON.stringify(import.meta.resolve('pomegranate-compiler'))};\n`,
  );
  await writeFile(typescript, `require(${JSON.stringify(tsc)});\n`);
  const args = [
    fileURLToPath(new URL('../bench/check-output.ts', import.meta.url)),
    compiler,
    typescript,
  ];
  const loose = record(
    json((await exec(process.execPath, args, { timeout: 30_000 })).stdout),
  );
  assert.equal(loose.sourceBudgets, 'passed');
  assert.equal(loose.compilerVersion, null);
  assert.equal(loose.compilerPackageManifest, null);
  assert.equal(loose.typescriptVersion, null);
  assert.equal(loose.typescriptPackageManifest, null);
  const manifest = join(root, 'package.json');
  await writeFile(
    manifest,
    '{"name":"synthetic-benchmark-wrapper","version":"0.0.0-wrapper","type":"module"}\n',
  );
  const wrapped = record(
    json((await exec(process.execPath, args, { timeout: 30_000 })).stdout),
  );
  assert.equal(wrapped.sourceBudgets, 'passed');
  assert.equal(wrapped.compilerVersion, '0.0.0-wrapper');
  assert.equal(wrapped.compilerPackageManifest, await realpath(manifest));
  assert.equal(wrapped.typescriptVersion, '0.0.0-wrapper');
  assert.equal(wrapped.typescriptPackageManifest, await realpath(manifest));
});
