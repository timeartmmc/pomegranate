import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm } from 'node:fs/promises';
import { cpus, release } from 'node:os';
import { join, sep } from 'node:path';
import {
  prepareArtifactSpecs,
  readArtifactPlan,
  verifyPreparedArtifacts,
} from './artifacts.ts';
import {
  generationCase,
  generationProfiles,
  generationSmoke,
  generationWorkload,
} from './cases/generation.ts';
import type { TypecheckProfile } from './cases/typecheck.ts';
import {
  profileSettings,
  createRunDirectory,
  publishReport,
  readJson,
  record,
  sha256,
  writeFailure,
  writeJson,
} from './controller.ts';
import {
  benchmarkSources,
  installedTree,
  captureBenchmarkHarness,
  verifyBenchmarkHarness,
} from './installed.ts';
import { seededSchedule } from './order.ts';
import { nodeEnvironment, runLogged, runLoggedProcess } from './process.ts';

export const generationSettings = (value: unknown) =>
  profileSettings(value, generationProfiles, generationSmoke);

export function generationMetrics(value: unknown, operations: number) {
  const result = record(value, 'generation evidence');
  assert.equal(
    result.schemaVersion,
    1,
    'unsupported generation evidence version',
  );
  const { generationMs, peakRssKiB } = result;
  assert.ok(
    typeof generationMs === 'number' &&
      Number.isFinite(generationMs) &&
      generationMs > 0,
    'missing or malformed generationMs',
  );
  assert.ok(
    typeof peakRssKiB === 'number' &&
      Number.isSafeInteger(peakRssKiB) &&
      peakRssKiB > 0,
    'missing or malformed peakRssKiB',
  );
  const operationsPerSecond = (operations * 1000) / generationMs;
  assert.ok(
    Number.isFinite(operationsPerSecond),
    'non-finite operations per second',
  );
  return { generationMs, peakRssKiB, operationsPerSecond };
}

async function sourceInventory(directory: string) {
  const tree = await installedTree(directory);
  for (const file of tree.files)
    assert.ok('sha256' in file, 'generated output must not contain links');
  return tree;
}

// Inputs and configs are prepared before timing; generation creates fresh output directories.
export async function generationProject(
  directory: string,
  inputPath: string,
  profile: TypecheckProfile,
) {
  await mkdir(directory);
  await writeJson(join(directory, 'profile.json'), profile);
  const input = generationWorkload(profile);
  for (const name of ['measured', 'warmup']) {
    await writeJson(join(directory, `${name}.json`), {
      version: 2,
      openapi: inputPath,
      output: `./${name}`,
      ...input.options,
    });
  }
}

export async function collectGeneration(
  worker: string,
  cli: string,
  directory: string,
  mode: 'cold' | 'warm',
  operations: number,
) {
  const environment = nodeEnvironment();
  // Fresh-process cold does not mean dropped OS filesystem caches. Disable
  // Node's persistent compilation cache consistently in both modes.
  delete environment.NODE_COMPILE_CACHE;
  environment.NODE_DISABLE_COMPILE_CACHE = '1';
  const args = [
    worker,
    cli,
    join(directory, 'measured.json'),
    join(directory, 'warmup.json'),
    mode,
    join(directory, 'worker-result.json'),
  ];
  const result = await runLoggedProcess(
    process.execPath,
    args,
    directory,
    join(directory, 'worker'),
    environment,
    120_000,
  );
  const evidence = record(
    (await readJson(join(directory, 'worker-result.json'), 64 * 1024)).value,
  );
  assert.equal(evidence.mode, mode, 'worker mode changed');
  assert.equal(evidence.node, process.version, 'worker Node version changed');
  assert.equal(evidence.cli, cli, 'worker compiler entry changed');
  return {
    processWallMs: result.wallMs,
    ...generationMetrics(evidence, operations),
    command: [process.execPath, ...args],
  };
}

