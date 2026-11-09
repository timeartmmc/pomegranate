import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareArtifactSpecs, readArtifactPlan } from './artifacts.ts';
import {
  createRunDirectory,
  publishReport,
  writeFailure,
  writeJson,
  benchmarkDirectory,
} from './controller.ts';
import { jsonResponseCase } from './cases/json-response.ts';
import { fingerprintSources, runTiming, timingSettings } from './timing.ts';

export async function compareArtifacts(
  plan: string,
  output: string,
  settings: unknown = {},
) {
  const sampling = timingSettings(settings);
  const specs = await readArtifactPlan(plan);
  const controllerPaths = [benchmarkDirectory];
  const controller = await fingerprintSources(controllerPaths);
  // All stages own subdirectories of one fresh run. A failure keeps evidence
  // but cannot publish a final comparison report or overwrite an earlier run.
  const root = await createRunDirectory(output);
  let stage = 'preparation';
  try {
    await writeJson(join(root, 'settings.json'), sampling);
    const preparedRoot = join(root, 'prepared');
    const preparation = await prepareArtifactSpecs(specs, preparedRoot);
    stage = 'binding';
    const expected = preparation.artifacts
      .flatMap((artifact) => {
        const consumer = join(preparedRoot, artifact.role);
        return [
          {
            path: join(consumer, 'compiler.tgz'),
            sha256: artifact.archive.sha256,
          },
          {
            path: join(consumer, 'package-lock.json'),
            sha256: artifact.lockSha256,
          },
          {
            path: join(consumer, 'node_modules'),
            sha256: artifact.installedTreeSha256,
          },
          {
            path: join(consumer, artifact.generated.directory),
            sha256: artifact.generated.treeSha256,
          },
        ];
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    assert.deepEqual(
      await fingerprintSources(expected.map(({ path }) => path)),
      expected,
      'prepared artifacts changed before timing',
    );
    const preparationFile = join(preparedRoot, 'report.json');
    assert.deepEqual(
      JSON.parse(await readFile(preparationFile, 'utf8')) as unknown,
      preparation,
    );
    const preparedSources = await fingerprintSources([preparedRoot]);
    await mkdir(join(root, 'adapters'));
    const factory = new URL('./pom.ts', import.meta.url);
    const adapters = [];
    for (const artifact of preparation.artifacts) {
      const generated = join(
        preparedRoot,
        artifact.role,
        artifact.generated.directory,
      );
      const module = join(root, 'adapters', `${artifact.role}.mjs`);
      const identity = {
        name: 'POM',
        role: artifact.role,
        version: artifact.packageVersion,
        archiveSha256: artifact.archive.sha256,
        lockSha256: artifact.lockSha256,
        installedTreeSha256: artifact.installedTreeSha256,
        generatedSha256: artifact.generated.sha256,
        generatedTreeSha256: artifact.generated.treeSha256,
      };
      await writeFile(
        module,
        `import { createPomAdapter } from ${JSON.stringify(factory.href)};\n` +
          `export const create = () => createPomAdapter(new URL(${JSON.stringify(pathToFileURL(join(generated, 'client.consumer.schemas.ts')).href)}), ${JSON.stringify(identity)});\n`,
        { flag: 'wx' },
      );
      adapters.push({
        id: artifact.role,
        module,
        sources: [fileURLToPath(factory), generated, preparationFile],
      });
    }
    const timingPlan = join(root, 'timing-plan.json');
    await writeJson(timingPlan, { version: 1, ...sampling, adapters });
    assert.deepEqual(
      await fingerprintSources(controllerPaths),
      controller,
      'benchmark controller changed during preparation',
    );
    stage = 'timing';
    const timing = await runTiming(timingPlan, join(root, 'timing'));
    stage = 'report';
    assert.deepEqual(
      await fingerprintSources([preparedRoot]),
      preparedSources,
      'prepared artifacts changed during timing',
    );
    assert.deepEqual(
      await fingerprintSources(controllerPaths),
      controller,
      'benchmark controller changed during comparison',
    );
    const receipts = (
      await fingerprintSources([
        preparationFile,
        join(root, 'timing', 'report.json'),
      ])
    ).map(({ path, sha256 }) => ({ path: relative(root, path), sha256 }));
    const report = {
      schemaVersion: 1,
      status: timing.status,
      qualification: timing.qualification,
      case: jsonResponseCase,
      controller,
      receipts,
      preparation,
      timing,
    };
    await publishReport(root, report);
    return report;
  } catch (error) {
    await writeFailure(root, stage, error);
    throw error;
  }
}
