import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before, describe } from 'node:test';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import { compareArtifacts } from '../bench/comparison.ts';
import { jsonResponseWorkload } from '../bench/cases/json-response.ts';
import { installedTree } from '../bench/installed.ts';
import { json, record } from './assertions.ts';

const exec = promisify(execFile);
const digest = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const settings = {
  rounds: 2,
  seed: 7,
  policy: { warmupMs: 0, sampleMs: 1, samples: 1, batchSize: 16 },
};

void describe('artifact-to-timing comparison', () => {
  let root = '';
  let outputs: Record<string, string>;
  before(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'pom-comparison-'));
    const { document, options } = jsonResponseWorkload();
    outputs = await compile(document, options);
  });
  after(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function fixture(name: string, transform = (source: string) => source) {
    const directory = join(root, name);
    const packageDirectory = join(directory, 'package');
    await mkdir(packageDirectory, { recursive: true });
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({
        name: 'pomegranate-compiler',
        version: '0.0.0-test',
        type: 'module',
        exports: './index.js',
      }),
    );
    // The focused fixture packages real generated output, not a second compiler.
    // Canonical packed verification covers the actual compiler implementation.
    const files = { ...outputs };
    files['client.consumer.schemas.ts'] = transform(
      files['client.consumer.schemas.ts']!,
    );
    await writeFile(
      join(packageDirectory, 'index.js'),
      'if(process.argv.includes("--worker"))throw new Error("compiler loaded during timing");\n' +
        `export const compile = async () => (${JSON.stringify(files)});\n`,
    );
    const archive = join(directory, 'compiler.tgz');
    await exec('tar', ['-czf', archive, '-C', directory, 'package']);
    const artifact = { path: archive, sha256: digest(await readFile(archive)) };
    const plan = join(directory, 'plan.json');
    await writeFile(
      plan,
      JSON.stringify({
        version: 1,
        baseline: artifact,
        candidate: artifact,
        releaseAnchor: artifact,
      }),
    );
    return { directory, archive, artifact, plan };
  }

  void test('joins exact artifact, generated output and fresh-worker receipts without loading the compiler in timing', async () => {
    const input = await fixture('complete');
    const output = join(input.directory, 'run');
    const report = await compareArtifacts(input.plan, output, settings);
    assert.equal(report.status, 'complete');
    assert.equal(report.preparation.behavior, 'verified');
    assert.equal(report.timing.observations.length, 18);
    assert.equal(report.timing.qualified.length, 3);
    for (const artifact of report.preparation.artifacts) {
      const consumer = join(output, 'prepared', artifact.role);
      assert.equal(
        await realpath(join(consumer, 'node_modules/pomegranate-compiler')),
        join(consumer, 'node_modules/pomegranate-compiler'),
      );
      assert.equal(artifact.archive.sha256, input.artifact.sha256);
      const generated = join(consumer, artifact.generated.directory);
      assert.equal(
        (await installedTree(generated)).sha256,
        artifact.generated.treeSha256,
      );
      for (const file of artifact.generated.files)
        assert.equal(
          digest(await readFile(join(generated, file.name))),
          file.sha256,
        );
      const qualified = report.timing.qualified.find(
        ({ id }) => id === artifact.role,
      );
      assert.ok(qualified);
      const identity = record(record(qualified.identity).adapter);
      assert.equal(identity.role, artifact.role);
      assert.equal(identity.archiveSha256, artifact.archive.sha256);
      assert.equal(identity.installedTreeSha256, artifact.installedTreeSha256);
      assert.equal(identity.generatedSha256, artifact.generated.sha256);
      assert.equal(identity.generatedTreeSha256, artifact.generated.treeSha256);
      const raw = record(
        json(
          await readFile(
            join(
              output,
              'timing',
              report.timing.observations.find(({ id }) => id === artifact.role)!
                .file,
            ),
            'utf8',
          ),
        ),
      );
      assert.deepEqual(raw.identity, qualified.identity);
    }
    assert.equal(report.receipts.length, 2);
    for (const receipt of report.receipts)
      assert.equal(
        digest(await readFile(join(output, receipt.path))),
        receipt.sha256,
      );
    const before = await readFile(join(output, 'report.json'));
    await assert.rejects(compareArtifacts(input.plan, output, settings), {
      code: 'EEXIST',
    });
    assert.deepEqual(await readFile(join(output, 'report.json')), before);
    assert.equal(digest(await readFile(input.archive)), input.artifact.sha256);
  });

  void test('bad settings fail before creating output; a bad archive keeps failure evidence without timing', async () => {
    const input = await fixture('invalid');
    const output = join(input.directory, 'run');
    for (const invalid of [
      { rounds: 0 },
      { seed: -1 },
      { policy: {} },
      { ignored: true },
    ])
      await assert.rejects(compareArtifacts(input.plan, output, invalid));
    await assert.rejects(stat(output), { code: 'ENOENT' });
    await writeFile(
      input.plan,
      JSON.stringify({
        version: 1,
        baseline: input.artifact,
        candidate: { ...input.artifact, sha256: '0'.repeat(64) },
        releaseAnchor: input.artifact,
      }),
    );
    await assert.rejects(
      compareArtifacts(input.plan, output, settings),
      /SHA-256 mismatch/,
    );
    assert.equal(
      record(json(await readFile(join(output, 'failure.json'), 'utf8'))).stage,
      'preparation',
    );
    await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(output, 'timing')), { code: 'ENOENT' });
    assert.equal(digest(await readFile(input.archive)), input.artifact.sha256);
  });

  void test('changed generated code invalidates measurement and preserves both failure records', async () => {
    const input = await fixture(
      'generated-drift',
      (source) =>
        source +
        `
import {appendFileSync} from 'node:fs';
if(process.argv[2]==='--worker'&&process.argv[4]!=='preflight')appendFileSync(new URL(import.meta.url),'\\n// changed generated bytes\\n');
`,
    );
    const output = join(input.directory, 'run');
    await assert.rejects(
      compareArtifacts(input.plan, output, settings),
      /sources changed/,
    );
    assert.equal(
      record(json(await readFile(join(output, 'failure.json'), 'utf8'))).stage,
      'timing',
    );
    assert.equal(
      record(json(await readFile(join(output, 'timing/failure.json'), 'utf8')))
        .status,
      'invalid',
    );
    await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
    await assert.rejects(stat(join(output, 'timing/report.json')), {
      code: 'ENOENT',
    });
  });

  void test('a seeded qualification failure remains a partial comparison with no measurements', async () => {
    const input = await fixture(
      'partial',
      (source) =>
        source.replaceAll('responseSchemas', 'originalResponseSchemas') +
        `
const originalParse=originalResponseSchemas.RecordList.safeParse;
export const responseSchemas={...originalResponseSchemas,RecordList:{...originalResponseSchemas.RecordList,safeParse(input){
 const result=originalParse(input);
 if(result.success&&result.data.items[0]?.id===897)result.data.items[0].label='corrupt';
 return result;
}}};
`,
    );
    const output = join(input.directory, 'run');
    const report = await compareArtifacts(input.plan, output, settings);
    assert.equal(report.status, 'partial');
    assert.equal(report.preparation.behavior, 'verified');
    assert.equal(report.timing.qualified.length, 0);
    assert.equal(report.timing.ineligible.length, 3);
    assert.equal(report.timing.observations.length, 0);
    assert.equal(
      record(json(await readFile(join(output, 'report.json'), 'utf8'))).status,
      'partial',
    );
  });

  void test('artifact drift cannot become a completed joined report even if timing succeeds', async () => {
    const input = await fixture(
      'archive-drift',
      (source) =>
        source +
        `
import {appendFileSync,chmodSync} from 'node:fs';
if(process.argv[2]==='--worker'&&process.argv[4]!=='preflight'){
 const archive=new URL('../compiler.tgz',import.meta.url);
 chmodSync(archive,0o600);appendFileSync(archive,'changed archive');
}
`,
    );
    const output = join(input.directory, 'run');
    await assert.rejects(
      compareArtifacts(input.plan, output, settings),
      /artifacts changed during timing/,
    );
    assert.equal(
      record(json(await readFile(join(output, 'failure.json'), 'utf8'))).stage,
      'report',
    );
    assert.equal(
      record(json(await readFile(join(output, 'timing/report.json'), 'utf8')))
        .status,
      'complete',
    );
    await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
    assert.equal(digest(await readFile(input.archive)), input.artifact.sha256);
  });
});
