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
import { schemaFixture, standaloneSelection } from '../test/schema-fixture.mjs';
import {
  multipartFixture,
  multipartSelection,
} from '../test/multipart-fixture.mjs';
import { deepFixture, deepTypeConsumer } from '../test/deep-fixture.mjs';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
// Source tests use pinned development releases; installed consumers exercise the
// Zod peer minimum with the TypeScript 5.7 compiler line instead.
const minimumZodVersion = '4.6.6';
const license = await readFile(join(repo, 'LICENSE'), 'utf8');
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

function assertRuntimeLicense(source) {
  // These helpers are copied source, so their notice must travel with generated
  // code even when an application no longer has the compiler package installed.
  const notice = source.match(/\/\*![\s\S]*?\*\//)?.[0];
  assert.ok(notice, 'generated runtime must retain its license notice');
  assert.equal(
    notice
      .replace(/^\/\*!|\*\/$/g, '')
      .replace(/^\s*\* ?/gm, '')
      .replace(/\s+/g, ' ')
      .trim(),
    license.replace(/\s+/g, ' ').trim(),
  );
}

try {
  console.log(`Verifying packed package on ${process.version}`);
  const tarball = join(scratch, 'compiler.tgz');
  // Packing runs the build: stale modules from removed source files must not
  // survive into either the archive or the local distribution directory.
  const staleModule = 'dist/obsolete-build-probe.js';
  await run(process.execPath, [join(repo, 'scripts/clean-dist.mjs')], repo);
  await mkdir(join(repo, 'dist'), { recursive: true });
  await writeFile(join(repo, staleModule), 'throw new Error("stale build");\n');
  await run('bun', ['pm', 'pack', '--filename', tarball], repo);
  await assert.rejects(stat(join(repo, staleModule)), { code: 'ENOENT' });
  const entries = JSON.parse(
    (
      await run(
        'bun',
        [
          '--eval',
          `
      const archive = new Bun.Archive(await Bun.file(process.argv[1]).bytes());
      console.log(JSON.stringify([...(await archive.files()).keys()]));
    `,
          tarball,
        ],
        repo,
      )
    ).stdout,
  );
  const paths = entries.map((path) => {
    assert.ok(path.startsWith('package/'), `Unexpected archive entry: ${path}`);
    return path.slice('package/'.length);
  });
  assert.ok(paths.includes('dist/cli.js'));
  assert.ok(paths.includes('dist/runtime.ts'));
  assert.ok(paths.includes('LICENSE'));
  assert.ok(!paths.includes(staleModule));
  for (const path of paths) {
    assert.ok(
      path.startsWith('dist/') ||
        [
          'package.json',
          'LICENSE',
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
        dependencies: { zod: minimumZodVersion },
        devDependencies: {
          'pomegranate-compiler': `file:${tarball}`,
          typescript: '5.7.3',
          '@types/node': '22.18.0',
        },
      },
      null,
      2,
    ),
  );
  // Consumers need no Bun installation. npm's strict engine and peer checks
  // also catch compatibility promises that Bun alone might let us overlook.
  await run('npm', [
    'install',
    '--ignore-scripts',
    '--engine-strict',
    '--strict-peer-deps',
    '--legacy-peer-deps=false',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
  ]);
  assert.equal(
    JSON.parse(
      await readFile(join(consumer, 'node_modules/zod/package.json'), 'utf8'),
    ).version,
    minimumZodVersion,
  );
  const installed = join(consumer, 'node_modules/pomegranate-compiler');
  assert.equal(await readFile(join(installed, 'LICENSE'), 'utf8'), license);
  assert.equal(
    JSON.parse(await readFile(join(installed, 'package.json'), 'utf8')).license,
    'MIT',
  );
  for (const name of [
    'pom.json',
    'openapi.json',
    'transport.ts',
    'demo.ts',
    'tsconfig.json',
  ]) {
    await cp(join(repo, 'examples/json', name), join(consumer, name));
  }
  const document = JSON.parse(
    await readFile(join(consumer, 'openapi.json'), 'utf8'),
  );
  document.openapi = '3.1.2';
  await writeFile(join(consumer, 'openapi.json'), JSON.stringify(document));
  const tsconfig = JSON.parse(
    await readFile(join(consumer, 'tsconfig.json'), 'utf8'),
  );
  tsconfig.include = [
    '*.ts',
    'generated/*.ts',
    'schema-generated/*.ts',
    'staff-only/*.ts',
    'multipart-generated/*.ts',
    'deep-generated/*.ts',
  ];
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify(tsconfig));
  await cp(
    join(repo, 'test/consumer-types.ts'),
    join(consumer, 'consumer-types.ts'),
  );
  await cp(
    join(repo, 'test/schema-fixture.mjs'),
    join(consumer, 'schema-fixture.mjs'),
  );
  await cp(
    join(repo, 'test/schema-types.ts'),
    join(consumer, 'schema-types.ts'),
  );
  for (const name of ['multipart-types.ts', 'multipart-fixture.mjs'])
    await cp(join(repo, 'test', name), join(consumer, name));
  await cp(
    join(repo, 'test/deep-fixture.mjs'),
    join(consumer, 'deep-fixture.mjs'),
  );
  await writeFile(join(consumer, 'deep-types.ts'), deepTypeConsumer());
  await writeFile(
    join(consumer, 'deep-openapi.json'),
    JSON.stringify(deepFixture()),
  );
  await writeFile(
    join(consumer, 'deep-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './deep-openapi.json',
      output: './deep-generated',
      clients: ['deep'],
    }),
  );
  await writeFile(
    join(consumer, 'multipart-openapi.json'),
    JSON.stringify(multipartFixture()),
  );
  await writeFile(
    join(consumer, 'multipart-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './multipart-openapi.json',
      output: './multipart-generated',
      ...multipartSelection,
    }),
  );
  await writeFile(
    join(consumer, 'schema-openapi.json'),
    JSON.stringify(schemaFixture()),
  );
  await writeFile(
    join(consumer, 'schema-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './schema-openapi.json',
      output: './schema-generated',
      clients: ['samples'],
      transportHeaders: ['X-Origin'],
      standalone: {
        ...standaloneSelection,
        empty: { schema: '#/components/schemas/Empty', usage: 'request' },
      },
    }),
  );
  const binary = join(
    consumer,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'pom.cmd' : 'pom',
  );
  await run(binary, ['--help']);
  await run(binary, ['generate', '--config', join(consumer, 'deep-pom.json')]);
  await run(binary, ['check', '--config', join(consumer, 'deep-pom.json')]);
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'multipart-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'multipart-pom.json'),
  ]);
  await writeFile(
    join(consumer, 'native-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './multipart-openapi.json',
      output: './native-only',
      clients: ['native'],
      targets: { native: 'native' },
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'native-pom.json'),
  ]);
  await run(binary, ['check', '--config', join(consumer, 'native-pom.json')]);
  assert.equal(
    (await readdir(join(consumer, 'native-only'))).includes(
      'runtime.browser.ts',
    ),
    false,
  );
  await writeFile(
    join(consumer, 'native-tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...tsconfig.compilerOptions,
        lib: ['ES2022'],
        types: ['node'],
        noEmit: true,
      },
      include: ['native-only/*.ts'],
    }),
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'native-tsconfig.json'),
  ]);
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'schema-pom.json'),
  ]);
  await run(binary, ['check', '--config', join(consumer, 'schema-pom.json')]);
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
    import * as pom from 'pomegranate-compiler';
    import {readFile} from 'node:fs/promises';
    assert.deepEqual(Object.keys(pom).sort(), ['ContractError', 'compile', 'runProject']);
    const document=JSON.parse(await readFile('./openapi.json', 'utf8'));
    const files = await pom.compile(document,{clients:['staff']});
    for (const version of ['3.1.0','3.1.1','3.1.2']) {
      document.openapi=version;
      assert.deepEqual(await pom.compile(document,{clients:['staff']}),files);
    }
    assert.deepEqual(Object.keys(files).sort(), ['client.staff.operations.ts', 'client.staff.schemas.ts', 'client.staff.ts', 'runtime.ts']);
    assert.doesNotMatch(Object.values(files).join(' '),/PreparationInput|client.consumer/);
    const unsafeHeader = structuredClone(document);
    unsafeHeader.paths['/api/staff/reports'].get.parameters = [{name:'__PROTO__',in:'header',required:true,schema:{type:'string',const:'must-match'}}];
    for (const transportHeaders of [[], ['__PROTO__']])
      await assert.rejects(pom.compile(unsafeHeader,{clients:['staff'],transportHeaders}),/unsupported object key/);
    const invalidSecurity = structuredClone(document);
    invalidSecurity.paths['/api/staff/reports'].get.security=[{WidgetSession:['editor']}];
    await assert.rejects(pom.compile(invalidSecurity,{clients:['consumer']}),/role requirements are unsupported/);
    assert.equal((await pom.runProject('./pom.json', {check:true})).clean, true);
    await assert.rejects(pom.runProject('./pom.json', {chek:true}), /project options.chek/);
    let nested = {type:'string'};
    for (let depth=0; depth<900; depth++) nested={type:'array',items:nested};
    const excessive = structuredClone(document);
    excessive.components.schemas.ExcessiveNesting = nested;
    await assert.rejects(pom.compile(excessive,{clients:['staff']}), /supported limit/);
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
  for (const path of [
    'generated/runtime.ts',
    'multipart-generated/runtime.ts',
    'multipart-generated/runtime.browser.ts',
  ])
    assertRuntimeLicense(await readFile(join(consumer, path), 'utf8'));
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
      /pomegranate-compiler|oxfmt|prettier|node:|\/Users\//,
    );
  }
  // Removing the actual compiler installation proves application execution does
  // not reach back into the compiler, its source checkout, or a sibling project.
  await rm(join(consumer, 'node_modules/pomegranate-compiler'), {
    recursive: true,
  });
  await rm(join(consumer, 'node_modules/oxfmt'), { recursive: true });
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    await assert.rejects(import('pomegranate-compiler'), {code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(import('oxfmt'), {code:'ERR_MODULE_NOT_FOUND'});
  `,
  ]);
  // Both runtimes execute the same sources; Node strips only erasable syntax.
  const sourceChecks = `
    import assert from 'node:assert/strict';
    import {operations} from './generated/client.consumer.ts';
    import {operations as schemaOperations, RequestValidationError as SchemaError} from './schema-generated/client.samples.ts';
    import {schema as message} from './schema-generated/standalone.message.ts';
    import {schema as input} from './schema-generated/standalone.input.ts';
    import {schema as empty} from './schema-generated/standalone.empty.ts';
    import {verifySchemas, verifyStandalone} from './schema-fixture.mjs';
    import {operations as browser} from './multipart-generated/client.browser.ts';
    import {operations as native, RequestValidationError} from './multipart-generated/client.native.ts';
    import {verifyMultipart} from './multipart-fixture.mjs';
    import {operations as deep, RequestValidationError as DeepError} from './deep-generated/client.deep.ts';
    import {verifyDeep} from './deep-fixture.mjs';
    assert.equal(operations.checkHealth.build().method, 'HEAD');
    verifySchemas(schemaOperations, SchemaError);
    verifyStandalone(message, input);
    assert.deepEqual(empty.parse({}), {});
    assert.equal(empty.safeParse(42).success, false);
    await verifyMultipart(browser, native, RequestValidationError);
    verifyDeep(deep, DeepError);
  `;
  await run(process.execPath, ['--input-type=module', '-e', sourceChecks]);
  await run('bun', ['-e', sourceChecks]);
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
    import {operations as schemaOperations, RequestValidationError as SchemaError} from './.build/schema-generated/client.samples.js';
    import {verifySchemas,verifyStandalone} from './schema-fixture.mjs';
    import {schema as message} from './.build/schema-generated/standalone.message.js';
    import {schema as input} from './.build/schema-generated/standalone.input.js';
    verifySchemas(schemaOperations, SchemaError);
    verifyStandalone(message,input);
    import {operations as browserUploads} from './.build/multipart-generated/client.browser.js';
    import {operations as nativeUploads, RequestValidationError as UploadError} from './.build/multipart-generated/client.native.js';
    import {verifyMultipart} from './multipart-fixture.mjs';
    await verifyMultipart(browserUploads,nativeUploads,UploadError);
    import {execute as executeJson} from './.build/transport.js';
    const unsupported = async () => { throw new Error('Transport must not be called'); };
    await assert.rejects(executeJson(nativeUploads.uploadInline.build({body:{file:{uri:'file:///local'}}}),unsupported,unsupported), /does not support multipart/);
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
    const headers={'Content-Type':'application/json','X-Request-ID':'isolated'};
    const body='{"state":"pending","reference":"isolated"}';
    assert.equal(operations.prepareWidget.parseResponse({status:202,headers,body}).kind,'success');
    for(const invalid of [
      {...headers,'Content-Type':'application/json; charset=utf-8, text/plain'},
      {...headers,'Bad Header':'observed'},
    ]) {
      const rejected=operations.prepareWidget.parseResponse({status:202,headers:invalid,body});
      assert.equal(rejected.kind,'protocol');
      assert.equal(rejected.status,202);
      assert.equal(rejected.validatedHeaders['x-request-id'],'isolated');
      assert.equal(Object.hasOwn(rejected,'data'),false);
    }
  `,
  ]);
  console.log(
    `Packed install passed: ${paths.length} allowed files; Zod ${minimumZodVersion}; npm engine-strict install, CLI, library, drift, strict types, transport and compiler-free Node/Bun source and emitted JavaScript execution`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
