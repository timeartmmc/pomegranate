import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import { generatedWorkspace } from '../test/generated-workspace.ts';
import {
  scaleCompilerOptions,
  typecheckScaleFixture,
} from '../test/typecheck-scale-fixture.ts';

// Run serially: local timings describe this toolchain and machine, not a CI budget.
const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const compiler = resolve(
  process.argv[3] ?? join(repo, 'node_modules/typescript/bin/tsc'),
);
const revision = (
  await exec('git', ['rev-parse', process.argv[2] ?? 'HEAD'], { cwd: repo })
).stdout.trim();
const scratch = await mkdtemp(join(tmpdir(), 'pom-typecheck-'));
const baseline = join(scratch, 'baseline');
const outputs: string[] = [];
try {
  await mkdir(baseline);
  const archive = join(scratch, 'baseline.tar');
  await exec(
    'git',
    ['archive', '--format=tar', `--output=${archive}`, revision],
    { cwd: repo },
  );
  await exec('tar', ['-xf', archive, '-C', baseline]);
  await symlink(
    join(repo, 'node_modules'),
    join(baseline, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await exec('bun', ['run', 'build'], { cwd: baseline });
  const before = (await import(
    pathToFileURL(join(baseline, 'dist/index.js')).href
  )) as typeof import('../dist/index.js');
  const results: {
    count: number;
    candidate: string;
    bytes: number;
    lines: number;
    wallMs: number[];
    checkMs: number[];
  }[] = [];
  for (const count of [600, 1200, 3000]) {
    const input = typecheckScaleFixture(count);
    const cases: { root: string; result: (typeof results)[number] }[] = [];
    for (const [candidate, generate] of [
      ['baseline', before.compile],
      ['working', compile],
    ] as const) {
      const files = await generate(input.document, input.options);
      const root = await generatedWorkspace(files);
      outputs.push(root);
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: scaleCompilerOptions,
          include: ['./*.ts'],
        }),
      );
      const result = {
        count,
        candidate,
        bytes: Object.values(files).reduce(
          (n, v) => n + Buffer.byteLength(v),
          0,
        ),
        lines: Object.values(files).reduce(
          (n, v) => n + v.split('\n').length - 1,
          0,
        ),
        wallMs: [] as number[],
        checkMs: [] as number[],
      };
      results.push(result);
      cases.push({ root, result });
    }
    for (let round = 0; round < 3; round++)
      for (const { root, result } of round % 2 === 0
        ? cases
        : [...cases].reverse()) {
        const start = performance.now();
        const { stdout } = await exec(
          process.execPath,
          [
            compiler,
            '-p',
            join(root, 'tsconfig.json'),
            '--extendedDiagnostics',
          ],
          { cwd: root, maxBuffer: 4 * 1024 * 1024 },
        );
        result.wallMs.push(performance.now() - start);
        const check = stdout.match(/Check time:\s*([\d.]+)s/);
        assert.ok(check?.[1], stdout);
        result.checkMs.push(Number(check[1]) * 1000);
      }
  }
  console.log(
    JSON.stringify(
      {
        revision,
        node: process.version,
        typescript: (
          await exec(process.execPath, [compiler, '--version'])
        ).stdout.trim(),
        bun: (await exec('bun', ['--version'])).stdout.trim(),
        results,
      },
      null,
      2,
    ),
  );
} finally {
  for (const root of outputs) await rm(root, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
