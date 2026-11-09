import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { jsonResponseCase } from './cases/json-response.ts';
import {
  jsonResponseRuntime,
  profileKey,
} from './cases/json-response-runtime.ts';
import {
  benchmarkDirectory,
  benchmarkId,
  benchmarkSeed,
  createRunDirectory,
  publishReport,
  readJson,
  readPlan,
  record,
  sha256,
  writeFailure,
} from './controller.ts';
import { calibrationMethod, pairedMedianInterval } from './statistics.ts';
import { fingerprintSources, timingSettings } from './timing.ts';

function array(value: unknown, location = 'value'): unknown[] {
  assert.ok(Array.isArray(value), `${location}: expected an array`);
  return value;
}

export function calibrationPlan(value: unknown) {
  // Version 1 fixes paired-median-sign-v1 and its family policy. Changing the
  // method requires a new study version, not reinterpretation of old plans.
  const plan = record(value, 'study');
  assert.deepEqual(
    Object.keys(plan).sort(),
    [
      'version',
      'rounds',
      'policy',
      'profiles',
      'reference',
      'comparisons',
      'controls',
      'sessions',
    ].sort(),
    'study: expected version, rounds, policy, profiles, reference, comparisons, controls and sessions only',
  );
  assert.equal(plan.version, 1, 'study.version: expected 1');
  const settings = timingSettings({
    rounds: plan.rounds,
    policy: plan.policy,
    profiles: plan.profiles,
  });
  assert.equal(
    settings.rounds,
    plan.rounds,
    'study.rounds: an explicit integer between 1 and 100 is required',
  );
  assert.deepEqual(
    settings.policy,
    plan.policy,
    'study.policy: an explicit sampling policy is required',
  );
  assert.deepEqual(
    settings.profiles,
    plan.profiles,
    'study.profiles: explicit runtime profiles are required',
  );
  const reference = benchmarkId(plan.reference, 'study.reference');
  const comparisons = array(plan.comparisons, 'study.comparisons').map(
    (value, index) => {
      const location = `study.comparisons[${index}]`;
      const entry = record(value, location);
      assert.ok(
        entry.kind === 'identical' || entry.kind === 'repeat',
        `${location}.kind: expected identical or repeat`,
      );
      assert.deepEqual(
        Object.keys(entry).sort(),
        (entry.kind === 'repeat'
          ? ['id', 'kind', 'every']
          : ['id', 'kind']
        ).sort(),
        `${location}: expected id, kind${entry.kind === 'repeat' ? ' and every' : ''} only`,
      );
      if (entry.kind === 'repeat')
        assert.ok(
          typeof entry.every === 'number' &&
            Number.isSafeInteger(entry.every) &&
            entry.every >= 1 &&
            entry.every <= 1024,
          `${location}.every: expected an integer between 1 and 1024`,
        );
      return {
        id: benchmarkId(entry.id, `${location}.id`),
        kind: entry.kind,
        every: entry.kind === 'repeat' ? (entry.every as number) : 0,
      };
    },
  );
  assert.ok(
    comparisons.length >= 1 && comparisons.length <= 18,
    'study.comparisons: expected between 1 and 18 comparisons',
  );
  assert.ok(
    comparisons.some(({ kind }) => kind === 'identical'),
    'study.comparisons: an identical-artifact control is required',
  );
  const controls = array(plan.controls, 'study.controls').map((value, index) =>
    benchmarkId(value, `study.controls[${index}]`),
  );
  assert.ok(
    controls.length >= 1 && controls.length <= 18,
    'study.controls: expected between 1 and 18 control IDs',
  );
  const ids = [reference, ...comparisons.map(({ id }) => id), ...controls];
  assert.ok(
    ids.length <= 20,
    'study: expected at most 20 adapter IDs in total',
  );
  assert.equal(
    new Set(ids.map((id) => id.toLowerCase())).size,
    ids.length,
    'study: adapter IDs must be unique ignoring ASCII case',
  );
  const sessions = array(plan.sessions, 'study.sessions').map(
    (value, index) => {
      const location = `study.sessions[${index}]`;
      const session = record(value, location);
      assert.deepEqual(
        Object.keys(session).sort(),
        ['id', 'report', 'seed'],
        `${location}: expected id, report and seed only`,
      );
      assert.ok(
        typeof session.report === 'string' && session.report.length > 0,
        `${location}.report: expected a nonempty local report path`,
      );
      const seed = benchmarkSeed(session.seed, `${location}.seed`);
      return {
        id: benchmarkId(session.id, `${location}.id`),
        report: session.report,
        seed,
      };
    },
  );
  assert.ok(
    sessions.length >= 2 && sessions.length <= 20,
    'study.sessions: expected between 2 and 20 sessions',
  );
  assert.equal(
    new Set(sessions.map(({ id }) => id.toLowerCase())).size,
    sessions.length,
    'study.sessions: IDs must be unique ignoring ASCII case',
  );
  assert.equal(
    new Set(sessions.map(({ seed }) => seed)).size,
    sessions.length,
    'study.sessions: seeds must be unique',
  );
  assert.equal(
    new Set(sessions.map(({ report }) => report)).size,
    sessions.length,
    'study.sessions: report paths must be unique',
  );
  return {
    reference,
    comparisons,
    controls,
    sessions,
    rounds: settings.rounds,
    policy: settings.policy,
    profiles: settings.profiles,
  };
}

