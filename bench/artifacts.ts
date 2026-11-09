import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jsonResponseCase } from './cases/json-response.ts';
import {
  benchmarkSources,
  installedIdentity,
  installedTree,
} from './installed.ts';
import {
  boundedFile,
  createRunDirectory,
  publishReport,
  readPlan,
  record,
  sha256,
  writeFailure,
} from './controller.ts';
import { nodeEnvironment, runLogged } from './process.ts';

const roles = ['baseline', 'candidate', 'releaseAnchor'] as const;
const harnessNames = ['cases/json-response.ts', 'preflight.ts'] as const;
const maximumArchiveBytes = 64 * 1024 * 1024;
const digestPattern = /^[a-f0-9]{64}$/;

export interface ArtifactSpec {
  readonly role: (typeof roles)[number];
  readonly path: string;
  readonly sha256: string;
}

interface ArchiveIdentity {
  readonly sha256: string;
  readonly bytes: number;
  readonly integrity: string;
}

function json(source: string): unknown {
  return JSON.parse(source) as unknown;
}

function generatedInventory(value: unknown) {
  assert.ok(
    Array.isArray(value) && value.length > 0,
    'preflight must report generated files',
  );
  const files = value.map((entry: unknown) => {
    const file = record(entry, 'generated file');
    assert.ok(
      typeof file.name === 'string' && /^[a-zA-Z0-9_.-]+\.ts$/.test(file.name),
    );
    assert.ok(
      typeof file.bytes === 'number' &&
        Number.isSafeInteger(file.bytes) &&
        file.bytes > 0,
    );
    assert.ok(
      typeof file.sha256 === 'string' && digestPattern.test(file.sha256),
    );
    return { name: file.name, bytes: file.bytes, sha256: file.sha256 };
  });
  files.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  assert.equal(
    new Set(files.map(({ name }) => name)).size,
    files.length,
    'generated files must have unique names',
  );
  return { sha256: sha256(JSON.stringify(files)), files };
}

export function artifactPlan(
  value: unknown,
  baseDirectory: string,
): ArtifactSpec[] {
  const plan = record(value, 'plan');
  assert.deepEqual(
    Object.keys(plan).sort(),
    [...roles, 'version'].sort(),
    'plan: expected version, baseline, candidate and releaseAnchor only',
  );
  assert.equal(plan.version, 1, 'plan.version: expected 1');
  return roles.map((role) => {
    const input = record(plan[role], role);
    assert.deepEqual(
      Object.keys(input).sort(),
      ['path', 'sha256'],
      `${role}: expected path and sha256 only`,
    );
    assert.ok(
      typeof input.path === 'string' && input.path.length > 0,
      `${role}.path: expected a local archive path`,
    );
    assert.ok(
      typeof input.sha256 === 'string' && digestPattern.test(input.sha256),
      `${role}.sha256: expected 64 lowercase hexadecimal digits`,
    );
    return {
      role,
      path: resolve(baseDirectory, input.path),
      sha256: input.sha256,
    };
  });
}

