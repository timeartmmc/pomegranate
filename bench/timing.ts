import assert from 'node:assert/strict';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { arch, cpus, platform, release } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  jsonResponseCase,
  verifyJsonResponseValidation,
  verifyJsonResponseValue,
  verifyJsonResponseRejection,
  verifyJsonResponseFailure,
  verifyJsonResponseConstruction,
  verifyJsonResponseNoExcludedReads,
} from './cases/json-response.ts';
import { nodeEnvironment, runLogged } from './process.ts';
import { installedTree } from './installed.ts';
import {
  createRunDirectory,
  publishReport,
  readPlan,
  readJson,
  record,
  sha256,
  writeFailure,
  benchmarkDirectory,
  benchmarkSeed,
  benchmarkId,
} from './controller.ts';

import {
  defaultProfiles,
  defaultRecords,
  jsonResponseRuntime,
  poolSize,
  profileKey,
  runtimePool,
  runtimeProfiles,
  scenarios,
} from './cases/json-response-runtime.ts';
import type {
  RuntimeProfile,
  Scenario,
} from './cases/json-response-runtime.ts';

export interface SamplingPolicy {
  warmupMs: number;
  sampleMs: number;
  samples: number;
  batchSize: number;
}
export const defaultPolicy: Readonly<SamplingPolicy> = Object.freeze({
  warmupMs: 100,
  sampleMs: 100,
  samples: 5,
  batchSize: 128,
});
export interface ValidationAdapter {
  readonly validate: (input: unknown) => unknown;
  identity: Record<string, string>;
  dispose?: () => void | Promise<void>;
}
export interface WorkerOptions {
  seed: number;
  policy: SamplingPolicy;
  profiles?: readonly RuntimeProfile[];
  records?: number;
}
class SharedSourceError extends Error {
  override name = 'SharedSourceError';
}
type Result =
  | { success: true; data: { items: { id: number }[] } }
  | {
      success: false;
      error: Error & { issues: { path: unknown; message: string }[] };
    };

export function samplingPolicy(value: unknown): SamplingPolicy {
  const policy = record(value, 'policy');
  assert.deepEqual(
    Object.keys(policy).sort(),
    Object.keys(defaultPolicy).sort(),
    'policy: expected warmupMs, sampleMs, samples and batchSize only',
  );
  for (const [name, maximum] of [
    ['warmupMs', 10_000],
    ['sampleMs', 10_000],
    ['samples', 50],
    ['batchSize', 4096],
  ] as const) {
    const setting = policy[name];
    assert.ok(
      typeof setting === 'number' &&
        Number.isSafeInteger(setting) &&
        setting >= (name === 'warmupMs' ? 0 : 1) &&
        setting <= maximum,
      `policy.${name}: expected an integer between ${name === 'warmupMs' ? 0 : 1} and ${maximum}`,
    );
  }
  return policy as unknown as SamplingPolicy;
}

export function workerDeadline(policy: SamplingPolicy): number {
  samplingPolicy(policy);
  return 60_000 + policy.warmupMs + policy.samples * policy.sampleMs;
}

export function timingSettings(value: unknown = {}) {
  const settings = record(value, 'settings');
  for (const key of Object.keys(settings))
    assert.ok(
      ['seed', 'rounds', 'policy', 'profiles'].includes(key),
      `settings: unknown field ${key}; expected seed, rounds, policy or profiles`,
    );
  const rounds = settings.rounds ?? 12;
  const seed = benchmarkSeed(settings.seed ?? 20261108);
  assert.ok(
    typeof rounds === 'number' &&
      Number.isSafeInteger(rounds) &&
      rounds >= 1 &&
      rounds <= 100,
    'rounds: expected an integer between 1 and 100',
  );
  return {
    seed,
    rounds,
    policy: samplingPolicy(settings.policy ?? defaultPolicy),
    profiles: runtimeProfiles(settings.profiles ?? defaultProfiles),
  };
}

