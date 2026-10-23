import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  cp,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'pom-package-'));
const consumer = join(scratch, 'isolated consumer');
const environment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};

async function run(command, args, cwd = consumer) {
  try {
    return await exec(command, args, {
      cwd,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    error.message += `\n${error.stdout ?? ''}${error.stderr ?? ''}`;
    throw error;
  }
}

try {
  console.log(`Verifying packed package on ${process.version}`);
  const packed = JSON.parse(
    (await run('npm', ['pack', '--json', '--pack-destination', scratch], repo))
      .stdout,
  );
  assert.equal(packed.length, 1);
  const tarball = join(scratch, packed[0].filename);
  const paths = packed[0].files.map((file) => file.path);
  assert.ok(paths.includes('dist/cli.js'));
  assert.ok(paths.includes('dist/runtime.ts'));
  for (const path of paths) {
    assert.ok(
      path.startsWith('dist/') ||
        [
          'package.json',
          'README.md',
          'ARCHITECTURE.md',
          'CONTRIBUTING.md',
        ].includes(path),
      `Unexpected packaged file: ${path}`,
    );
    assert.doesNotMatch(path, /(^|\/)(node_modules|\.git|test|examples)(\/|$)/);
  }
  await mkdir(consumer);
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'pom-isolated-verification',
        private: true,
        type: 'module',
        dependencies: { zod: '4.3.6' },
        devDependencies: {
          '@pomegranate/compiler': `file:${tarball}`,
          typescript: '7.0.2',
        },
      },
      null,
      2,
    ),
  );
  await run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund']);
  for (const name of [
    'pom.json',
    'openapi.json',
    'transport.ts',
    'demo.ts',
    'tsconfig.json',
  ]) {
    await cp(join(repo, 'examples/json', name), join(consumer, name));
  }
  await cp(
    join(repo, 'test/consumer-types.ts'),
    join(consumer, 'consumer-types.ts'),
  );
  const binary = join(
    consumer,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pom.cmd' : 'pom',
  );
  await run(binary, ['--help']);
  // The installed executable resolves paths from config even when launched from
  // a working directory outside both the source checkout and the consumer.
  await run(
    binary,
    ['generate', '--config', join(consumer, 'pom.json')],
    scratch,
  );
  await run(binary, ['check', '--config', join(consumer, 'pom.json')], scratch);
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import * as pom from '@pomegranate/compiler';
    import {readFile} from 'node:fs/promises';
    assert.deepEqual(Object.keys(pom).sort(), ['ContractError', 'compile', 'runProject']);
    const document=JSON.parse(await readFile('./openapi.json', 'utf8'));
    const files = await pom.compile(document,{clients:['staff']});
    assert.deepEqual(Object.keys(files).sort(), ['client.staff.operations.ts', 'client.staff.schemas.ts', 'client.staff.ts', 'runtime.ts']);
    assert.doesNotMatch(Object.values(files).join(' '),/PreparationInput|client.consumer/);
    document.paths['/api/staff/reports'].get.security=[{WidgetSession:['editor']}];
    await assert.rejects(pom.compile(document,{clients:['consumer']}),/role requirements are unsupported/);
    assert.equal((await pom.runProject('./pom.json', {check:true})).clean, true);
  `,
  ]);
  const generatedIndex = join(consumer, 'generated/client.consumer.ts');
  const original = await readFile(generatedIndex, 'utf8');
  await writeFile(
    generatedIndex,
    `${original}\n// intentional verification drift\n`,
  );
  const changed = {
    source: await readFile(generatedIndex, 'utf8'),
    mtime: (await stat(generatedIndex)).mtimeMs,
  };
  await assert.rejects(
    run(binary, ['check', '--config', join(consumer, 'pom.json')]),
    (error) => error.code === 1 && /modified owned output/.test(error.stderr),
  );
  assert.deepEqual(
    {
      source: await readFile(generatedIndex, 'utf8'),
      mtime: (await stat(generatedIndex)).mtimeMs,
    },
    changed,
  );
  await writeFile(generatedIndex, original);
  await run(binary, ['check', '--config', join(consumer, 'pom.json')]);
  await writeFile(
    join(consumer, 'pom.staff.json'),
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './staff-only',
      clients: ['staff'],
    }),
  );
  await run(binary, ['generate', '--config', join(consumer, 'pom.staff.json')]);
  await run(binary, ['check', '--config', join(consumer, 'pom.staff.json')]);
  assert.deepEqual((await readdir(join(consumer, 'staff-only'))).sort(), [
    '.pom-manifest.json',
    'client.staff.operations.ts',
    'client.staff.schemas.ts',
    'client.staff.ts',
    'runtime.ts',
  ]);
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'tsconfig.json'),
  ]);
  for (const name of (await readdir(join(consumer, 'generated'))).filter(
    (name) => name.endsWith('.ts'),
  )) {
    const source = await readFile(join(consumer, 'generated', name), 'utf8');
    assert.doesNotMatch(
      source,
      /@pomegranate\/compiler|oxfmt|prettier|node:|\/Users\//,
    );
  }
  // Removing the actual compiler installation proves application execution does
  // not reach back into the compiler, its source checkout, or a sibling project.
  await rm(join(consumer, 'node_modules/@pomegranate/compiler'), {
    recursive: true,
  });
  await rm(join(consumer, 'node_modules/oxfmt'), { recursive: true });
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    await assert.rejects(import('@pomegranate/compiler'), {code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(import('oxfmt'), {code:'ERR_MODULE_NOT_FOUND'});
  `,
  ]);
  const demo = await run(process.execPath, [join(consumer, '.build/demo.js')]);
  assert.match(
    demo.stdout,
    /POST \/api\/widgets\/demo%2Fwidget\/preparations → 202 synthetic-123/,
  );
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import {operations, RequestValidationError} from './.build/generated/client.consumer.js';
    import {operations as staff} from './.build/generated/client.staff.js';
    import {requestSchemas, responseSchemas} from './.build/generated/client.staff.schemas.js';
    assert.deepEqual(Object.keys(operations).sort(),['checkHealth','getWidget','prepareWidget','widgetOptions']);
    assert.deepEqual(Object.keys(staff).sort(),['checkHealth','getStaffReport','getWidget']);
    assert.equal(Object.hasOwn(requestSchemas,'PreparationInput'),false);
    assert.equal(Object.hasOwn(requestSchemas,'StaffReport'),false);
    assert.equal(Object.hasOwn(responseSchemas,'StaffPeriod'),true);
    assert.deepEqual(staff.getStaffReport.build().policy.auth,{label:'partnerStaff',transport:'bearer'});
    assert.deepEqual(operations.checkHealth.build().policy.auth,{label:'public',transport:'none'});
    assert.throws(() => operations.prepareWidget.build({}), RequestValidationError);
    const result = operations.prepareWidget.parseResponse({status:409,headers:{'Content-Type':'application/json','X-Request-ID':'isolated','Retry-After':'7'},body:'{'});
    assert.equal(result.kind,'protocol');
    assert.equal(result.status,409);
    assert.equal(result.validatedHeaders['retry-after'],'7');
    assert.equal(Object.hasOwn(result,'data'),false);
  `,
  ]);
  console.log(
    `Packed install passed: ${paths.length} allowed files; CLI, library, drift, strict types, transport and compiler-free execution`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
