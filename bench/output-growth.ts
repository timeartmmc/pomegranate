import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { record, sha256, writeFailure, writeJson } from './controller.ts';
import { nodeEnvironment, runLogged } from './process.ts';
import {
  outputGrowthCase,
  outputGrowthProfiles,
  outputGrowthWorkload,
  outputGrowthConsumer,
  verifyOutputGrowth,
} from './cases/output-growth.ts';
import type { OutputGrowthProfile } from './cases/output-growth.ts';

type Compiler = (
  document: unknown,
  options: { clients: string[] },
) => Promise<unknown>;

export class OutputGrowthError extends Error {
  readonly evidenceDirectory: string;

  constructor(directory: string, cause: unknown) {
    super(
      `${cause instanceof Error ? cause.message : String(cause)}\nOutput-growth evidence retained at ${directory}`,
      { cause },
    );
    this.name = 'OutputGrowthError';
    this.evidenceDirectory = directory;
  }
}

// Fixed reference measurements from compiler da32f73, case version 1. These
// source-byte review allowances are independent of timing/CPU/memory budgets.
// Keep the reference explicit: updating it requires inspecting the output diff,
// preserving the behavior oracle, and reviewing the intended size increase.
// Change the policy version when changing these limits; never rebaseline blindly.
const commonBytes = {
  'client.consumer.ts': 424,
  'endpoint-runtime.ts': 4640,
  'policy-types.ts': 1353,
  'runtime.ts': 83717,
};
export const outputGrowthReferenceBytes = {
  small: {
    ...commonBytes,
    'client.consumer.operations.ts': 1451,
    'client.consumer.schemas.ts': 6082,
    'schema-types.*.ts': 429,
  },
  operations: {
    ...commonBytes,
    'client.consumer.operations.ts': 25957,
    'client.consumer.schemas.ts': 6082,
    'schema-types.*.ts': 429,
  },
  schemas: {
    ...commonBytes,
    'client.consumer.operations.ts': 1451,
    'client.consumer.schemas.ts': 20786,
    'schema-types.*.ts': 1703,
  },
  combined: {
    ...commonBytes,
    'client.consumer.operations.ts': 25957,
    'client.consumer.schemas.ts': 20786,
    'schema-types.*.ts': 1703,
  },
};
export const outputGrowthPolicy = Object.freeze({
  id: 'shared-contract-output-budgets',
  version: 2,
  referenceCompiler: 'da32f73',
  bytes:
    'complete generated TypeScript UTF-8 source, including runtime helpers and comments',
  // A few import/export statements in a tiny module should not look like a
  // performance failure. Larger files retain a proportional review allowance.
  relativeHeadroomPercent: 5,
  minimumHeadroomBytes: 512,
  perFileAllowance:
    'reference + max(minimumHeadroomBytes, ceil(reference * relativeHeadroomPercent / 100))',
  maximumInteractionBytes: 1024,
  scope:
    'deterministic source-output guardrails; no latency, allocation, bundled-size or product-wide acceptance verdict',
});

export function inspectOutput(value: unknown) {
  const sources = Object.fromEntries(
    Object.entries(record(value, 'compiler output')).map(([name, source]) => {
      assert.match(
        name,
        /^[a-zA-Z0-9_.-]+\.ts$/,
        'generated output must use flat TypeScript filenames',
      );
      assert.ok(
        typeof source === 'string' && source.length > 0,
        `${name}: expected nonempty source`,
      );
      return [name, source];
    }),
  );
  assert.ok(
    Object.keys(sources).length > 0,
    'compiler output must contain files',
  );
  const files = Object.keys(sources)
    .sort()
    .map((name) => ({
      name,
      // Preserve the real digest-qualified filename in evidence. Group the one
      // shared type module without pinning its ownership digest in the budget.
      key: /^schema-types\.[a-f0-9]{64}\.ts$/.test(name)
        ? 'schema-types.*.ts'
        : name,
      bytes: Buffer.byteLength(sources[name]!),
      sha256: sha256(sources[name]!),
    }));
  assert.equal(
    new Set(files.map(({ key }) => key)).size,
    files.length,
    'ambiguous output budget keys',
  );
  return {
    sources,
    metrics: {
      files,
      totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    },
  };
}

type Cell = {
  profile: OutputGrowthProfile;
  metrics: ReturnType<typeof inspectOutput>['metrics'];
};