export function measureValidation(
  validate: ValidationAdapter['validate'],
  scenario: Scenario,
  seed: number,
  policy: SamplingPolicy,
  records = defaultRecords,
) {
  samplingPolicy(policy);
  assert.ok(scenarios.includes(scenario));
  const inputs = runtimePool(seed, { scenario, records });
  const name = profileKey({ scenario, records });
  const before = structuredClone(inputs);
  const retained = Array<Result | undefined>(poolSize).fill(undefined);
  const expectedSuccess =
    scenario === 'parsed-valid' || scenario === 'json-valid';
  let cursor = 0;
  let checksum = 0;
  const invoke =
    scenario === 'json-valid'
      ? (index: number) => validate(JSON.parse(inputs[index]!.text) as unknown)
      : (index: number) => validate(inputs[index]!.input);
  function window(milliseconds: number) {
    let operations = 0;
    const start = performance.now();
    let elapsedMs: number;
    do {
      for (let index = 0; index < policy.batchSize; index++) {
        // The result contract is checked in a separate preflight process. Keep
        // common consumption small and include its cost for every implementation.
        const result = invoke(cursor) as Result;
        if (result.success !== expectedSuccess)
          throw new Error('timed validation changed its verdict');
        checksum =
          (checksum +
            (result.success
              ? result.data.items.length + (result.data.items[0]?.id ?? 0)
              : result.error.issues.length)) |
          0;
        retained[cursor] = result;
        cursor = (cursor + 1) % poolSize;
        operations++;
      }
      elapsedMs = performance.now() - start;
    } while (elapsedMs < milliseconds);
    // Observe escaping results after the clock stops. Do not force collection
    // or remove GC pauses: one output per input stays live across windows.
    for (const [slot, result] of retained.entries()) {
      if (!result) continue;
      if (result.success) assert.deepEqual(result.data, inputs[slot]!.expected);
      else verifyJsonResponseFailure(result, inputs[slot]!.paths, name);
    }
    assert.deepEqual(inputs, before, 'timed validation mutated its input pool');
    return { operations, elapsedMs, checksum };
  }
  if (policy.warmupMs > 0) window(policy.warmupMs);
  const observations = Array.from({ length: policy.samples }, () =>
    window(policy.sampleMs),
  );
  const operations = observations.reduce((sum, row) => sum + row.operations, 0);
  const elapsedMs = observations.reduce((sum, row) => sum + row.elapsedMs, 0);
  return {
    observations,
    operations,
    elapsedMs,
    usPerOperation: (elapsedMs * 1000) / operations,
  };
}

async function loadAdapter(path: string): Promise<ValidationAdapter> {
  const module: unknown = await import(pathToFileURL(path).href);
  const factory = record(module).create;
  assert.equal(typeof factory, 'function', 'adapter must export create()');
  const value = record(await (factory as () => unknown)());
  assert.equal(typeof value.validate, 'function');
  const identity = record(value.identity);
  assert.ok(Object.keys(identity).length > 0);
  for (const setting of Object.values(identity))
    assert.equal(typeof setting, 'string');
  assert.ok(value.dispose === undefined || typeof value.dispose === 'function');
  return {
    validate: (value.validate as ValidationAdapter['validate']).bind(value),
    identity: Object.fromEntries(
      Object.keys(identity)
        .sort()
        .map((key) => [key, identity[key] as string]),
    ),
    ...(value.dispose === undefined
      ? {}
      : {
          dispose: (
            value.dispose as NonNullable<ValidationAdapter['dispose']>
          ).bind(value),
        }),
  };
}

