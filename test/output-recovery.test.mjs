import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { synchronizeOutputs } from '../dist/outputs.js';
import { fileSnapshot, temporary } from './helpers.mjs';

const before = { 'a.ts': 'old a', 'stale.ts': 'old stale' };
const after = { 'a.ts': 'new a', 'b.ts': 'new b' };
const journal = '.pom-journal.json';

function inject(t, method, implementation) {
  t.mock.method(fs, method, implementation);
  syncBuiltinESMExports();
  return () => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  };
}

async function interrupt(t, root, target, when = 'before', files = after) {
  const method = target === 'stale.ts' ? 'rm' : 'rename';
  const original = fs[method];
  let triggered = false;
  const restore = inject(t, method, async (...args) => {
    const destination = method === 'rename' ? args[1] : args[0];
    if (!triggered && destination === join(root, target)) {
      triggered = true;
      if (when === 'after') await original(...args);
      throw new Error('injected publication interruption');
    }
    return original(...args);
  });
  try {
    await assert.rejects(
      synchronizeOutputs(root, files, [], false),
      /injected publication interruption/,
    );
  } finally {
    restore();
  }
  assert.equal(triggered, true);
}

for (const target of [
  journal,
  'a.ts',
  'b.ts',
  'stale.ts',
  '.pom-manifest.json',
]) {
  for (const when of ['before', 'after']) {
    test(`generation recovers ${when} publishing ${target}`, async (t) => {
      const root = await temporary(t);
      await synchronizeOutputs(root, before, [], false);
      await fs.writeFile(join(root, 'notes.txt'), 'application-owned');
      await interrupt(t, root, target, when);
      const interrupted = await fileSnapshot(root);
      const checking = await synchronizeOutputs(root, after, [], true);
      assert.equal(checking.clean, false);
      assert.deepEqual(await fileSnapshot(root), interrupted);
      await synchronizeOutputs(root, after, [], false);
      assert.equal(
        (await synchronizeOutputs(root, after, [], true)).clean,
        true,
      );
      assert.equal(await fs.readFile(join(root, 'a.ts'), 'utf8'), 'new a');
      assert.equal(await fs.readFile(join(root, 'b.ts'), 'utf8'), 'new b');
      assert.equal(
        await fs.readFile(join(root, 'notes.txt'), 'utf8'),
        'application-owned',
      );
      assert.deepEqual((await fs.readdir(root)).sort(), [
        '.pom-manifest.json',
        'a.ts',
        'b.ts',
        'notes.txt',
      ]);
    });
  }
}

test('failure removing the published journal is recoverable without rewriting completed targets', async (t) => {
  const root = await temporary(t);
  const remove = fs.rm;
  const restore = inject(t, 'rm', async (path, ...args) => {
    if (path === join(root, journal)) throw new Error('journal cleanup failed');
    return remove(path, ...args);
  });
  try {
    await assert.rejects(
      synchronizeOutputs(root, after, [], false),
      /journal cleanup failed/,
    );
  } finally {
    restore();
  }
  const finished = await fileSnapshot(root);
  await synchronizeOutputs(root, after, [], false);
  const recovered = await fileSnapshot(root);
  for (const name of ['a.ts', 'b.ts', '.pom-manifest.json'])
    assert.deepEqual(recovered[name], finished[name]);
  assert.equal(recovered[journal], undefined);
});

test('first generation and missing owned files retain recovery evidence', async (t) => {
  for (const initial of [false, true]) {
    const root = await temporary(t);
    if (initial) {
      await synchronizeOutputs(root, before, [], false);
      await fs.rm(join(root, 'a.ts'));
    }
    await interrupt(t, root, 'a.ts');
    await synchronizeOutputs(root, after, [], false);
    assert.equal((await synchronizeOutputs(root, after, [], true)).clean, true);
  }
});

test('recovery can finish the interrupted set before applying changed inputs', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(root, before, [], false);
  await interrupt(t, root, 'b.ts');
  const next = { 'a.ts': 'third a', 'c.ts': 'third c' };
  await synchronizeOutputs(root, next, [], false);
  assert.equal((await synchronizeOutputs(root, next, [], true)).clean, true);
  assert.deepEqual((await fs.readdir(root)).sort(), [
    '.pom-manifest.json',
    'a.ts',
    'c.ts',
  ]);
});

test('an edited interrupted target blocks every recovery write', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(root, before, [], false);
  await interrupt(t, root, 'b.ts');
  await fs.writeFile(join(root, 'a.ts'), 'user edit');
  const snapshot = await fileSnapshot(root);
  await assert.rejects(
    synchronizeOutputs(root, after, [], false),
    /recovery conflict/,
  );
  assert.deepEqual(await fileSnapshot(root), snapshot);
});