export function verifyOutputBudgets(cells: readonly Cell[]) {
  assert.deepEqual(
    cells.map(({ profile }) => profile),
    outputGrowthProfiles,
    'all output-growth profiles must be present in their declared order',
  );
  for (const { profile, metrics } of cells) {
    const reference = outputGrowthReferenceBytes[profile.id];
    assert.deepEqual(
      metrics.files.map(({ key }) => key).sort(),
      Object.keys(reference).sort(),
      `${profile.id}: generated output inventory changed`,
    );
    for (const file of metrics.files) {
      const referenceBytes = reference[file.key as keyof typeof reference];
      const maximum =
        referenceBytes +
        Math.max(
          outputGrowthPolicy.minimumHeadroomBytes,
          Math.ceil(
            (referenceBytes * outputGrowthPolicy.relativeHeadroomPercent) / 100,
          ),
        );
      assert.ok(
        file.bytes <= maximum,
        `${profile.id}: ${file.name} exceeds generated-source byte budget: ${file.bytes} > ${maximum} (reference ${referenceBytes})`,
      );
    }
  }
  const [small, operations, schemas, combined] = cells;
  // Subtract fixed helpers and the independent growth along each axis. A per-
  // operation copy of the widened schema adds a positive interaction; savings
  // are allowed. The reference interaction is zero; one KiB permits small fixed
  // representation changes without allowing a second whole schema copy.
  const interactionBytes =
    combined!.metrics.totalBytes -
    operations!.metrics.totalBytes -
    schemas!.metrics.totalBytes +
    small!.metrics.totalBytes;
  assert.ok(
    interactionBytes <= outputGrowthPolicy.maximumInteractionBytes,
    `operation/schema interaction exceeds output growth budget: ${interactionBytes} > ${outputGrowthPolicy.maximumInteractionBytes} bytes`,
  );
  return {
    interactionBytes,
    maximumInteractionBytes: outputGrowthPolicy.maximumInteractionBytes,
  };
}

export async function runOutputGrowth(
  compile: Compiler,
  typeScriptEntry: string,
) {
  const root = await mkdtemp(join(tmpdir(), 'pom-output-growth-'));
  const cells: Cell[] = [];
  let stage = 'setup';
  let succeeded = false;
  try {
    // Generated core output runs without dependency links or the compiler in
    // its scratch tree. This qualification has no measured timing boundary.
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    for (const profile of outputGrowthProfiles) {
      const workload = outputGrowthWorkload(profile);
      const directory = join(root, profile.id);
      await mkdir(directory);
      await writeJson(join(directory, 'input.json'), workload);
      stage = `compile:${profile.id}`;
      const before = structuredClone(workload);
      const { sources, metrics } = inspectOutput(
        await compile(workload.document, workload.options),
      );
      for (const [name, source] of Object.entries(sources))
        await writeFile(join(directory, name), source, { flag: 'wx' });
      await writeJson(join(directory, 'input-after-first.json'), workload);
      assert.deepEqual(workload, before, 'compilation must preserve input');
      const second = inspectOutput(
        await compile(workload.document, workload.options),
      );
      const repeated = join(directory, 'repeat');
      await mkdir(repeated);
      for (const [name, source] of Object.entries(second.sources))
        await writeFile(join(repeated, name), source, { flag: 'wx' });
      await writeJson(join(directory, 'input-after-repeat.json'), workload);
      assert.deepEqual(
        workload,
        before,
        'repeated compilation must preserve input',
      );
      for (const name of new Set([
        ...Object.keys(sources),
        ...Object.keys(second.sources),
      ]))
        assert.equal(
          second.sources[name],
          sources[name],
          `identical compilation must produce identical complete output: ${name}`,
        );
      stage = `qualification:${profile.id}`;
      verifyOutputGrowth(
        profile,
        await import(pathToFileURL(join(directory, 'client.consumer.ts')).href),
        await import(
          pathToFileURL(join(directory, 'client.consumer.schemas.ts')).href
        ),
      );
      await writeFile(
        join(directory, 'size-consumer.ts'),
        outputGrowthConsumer(profile),
        { flag: 'wx' },
      );
      cells.push({ profile, metrics });
    }
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          lib: ['ES2022', 'DOM'],
          types: [],
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          allowImportingTsExtensions: true,
          noEmit: true,
          skipLibCheck: false,
        },
        include: ['./*/*.ts'],
      }),
      { flag: 'wx' },
    );
    stage = 'typecheck';
    try {
      await runLogged(
        process.execPath,
        [typeScriptEntry, '-p', join(root, 'tsconfig.json')],
        root,
        join(root, 'typecheck'),
        nodeEnvironment(),
        60_000,
      );
    } catch (error) {
      throw new Error('output-growth generated consumer types failed', {
        cause: error,
      });
    }
    stage = 'budgets';
    const growth = verifyOutputBudgets(cells);
    succeeded = true;
    return {
      schemaVersion: 2,
      case: outputGrowthCase,
      behavior: 'verified',
      generatedTypes: 'verified',
      sourceBudgets: 'passed',
      policy: outputGrowthPolicy,
      referenceBytes: structuredClone(outputGrowthReferenceBytes),
      growth,
      cells,
    };
  } catch (error) {
    await writeFailure(root, stage, error);
    throw new OutputGrowthError(root, error);
  } finally {
    if (succeeded) await rm(root, { recursive: true, force: true });
  }
}