export async function timingWorker(
  modulePath: string,
  mode: 'preflight' | Scenario,
  {
    seed,
    policy,
    profiles: selectedProfiles = defaultProfiles,
    records = defaultRecords,
  }: WorkerOptions,
) {
  const profiles = runtimeProfiles(selectedProfiles);
  if (mode !== 'preflight') {
    const [profile] = runtimeProfiles([{ scenario: mode, records }]);
    assert.ok(
      profiles.some(
        (selected) => profileKey(selected) === profileKey(profile!),
      ),
      'measured profile must belong to its qualified selection',
    );
  }
  const path = await realpath(modulePath);
  const moduleSha256 = sha256(await readFile(path));
  const adapter = await loadAdapter(path);
  try {
    assert.equal(
      sha256(await readFile(path)),
      moduleSha256,
      'adapter changed during setup',
    );
    const identity = {
      case: jsonResponseCase,
      profile: jsonResponseRuntime,
      profiles,
      moduleSha256,
      adapter: adapter.identity,
      node: process.version,
      execPath: process.execPath,
      platform: platform(),
      arch: arch(),
      cpu: cpus()[0]?.model,
    };
    if (mode === 'preflight') {
      try {
        verifyJsonResponseValidation(adapter);
        for (const profile of profiles) {
          for (const [index, sample] of runtimePool(seed, profile).entries()) {
            const value: unknown =
              profile.scenario === 'json-valid'
                ? (JSON.parse(sample.text) as unknown)
                : sample.input;
            if (sample.paths.length) {
              verifyJsonResponseRejection(
                adapter,
                value,
                sample.paths,
                profileKey(profile),
              );
              // Repair in place: cached failures must not survive valid input.
              for (const path of sample.paths) {
                const position = path[1];
                sample.input.items[position]!.details.tags = structuredClone(
                  sample.expected.items[position]!.details.tags,
                );
              }
            }
            if (index === 0)
              verifyJsonResponseNoExcludedReads(
                adapter,
                value,
                sample.expected,
              );
            verifyJsonResponseConstruction(adapter, value, sample.expected);
            // Each selected size must observe later changes to the same input,
            // including valid changes and a newly invalid value.
            record(value).nextCursor = 'changed-cursor';
            verifyJsonResponseValue(adapter, value, {
              ...sample.expected,
              nextCursor: 'changed-cursor',
            });
            record(value).nextCursor = '';
            verifyJsonResponseRejection(
              adapter,
              value,
              [['nextCursor']],
              profileKey(profile),
            );
          }
        }
      } catch (error) {
        return {
          schemaVersion: 2,
          mode,
          identity,
          behavior: 'rejected',
          reason:
            error instanceof Error
              ? (error.stack ?? error.message)
              : String(error),
        };
      }
      return { schemaVersion: 2, mode, identity, behavior: 'verified' };
    }
    return {
      schemaVersion: 2,
      mode,
      identity,
      policy,
      seed,
      records,
      ...measureValidation(adapter.validate, mode, seed, policy, records),
    };
  } finally {
    await adapter.dispose?.();
  }
}

