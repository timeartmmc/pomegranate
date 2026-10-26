import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { fail } from './diagnostics.js';
import {
  existingFile,
  filenames,
  hasCode,
  hash,
  inspectOutputs,
  inspectRecovery,
  inventoryName,
  journal,
  journalName,
  lockName,
  outputDirectory,
  readJournal,
  safeDirectory,
  snapshot,
} from './output-state.js';
import type { Files, OutputPlan } from './output-state.js';

type Lock = {
  path: string;
  token: string;
  dev: number;
  ino: number;
  ready: boolean;
};

async function ownLock(lock: Lock): Promise<void> {
  const stat = await lstat(lock.path);
  const owner = await existingFile(join(lock.path, 'owner'));
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.dev !== lock.dev ||
    stat.ino !== lock.ino ||
    (owner?.content !== lock.token && (lock.ready || owner !== undefined))
  )
    fail(
      lock.path,
      'generation lock ownership changed; preserving replacement lock',
    );
}

async function cleanupGeneration(
  lock: Lock,
  stage: string | undefined,
  primaryError: Error | undefined,
): Promise<void> {
  const errors: unknown[] = [];
  try {
    await ownLock(lock);
  } catch (error) {
    // A staging path is inside our lock. If ownership changed, leave the whole
    // replacement directory alone, including any coincidentally named files.
    errors.push(error);
  }
  if (errors.length === 0) {
    if (stage) {
      try {
        await rm(stage, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await ownLock(lock);
      await rm(lock.path, { recursive: true });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    const detail = errors
      .map((error) => (error instanceof Error ? error.message : String(error)))
      .join('; ');
    throw new AggregateError(
      primaryError ? [primaryError, ...errors] : errors,
      `${primaryError ? `${primaryError.message}; ` : ''}output cleanup failed: ${detail}`,
      { cause: primaryError },
    );
  }
}

async function unchanged(root: string, plan: OutputPlan): Promise<void> {
  for (const [name, previous] of plan.snapshots)
    if ((await existingFile(join(root, name)))?.hash !== previous?.hash)
      fail(
        join(root, name),
        'output changed during generation; refusing to overwrite it',
      );
}

async function stageFiles(
  stage: string,
  files: Files,
  plan: OutputPlan,
): Promise<void> {
  for (const [name, content] of Object.entries(files))
    await writeFile(join(stage, name), content, 'utf8');
  await writeFile(join(stage, inventoryName), plan.nextManifest, 'utf8');
}

async function publish(
  root: string,
  stage: string,
  files: Files,
  plan: OutputPlan,
  lock: Lock,
  newJournal?: string,
): Promise<void> {
  await ownLock(lock);
  await unchanged(root, plan);
  if (newJournal !== undefined) {
    // Publish the complete recovery evidence before the first target change.
    // Atomic rename prevents a partially written journal from authorizing work.
    await writeFile(join(stage, journalName), newJournal, 'utf8');
    await ownLock(lock);
    await unchanged(root, plan);
    await rename(join(stage, journalName), join(root, journalName));
  }
  const journalHash =
    newJournal === undefined
      ? plan.snapshots.get(journalName)?.hash
      : hash(newJournal);
  const assertWriter = async () => {
    await ownLock(lock);
    if ((await existingFile(join(root, journalName)))?.hash !== journalHash)
      fail(journalName, 'recovery journal changed during generation');
  };
  for (const [name, content] of Object.entries(files)) {
    if (plan.snapshots.get(name)?.content === content) continue;
    await assertWriter();
    if (
      (await existingFile(join(root, name)))?.hash !==
      plan.snapshots.get(name)?.hash
    )
      fail(name, 'output changed during generation; refusing to overwrite it');
    await rename(join(stage, name), join(root, name));
  }
  for (const [name, previous] of plan.snapshots) {
    if (
      name === inventoryName ||
      name === journalName ||
      Object.hasOwn(files, name) ||
      !previous
    )
      continue;
    await assertWriter();
    if ((await existingFile(join(root, name)))?.hash !== previous.hash)
      fail(name, 'output changed during generation; refusing to remove it');
    await rm(join(root, name));
  }
  await assertWriter();
  if (
    (await existingFile(join(root, inventoryName)))?.hash !==
    plan.snapshots.get(inventoryName)?.hash
  )
    fail(inventoryName, 'manifest changed during generation');
  if (plan.snapshots.get(inventoryName)?.content !== plan.nextManifest)
    await rename(join(stage, inventoryName), join(root, inventoryName));
  await assertWriter();
  await rm(join(root, journalName));
}

export type OutputResult = Readonly<{
  output: string;
  clean: boolean;
  changes: readonly string[];
}>;

/** An inventory is an ownership claim, not permission to overwrite edited files. */
export async function synchronizeOutputs(
  output: string,
  expected: Files,
  inputs: readonly string[],
  check: boolean,
): Promise<OutputResult> {
  const root = await outputDirectory(output);
  filenames(Object.keys(expected));
  const protectedInputs = new Set(
    await Promise.all(inputs.map((input) => realpath(input))),
  );
  const pending = await snapshot(root, journalName, protectedInputs);
  if (check) {
    if (pending) readJournal(pending.content);
    const plan = await inspectOutputs(root, expected, protectedInputs);
    const changes = [
      ...(pending ? [`interrupted generation: ${journalName}`] : []),
      ...plan.conflicts,
      ...plan.changes,
    ];
    return { output: root, clean: changes.length === 0, changes };
  }
  await mkdir(root, { recursive: true });
  const path = join(root, lockName);
  try {
    await mkdir(path);
  } catch (error) {
    if (hasCode(error, 'EEXIST'))
      fail(
        root,
        `output is locked (${lockName}); another generation may be running`,
      );
    throw error;
  }
  const identity = await lstat(path);
  const lock: Lock = {
    path,
    token: randomUUID(),
    dev: identity.dev,
    ino: identity.ino,
    ready: false,
  };
  let stage: string | undefined;
  let primaryError: Error | undefined;
  try {
    await writeFile(join(path, 'owner'), lock.token, {
      encoding: 'utf8',
      flag: 'wx',
    });
    lock.ready = true;
    await safeDirectory(root);
    const currentJournal = await snapshot(root, journalName, protectedInputs);
    let recovered = false;
    if (currentJournal) {
      const pending = readJournal(currentJournal.content);
      const plan = await inspectRecovery(
        root,
        pending,
        currentJournal,
        protectedInputs,
      );
      // Validate the new request too before completing the prior publication.
      // Recovery must not hide an input overlap or an unrelated unowned target.
      filenames([...Object.keys(pending.before), ...Object.keys(expected)]);
      for (const name of Object.keys(expected)) {
        const current = await snapshot(root, name, protectedInputs);
        if (!Object.hasOwn(pending.before, name) && current)
          fail(join(root, name), `unowned output: ${name}`);
      }
      stage = await mkdtemp(join(path, '.pom-stage-'));
      await stageFiles(stage, pending.files, plan);
      await publish(root, stage, pending.files, plan, lock);
      recovered = true;
    }
    const plan = await inspectOutputs(root, expected, protectedInputs);
    if (plan.conflicts.length)
      fail(
        root,
        `refusing to replace protected files: ${plan.conflicts.join('; ')}`,
      );
    if (plan.changes.length === 0)
      return {
        output: root,
        clean: !recovered,
        changes: recovered ? ['recovered interrupted generation'] : [],
      };
    plan.snapshots.set(journalName, undefined);
    stage ??= await mkdtemp(join(path, '.pom-stage-'));
    await stageFiles(stage, expected, plan);
    await publish(
      root,
      stage,
      expected,
      plan,
      lock,
      JSON.stringify(journal(plan, expected)) + '\n',
    );
    return {
      output: root,
      clean: false,
      changes: [
        ...(recovered ? ['recovered interrupted generation'] : []),
        ...plan.changes,
      ],
    };
  } catch (error) {
    primaryError =
      error instanceof Error
        ? error
        : new Error(String(error), { cause: error });
    throw primaryError;
  } finally {
    await cleanupGeneration(lock, stage, primaryError);
  }
}