test('new unowned targets and protected inputs are checked before recovery writes', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(root, before, [], false);
  await interrupt(t, root, 'stale.ts');
  await fs.writeFile(join(root, 'unowned.ts'), 'application-owned');
  const snapshot = await fileSnapshot(root);
  await assert.rejects(
    synchronizeOutputs(
      root,
      { ...after, 'unowned.ts': 'generated' },
      [],
      false,
    ),
    /unowned output/,
  );
  for (const name of ['a.ts', journal])
    await assert.rejects(
      synchronizeOutputs(root, after, [join(root, name)], false),
      /protected input/,
    );
  assert.deepEqual(await fileSnapshot(root), snapshot);
});

for (const mutate of [
  () => '{',
  (source) => {
    const value = JSON.parse(source);
    value.files['../escape.ts'] = 'unsafe';
    return JSON.stringify(value);
  },
  (source) => {
    const value = JSON.parse(source);
    value.before['b.ts'] = '0'.repeat(64);
    return JSON.stringify(value);
  },
  (source) => {
    const value = JSON.parse(source);
    value.files['A.ts'] = 'alias';
    return JSON.stringify(value);
  },
  (source) => {
    const value = JSON.parse(source);
    value.files['b.ts'] = 'edited recovery source';
    return JSON.stringify(value);
  },
]) {
  test('invalid recovery metadata preserves the complete output set', async (t) => {
    const root = await temporary(t);
    await synchronizeOutputs(root, before, [], false);
    await interrupt(t, root, 'b.ts');
    const path = join(root, journal);
    await fs.writeFile(path, mutate(await fs.readFile(path, 'utf8')));
    const snapshot = await fileSnapshot(root);
    for (const check of [true, false])
      await assert.rejects(synchronizeOutputs(root, after, [], check));
    assert.deepEqual(await fileSnapshot(root), snapshot);
  });
}

test('a replacement lock is preserved and the old writer stops before publication', async (t) => {
  const root = await temporary(t);
  await synchronizeOutputs(root, before, [], false);
  const snapshot = await fileSnapshot(root);
  const write = fs.writeFile;
  const restore = inject(t, 'writeFile', async (path, ...args) => {
    await write(path, ...args);
    if (path.includes('.pom-stage-') && path.endsWith('.pom-manifest.json')) {
      await fs.rm(join(root, '.pom-lock'), { recursive: true });
      await fs.mkdir(join(root, '.pom-lock'));
      await write(join(root, '.pom-lock', 'owner'), 'replacement writer');
    }
  });
  try {
    await assert.rejects(
      synchronizeOutputs(root, after, [], false),
      /lock ownership changed/,
    );
  } finally {
    restore();
  }
  assert.deepEqual(await fileSnapshot(root), snapshot);
  assert.equal(
    await fs.readFile(join(root, '.pom-lock', 'owner'), 'utf8'),
    'replacement writer',
  );
});

test(
  'a killed writer can recover after its stopped lock is removed',
  { timeout: 15000 },
  async (t) => {
    const root = await temporary(t);
    await synchronizeOutputs(root, before, [], false);
    const compiler = new URL('../dist/outputs.js', import.meta.url).href;
    const script = `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (...args) => {
      await rename(...args);
      if (args[1] === ${JSON.stringify(join(root, 'a.ts'))}) {
        process.stdout.write('published-first\\n');
        setInterval(() => {}, 1000);
        await new Promise(() => {});
      }
    };
    syncBuiltinESMExports();
    const { synchronizeOutputs } = await import(${JSON.stringify(compiler)});
    await synchronizeOutputs(${JSON.stringify(root)}, ${JSON.stringify(after)}, [], false);
  `;
    const child = spawn(
      process.execPath,
      ['--input-type=module', '-e', script],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    t.after(() => child.kill('SIGKILL'));
    await Promise.race([
      once(child.stdout, 'data'),
      once(child, 'exit').then(([code]) => {
        throw new Error(`writer exited early: ${code}`);
      }),
    ]);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    await assert.rejects(
      synchronizeOutputs(root, after, [], false),
      /output is locked/,
    );
    // The test has observed process exit, so removing this stopped writer's lock
    // is safe. Production never guesses ownership from elapsed time or a PID.
    await fs.rm(join(root, '.pom-lock'), { recursive: true });
    await synchronizeOutputs(root, after, [], false);
    assert.equal((await synchronizeOutputs(root, after, [], true)).clean, true);
    assert.deepEqual((await fs.readdir(root)).sort(), [
      '.pom-manifest.json',
      'a.ts',
      'b.ts',
    ]);
  },
);