export async function fingerprintSources(paths: readonly string[]) {
  const files = [
    ...new Set(await Promise.all(paths.map((path) => realpath(path)))),
  ].sort();
  return Promise.all(
    files.map(async (path) => {
      const metadata = await stat(path);
      if (metadata.isDirectory())
        return { path, sha256: (await installedTree(path)).sha256 };
      assert.ok(
        metadata.isFile(),
        'timing sources must be regular files or installed trees',
      );
      return { path, sha256: sha256(await readFile(path)) };
    }),
  );
}

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}
function shuffled<T>(values: readonly T[], next: () => number): T[] {
  const order = [...values];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  return order;
}
function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export async function runTiming(planPath: string, output: string) {
  const { path, value } = await readPlan(planPath);
  const plan = record(value, 'plan');
  for (const key of Object.keys(plan))
    assert.ok(
      ['version', 'adapters', 'seed', 'rounds', 'policy', 'profiles'].includes(
        key,
      ),
      `plan: unknown field ${key}; expected version, adapters, seed, rounds, policy or profiles`,
    );
  assert.equal(plan.version, 1, 'plan.version: expected 1');
  const { seed, rounds, policy, profiles } = timingSettings({
    seed: plan.seed,
    rounds: plan.rounds,
    policy: plan.policy,
    profiles: plan.profiles,
  });
  assert.ok(
    Array.isArray(plan.adapters) &&
      plan.adapters.length > 0 &&
      plan.adapters.length <= 20,
    'plan.adapters: expected between 1 and 20 adapters',
  );
  const adapters = plan.adapters.map((value: unknown, index: number) => {
    const location = `plan.adapters[${index}]`;
    const adapter = record(value, location);
    for (const key of Object.keys(adapter))
      assert.ok(
        ['id', 'module', 'sources', 'expect'].includes(key),
        `${location}: unknown field ${key}; expected id, module, sources or expect`,
      );
    const id = benchmarkId(adapter.id, `${location}.id`);
    assert.ok(
      typeof adapter.module === 'string' && adapter.module.length > 0,
      `${location}.module: expected a nonempty local module path`,
    );
    assert.ok(
      Array.isArray(adapter.sources) &&
        adapter.sources.every((source: unknown) => typeof source === 'string'),
      `${location}.sources: expected an array of local source paths`,
    );
    assert.ok(
      adapter.expect === undefined ||
        adapter.expect === 'eligible' ||
        adapter.expect === 'ineligible',
      `${location}.expect: expected eligible or ineligible`,
    );
    return {
      id,
      module: resolve(dirname(path), adapter.module),
      sources: adapter.sources.map((source) => resolve(dirname(path), source)),
      expect: adapter.expect ?? 'eligible',
    };
  });
  assert.equal(
    new Set(adapters.map(({ id }) => id.toLowerCase())).size,
    adapters.length,
    'adapter IDs must be unique ignoring ASCII case',
  );
  // Attest the same declared closure for every tool. This keeps setup hashing
  // load independent of which adapter is about to run. Tree hashing stays in
  // the parent; workers check their entry module. Include the whole maintained
  // benchmark tree so new helpers cannot silently escape source attestation.
  const declaredPaths = [
    benchmarkDirectory,
    ...adapters.flatMap((adapter) => [adapter.module, ...adapter.sources]),
  ];
  const root = await createRunDirectory(output);
  const environment = nodeEnvironment();
  const entry = new URL('./run.ts', import.meta.url);
  const entryPath = fileURLToPath(entry);
  const qualified: {
    id: string;
    module: string;
    sources: string[];
    fingerprint: string;
    identity: unknown;
  }[] = [];
  const ineligible: { id: string; reason: string }[] = [];
  const controls: { id: string; status: string; reason: string }[] = [];
  const observations: {
    id: string;
    scenario: Scenario;
    records: number;
    round: number;
    profilePosition: number;
    position: number;
    usPerOperation: number;
    file: string;
  }[] = [];
  async function worker(
    adapter: { id: string; module: string; sources: readonly string[] },
    selection: 'preflight' | RuntimeProfile,
    log: string,
    sources: Awaited<ReturnType<typeof fingerprintSources>>,
  ) {
    const mode = selection === 'preflight' ? 'preflight' : selection.scenario;
    await attest(sources, 'before worker execution');
    const resultPath = join(root, `${log}.result.json`);
    try {
      await runLogged(
        process.execPath,
        [
          entryPath,
          '--worker',
          adapter.module,
          mode,
          JSON.stringify({
            seed,
            policy,
            profiles,
            ...(selection === 'preflight'
              ? {}
              : { records: selection.records }),
          }),
          resultPath,
        ],
        root,
        join(root, log),
        environment,
        mode === 'preflight' ? 60_000 : workerDeadline(policy),
      );
    } finally {
      await attest(sources, 'after worker execution');
    }
    // Adapter stdout/stderr are logs; only this dedicated file carries the
    // result. Library notices must not become false oracle failures.
    const result = record((await readJson(resultPath, 4 * 1024 * 1024)).value);
    assert.equal(result.schemaVersion, 2);
    assert.equal(result.mode, mode);
    return result;
  }
  async function attest(
    expected: Awaited<ReturnType<typeof fingerprintSources>>,
    phase: string,
  ) {
    try {
      assert.deepEqual(await fingerprintSources(declaredPaths), expected);
    } catch (error) {
      throw new SharedSourceError(`shared declared sources changed ${phase}`, {
        cause: error,
      });
    }
  }
  let stage = 'source-setup';
  try {
    await writeFile(
      join(root, 'plan.json'),
      `${JSON.stringify({ version: 1, seed, rounds, policy, profiles, adapters }, null, 2)}\n`,
      { flag: 'wx' },
    );
    // A bad shared source closure is a setup failure, not evidence that every
    // adapter failed its own oracle. Validate it before classifying adapters.
    const sources = await fingerprintSources(declaredPaths);
    stage = 'qualification';
    for (const adapter of adapters) {
      let result: Record<string, unknown>;
      try {
        result = await worker(
          adapter,
          'preflight',
          `preflight-${adapter.id}`,
          sources,
        );
      } catch (error) {
        if (error instanceof SharedSourceError) throw error;
        if (adapter.expect === 'ineligible')
          throw new Error(
            `${adapter.id}: negative control failed before oracle qualification`,
            { cause: error },
          );
        const failure = {
          id: adapter.id,
          reason: error instanceof Error ? error.message : String(error),
        };
        ineligible.push(failure);
        continue;
      }
      if (result.behavior === 'rejected') {
        assert.ok(typeof result.reason === 'string');
        const failure = { id: adapter.id, reason: result.reason };
        if (adapter.expect === 'ineligible')
          controls.push({ ...failure, status: 'rejected-as-expected' });
        else ineligible.push(failure);
        continue;
      }
      assert.equal(result.behavior, 'verified');
      assert.notEqual(
        adapter.expect,
        'ineligible',
        'negative control unexpectedly qualified',
      );
      qualified.push({
        ...adapter,
        fingerprint: sha256(JSON.stringify(result.identity)),
        identity: result.identity,
      });
    }
    stage = 'measurement';
    const next = random(seed);
    for (let round = 0; round < rounds; round++) {
      for (const [profilePosition, profile] of shuffled(
        profiles,
        next,
      ).entries()) {
        const { scenario, records } = profile;
        const order = shuffled(qualified, next);
        for (const [position, adapter] of order.entries()) {
          const file = `measurement-${round}-${profileKey(profile)}-${adapter.id}`;
          const result = await worker(adapter, profile, file, sources);
          assert.equal(
            sha256(JSON.stringify(result.identity)),
            adapter.fingerprint,
            'worker identity changed after qualification',
          );
          assert.deepEqual(result.policy, policy);
          assert.equal(result.seed, seed);
          assert.equal(result.records, records);
          assert.ok(
            typeof result.usPerOperation === 'number' &&
              Number.isFinite(result.usPerOperation) &&
              result.usPerOperation > 0,
          );
          observations.push({
            id: adapter.id,
            scenario,
            records,
            round,
            profilePosition,
            position,
            usPerOperation: result.usPerOperation,
            file: `${file}.result.json`,
          });
        }
      }
    }
    const summary = qualified.flatMap(({ id }) =>
      profiles.map(({ scenario, records }) => {
        const values = observations
          .filter(
            (row) =>
              row.id === id &&
              row.scenario === scenario &&
              row.records === records,
          )
          .map((row) => row.usPerOperation);
        assert.equal(values.length, rounds);
        return {
          id,
          scenario,
          records,
          processes: values.length,
          medianUs: median(values),
          minUs: Math.min(...values),
          maxUs: Math.max(...values),
        };
      }),
    );
    stage = 'report';
    const report = {
      schemaVersion: 2,
      status:
        ineligible.length || qualified.length === 0 ? 'partial' : 'complete',
      qualification: 'exploratory; no performance acceptance verdict',
      boundary:
        'validation plus detached stripped output; json-valid includes JSON.parse; records and error positions are explicit per profile',
      lifecycle:
        'fixed warmup, finite measurement windows, natural GC, 64 input identities, 64 retained outputs; not a steady-state claim',
      statisticalUnit:
        'fresh process; windows within a process are not independent',
      statistic:
        'median of process means; min/max describe observed process variation, not confidence intervals',
      order:
        'seeded randomized profiles per round and adapters within each profile',
      sourceAttestation:
        'fixed run baseline for the complete benchmark tree and caller-declared adapter sources, checked before and after every worker in the parent; no OS isolation or adapter import discovery',
      sources,
      host: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        release: release(),
        cpu: cpus()[0]?.model,
      },
      seed,
      rounds,
      policy,
      profiles,
      profile: jsonResponseRuntime,
      qualified,
      ineligible,
      controls,
      observations,
      summary,
    };
    await publishReport(root, report);
    return report;
  } catch (error) {
    await writeFailure(root, stage, error);
    throw error;
  }
}