// Pair process means within their original randomized round. Windows are never
// treated as independent observations. A missing comparison invalidates the
// session instead of reducing the predeclared multiplicity correction.
export function calibrationSession(
  value: unknown,
  plan: ReturnType<typeof calibrationPlan>,
  seed: number,
  study: { path: string; sha256: string },
) {
  const report = record(value);
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.status, 'complete');
  assert.equal(report.seed, seed);
  assert.equal(report.rounds, plan.rounds);
  assert.deepEqual(report.policy, plan.policy);
  assert.deepEqual(report.profiles, plan.profiles);
  assert.deepEqual(report.profile, jsonResponseRuntime);
  const host = record(report.host);
  for (const key of ['node', 'platform', 'arch', 'release', 'cpu'])
    assert.equal(typeof host[key], 'string');
  assert.deepEqual(report.ineligible, []);
  const controls = array(report.controls).map((value) => record(value));
  assert.deepEqual(
    controls
      .map((entry) => benchmarkId(entry.id, 'report.controls[].id'))
      .sort(),
    [...plan.controls].sort(),
  );
  for (const control of controls)
    assert.equal(control.status, 'rejected-as-expected');
  const sources = array(report.sources).map((value) => record(value));
  assert.ok(
    sources.some(
      (entry) => entry.path === study.path && entry.sha256 === study.sha256,
    ),
    'report must attest the predeclared study plan',
  );
  const qualified = array(report.qualified).map((value) => record(value));
  const expectedIds = [plan.reference, ...plan.comparisons.map(({ id }) => id)];
  assert.deepEqual(
    qualified
      .map((entry) => benchmarkId(entry.id, 'report.qualified[].id'))
      .sort(),
    [...expectedIds].sort(),
  );
  const identities = new Map(
    qualified.map((entry) => {
      const identity = record(entry.identity);
      assert.equal(entry.fingerprint, sha256(JSON.stringify(identity)));
      assert.deepEqual(identity.case, jsonResponseCase);
      assert.deepEqual(identity.profile, jsonResponseRuntime);
      assert.deepEqual(identity.profiles, plan.profiles);
      assert.equal(identity.node, host.node);
      return [String(entry.id), identity];
    }),
  );
  const reference = identities.get(plan.reference)!;
  const referenceEntry = qualified.find(
    (entry) => entry.id === plan.reference,
  )!;
  const base = record(reference.adapter);
  assert.equal(base.control, 'repeat-validation-v1');
  assert.equal(base.repeatEvery, '0');
  for (const comparison of plan.comparisons) {
    const identity = identities.get(comparison.id)!;
    const entry = qualified.find((entry) => entry.id === comparison.id)!;
    // A different wrapper injects repeat work, but its underlying validator
    // sources must stay fixed or build differences confound that effect.
    assert.deepEqual(
      entry.sources,
      referenceEntry.sources,
      'calibration controls must declare the same validator sources as the reference',
    );
    if (comparison.kind === 'identical') {
      assert.deepEqual(
        identity,
        reference,
        'A/A controls must have identical factories and identities',
      );
      assert.equal(entry.module, referenceEntry.module);
    } else {
      const { adapter, moduleSha256, ...common } = identity;
      const {
        adapter: referenceAdapter,
        moduleSha256: referenceModule,
        ...referenceCommon
      } = reference;
      assert.equal(typeof moduleSha256, 'string');
      assert.equal(typeof referenceModule, 'string');
      assert.deepEqual(common, referenceCommon);
      assert.deepEqual(adapter, {
        ...record(referenceAdapter),
        repeatEvery: String(comparison.every),
      });
    }
  }
  const rows = array(report.observations).map((value) => record(value));
  assert.equal(
    rows.length,
    expectedIds.length * plan.profiles.length * plan.rounds,
  );
  const costs = new Map<string, number>();
  const files = new Set<string>();
  const positions = new Set<string>();
  const profilePositions = new Map<string, string>();
  for (const row of rows) {
    assert.ok(expectedIds.includes(String(row.id)));
    const profile = plan.profiles.find(
      (profile) =>
        profile.scenario === row.scenario && profile.records === row.records,
    );
    assert.ok(profile);
    assert.ok(
      typeof row.round === 'number' &&
        Number.isSafeInteger(row.round) &&
        row.round >= 0 &&
        row.round < plan.rounds,
    );
    assert.ok(
      typeof row.position === 'number' &&
        Number.isSafeInteger(row.position) &&
        row.position >= 0 &&
        row.position < expectedIds.length,
    );
    assert.ok(
      typeof row.profilePosition === 'number' &&
        Number.isSafeInteger(row.profilePosition) &&
        row.profilePosition >= 0 &&
        row.profilePosition < plan.profiles.length,
    );
    assert.ok(
      typeof row.usPerOperation === 'number' &&
        Number.isFinite(row.usPerOperation) &&
        row.usPerOperation > 0,
    );
    assert.ok(
      typeof row.file === 'string' &&
        row.file.length > 0 &&
        !files.has(row.file),
    );
    files.add(row.file);
    const key = `${profileKey(profile)}:${row.round}:${String(row.id)}`;
    assert.ok(!costs.has(key), 'duplicate paired observation');
    costs.set(key, row.usPerOperation);
    const position = `${row.round}:${profileKey(profile)}:${row.position}`;
    assert.ok(!positions.has(position), 'duplicate adapter position');
    positions.add(position);
    const profilePosition = `${row.round}:${row.profilePosition}`;
    if (profilePositions.has(profilePosition))
      assert.equal(profilePositions.get(profilePosition), profileKey(profile));
    else profilePositions.set(profilePosition, profileKey(profile));
  }
  assert.equal(profilePositions.size, plan.rounds * plan.profiles.length);
  const familySize = plan.comparisons.length * plan.profiles.length;
  const cells = plan.profiles.flatMap((profile) => {
    const values = (id: string) =>
      Array.from({ length: plan.rounds }, (_, round) => {
        const cost = costs.get(`${profileKey(profile)}:${round}:${id}`);
        assert.notEqual(cost, undefined, 'missing paired observation');
        return cost!;
      });
    const baseline = values(plan.reference);
    return plan.comparisons.map((comparison) => {
      const candidate = values(comparison.id);
      return {
        ...comparison,
        ...profile,
        referenceUs: baseline,
        candidateUs: candidate,
        ...pairedMedianInterval(baseline, candidate, familySize),
      };
    });
  });
  return {
    cells,
    compatibility: {
      host: report.host,
      sources: report.sources,
      qualified: report.qualified,
    },
  };
}