export async function snapshotArtifact(
  spec: ArtifactSpec,
  destination: string,
): Promise<ArchiveIdentity> {
  const bytes = await boundedFile(spec.path, maximumArchiveBytes);
  const digest = sha256(bytes);
  assert.equal(digest, spec.sha256, `${spec.role}: archive SHA-256 mismatch`);
  await writeFile(destination, bytes, { flag: 'wx', mode: 0o444 });
  return {
    sha256: digest,
    bytes: bytes.length,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
}

export async function prepareArtifacts(
  planPath: string,
  outputDirectory: string,
) {
  const { path: manifest, value } = await readPlan(planPath);
  const specs = artifactPlan(value, dirname(manifest));
  // Capture the trusted harness once, before installing or executing any artifact.
  // Every consumer receives these same bytes even if the checkout changes later.
  const harness = await Promise.all(
    harnessNames.map(async (name) => ({
      name,
      source: await readFile(new URL(name, import.meta.url)),
    })),
  );
  const harnessFiles = harness.map(({ name, source }) => ({
    name,
    sha256: sha256(source),
  }));
  const controllerFiles = await benchmarkSources();
  const caseHash = harnessFiles.find(
    ({ name }) => name === 'cases/json-response.ts',
  );
  assert.ok(caseHash);
  // A fresh directory is the ownership boundary. Preserve all evidence on failure;
  // never clean or overwrite an existing run or caller-owned inputs.
  const root = await createRunDirectory(outputDirectory);
  let stage = 'snapshot';
  try {
    await writeFile(
      join(root, 'plan.json'),
      `${JSON.stringify(
        {
          version: 1,
          ...Object.fromEntries(
            specs.map((spec) => [
              spec.role,
              {
                path: `./${spec.role}/compiler.tgz`,
                sha256: spec.sha256,
              },
            ]),
          ),
        },
        null,
        2,
      )}\n`,
      { flag: 'wx' },
    );
    const archives = new Map<ArtifactSpec['role'], ArchiveIdentity>();
    for (const spec of specs) {
      const consumer = join(root, spec.role);
      await mkdir(consumer);
      stage = `snapshot:${spec.role}`;
      archives.set(
        spec.role,
        await snapshotArtifact(spec, join(consumer, 'compiler.tgz')),
      );
    }
    const environment = nodeEnvironment();
    stage = 'npm-version';
    const npm = (
      await runLogged(
        'npm',
        ['--version'],
        root,
        join(root, 'npm-version'),
        environment,
        30_000,
      )
    ).trim();
    const prepared = [];
    for (const spec of specs) {
      const consumer = join(root, spec.role);
      await writeFile(
        join(consumer, 'package.json'),
        `${JSON.stringify(
          {
            name: 'pom-benchmark-consumer',
            version: '1.0.0',
            private: true,
            type: 'module',
            dependencies: { 'pomegranate-compiler': 'file:./compiler.tgz' },
          },
          null,
          2,
        )}\n`,
        { flag: 'wx' },
      );
      stage = `install:${spec.role}`;
      await runLogged(
        'npm',
        [
          'install',
          '--global=false',
          `--prefix=${consumer}`,
          '--ignore-scripts',
          '--engine-strict',
          '--strict-peer-deps',
          '--legacy-peer-deps=false',
          '--no-audit',
          '--no-fund',
          '--package-lock=true',
          '--lockfile-version=3',
        ],
        consumer,
        join(consumer, 'install'),
        environment,
        120_000,
      );
      const archive = archives.get(spec.role);
      assert.ok(archive);
      const installed = join(consumer, 'node_modules/pomegranate-compiler');
      const identity = await installedIdentity(consumer, archive.integrity);
      await writeFile(
        join(consumer, 'installed-files.json'),
        `${JSON.stringify(identity.files, null, 2)}\n`,
        { flag: 'wx' },
      );
      await mkdir(join(consumer, 'bench/cases'), { recursive: true });
      for (const { name, source } of harness)
        await writeFile(join(consumer, 'bench', name), source, { flag: 'wx' });
      stage = `preflight:${spec.role}`;
      const stdout = await runLogged(
        process.execPath,
        ['bench/preflight.ts', 'generated'],
        consumer,
        join(consumer, 'preflight'),
        environment,
        30_000,
      );
      const preflight = record(json(stdout), `${spec.role} preflight`);
      assert.equal(preflight.schemaVersion, 1);
      assert.deepEqual(preflight.case, jsonResponseCase);
      assert.equal(preflight.caseSha256, caseHash.sha256);
      assert.equal(preflight.behavior, 'verified');
      assert.equal(preflight.performance, 'unmeasured');
      assert.equal(preflight.node, process.version);
      assert.equal(preflight.platform, process.platform);
      assert.equal(preflight.arch, process.arch);
      assert.ok(typeof preflight.compilerEntry === 'string');
      const entry = await realpath(fileURLToPath(preflight.compilerEntry));
      const entryRelative = relative(installed, entry);
      assert.ok(
        entryRelative.length > 0 &&
          !isAbsolute(entryRelative) &&
          entryRelative !== '..' &&
          !entryRelative.startsWith(`..${sep}`),
        `${spec.role}: preflight must resolve the installed compiler`,
      );
      assert.equal(
        (await installedIdentity(consumer, archive.integrity)).treeSha256,
        identity.treeSha256,
        'preflight must preserve installed runtime code',
      );
      assert.equal(
        sha256(await readFile(join(consumer, 'package-lock.json'))),
        identity.lockSha256,
        'preflight must preserve its dependency lock',
      );
      for (const file of harnessFiles)
        assert.equal(
          sha256(await readFile(join(consumer, 'bench', file.name))),
          file.sha256,
          'preflight must preserve its harness',
        );
      assert.equal(
        sha256(
          await boundedFile(
            join(consumer, 'compiler.tgz'),
            maximumArchiveBytes,
          ),
        ),
        archive.sha256,
        'preparation must preserve its archive',
      );
      prepared.push({
        role: spec.role,
        archive,
        packageVersion: identity.packageVersion,
        entry: entryRelative,
        lockSha256: identity.lockSha256,
        installedTreeSha256: identity.treeSha256,
        generated: {
          directory: 'generated',
          ...generatedInventory(preflight.generated),
          treeSha256: (await installedTree(join(consumer, 'generated'))).sha256,
        },
        preflightSha256: sha256(stdout),
      });
    }
    stage = 'report';
    assert.deepEqual(
      await benchmarkSources(),
      controllerFiles,
      'benchmark sources changed during preparation',
    );
    const report = {
      schemaVersion: 1,
      behavior: 'verified',
      performance: 'unmeasured',
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      npm,
      controller: {
        sha256: sha256(JSON.stringify(controllerFiles)),
        files: controllerFiles,
      },
      harness: {
        sha256: sha256(JSON.stringify(harnessFiles)),
        files: harnessFiles,
      },
      artifacts: prepared,
    };
    await publishReport(root, report);
    return report;
  } catch (error) {
    await writeFailure(root, stage, error);
    throw error;
  }
}
