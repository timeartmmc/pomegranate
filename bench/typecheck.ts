import assert from 'node:assert/strict';
import { cp, mkdir, readFile, realpath } from 'node:fs/promises';
import { cpus, release } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareArtifactSpecs, readArtifactPlan } from './artifacts.ts';
import {
  benchmarkSeed,
  createRunDirectory,
  publishReport,
  readPlan,
  record,
  sha256,
  writeFailure,
  writeJson,
} from './controller.ts';
import { benchmarkSources, installedTree } from './installed.ts';
import { random, shuffled } from './order.ts';
import { nodeEnvironment, runLogged, runLoggedProcess } from './process.ts';
import {
  typecheckCase,
  typecheckProfiles,
  typecheckSmoke,
} from './cases/typecheck.ts';
import type { TypecheckProfile } from './cases/typecheck.ts';

// Also used by installed-package verification: one owner for the documented minimum.
export const minimumTypeScript = '5.7.3';

export function typecheckSettings(value: unknown) {
  const input = record(value, 'typecheck settings');
  for (const key of Object.keys(input))
    assert.ok(
      ['seed', 'rounds', 'profiles'].includes(key),
      `settings: unknown field ${key}; expected seed, rounds or profiles`,
    );
  const seed = benchmarkSeed(input.seed ?? 20261109);
  const rounds = input.rounds ?? 3;
  assert.ok(
    typeof rounds === 'number' &&
      Number.isSafeInteger(rounds) &&
      rounds >= 1 &&
      rounds <= 30,
    'rounds: expected 1..30',
  );
  const ids = input.profiles ?? typecheckProfiles.map((profile) => profile.id);
  assert.ok(
    Array.isArray(ids) && ids.length > 0 && new Set(ids).size === ids.length,
    'profiles: expected unique case IDs',
  );
  const profiles = ids.map((id: unknown) => {
    const profile = [...typecheckProfiles, typecheckSmoke].find(
      (profile) => profile.id === id,
    );
    assert.ok(profile, `unknown typecheck profile: ${String(id)}`);
    return profile;
  });
  return { seed, rounds, profiles };
}

// Require the supported extendedDiagnostics vocabulary. Missing data is a failed
// measurement, not a zero-cost sample. Memory is TS's own counter, never peak RSS.
export function typecheckDiagnostics(stdout: string) {
  function metric(label: string, unit: string) {
    const matches = stdout
      .split(/\r?\n/)
      .filter((line) => line.startsWith(`${label}:`));
    assert.equal(
      matches.length,
      1,
      `unsupported TypeScript diagnostic format: missing or duplicate ${label}`,
    );
    const match = matches[0]!.match(
      new RegExp(`^${label}:\\s*([0-9]+(?:\\.[0-9]+)?)${unit}\\s*$`),
    );
    assert.ok(
      match?.[1],
      `unsupported TypeScript diagnostic format: malformed ${label}: ${matches[0]}`,
    );
    const value = Number(match[1]);
    assert.ok(Number.isFinite(value), `non-finite ${label}`);
    return value;
  }
  const checkMs = metric('Check time', 's') * 1000;
  const instantiations = metric('Instantiations', '');
  assert.ok(
    Number.isSafeInteger(instantiations),
    'malformed Instantiations: expected integer',
  );
  const compilerMemoryK = metric('Memory used', 'K');
  return { checkMs, instantiations, compilerMemoryK };
}

// Fixed LCG and Fisher-Yates make the full serial schedule replayable from seed.
export function typecheckSchedule<T>(
  cells: readonly T[],
  rounds: number,
  seed: number,
) {
  const next = random(seed);
  const schedule: { round: number; cell: T }[] = [];
  for (let round = 0; round < rounds; round++) {
    schedule.push(...shuffled(cells, next).map((cell) => ({ round, cell })));
  }
  return schedule;
}

