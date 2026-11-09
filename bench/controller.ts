import assert from 'node:assert/strict';
import { isUtf8 } from 'node:buffer';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';

export const benchmarkDirectory = fileURLToPath(new URL('.', import.meta.url));

// Controller evidence I/O stays out of the copied, standalone case/preflight
// harness. Every controller uses the same limits and publication/failure format.
export function record(
  value: unknown,
  location = 'value',
): Record<string, unknown> {
  assert.ok(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    `${location}: expected an object`,
  );
  return value as Record<string, unknown>;
}

export function benchmarkSeed(value: unknown, location = 'seed'): number {
  assert.ok(
    typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 0xffffffff,
    `${location}: expected an integer between 0 and 4294967295`,
  );
  return value;
}

export function benchmarkId(value: unknown, location: string): string {
  assert.ok(
    typeof value === 'string' && /^[a-zA-Z0-9_-]+$/.test(value),
    `${location}: expected ASCII letters, digits, underscores or hyphens`,
  );
  return value;
}

export const sha256 = (source: string | Buffer) =>
  createHash('sha256').update(source).digest('hex');

// Bound the actual read as well as stat: concurrent growth must not allocate
// without limit or turn a partial archive into an accepted snapshot.
export async function boundedFile(
  path: string,
  maximumBytes: number,
): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const metadata = await file.stat();
    assert.ok(metadata.isFile(), `${path}: expected a regular file`);
    assert.ok(
      metadata.size <= maximumBytes,
      `${path}: exceeds ${maximumBytes} bytes`,
    );
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(
        bytes,
        length,
        bytes.length - length,
        null,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    assert.equal(
      length,
      metadata.size,
      `${path}: file size changed while reading`,
    );
    return bytes.subarray(0, length);
  } finally {
    await file.close();
  }
}

export async function readJson(input: string, maximumBytes: number) {
  const path = await realpath(input);
  const bytes = await boundedFile(path, maximumBytes);
  assert.ok(isUtf8(bytes), 'JSON input: expected UTF-8');
  return {
    path,
    value: JSON.parse(bytes.toString('utf8')) as unknown,
    sha256: sha256(bytes),
  };
}

export async function readPlan(input: string) {
  return readJson(input, 64 * 1024);
}

export async function createRunDirectory(output: string): Promise<string> {
  await mkdir(resolve(output));
  return realpath(output);
}

export async function writeJson(path: string, value: object): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
}

export async function publishReport(
  root: string,
  report: object,
): Promise<void> {
  await writeJson(join(root, 'report.pending.json'), report);
  await rename(join(root, 'report.pending.json'), join(root, 'report.json'));
}

export async function writeFailure(
  root: string,
  stage: string,
  error: unknown,
): Promise<void> {
  await writeJson(join(root, 'failure.json'), {
    schemaVersion: 1,
    status: 'invalid',
    stage,
    error: error instanceof Error ? error.message : String(error),
    details: inspect(error, {
      depth: 4,
      colors: false,
      customInspect: false,
      maxArrayLength: 20,
      maxStringLength: 4096,
    }).slice(0, 32_768),
  });
}
