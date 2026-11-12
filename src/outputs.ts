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
  inventoryName,
  lockName,
  outputDirectory,
  safeDirectory,
} from './output-state.js';
import type { Files, OutputPlan, OutputWarning } from './output-state.js';
export type { OutputWarning } from './output-state.js';

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
): Promise<void> {
  await ownLock(lock);
  await unchanged(root, plan);
  for (const [name, content] of Object.entries(files)) {
    if (plan.snapshots.get(name)?.hash === hash(content)) continue;
    await ownLock(lock);
    if (
      (await existingFile(join(root, name)))?.hash !==
      plan.snapshots.get(name)?.hash
    )
      fail(name, 'output changed during generation; refusing to overwrite it');
    await rename(join(stage, name), join(root, name));
  }
  for (const name of plan.removals) {
    await ownLock(lock);
    if (
      (await existingFile(join(root, name)))?.hash !==
      plan.snapshots.get(name)?.hash
    )
      fail(name, 'output changed during generation; refusing to remove it');
    await rm(join(root, name));
  }
  // Publish ownership last, and never record an edit made after a target was
  // published as if it were generated content. A retry uses the current inputs.
  for (const [name, content] of Object.entries(files))
    if ((await existingFile(join(root, name)))?.hash !== hash(content))
      fail(
        name,
        'output changed during generation; refusing to publish its manifest',
      );
  await ownLock(lock);
  if (
    (await existingFile(join(root, inventoryName)))?.hash !==
    plan.snapshots.get(inventoryName)?.hash
  )
    fail(inventoryName, 'manifest changed during generation');
  if (plan.snapshots.get(inventoryName)?.content !== plan.nextManifest)
    await rename(join(stage, inventoryName), join(root, inventoryName));
}

export type OutputResult = Readonly<{
  output: string;
  clean: boolean;
  changes: readonly string[];
  warnings: readonly OutputWarning[];
}>;

/** Owned targets may be replaced with warnings; uncertain stale files are preserved. */
export async function synchronizeOutputs(
  output: string,
  expected: Files,
  inputs: readonly string[],
  check: boolean,
  onWarning?: (warning: OutputWarning) => void,
): Promise<OutputResult> {
  const root = await outputDirectory(output);
  filenames(Object.keys(expected));
  const protectedInputs = new Set(
    await Promise.all(inputs.map((input) => realpath(input))),
  );
  if (check) {
    const plan = await inspectOutputs(root, expected, protectedInputs);
    for (const warning of plan.warnings) onWarning?.(warning);
    const changes = [...plan.conflicts, ...plan.changes];
    return {
      output: root,
      clean: changes.length === 0,
      changes,
      warnings: plan.warnings,
    };
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
    const plan = await inspectOutputs(root, expected, protectedInputs);
    if (plan.conflicts.length)
      fail(
        root,
        `refusing to replace protected files: ${plan.conflicts.join('; ')}`,
      );
    for (const warning of plan.warnings) onWarning?.(warning);
    if (plan.changes.length > 0) {
      stage = await mkdtemp(join(path, '.pom-stage-'));
      await stageFiles(stage, expected, plan);
      await publish(root, stage, expected, plan, lock);
    }
    return {
      output: root,
      clean: plan.changes.length === 0,
      changes: plan.changes,
      warnings: plan.warnings,
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