export async function collectTypecheck(
  directory: string,
  typescript: string,
  log: string,
  measured: boolean,
) {
  const args = [
    typescript,
    '-p',
    join(directory, 'tsconfig.json'),
    '--pretty',
    'false',
    '--locale',
    'en',
    ...(measured ? ['--extendedDiagnostics'] : []),
  ];
  const result = await runLoggedProcess(
    process.execPath,
    args,
    directory,
    log,
    nodeEnvironment(),
    120_000,
  );
  return measured
    ? { wallMs: result.wallMs, ...typecheckDiagnostics(result.stdout) }
    : null;
}

export async function runTypecheck(
  planPath: string,
  output: string,
  settingsValue: unknown = {},
) {
  const settings = typecheckSettings(settingsValue);
  // Parse before claiming an output directory, as in the artifact controllers.
  const specs = await readArtifactPlan(planPath);
  const manifest = record(
    (await readPlan(fileURLToPath(new URL('../package.json', import.meta.url))))
      .value,
  );
  const development = record(manifest.devDependencies).typescript;
  assert.ok(
    typeof development === 'string' && /^\d+\.\d+\.\d+$/.test(development),
    'expected an exact development TypeScript version in package.json',
  );
  const controller = await benchmarkSources();
  const root = await createRunDirectory(output);
  let stage = 'preparation';
  try {
    await writeJson(join(root, 'settings.json'), {
      seed: settings.seed,
      rounds: settings.rounds,
      profiles: settings.profiles.map((profile) => profile.id),
    });
    const preparation = await prepareArtifactSpecs(
      specs,
      join(root, 'prepared'),
    );
    const toolchains = [];
    for (const [id, version] of [
      ['minimum', minimumTypeScript],
      ['development', development],
    ] as const) {
      stage = `toolchain:${id}`;
      const directory = join(root, id);
      await mkdir(directory);
      await writeJson(join(directory, 'package.json'), {
        private: true,
        type: 'module',
        dependencies: { typescript: version },
      });
      await runLogged(
        'npm',
        [
          'install',
          '--global=false',
          `--prefix=${directory}`,
          '--legacy-peer-deps=false',
          '--ignore-scripts',
          '--engine-strict',
          '--strict-peer-deps',
          '--no-audit',
          '--no-fund',
          '--package-lock=true',
          '--lockfile-version=3',
        ],
        directory,
        join(directory, 'install'),
        nodeEnvironment(),
        120_000,
      );
      const entry = await realpath(
        join(directory, 'node_modules/typescript/bin/tsc'),
      );
      const actual = (
        await runLogged(
          process.execPath,
          [entry, '--version'],
          directory,
          join(directory, 'version'),
          nodeEnvironment(),
          30_000,
        )
      ).trim();
      assert.equal(
        actual,
        `Version ${version}`,
        `${id}: TypeScript version mismatch`,
      );
      toolchains.push({
        id,
        version,
        entry,
        directory,
        installed: await installedTree(join(directory, 'node_modules')),
        lockSha256: sha256(
          await readFile(join(directory, 'package-lock.json')),
        ),
      });
    }
    // Copy the harness before generation; installed compilers cannot resolve a
    // sibling checkout or borrow its dependencies to compile the synthetic input.
    const harness = join(root, 'harness');
    await mkdir(harness);
    await cp(
      fileURLToPath(new URL('.', import.meta.url)),
      join(harness, 'bench'),
      { recursive: true },
    );
    await writeJson(join(harness, 'package.json'), {
      private: true,
      type: 'module',
    });
    const cells = [];
    const projects: {
      directory: string;
      source: Awaited<ReturnType<typeof installedTree>>;
      profile: TypecheckProfile;
      role: string;
    }[] = [];
    for (const artifact of preparation.artifacts) {
      const consumer = join(root, 'prepared', artifact.role);
      for (const profile of settings.profiles) {
        stage = `generate:${artifact.role}:${profile.id}`;
        const directory = join(consumer, profile.id);
        const profilePath = join(consumer, `${profile.id}.json`);
        await writeJson(profilePath, profile);
        await runLogged(
          process.execPath,
          [
            join(harness, 'bench/typecheck-generate.ts'),
            join(consumer, 'node_modules/pomegranate-compiler', artifact.entry),
            directory,
            profilePath,
          ],
          consumer,
          join(consumer, `${profile.id}-generate`),
          nodeEnvironment(),
          120_000,
        );
        const project = {
          directory,
          profile,
          role: artifact.role,
          source: await installedTree(directory),
        };
        projects.push(project);
        for (const toolchain of toolchains) {
          stage = `qualify:${artifact.role}:${profile.id}:${toolchain.id}`;
          const log = join(consumer, `${profile.id}-${toolchain.id}-qualify`);
          await collectTypecheck(directory, toolchain.entry, log, false);
          const config = await runLogged(
            process.execPath,
            [
              toolchain.entry,
              '-p',
              join(directory, 'tsconfig.json'),
              '--showConfig',
            ],
            directory,
            `${log}-config`,
            nodeEnvironment(),
            30_000,
          );
          cells.push({
            role: artifact.role,
            profile: profile.id,
            toolchain: toolchain.id,
            directory,
            entry: toolchain.entry,
            effectiveConfig: JSON.parse(config) as unknown,
          });
        }
      }
    }
    await writeJson(join(root, 'qualified.json'), { projects, cells });
    const schedule = typecheckSchedule(cells, settings.rounds, settings.seed);
    await writeJson(join(root, 'schedule.json'), schedule);
    await mkdir(join(root, 'samples'));
    const observations = [];
    for (const [index, { round, cell }] of schedule.entries()) {
      stage = `measure:${index}:${cell.role}:${cell.profile}:${cell.toolchain}`;
      const log = join(root, 'samples', String(index).padStart(5, '0'));
      const metrics = await collectTypecheck(
        cell.directory,
        cell.entry,
        log,
        true,
      );
      const observation = {
        index,
        round,
        role: cell.role,
        profile: cell.profile,
        toolchain: cell.toolchain,
        log,
        ...metrics,
      };
      await writeJson(`${log}.json`, observation);
      observations.push(observation);
    }
    stage = 'identity-check';
    for (const project of projects)
      assert.deepEqual(
        await installedTree(project.directory),
        project.source,
        'typecheck changed project sources',
      );
    for (const toolchain of toolchains) {
      assert.deepEqual(
        await installedTree(join(toolchain.directory, 'node_modules')),
        toolchain.installed,
        'TypeScript installation changed',
      );
      assert.equal(
        sha256(await readFile(join(toolchain.directory, 'package-lock.json'))),
        toolchain.lockSha256,
        'TypeScript lock changed',
      );
    }
    for (const artifact of preparation.artifacts) {
      const consumer = join(root, 'prepared', artifact.role);
      assert.equal(
        sha256(await readFile(join(consumer, 'package-lock.json'))),
        artifact.lockSha256,
        'compiler lock changed',
      );
      assert.equal(
        sha256(await readFile(join(consumer, 'compiler.tgz'))),
        artifact.archive.sha256,
        'compiler archive changed',
      );
      assert.equal(
        (await installedTree(join(consumer, 'node_modules'))).sha256,
        artifact.installedTreeSha256,
        'compiler installation changed',
      );
    }
    assert.deepEqual(
      await benchmarkSources(),
      controller,
      'benchmark sources changed',
    );
    assert.deepEqual(
      await benchmarkSources(join(harness, 'bench')),
      controller,
      'copied harness changed',
    );
    const report = {
      schemaVersion: 1,
      status: 'complete',
      case: typecheckCase,
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
      toolchains,
      projects,
      profiles: settings.profiles,
      seed: settings.seed,
      rounds: settings.rounds,
      cells,
      observations,
      measurement: {
        wallMs:
          'fresh whole-process elapsed time, including TypeScript startup and project loading; excludes log writes',
        checkMs: 'TypeScript extendedDiagnostics Check time',
        compilerMemoryK:
          'TypeScript Memory used in unconverted reported K units; not peak process RSS',
        peakProcessMemory: 'unmeasured',
        order:
          'serial, seeded shuffle of artifact/profile/toolchain cells each round',
      },
    };
    await publishReport(root, report);
    return report;
  } catch (error) {
    await writeFailure(root, stage, error);
    throw new Error(
      `Typecheck benchmark failed at ${stage}: ${error instanceof Error ? error.message : String(error)}; evidence retained at ${root}`,
      { cause: error },
    );
  }
}