export async function analyzeCalibration(planPath: string, output: string) {
  const study = await readPlan(planPath);
  const plan = calibrationPlan(study.value);
  const root = await createRunDirectory(output);
  try {
    const analyzerSources = await fingerprintSources([benchmarkDirectory]);
    const sessions: {
      id: string;
      seed: number;
      input: { path: string; sha256: string };
      cells: ReturnType<typeof calibrationSession>['cells'];
    }[] = [];
    let compatibility: unknown;
    for (const session of plan.sessions) {
      const report = await readJson(
        resolve(dirname(study.path), session.report),
        16 * 1024 * 1024,
      );
      const result = calibrationSession(
        report.value,
        plan,
        session.seed,
        study,
      );
      if (compatibility === undefined) compatibility = result.compatibility;
      else
        assert.deepEqual(
          result.compatibility,
          compatibility,
          'session source, host or adapter identity changed',
        );
      // Collection sources must agree across sessions. Analysis has a separate
      // receipt so an archived dataset remains usable after unrelated harness
      // changes, or from a copied analyzer, without rewriting its provenance.
      sessions.push({
        id: session.id,
        seed: session.seed,
        input: { path: report.path, sha256: report.sha256 },
        cells: result.cells,
      });
    }
    const summary = plan.profiles.flatMap((profile) =>
      plan.comparisons.map((comparison) => {
        const cells = sessions.map(({ cells }) =>
          cells.find(
            (cell) =>
              cell.id === comparison.id &&
              profileKey(cell) === profileKey(profile),
          )!,
        );
        return {
          ...comparison,
          ...profile,
          sessions: cells.length,
          slower: cells.filter(({ signal }) => signal === 'slower').length,
          faster: cells.filter(({ signal }) => signal === 'faster').length,
          unresolved: cells.filter(({ signal }) => signal === 'unresolved')
            .length,
          estimates: cells.map(({ estimate }) => estimate),
        };
      }),
    );
    assert.deepEqual(
      await fingerprintSources([benchmarkDirectory]),
      analyzerSources,
    );
    const report = {
      schemaVersion: 1,
      status: 'complete',
      qualification:
        'pilot only; no CI threshold, minimum detectable effect or product acceptance verdict',
      method: calibrationMethod,
      limitations:
        'Within-session bounds are conditional on the stated model. Shared reference controls and neighboring sessions are dependent. Counts across sessions do not establish a false-alarm rate or detection power. Injected extra-call frequency is not a nominal percentage slowdown.',
      study: { path: study.path, sha256: study.sha256 },
      analyzerSources,
      compatibility,
      sessions,
      summary,
    };
    await publishReport(root, report);
    return report;
  } catch (error) {
    await writeFailure(root, 'analysis', error);
    throw error;
  }
}
