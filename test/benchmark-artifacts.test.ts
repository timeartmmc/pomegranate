import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  artifactPlan,
  prepareArtifacts,
  snapshotArtifact,
} from '../bench/artifacts.ts';
import { json, record } from './assertions.ts';
import { temporary } from './helpers.ts';

const exec = promisify(execFile);
const bytes = Buffer.from('synthetic archive bytes\n');
const digest = createHash('sha256').update(bytes).digest('hex');
const plan = (path: string) => ({
  version: 1,
  baseline: { path, sha256: digest },
  candidate: { path, sha256: digest },
  releaseAnchor: { path, sha256: digest },
});

void test('artifact plan requires every explicit role and resolves paths from the plan directory', () => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  const specs = artifactPlan(plan('input.tgz'), directory);
  assert.deepEqual(
    specs.map(({ role }) => role),
    ['baseline', 'candidate', 'releaseAnchor'],
  );
  for (const spec of specs) {
    assert.equal(spec.path, join(directory, 'input.tgz'));
    assert.equal(spec.sha256, digest);
  }
  for (const value of [
    null,
    {},
    { ...plan('input.tgz'), version: 2 },
    { ...plan('input.tgz'), unknown: true },
    { ...plan('input.tgz'), releaseAnchor: undefined },
    { ...plan('input.tgz'), candidate: { path: '', sha256: digest } },
    { ...plan('input.tgz'), candidate: { path: 'input.tgz' } },
    {
      ...plan('input.tgz'),
      candidate: { path: 'input.tgz', sha256: digest.toUpperCase() },
    },
    {
      ...plan('input.tgz'),
      candidate: { path: 'input.tgz', sha256: digest, ignored: true },
    },
  ])
    assert.throws(() => artifactPlan(value, directory), assert.AssertionError);
});

void test('archive snapshots verify pinned bytes and preserve caller files', async (t) => {
  const root = await temporary(t);
  const source = join(root, 'input.tgz');
  const destination = join(root, 'snapshot.tgz');
  await writeFile(source, bytes);
  const spec = { role: 'baseline' as const, path: source, sha256: digest };
  assert.deepEqual(await snapshotArtifact(spec, destination), {
    sha256: digest,
    bytes: bytes.length,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  });
  assert.deepEqual(await readFile(source), bytes);
  await writeFile(source, 'changed');
  assert.deepEqual(await readFile(destination), bytes);
  await assert.rejects(
    snapshotArtifact(spec, join(root, 'mismatch.tgz')),
    /SHA-256 mismatch/,
  );
  await assert.rejects(stat(join(root, 'mismatch.tgz')), { code: 'ENOENT' });
  await writeFile(source, bytes);
  await assert.rejects(snapshotArtifact(spec, destination), { code: 'EEXIST' });
  assert.deepEqual(await readFile(destination), bytes);
});

void test('archive snapshots reject directories and oversized regular files', async (t) => {
  const root = await temporary(t);
  const destination = join(root, 'snapshot.tgz');
  const spec = { role: 'candidate' as const, path: root, sha256: digest };
  await assert.rejects(
    snapshotArtifact(spec, destination),
    /regular file|EISDIR/,
  );
  const source = join(root, 'large.tgz');
  const file = await open(source, 'wx');
  try {
    await file.truncate(65 * 1024 * 1024);
  } finally {
    await file.close();
  }
  await assert.rejects(
    snapshotArtifact({ ...spec, path: source }, destination),
    /exceeds/,
  );
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

void test('invalid plans fail before creating a result directory', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'plan.json');
  const output = join(root, 'result');
  for (const source of ['{', '{"version":2}', Buffer.from([0xff])]) {
    await writeFile(path, source);
    await assert.rejects(prepareArtifacts(path, output));
    await assert.rejects(stat(output), { code: 'ENOENT' });
  }
});

void test('an existing result directory and its evidence are never overwritten', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'plan.json');
  const output = join(root, 'result');
  await writeFile(path, JSON.stringify(plan('input.tgz')));
  await mkdir(output);
  await writeFile(join(output, 'report.json'), 'caller evidence');
  await assert.rejects(prepareArtifacts(path, output), { code: 'EEXIST' });
  assert.equal(
    await readFile(join(output, 'report.json'), 'utf8'),
    'caller evidence',
  );
  await assert.rejects(stat(join(output, 'failure.json')), { code: 'ENOENT' });
});