export async function runGeneration(
  planPath: string,
  output: string,
  settingsValue: unknown = {},
) {
  const settings = generationSettings(settingsValue);
  const specs = await readArtifactPlan(planPath);
  const controller = await benchmarkSources();
  const root = await createRunDirectory(output);
  let stage = 'preparation';
  try {
    await writeJson(join(root, 'settings.json'), {
      ...settings,
      profiles: settings.profiles.map((profile) => profile.id),
    });
    const preparation = await prepareArtifactSpecs(
      specs,
      join(root, 'prepared'),
    );
    stage = 'capture-harness';
    const harness = await captureBenchmarkHarness(root);
    const worker = join(harness, 'bench/generation-worker.ts');
    const qualifier = join(harness, 'bench/generation-qualify.ts');
    const projects = [];
    for (const artifact of preparation.artifacts) {
      const consumer = join(root, 'prepared', artifact.role);
      stage = `resolve-cli:${artifact.role}`;
      const installed = join(consumer, 'node_modules/pomegranate-compiler');
      const metadata = record(
        (await readJson(join(installed, 'package.json'), 64 * 1024)).value,
      );
      const bin = record(metadata.bin).pom;
      assert.ok(
        typeof bin === 'string',
        'installed compiler must declare bin.pom',
      );
      const cli = await realpath(join(installed, bin));
      assert.ok(
        cli.startsWith(`${installed}${sep}`),
        'compiler CLI must remain inside its installed package',
      );
      for (const profile of settings.profiles) {
        stage = `qualify:${artifact.role}:${profile.id}`;
        const directory = join(consumer, profile.id);
        await mkdir(directory);
        const inputPath = join(directory, 'openapi.json');
        await writeJson(inputPath, generationWorkload(profile).document);
        const inputSha256 = sha256(await readFile(inputPath));
        const qualification = join(directory, 'qualification');
        await generationProject(qualification, inputPath, profile);
        await collectGeneration(
          worker,
          cli,
          qualification,
          'cold',
          profile.operations,
        );
        await runLogged(
          process.execPath,
          [cli, 'check', '--config', join(qualification, 'measured.json')],
          qualification,
          join(qualification, 'check'),
          nodeEnvironment(),
          120_000,
        );
        await runLogged(
          process.execPath,
          [
            qualifier,
            join(qualification, 'measured'),
            join(qualification, 'profile.json'),
          ],
          qualification,
          join(qualification, 'inventory'),
          nodeEnvironment(),
          120_000,
        );
        const source = await sourceInventory(join(qualification, 'measured'));
        projects.push({
          role: artifact.role,
          profile,
          cli,
          directory,
          inputPath,
          inputSha256,
          source,
        });
      }
    }
    stage = 'schedule';
    await writeJson(join(root, 'qualified.json'), projects);
    const cells = projects.flatMap((project) =>
      (['cold', 'warm'] as const).map((mode) => ({ project, mode })),
    );
    const schedule = seededSchedule(cells, settings.rounds, settings.seed);
    await writeJson(
      join(root, 'schedule.json'),
      schedule.map(({ round, cell: { project, mode } }) => ({
        round,
        role: project.role,
        profile: project.profile.id,
        mode,
      })),
    );
    await mkdir(join(root, 'samples'));
    const observations = [];
    for (const [
      index,
      {
        round,
        cell: { project, mode },
      },
    ] of schedule.entries()) {
      stage = `measure:${index}:${project.role}:${project.profile.id}:${mode}`;
      const directory = join(root, 'samples', String(index).padStart(5, '0'));
      await generationProject(directory, project.inputPath, project.profile);
      const metrics = await collectGeneration(
        worker,
        project.cli,
        directory,
        mode,
        project.profile.operations,
      );
      stage = `verify-output:${index}`;
      assert.deepEqual(
        await sourceInventory(join(directory, 'measured')),
        project.source,
        'measured generation differs from qualified source',
      );
      if (mode === 'warm')
        assert.deepEqual(
          await sourceInventory(join(directory, 'warmup')),
          project.source,
          'warmup generation differs from qualified source',
        );
      const observation = {
        index,
        round,
        role: project.role,
        profile: project.profile.id,
        operations: project.profile.operations,
        mode,
        ...metrics,
      };
      await writeJson(join(directory, 'sample.json'), observation);
      observations.push(observation);
      // Retain the qualified copy and receipts. A failed comparison above keeps
      // both outputs for diagnosis; only verified sample copies are redundant.
      await rm(join(directory, 'measured'), { recursive: true });
      if (mode === 'warm')
        await rm(join(directory, 'warmup'), { recursive: true });
    }
    stage = 'identity-check';
    for (const project of projects) {
      assert.equal(
        sha256(await readFile(project.inputPath)),
        project.inputSha256,
        'generation input changed',
      );
      assert.deepEqual(
        await sourceInventory(
          join(project.directory, 'qualification/measured'),
        ),
        project.source,
        'qualified source changed',
      );
    }
    await verifyPreparedArtifacts(
      join(root, 'prepared'),
      preparation.artifacts,
    );
    await verifyBenchmarkHarness(harness, controller);
    const report = {
      schemaVersion: 1,
      status: 'complete',
      case: generationCase,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      host: {
        osRelease: release(),
        cpus: cpus().map(({ model, speed }) => ({ model, speed })),
      },
      preparation,
      preparationSha256: sha256(
        await readFile(join(root, 'prepared/report.json')),
      ),
      controller,
      seed: settings.seed,
      rounds: settings.rounds,
      profiles: settings.profiles,
      projects,
      observations,
      measurement: {
        cold: 'fresh Node process; measured CLI invocation includes compiler loading, input reads, parsing, normalization, emission, formatting and output writes',
        warm: 'one untimed full generation in the same process before the measured CLI invocation; separate fresh output directories',
        generationMs:
          'elapsed measured CLI invocation; excludes Node startup and worker setup; includes compiler loading in cold mode',
        processWallMs:
          'whole fresh worker elapsed time, including Node startup, worker setup, any warmup and evidence write',
        operationsPerSecond:
          'input operation count * 1000 / generationMs; batch code-generation rate, not API request throughput',
        peakRssKiB:
          'process.resourceUsage().maxRSS in KiB: worker lifetime peak RSS, including compiler loading and warmup; not heap usage, not a warm-only delta',
        cache:
          'Node persistent compile cache disabled; OS filesystem caches are not flushed',
        order:
          'serial fresh workers in seeded randomized artifact/profile/mode order each round',
      },
    };
    await publishReport(root, report);
    return report;
  } catch (error) {
    await writeFailure(root, stage, error);
    throw new Error(
      `Generation benchmark failed at ${stage}: ${error instanceof Error ? error.message : String(error)}; evidence retained at ${root}`,
      { cause: error },
    );
  }
}