void test('a digest mismatch retains failure evidence and prevents every install', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'plan.json');
  const output = join(root, 'result');
  const input = plan('input.tgz');
  input.candidate.sha256 = '0'.repeat(64);
  await writeFile(join(root, 'input.tgz'), bytes);
  await writeFile(path, JSON.stringify(input));
  await assert.rejects(
    prepareArtifacts(path, output),
    /candidate: archive SHA-256 mismatch/,
  );
  const failure = record(
    json(await readFile(join(output, 'failure.json'), 'utf8')),
  );
  assert.equal(failure.status, 'invalid');
  assert.equal(failure.stage, 'snapshot:candidate');
  await assert.rejects(stat(join(output, 'npm-version.stdout.log')), {
    code: 'ENOENT',
  });
  await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
  assert.deepEqual(await readFile(join(root, 'input.tgz')), bytes);
});

void test('an invalid package retains installation logs and cannot emit a completion report', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'plan.json');
  const output = join(root, 'result');
  await writeFile(join(root, 'input.tgz'), bytes);
  await writeFile(path, JSON.stringify(plan('input.tgz')));
  await assert.rejects(prepareArtifacts(path, output));
  const failure = record(
    json(await readFile(join(output, 'failure.json'), 'utf8')),
  );
  assert.equal(failure.stage, 'install:baseline');
  assert.equal(failure.status, 'invalid');
  assert.ok(
    (await readFile(join(output, 'baseline/install.stderr.log'), 'utf8'))
      .length > 0,
  );
  await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
  for (const role of ['baseline', 'candidate', 'releaseAnchor'])
    assert.deepEqual(await readFile(join(output, role, 'compiler.tgz')), bytes);
});

void test('artifact preparation CLI requires an explicit plan and fresh output path', async () => {
  await assert.rejects(
    exec(process.execPath, [
      fileURLToPath(new URL('../bench/prepare.ts', import.meta.url)),
    ]),
    /usage: node bench\/prepare.ts/,
  );
});

void test('npm global settings cannot redirect installation outside the owned consumer', async (t) => {
  const root = await temporary(t);
  const fixture = join(root, 'package');
  await mkdir(fixture);
  await writeFile(
    join(fixture, 'package.json'),
    JSON.stringify({
      name: 'pomegranate-compiler',
      version: '0.0.0',
      type: 'module',
      exports: { '.': { import: './index.js' } },
      files: ['index.js'],
    }),
  );
  await writeFile(
    join(fixture, 'index.js'),
    'export async function compile() { throw new Error("synthetic compiler failure"); }\n',
  );
  await exec(
    'npm',
    ['pack', '--ignore-scripts', '--offline', '--pack-destination', root],
    { cwd: fixture },
  );
  const archive = join(root, 'pomegranate-compiler-0.0.0.tgz');
  const artifact = {
    path: archive,
    sha256: createHash('sha256')
      .update(await readFile(archive))
      .digest('hex'),
  };
  const planPath = join(root, 'plan.json');
  await writeFile(
    planPath,
    JSON.stringify({
      version: 1,
      baseline: artifact,
      candidate: artifact,
      releaseAnchor: artifact,
    }),
  );
  const output = join(root, 'result');
  const externalPrefix = join(root, 'external-prefix');
  await assert.rejects(
    exec(
      process.execPath,
      [
        fileURLToPath(new URL('../bench/prepare.ts', import.meta.url)),
        planPath,
        output,
      ],
      {
        env: {
          ...process.env,
          npm_config_global: 'true',
          npm_config_prefix: externalPrefix,
        },
      },
    ),
  );
  const failure = record(
    json(await readFile(join(output, 'failure.json'), 'utf8')),
  );
  assert.equal(failure.stage, 'preflight:baseline');
  assert.equal(failure.status, 'invalid');
  assert.match(
    await readFile(join(output, 'baseline/preflight.stderr.log'), 'utf8'),
    /synthetic compiler failure/,
  );
  await assert.rejects(stat(externalPrefix), { code: 'ENOENT' });
  await assert.rejects(stat(join(output, 'report.json')), { code: 'ENOENT' });
});
