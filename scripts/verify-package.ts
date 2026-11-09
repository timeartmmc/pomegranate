import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cp,
  readdir,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { minimumTypeScript } from '../bench/typecheck.ts';
import {
  commandError,
  commandFailure,
  json,
  record,
} from '../test/assertions.ts';
import { deepFixture, deepTypeConsumer } from '../test/deep-fixture.ts';
import {
  typeIdentityConsumer,
  typeIdentityFixture,
  typeIdentitySelection,
} from '../test/type-identity-fixture.ts';
import {
  directionalTypeIdentityConsumer,
  directionalTypeIdentityFixture,
  directionalTypeIdentitySelection,
} from '../test/directional-type-identity-fixture.ts';
import {
  typeCompositionFixture,
  typeCompositionSelection,
  verifyTypeComposition,
} from '../test/type-composition-fixture.ts';
import { annotateDocument } from '../test/metadata-fixture.ts';
import {
  multipartFixture,
  multipartSelection,
} from '../test/multipart-fixture.ts';
import { schemaFixture, standaloneSelection } from '../test/schema-fixture.ts';
import {
  directionalFixture,
  directionalSelection,
  directionalTypeConsumer,
} from '../test/directional-fixture.ts';
import { symbolFixture } from '../test/symbol-fixture.ts';
import {
  extensionFixture,
  extensionSelection,
  extensionKeywordTargets,
} from '../test/extension-fixture.ts';
import {
  parameterReferenceFixture,
  parameterReferenceSelection,
  parameterReferenceConsumer,
} from '../test/parameter-reference-fixture.ts';
import {
  responseReferenceFixture,
  responseReferenceSelection,
  responseReferenceConsumer,
} from '../test/response-reference-fixture.ts';
import {
  bodyHeaderReferenceFixture,
  bodyHeaderReferenceSelection,
  bodyHeaderReferenceConsumer,
} from '../test/body-header-reference-fixture.ts';
import {
  ipCommentFixture,
  ipCommentSelection,
  ipCommentConsumer,
} from '../test/ip-comment-fixture.ts';
import {
  propertyCountFixture,
  propertyCountSelection,
  propertyCountConsumer,
} from '../test/property-count-fixture.ts';
import {
  queryCsvFixture,
  queryCsvSelection,
  queryCsvConsumer,
} from '../test/query-csv-fixture.ts';
import {
  openapi30Fixture,
  openapi30Selection,
  openapi30Consumer,
} from '../test/openapi30-fixture.ts';
import {
  toleranceFixture,
  toleranceSelection,
  toleranceConsumer,
} from '../test/tolerance-fixture.ts';
import {
  anyJsonFixture,
  anyJsonSelection,
  anyJsonConsumer,
} from '../test/any-json-fixture.ts';
import {
  mediaFixture,
  mediaSelection,
  mediaConsumer,
} from '../test/media-fixture.ts';
import {
  registeredFormatsFixture,
  registeredFormatsSelection,
  registeredFormatsConsumer,
} from '../test/registered-formats-fixture.ts';
import {
  numericFormatProfilesFixture,
  numericFormatProfilesSelection,
  numericFormatProfilesConsumer,
} from '../test/numeric-format-profiles-fixture.ts';
import {
  operationIdsFixture,
  operationIdsSelection,
  operationIdsTypeConsumer,
} from '../test/operation-ids-fixture.ts';
import {
  infiniteFixture,
  infiniteSelection,
} from '../test/infinite-fixture.ts';
import { offsetFixture, offsetSelection } from '../test/offset-fixture.ts';
import { verifyQueryDeclarations } from '../test/query-declarations.ts';
import {
  executionFixture,
  executionSelection,
} from '../test/execution-fixture.ts';
import { verifyExecutionDeclarations } from '../test/execution-declarations.ts';
import { verifyQueryPlatform } from '../test/query-platform-check.ts';
import {
  consumerModesFixture,
  verifyConsumerModes,
} from '../test/consumer-modes.ts';
import {
  aliasDeclarationFixture,
  verifyAliasDeclarations,
} from '../test/alias-declarations.ts';

import {
  verifyWideDeclarations,
  wideDeclarationFixture,
} from '../test/wide-declarations.ts';

const exec = promisify(execFile);
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const suppliedTarball = process.argv[2] ? resolve(process.argv[2]) : undefined;
// Source tests use pinned development releases; installed consumers exercise
// the TypeScript 5.7 compiler line and Query Core minimum instead.
const minimumQueryVersion = '5.104.5';
const license = await readFile(join(repo, 'LICENSE'), 'utf8');
const scratch = await mkdtemp(join(await realpath(tmpdir()), 'pom-package-'));
const consumer = join(scratch, 'isolated consumer');
const environment = {
  ...process.env,
  PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
};

async function run(command: string, args: string[], cwd = consumer) {
  try {
    return await exec(command, args, {
      cwd,
      env: environment,
      maxBuffer: 4 * 1024 * 1024,
    });
  } catch (error) {
    const failure = commandError(error);
    failure.message += `\n${failure.stdout}${failure.stderr}`;
    throw failure;
  }
}

function assertRuntimeLicense(source: string) {
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
  const tarball = suppliedTarball ?? join(scratch, 'compiler.tgz');
  // Packing runs the build: stale modules from removed source files must not
  // survive into either the archive or the local distribution directory.
  const staleModule = 'dist/obsolete-build-probe.js';
  if (!suppliedTarball) {
    await run(process.execPath, [join(repo, 'scripts/clean-dist.ts')], repo);
    await mkdir(join(repo, 'dist'), { recursive: true });
    await writeFile(
      join(repo, staleModule),
      'throw new Error("stale build");\n',
    );
    await run('bun', ['pm', 'pack', '--filename', tarball], repo);
    await assert.rejects(stat(join(repo, staleModule)), { code: 'ENOENT' });
  }
  const entries = json(
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
  assert.ok(
    Array.isArray(entries) &&
      entries.every((entry): entry is string => typeof entry === 'string'),
  );
  const paths = entries.map((path) => {
    assert.ok(path.startsWith('package/'), `Unexpected archive entry: ${path}`);
    return path.slice('package/'.length);
  });
  assert.ok(paths.includes('dist/cli.js'));
  for (const name of [
    'runtime',
    'endpoint-runtime',
    'policy-types',
    'runtime.browser',
    'execution-runtime',
    'call-runtime',
    'query-runtime',
    'query-sharing',
  ]) {
    assert.ok(paths.includes(`dist/templates/${name}.ts`));
    assert.ok(paths.includes(`dist/${name}.d.ts`));
    assert.ok(paths.includes(`dist/${name}.js`));
    assert.ok(!paths.includes(`dist/${name}.ts`));
  }
  assert.ok(paths.includes('LICENSE'));
  assert.ok(paths.includes('REFERENCE.md'));
  assert.ok(!paths.includes(staleModule));
  for (const path of paths) {
    assert.ok(
      path.startsWith('dist/') ||
        [
          'package.json',
          'LICENSE',
          'README.md',
          'REFERENCE.md',
          'QUERIES.md',
          'EXECUTION.md',
          'ARCHITECTURE.md',
          'CONTRIBUTING.md',
        ].includes(path),
      `Unexpected packaged file: ${path}`,
    );
    assert.doesNotMatch(path, /(^|\/)(node_modules|\.git|test|examples)(\/|$)/);
  }
  await mkdir(consumer);
  await mkdir(join(consumer, 'verification'));
  for (const name of [
    'assertions.ts',
    'schema-helpers.ts',
    'schema-fixture.ts',
    'directional-fixture.ts',
    'extension-fixture.ts',
    'parameter-reference-fixture.ts',
    'response-reference-fixture.ts',
    'body-header-reference-fixture.ts',
    'ip-comment-fixture.ts',
    'property-count-fixture.ts',
    'query-csv-fixture.ts',
    'openapi30-fixture.ts',
    'tolerance-fixture.ts',
    'any-json-fixture.ts',
    'media-fixture.ts',
    'registered-formats-fixture.ts',
    'numeric-format-profiles-fixture.ts',
    'type-composition-fixture.ts',
    'nullable-type-fixture.ts',
    'multipart-fixture.ts',
    'symbol-fixture.ts',
    'operation-ids-fixture.ts',
    'operation-ids-checks.ts',
    'deep-fixture.ts',
    'calendar-fixture.ts',
    'query-checks.ts',
    'query-hydration.ts',
    'query-error-checks.ts',
    'query-sharing-checks.ts',
    'infinite-checks.ts',
    'infinite-lifecycle-checks.ts',
    'offset-checks.ts',
    'execution-checks.ts',
    'execution-integration-checks.ts',
  ])
    await cp(join(repo, 'test', name), join(consumer, 'verification', name));
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'pom-isolated-verification',
        private: true,
        type: 'module',
        dependencies: {},
        devDependencies: {
          'pomegranate-compiler': `file:${tarball}`,
          typescript: minimumTypeScript,
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
  // Generated validators are local functions: no schema library is installed.
  await assert.rejects(stat(join(consumer, 'node_modules/zod')), {
    code: 'ENOENT',
  });
  await assert.rejects(
    stat(join(consumer, 'node_modules/@tanstack/query-core')),
    { code: 'ENOENT' },
  );
  const installed = join(consumer, 'node_modules/pomegranate-compiler');
  // The same complete archive exercises all roles through preparation and timing.
  // A copied harness outside the checkout must work without its node_modules or
  // private experiment setup. This checks behavior, never a speed threshold.
  const benchmarkArtifact = {
    path: tarball,
    sha256: createHash('sha256')
      .update(await readFile(tarball))
      .digest('hex'),
  };
  const benchmarkPlan = join(scratch, 'benchmark-plan.json');
  await writeFile(
    benchmarkPlan,
    JSON.stringify({
      version: 1,
      baseline: benchmarkArtifact,
      candidate: benchmarkArtifact,
      releaseAnchor: benchmarkArtifact,
    }),
  );
  const benchmarkHarness = join(scratch, 'benchmark-harness');
  await mkdir(benchmarkHarness);
  await cp(join(repo, 'bench'), join(benchmarkHarness, 'bench'), {
    recursive: true,
  });
  const benchmarkPackage = record(
    json(await readFile(join(repo, 'package.json'), 'utf8')),
  );
  await writeFile(
    join(benchmarkHarness, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      devDependencies: {
        typescript: record(benchmarkPackage.devDependencies).typescript,
      },
    }),
  );
  const typecheckSettings = join(scratch, 'typecheck-settings.json');
  await writeFile(
    typecheckSettings,
    JSON.stringify({ rounds: 1, profiles: ['smoke'] }),
  );
  const typecheckReport = record(
    json(
      (
        await run(
          process.execPath,
          [
            join(benchmarkHarness, 'bench/check-typecheck.ts'),
            benchmarkPlan,
            join(scratch, 'typecheck-benchmark'),
            typecheckSettings,
          ],
          scratch,
        )
      ).stdout,
    ),
  );
  assert.equal(typecheckReport.status, 'complete');
  assert.equal(record(typecheckReport.case).id, 'core-typecheck');
  assert.ok(Array.isArray(typecheckReport.observations));
  assert.equal(typecheckReport.observations.length, 6);
  const outputGrowth = record(
    json(
      (
        await run(
          process.execPath,
          [
            join(benchmarkHarness, 'bench/check-output.ts'),
            join(installed, 'dist/index.js'),
            join(consumer, 'node_modules/typescript/bin/tsc'),
          ],
          scratch,
        )
      ).stdout,
    ),
  );
  assert.equal(outputGrowth.sourceBudgets, 'passed');
  assert.equal(outputGrowth.generatedTypes, 'verified');
  assert.equal(outputGrowth.behavior, 'verified');
  assert.deepEqual(record(outputGrowth.case), {
    id: 'shared-contract-output',
    version: 1,
  });
  assert.ok(Array.isArray(outputGrowth.cells));
  assert.equal(outputGrowth.cells.length, 4);
  console.log(
    'Generated-source output budgets passed: four qualified contracts, isolated installed compiler and TypeScript consumer',
  );
  const benchmarkSettings = join(scratch, 'benchmark-settings.json');
  const benchmarkProfiles = [
    { scenario: 'parsed-valid', records: 0 },
    { scenario: 'json-valid', records: 16 },
    { scenario: 'parsed-valid', records: 128 },
    { scenario: 'parsed-invalid-many', records: 128 },
  ];
  await writeFile(
    benchmarkSettings,
    JSON.stringify({
      rounds: 1,
      profiles: benchmarkProfiles,
      policy: { warmupMs: 0, sampleMs: 1, samples: 1, batchSize: 16 },
    }),
  );
  const benchmarkComparison = record(
    json(
      (
        await run(
          process.execPath,
          [
            join(benchmarkHarness, 'bench/compare.ts'),
            benchmarkPlan,
            join(scratch, 'benchmark-comparison'),
            benchmarkSettings,
          ],
          scratch,
        )
      ).stdout,
    ),
  );
  assert.equal(benchmarkComparison.status, 'complete');
  const benchmarkTiming = record(benchmarkComparison.timing);
  assert.ok(Array.isArray(benchmarkTiming.observations));
  assert.equal(
    benchmarkTiming.observations.length,
    benchmarkProfiles.length * 3,
  );
  assert.deepEqual(benchmarkTiming.profiles, benchmarkProfiles);
  const benchmarkPreparation = record(benchmarkComparison.preparation);
  assert.equal(benchmarkPreparation.behavior, 'verified');
  assert.equal(benchmarkPreparation.performance, 'unmeasured');
  const benchmarkArtifacts = benchmarkPreparation.artifacts;
  assert.ok(
    Array.isArray(benchmarkArtifacts) && benchmarkArtifacts.length === 3,
  );
  assert.equal(
    new Set(
      benchmarkArtifacts.map((value) => record(value).installedTreeSha256),
    ).size,
    1,
  );
  assert.equal(
    new Set(
      benchmarkArtifacts.map((value) => record(record(value).archive).sha256),
    ).size,
    1,
  );
  assert.equal(
    new Set(benchmarkArtifacts.map((value) => record(value).lockSha256)).size,
    1,
  );
  assert.equal(
    new Set(
      benchmarkArtifacts.map((value) => record(record(value).generated).sha256),
    ).size,
    1,
  );
  console.log(
    'Benchmark comparison passed: isolated harness, three installed artifacts and selected collection/error profiles; performance acceptance unqualified',
  );
  assert.equal(await readFile(join(installed, 'LICENSE'), 'utf8'), license);
  assert.equal(
    record(json(await readFile(join(installed, 'package.json'), 'utf8')))
      .license,
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
  const document = record(
    json(await readFile(join(consumer, 'openapi.json'), 'utf8')),
  );
  document.openapi = '3.1.2';
  await writeFile(
    join(consumer, 'openapi-baseline.json'),
    JSON.stringify(document),
  );
  annotateDocument(document);
  await writeFile(join(consumer, 'openapi.json'), JSON.stringify(document));
  const yamlSource = `# Synthetic installed-consumer contract\n${stringify(document)}`;
  await writeFile(join(consumer, 'openapi.yaml'), yamlSource);
  const yamlConfig = record(
    json(await readFile(join(consumer, 'pom.json'), 'utf8')),
  );
  yamlConfig.openapi = './openapi.yaml';
  await writeFile(join(consumer, 'pom.yaml.json'), JSON.stringify(yamlConfig));
  const aliasDocument = structuredClone(document);
  aliasDocument.security = [];
  const sharedPolicy = {
    auth: 'public',
    retry: 'never',
    timeout: 'interactive',
    surfaces: ['consumer'],
  };
  aliasDocument.paths = Object.fromEntries(
    Array.from({ length: 1001 }, (_, index) => [
      `/alias${index}`,
      {
        get: {
          operationId: `alias${index}`,
          'x-pom': sharedPolicy,
          responses: { 200: { description: 'Synthetic alias reuse' } },
        },
      },
    ]),
  );
  await writeFile(
    join(consumer, 'alias-openapi.yaml'),
    stringify(aliasDocument),
  );
  await writeFile(
    join(consumer, 'alias-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './alias-openapi.yaml',
      output: './alias-generated',
      clients: ['consumer'],
    }),
  );
  const tsconfig = record(
    json(await readFile(join(consumer, 'tsconfig.json'), 'utf8')),
  );
  tsconfig.include = [
    '*.ts',
    'generated/*.ts',
    'schema-generated/*.ts',
    'staff-only/*.ts',
    'multipart-generated/*.ts',
    'deep-generated/*.ts',
    'type-identity-generated/*.ts',
    'type-identity-types.ts',
    'directional-type-identity-generated/*.ts',
    'directional-type-identity-types.ts',
    'symbol-generated/*.ts',
    'operation-ids-generated/*.ts',
    'query-generated/*.ts',
    'offset-generated/*.ts',
    'execution-generated/*.ts',
    'compatibility-generated/*.ts',
    'directional-generated/*.ts',
    'parameter-generated/*.ts',
    'response-generated/*.ts',
    'body-header-generated/*.ts',
    'ip-comment-generated/*.ts',
    'property-count-generated/*.ts',
    'query-csv-generated/*.ts',
    'openapi30-generated/*.ts',
    'tolerance-generated/*.ts',
    'any-json-generated/*.ts',
    'media-generated/*.ts',
    'registered-formats-generated/*.ts',
    'numeric-format-profiles-generated/*.ts',
    'extension-generated/*.ts',
  ];
  await writeFile(join(consumer, 'tsconfig.json'), JSON.stringify(tsconfig));
  await writeFile(
    join(consumer, 'directional-types.ts'),
    directionalTypeConsumer(),
  );
  await writeFile(
    join(consumer, 'directional-openapi.json'),
    JSON.stringify(directionalFixture()),
  );
  await writeFile(
    join(consumer, 'directional-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './directional-openapi.json',
      output: './directional-generated',
      ...directionalSelection,
    }),
  );
  await writeFile(
    join(consumer, 'compatibility-consumer.ts'),
    `
    import {operations, RequestValidationError} from './compatibility-generated/client.consumer.ts';
    import {schema} from './compatibility-generated/standalone.int32.ts';
    function equal(actual: unknown, expected: unknown): void {
      if (actual !== expected) throw new Error('Unexpected int32 result');
    }
    function invalidRequest(action: () => unknown): void {
      try { action(); } catch (error) {
        if (error instanceof RequestValidationError) return;
        throw error;
      }
      throw new Error('Expected int32 request rejection');
    }
    export function verifyCompatibility(): void {
      for (const value of [-2147483648, 0, 2147483647]) {
        const parsed: number = schema.parse(value);
        equal(parsed, value);
        const request = operations.roundTrip.build({body: value});
        const body: number = request.body;
        equal(body, value);
        const result = request.parseResponse({status: 200, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
        equal(result.kind, 'success');
        if (result.kind === 'success') {
          const response: number = result.data;
          equal(response, value);
        }
      }
      for (const value of [-2147483649, 2147483648, 0.5, '1']) {
        equal(schema.safeParse(value).success, false);
        invalidRequest(() => Reflect.apply(operations.roundTrip.build, undefined, [{body: value}]));
        const result = operations.roundTrip.parseResponse({status: 200, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)});
        equal(result.kind, 'protocol');
      }
    }
    `,
  );
  for (const name of [
    'consumer-types.ts',
    'schema-types.ts',
    'multipart-types.ts',
    'symbol-types.ts',
    'query-types.ts',
    'infinite-types.ts',
    'offset-types.ts',
    'execution-types.ts',
  ])
    await cp(join(repo, 'test', name), join(consumer, name));
  await writeFile(
    join(consumer, 'symbol-openapi.json'),
    JSON.stringify(symbolFixture()),
  );
  await writeFile(
    join(consumer, 'operation-ids-openapi.json'),
    JSON.stringify(operationIdsFixture()),
  );
  await writeFile(
    join(consumer, 'operation-ids-types.ts'),
    operationIdsTypeConsumer(),
  );
  await writeFile(
    join(consumer, 'operation-ids-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './operation-ids-openapi.json',
      output: './operation-ids-generated',
      ...operationIdsSelection,
    }),
  );
  await writeFile(
    join(consumer, 'symbol-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './symbol-openapi.json',
      output: './symbol-generated',
      clients: ['symbols'],
    }),
  );
  await writeFile(
    join(consumer, 'directional-type-identity-types.ts'),
    directionalTypeIdentityConsumer().replaceAll(
      './generated/',
      './directional-type-identity-generated/',
    ),
  );
  await writeFile(
    join(consumer, 'directional-type-identity-openapi.json'),
    JSON.stringify(directionalTypeIdentityFixture()),
  );
  await writeFile(
    join(consumer, 'directional-type-identity-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './directional-type-identity-openapi.json',
      output: './directional-type-identity-generated',
      ...directionalTypeIdentitySelection,
    }),
  );
  await writeFile(join(consumer, 'deep-types.ts'), deepTypeConsumer());
  await writeFile(
    join(consumer, 'type-identity-types.ts'),
    typeIdentityConsumer,
  );
  await writeFile(
    join(consumer, 'type-identity-openapi.json'),
    JSON.stringify(typeIdentityFixture()),
  );
  await writeFile(
    join(consumer, 'type-identity-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './type-identity-openapi.json',
      output: './type-identity-generated',
      ...typeIdentitySelection,
    }),
  );
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
  const extended = extensionFixture();
  await writeFile(
    join(consumer, 'extension-baseline.json'),
    JSON.stringify(extended),
  );
  for (const { value } of extensionKeywordTargets(extended))
    value['x-note'] = { note: 'Synthetic documentation annotation' };
  await writeFile(
    join(consumer, 'extension-openapi.yaml'),
    stringify(extended),
  );
  await writeFile(
    join(consumer, 'extension-openapi.json'),
    JSON.stringify(extended),
  );
  await writeFile(
    join(consumer, 'extension-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './extension-openapi.yaml',
      output: './extension-generated',
      ...extensionSelection,
      ignoreExtensions: ['x-note'],
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'extension-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'extension-pom.json'),
  ]);
  await writeFile(
    join(consumer, 'extension-generated/consumer.ts'),
    `
    import type { CompileOptions } from 'pomegranate-compiler';
    import { operations } from './client.consumer.ts';
    const options: CompileOptions = {clients: ['consumer'], ignoreExtensions: ['x-note']};
    export const request = operations.echo.build({path: {id: 'id'}, query: {'x-note': 'query'}, headers: {'x-note': 'request'}, body: {'x-note': 'kept'}});
    const retained: string = request.body['x-note'];
    void [retained, options];
    // @ts-expect-error Ignoring annotations preserves required data fields.
    operations.echo.build({path: {id: 'id'}, body: {}});
  `,
  );
  for (const [name, document, selection, source] of [
    [
      'parameter',
      parameterReferenceFixture(),
      parameterReferenceSelection,
      parameterReferenceConsumer,
    ],
    [
      'response',
      responseReferenceFixture(),
      responseReferenceSelection,
      responseReferenceConsumer,
    ],
    [
      'body-header',
      bodyHeaderReferenceFixture(),
      bodyHeaderReferenceSelection,
      bodyHeaderReferenceConsumer,
    ],
    ['ip-comment', ipCommentFixture(), ipCommentSelection, ipCommentConsumer],
    [
      'property-count',
      propertyCountFixture(),
      propertyCountSelection,
      propertyCountConsumer,
    ],
    ['query-csv', queryCsvFixture(), queryCsvSelection, queryCsvConsumer],
    ['openapi30', openapi30Fixture(), openapi30Selection, openapi30Consumer],
    ['tolerance', toleranceFixture(), toleranceSelection, toleranceConsumer],
    ['any-json', anyJsonFixture(), anyJsonSelection, anyJsonConsumer],
    ['media', mediaFixture(), mediaSelection, mediaConsumer],
    [
      'registered-formats',
      registeredFormatsFixture(),
      registeredFormatsSelection,
      registeredFormatsConsumer,
    ],
    [
      'numeric-format-profiles',
      numericFormatProfilesFixture(),
      numericFormatProfilesSelection,
      numericFormatProfilesConsumer,
    ],
  ] as const) {
    await writeFile(
      join(consumer, `${name}-openapi.yaml`),
      stringify(document),
    );
    const config = join(consumer, `${name}-pom.json`);
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        openapi: `./${name}-openapi.yaml`,
        output: `./${name}-generated`,
        ...selection,
      }),
    );
    await run(binary, ['generate', '--config', config]);
    await run(binary, ['check', '--config', config]);
    await writeFile(join(consumer, `${name}-generated/consumer.ts`), source);
  }
  const dPolicy = {
    auth: 'public',
    retry: 'never',
    timeout: 'interactive',
    surfaces: ['d'],
  };
  const dDocument = {
    openapi: '3.1.0',
    info: {
      title: 'Synthetic naming and long input',
      version: '1',
      description: 'x'.repeat(8_400_000),
    },
    'x-pom-policy': {
      version: 3,
      auth: { public: { transport: 'none' } },
      fields: {
        retry: { type: 'string', enum: ['never'] },
        timeout: { type: 'string', enum: ['interactive'] },
      },
      required: ['auth', 'retry', 'timeout'],
      surfaces: ['d'],
    },
    components: { schemas: { Payload: { type: 'object' } } },
    paths: {
      '/value': {
        get: {
          operationId: 'read',
          'x-pom': dPolicy,
          responses: {
            200: {
              description: 'Value',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Payload' },
                },
              },
            },
          },
        },
      },
    },
  };
  await writeFile(join(consumer, 'd-openapi.json'), JSON.stringify(dDocument));
  await writeFile(
    join(consumer, 'd-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './d-openapi.json',
      output: './d-generated',
      clients: ['d'],
      standalone: {
        d: { schema: '#/components/schemas/Payload', usage: 'response' },
      },
    }),
  );
  await run(binary, ['generate', '--config', join(consumer, 'd-pom.json')]);
  await run(binary, ['check', '--config', join(consumer, 'd-pom.json')]);
  await writeFile(
    join(consumer, 'd-types.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        rewriteRelativeImportExtensions: true,
        rootDir: 'd-generated',
        outDir: 'd-types',
      },
      include: ['d-generated/*.ts'],
    }),
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'd-types.json'),
  ]);
  await writeFile(
    join(consumer, 'query-openapi.json'),
    JSON.stringify(infiniteFixture(true)),
  );
  await writeFile(
    join(consumer, 'query-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './query-openapi.json',
      output: './query-generated',
      ...infiniteSelection,
    }),
  );
  // The optional integration is generated without loading TanStack or React.
  // Only consumers that select it need to install its declared dependencies.
  await run(binary, ['generate', '--config', join(consumer, 'query-pom.json')]);
  await run(binary, ['check', '--config', join(consumer, 'query-pom.json')]);
  await writeFile(
    join(consumer, 'offset-openapi.json'),
    JSON.stringify(offsetFixture()),
  );
  await writeFile(
    join(consumer, 'offset-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './offset-openapi.json',
      output: './offset-generated',
      ...offsetSelection,
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'offset-pom.json'),
  ]);
  await run(binary, ['check', '--config', join(consumer, 'offset-pom.json')]);
  await writeFile(
    join(consumer, 'execution-openapi.json'),
    JSON.stringify(executionFixture()),
  );
  await writeFile(
    join(consumer, 'execution-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './execution-openapi.json',
      output: './execution-generated',
      ...executionSelection,
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'execution-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'execution-pom.json'),
  ]);
  // Execution alone must compile and run without a schema library before TanStack is installed.
  await writeFile(
    join(consumer, 'execution-only-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './execution-openapi.json',
      output: './execution-only',
      clients: ['consumer'],
      executionClients: ['consumer'],
      transportHeaders: ['X-Language'],
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'execution-only-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'execution-only-pom.json'),
  ]);
  await writeFile(
    join(consumer, 'execution-only.json'),
    JSON.stringify({
      compilerOptions: {
        ...record(tsconfig.compilerOptions),
        lib: ['ES2022'],
        types: ['node'],
        noEmit: true,
      },
      include: ['execution-only/*.ts'],
    }),
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'execution-only.json'),
  ]);
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import {createClient} from './execution-only/client.consumer.ts';
    const client = createClient({namespace: 'no-tanstack', execute: async () => ({status:204, headers:{}, body:''})});
    assert.equal((await client.health.call({context:{}})).status,204);
    const scoped = createClient({namespace: 'no-tanstack-scoped', execute: async (_request, execution) => execution.validateResponse({status:204, headers:{}, body:''})});
    const healthy = await scoped.health.call({context:{}});
    assert.equal(healthy.status,204);
    assert.equal(Object.hasOwn(healthy,'data'),true);
    assert.equal(healthy.data,undefined);
    const controller = new AbortController();
    const cancellation = new Error('standalone cancellation');
    controller.abort('cancelled before transport');
    let mappings = 0;
    const mapped = createClient({namespace:'no-tanstack-mapped',execute:async()=>assert.fail('pre-abort invoked executor'),mapCancellation:event=>{mappings++;assert.equal(event.executorInvoked,false);return {error:cancellation};}});
    await assert.rejects(mapped.health.call({context:{},signal:controller.signal}),error=>error===cancellation);
    assert.equal(mappings,1);
    await assert.rejects(import('@tanstack/query-core'), {code:'ERR_MODULE_NOT_FOUND'});
  `,
  ]);
  await run('npm', [
    'install',
    '--ignore-scripts',
    '--engine-strict',
    '--strict-peer-deps',
    '--legacy-peer-deps=false',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    '--save-exact',
    `@tanstack/query-core@${minimumQueryVersion}`,
    `@tanstack/react-query@${minimumQueryVersion}`,
    'react@19.2.3',
    '@types/react@19.2.7',
  ]);
  // Query Core's declarations use the standard platform VoidFunction type.
  // Supply that one native-environment declaration, without loading DOM globals
  // or hiding dependency errors through skipLibCheck.
  await writeFile(
    join(consumer, 'query-native-globals.d.ts'),
    'interface VoidFunction { (): void; }\n',
  );
  await writeFile(
    join(consumer, 'query-native-tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...record(tsconfig.compilerOptions),
        lib: ['ES2022'],
        types: ['node'],
        noEmit: true,
      },
      include: [
        'query-generated/*.ts',
        'offset-generated/*.ts',
        'query-native-globals.d.ts',
      ],
    }),
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'query-native-tsconfig.json'),
  ]);
  await verifyQueryPlatform(
    consumer,
    join(consumer, 'node_modules/typescript/bin/tsc'),
    ['query-generated', 'offset-generated'],
  );
  await run(binary, ['--help']);
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'symbol-pom.json'),
  ]);
  await run(binary, ['check', '--config', join(consumer, 'symbol-pom.json')]);
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'operation-ids-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'operation-ids-pom.json'),
  ]);
  await run(binary, ['generate', '--config', join(consumer, 'deep-pom.json')]);
  await run(binary, ['check', '--config', join(consumer, 'deep-pom.json')]);
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'type-identity-pom.json'),
  ]);
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'directional-type-identity-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'directional-type-identity-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'type-identity-pom.json'),
  ]);
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
      executionClients: ['native'],
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
        ...record(tsconfig.compilerOptions),
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
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'directional-pom.json'),
  ]);
  await run(binary, [
    'check',
    '--config',
    join(consumer, 'directional-pom.json'),
  ]);
  // The installed executable resolves paths from config even when launched from
  // a working directory outside both the source checkout and the consumer.
  await run(
    binary,
    ['generate', '--config', join(consumer, 'pom.json')],
    scratch,
  );
  await run(binary, ['check', '--config', join(consumer, 'pom.json')], scratch);
  await run(
    binary,
    ['generate', '--config', join(consumer, 'alias-pom.json')],
    scratch,
  );
  await run(
    binary,
    ['check', '--config', join(consumer, 'alias-pom.json')],
    scratch,
  );
  // Both input syntaxes must agree on every generated byte in a real install.
  // Run YAML generation from outside the consumer too, then check it with JSON.
  await run(
    binary,
    ['check', '--config', join(consumer, 'pom.yaml.json')],
    scratch,
  );
  await run(
    binary,
    ['generate', '--config', join(consumer, 'pom.yaml.json')],
    scratch,
  );
  await run(binary, ['check', '--config', join(consumer, 'pom.json')], scratch);
  assert.equal(
    await readFile(join(consumer, 'openapi.yaml'), 'utf8'),
    yamlSource,
  );
  await writeFile(
    join(consumer, 'openapi.yaml'),
    `${yamlSource}\nopenapi: 3.1.0\n`,
  );
  await assert.rejects(
    run(
      binary,
      ['check', '--config', join(consumer, 'pom.yaml.json')],
      scratch,
    ),
    commandFailure(1, /invalid YAML: Map keys must be unique/),
  );
  await writeFile(join(consumer, 'openapi.yaml'), yamlSource);
  await run(binary, ['check', '--config', join(consumer, 'pom.json')], scratch);
  const jsonSource = await readFile(join(consumer, 'openapi.json'), 'utf8');
  await writeFile(
    join(consumer, 'openapi.json'),
    `${jsonSource.slice(0, -1)},"openapi":"3.1.0"}`,
  );
  await assert.rejects(
    run(binary, ['check', '--config', join(consumer, 'pom.json')], scratch),
    commandFailure(1, /invalid JSON: duplicate key/),
  );
  await writeFile(join(consumer, 'openapi.json'), jsonSource);
  const encodingDocument = structuredClone(document);
  record(encodingDocument.info).title = 'UTF8_MARKER';
  const [prefix, suffix] =
    JSON.stringify(encodingDocument).split('UTF8_MARKER');
  assert.ok(prefix !== undefined && suffix !== undefined);
  await writeFile(
    join(consumer, 'openapi.json'),
    Buffer.concat([
      Buffer.from(prefix),
      Buffer.from([0xff]),
      Buffer.from(suffix),
    ]),
  );
  for (const command of ['generate', 'check'])
    await assert.rejects(
      run(binary, [command, '--config', join(consumer, 'pom.json')], scratch),
      commandFailure(1, /invalid UTF-8/),
    );
  await writeFile(join(consumer, 'openapi.json'), jsonSource);
  const jsonConfig = await readFile(join(consumer, 'pom.json'), 'utf8');
  await writeFile(join(consumer, 'bom-pom.json'), `\ufeff${jsonConfig}`);
  await writeFile(join(consumer, 'openapi.json'), `\ufeff${jsonSource}`);
  await run(
    binary,
    ['generate', '--config', join(consumer, 'bom-pom.json')],
    scratch,
  );
  await run(
    binary,
    ['check', '--config', join(consumer, 'bom-pom.json')],
    scratch,
  );
  assert.equal(
    await readFile(join(consumer, 'openapi.json'), 'utf8'),
    `\ufeff${jsonSource}`,
  );
  await writeFile(join(consumer, 'openapi.json'), jsonSource);
  if (process.platform !== 'win32') {
    const parent = join(scratch, 'consumer-alias');
    await symlink(consumer, parent);
    const config = {
      ...record(json(jsonConfig)),
      output: join(parent, 'generated'),
    };
    await writeFile(
      join(consumer, 'parent-alias-pom.json'),
      JSON.stringify(config),
    );
    await run(
      binary,
      ['generate', '--config', join(consumer, 'parent-alias-pom.json')],
      scratch,
    );
    await run(
      binary,
      ['check', '--config', join(consumer, 'parent-alias-pom.json')],
      scratch,
    );
  }
  await run(binary, ['check', '--config', join(consumer, 'pom.json')], scratch);
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    import * as pom from 'pomegranate-compiler';
    import {mkdir, readFile, writeFile} from 'node:fs/promises';
    import {openapi30Fixture,openapi30Selection} from './verification/openapi30-fixture.ts';
    import {toleranceFixture,toleranceSelection} from './verification/tolerance-fixture.ts';
    import {registeredFormatsFixture,registeredFormatsSelection} from './verification/registered-formats-fixture.ts';
    import {numericFormatProfilesFixture,numericFormatProfilesSelection} from './verification/numeric-format-profiles-fixture.ts';
    assert.deepEqual(Object.keys(pom).sort(), ['ContractError', 'compile', 'runProject']);
    const openapi30Document=openapi30Fixture();
    const openapi30Before=structuredClone(openapi30Document);
    assert.deepEqual(await pom.compile(openapi30Document,openapi30Selection),await pom.compile(openapi30Fixture(true),openapi30Selection));
    assert.deepEqual(openapi30Document,openapi30Before);
    const toleranceDocument=toleranceFixture();
    const toleranceBefore=structuredClone(toleranceDocument);
    assert.deepEqual(await pom.compile(toleranceDocument,toleranceSelection),await pom.compile(toleranceFixture(false),toleranceSelection));
    assert.deepEqual(toleranceDocument,toleranceBefore);
    const registeredDocument=registeredFormatsFixture();
    const registeredBefore=structuredClone(registeredDocument);
    assert.deepEqual(await pom.compile(registeredDocument,registeredFormatsSelection),await pom.compile(registeredFormatsFixture(false),registeredFormatsSelection));
    assert.deepEqual(registeredDocument,registeredBefore);
    const numericDocument=numericFormatProfilesFixture();
    const numericBefore=structuredClone(numericDocument);
    assert.deepEqual(await pom.compile(numericDocument,numericFormatProfilesSelection),await pom.compile(numericFormatProfilesFixture(false),numericFormatProfilesSelection));
    assert.deepEqual(numericDocument,numericBefore);
    const document=JSON.parse(await readFile('./openapi.json', 'utf8'));
    const baseline=JSON.parse(await readFile('./openapi-baseline.json', 'utf8'));
    const before=structuredClone(document);
    const selection={clients:['consumer','staff']};
    const extensionDocument=JSON.parse(await readFile('./extension-openapi.json','utf8'));
    const extensionBaseline=JSON.parse(await readFile('./extension-baseline.json','utf8'));
    const extensionSelection={clients:['consumer','staff'],standalone:{tagged:{schema:'#/components/schemas/Tagged',usage:'response'}}};
    const extensionBefore=structuredClone(extensionDocument);
    await assert.rejects(pom.compile(extensionDocument,extensionSelection),/ignoreExtensions/);
    assert.deepEqual(await pom.compile(extensionDocument,{...extensionSelection,ignoreExtensions:['x-note']}),await pom.compile(extensionBaseline,extensionSelection));
    assert.deepEqual(extensionDocument,extensionBefore);
    await assert.rejects(pom.compile(extensionDocument,{...extensionSelection,ignoreExtensions:['x-pom']}),/cannot be ignored/);
    const unsupportedVersion=structuredClone(extensionDocument);
    unsupportedVersion.openapi='3.2.0';
    await assert.rejects(pom.compile(unsupportedVersion,extensionSelection),error=>error instanceof pom.ContractError&&error.location==='openapi');
    const semanticExtension=structuredClone(extensionBaseline);
    semanticExtension.components.parameters.Id['x-multi-segment']=true;
    for(const ignoreExtensions of [[],['x-multi-segment']])
      await assert.rejects(pom.compile(semanticExtension,{...extensionSelection,ignoreExtensions}),/x-multi-segment.*cannot be ignored/);
    assert.deepEqual(await pom.compile(document,selection),await pom.compile(baseline,selection));
    assert.deepEqual(document,before);
    const aliasedSecurity=structuredClone(document);
    const terminalSecurity=aliasedSecurity.components.securitySchemes.WidgetSession;
    aliasedSecurity.components.securitySchemes.WidgetSession={$ref:'#/components/securitySchemes/SessionAlias',description:'Synthetic alias'};
    aliasedSecurity.components.securitySchemes.SessionAlias={$ref:'#/components/securitySchemes/SessionBearer',summary:'Synthetic reference'};
    aliasedSecurity.components.securitySchemes.SessionBearer=terminalSecurity;
    const aliasBefore=structuredClone(aliasedSecurity);
    assert.deepEqual(await pom.compile(aliasedSecurity,selection),await pom.compile(document,selection));
    assert.deepEqual(aliasedSecurity,aliasBefore);
    aliasedSecurity.components.securitySchemes.SessionAlias.$ref='#/components/securitySchemes/Missing';
    await assert.rejects(pom.compile(aliasedSecurity,selection),error=>error instanceof pom.ContractError&&error.location==='components.securitySchemes.SessionAlias.$ref');
    aliasedSecurity.components.securitySchemes.SessionAlias.$ref='#/components/securitySchemes/WidgetSession';
    await assert.rejects(pom.compile(aliasedSecurity,selection),/cyclic security scheme reference/);
    const int32Document={openapi:'3.1.0',info:{title:'Synthetic int32 consumer',version:'1'},paths:{'/round-trip':{post:{operationId:'roundTrip',requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Int32'}}}},responses:{200:{description:'Round trip',content:{'application/json':{schema:{$ref:'#/components/schemas/Int32'}}}}}}}},components:{schemas:{Int32:{type:'integer',format:'int32'}}}};
    const int32Selection={clients:['consumer'],surfaces:{consumer:['roundTrip']},standalone:{int32:{schema:'#/components/schemas/Int32',usage:'request'}}};
    const int32Before=structuredClone(int32Document);
    const int32Files=await pom.compile(int32Document,int32Selection);
    assert.deepEqual(int32Document,int32Before);
    const bounded=structuredClone(int32Document);
    bounded.components.schemas.Int32={type:'integer',minimum:-2147483648,maximum:2147483647};
    assert.deepEqual(int32Files,await pom.compile(bounded,int32Selection));
    await mkdir('./compatibility-generated');
    for(const [name,source] of Object.entries(int32Files)) await writeFile('./compatibility-generated/'+name,source);
    int32Document.components.schemas.Int32.const=2147483648;
    await assert.rejects(pom.compile(int32Document,int32Selection),/bounds/);
    const inheritedParameters=structuredClone(document);
    const inheritedPath=inheritedParameters.paths['/api/widgets/{widgetId}/preparations'];
    inheritedPath.parameters=[inheritedPath.post.parameters[0],{name:'dryRun',in:'query',schema:{type:'boolean',const:true}}];
    inheritedPath.post.parameters=inheritedPath.post.parameters.slice(1);
    const inheritedBefore=structuredClone(inheritedParameters);
    // The installed generated/runtime/type/declaration checks below exercise
    // these exact bytes; inheritance must retain the expanded contract.
    assert.deepEqual(await pom.compile(inheritedParameters,selection),await pom.compile(document,selection));
    assert.deepEqual(inheritedParameters,inheritedBefore);
    inheritedPath.parameters[1].style='spaceDelimited';
    await assert.rejects(pom.compile(inheritedParameters,selection),error=>error instanceof pom.ContractError&&error.location==='paths./api/widgets/{widgetId}/preparations.parameters[1].style');
    inheritedPath.parameters[1].style='form';
    inheritedPath.parameters.push(structuredClone(inheritedPath.parameters[1]));
    await assert.rejects(pom.compile(inheritedParameters,selection),/duplicate parameter query:dryRun/);
    const invalidMetadata=structuredClone(document);
    invalidMetadata.info.license.identifier=false;
    await assert.rejects(pom.compile(invalidMetadata,selection),/info.license.identifier/);
    const legacyPolicy=structuredClone(document);
    legacyPolicy['x-pom-policy'].version=2;
    await assert.rejects(pom.compile(legacyPolicy,selection),/policy version 3/);
    const plain=structuredClone(document);
    delete plain['x-pom-policy'];
    const memberships={consumer:[],staff:[]};
    for(const item of Object.values(plain.paths)) for(const operation of Object.values(item)) {
      for(const surface of operation['x-pom'].surfaces) memberships[surface].push(operation.operationId);
      delete operation['x-pom'];
    }
    const plainBefore=structuredClone(plain);
    for(const options of [selection,{clients:[],standalone:{widget:{schema:'#/components/schemas/Widget',usage:'response'}}}]) {
      await assert.rejects(pom.compile(plain,options),error=>error instanceof pom.ContractError&&/config "surfaces" map/.test(error.message)&&/"x-pom-policy.surfaces"/.test(error.message)&&/operation "x-pom.surfaces"/.test(error.message));
    }
    const plainFiles=await pom.compile(plain,{...selection,surfaces:memberships});
    assert.deepEqual(plain,plainBefore);
    await mkdir('./plain-generated');
    for(const [name,source] of Object.entries(plainFiles)) await writeFile('./plain-generated/'+name,source);
    const plainEntry=await import('./plain-generated/client.consumer.ts');
    assert.deepEqual({...plainEntry.operations.checkHealth.build().policy},{});
    assert.deepEqual({...plainEntry.operations.checkHealth.build().security},{transport:'none'});
    const omittedPolicy=structuredClone(document);
    omittedPolicy['x-pom-policy']={version:3,surfaces:['consumer','staff']};
    for(const item of Object.values(omittedPolicy.paths)) for(const operation of Object.values(item)) operation['x-pom']={surfaces:operation['x-pom'].surfaces};
    const optionalFiles=await pom.compile(omittedPolicy,selection);
    assert.ok(Object.hasOwn(optionalFiles,'policy-types.ts'));
    const wrongPolicy=structuredClone(document);
    wrongPolicy.paths['/api/widgets/{widgetId}/preparations'].post['x-pom'].retry='unknown';
    await assert.rejects(pom.compile(wrongPolicy,selection),/x-pom.retry/);
    const undeclaredPolicyField=structuredClone(document);
    undeclaredPolicyField.paths['/api/widgets/{widgetId}/preparations'].post['x-pom'].audit=true;
    await assert.rejects(pom.compile(undeclaredPolicyField,selection),/x-pom.audit/);
    const missingRequiredPolicy=structuredClone(document);
    delete missingRequiredPolicy.paths['/api/widgets/{widgetId}/preparations'].post['x-pom'].auth;
    await assert.rejects(pom.compile(missingRequiredPolicy,selection),/x-pom.auth/);
    const invalidSlots = [
      [d => { d['x-pom-policy'].surfaces.length++; }, 'x-pom-policy.surfaces[2]'],
      [d => { d.paths['/api/widgets/{widgetId}/preparations'].post.parameters.length++; }, 'paths./api/widgets/{widgetId}/preparations.post.parameters[3]'],
      [d => { d.components.schemas.MissingBranch={anyOf:[{type:'null'},,]}; }, 'components.schemas.MissingBranch.anyOf[1]'],
    ];
    for (const [mutate, location] of invalidSlots) {
      const invalid=structuredClone(document);
      mutate(invalid);
      await assert.rejects(pom.compile(invalid,selection), error => {
        assert.ok(error instanceof pom.ContractError);
        assert.equal(error.location,location);
        return true;
      });
    }
    for(const schema of [
      {type:'string',enum:['ab'],pattern:'^x'},
      {type:'string',const:'nope',format:'uuid'},
      {type:'integer',enum:[3],multipleOf:2},
      {type:'integer',minimum:0.5,maximum:0.9},
    ]) {
      const invalid=structuredClone(document);
      invalid.components.schemas.Impossible=schema;
      await assert.rejects(pom.compile(invalid,selection),/components.schemas.Impossible/);
    }
    for (const pattern of ['(?i:abc)', '(?<part>a)|(?<part>b)', '\\\\p{Script=Beria_Erfe}']) {
      const invalid=structuredClone(document);
      invalid.components.schemas.UnsupportedPattern={type:'string',pattern};
      await assert.rejects(pom.compile(invalid,selection), error => {
        assert.ok(error instanceof pom.ContractError);
        assert.equal(error.location,'components.schemas.UnsupportedPattern.pattern');
        assert.match(error.message,/ECMAScript 2024.*Unicode 16\\.0/);
        return true;
      });
    }
    const portable=structuredClone(document);
    portable.components.schemas.PortablePattern={type:'string',pattern:'^(?<letter>\\\\p{Script=Todhri})\\\\k<letter>$'};
    const patterns=await pom.compile(portable,{clients:[],standalone:{pattern:{schema:'#/components/schemas/PortablePattern',usage:'request'}}});
    await mkdir('./pattern-generated');
    for (const [name,source] of Object.entries(patterns)) await writeFile('./pattern-generated/'+name,source);
    const files = await pom.compile(document,{clients:['staff']});
    for (const version of ['3.1.0','3.1.1','3.1.2']) {
      document.openapi=version;
      assert.deepEqual(await pom.compile(document,{clients:['staff']}),files);
    }
    assert.deepEqual(Object.keys(files).filter(name=>!name.startsWith('schema-types.')).sort(), ['client.staff.operations.ts', 'client.staff.schemas.ts', 'client.staff.ts', 'endpoint-runtime.ts', 'policy-types.ts', 'runtime.ts']);
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
    commandFailure(1, /modified owned output/),
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
    'generated/endpoint-runtime.ts',
    'generated/policy-types.ts',
    'multipart-generated/runtime.ts',
    'multipart-generated/runtime.browser.ts',
    'query-generated/query-runtime.ts',
    'query-generated/execution-runtime.ts',
    'execution-generated/execution-runtime.ts',
    'multipart-generated/execution-runtime.ts',
    'execution-generated/call-runtime.ts',
    'multipart-generated/call-runtime.ts',
    'query-generated/query-sharing.ts',
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
  assert.deepEqual(
    (await readdir(join(consumer, 'staff-only')))
      .filter((name) => !name.startsWith('schema-types.'))
      .sort(),
    [
      '.pom-manifest.json',
      'client.staff.operations.ts',
      'client.staff.schemas.ts',
      'client.staff.ts',
      'endpoint-runtime.ts',
      'policy-types.ts',
      'runtime.ts',
    ],
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'tsconfig.json'),
  ]);
  const modes = consumerModesFixture();
  await writeFile(
    join(consumer, 'consumer-modes-openapi.json'),
    JSON.stringify(modes.document),
  );
  await writeFile(
    join(consumer, 'consumer-modes-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './consumer-modes-openapi.json',
      output: './consumer-modes-generated',
      ...modes.options,
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'consumer-modes-pom.json'),
  ]);
  await verifyConsumerModes(
    join(consumer, 'consumer-modes-generated'),
    join(consumer, 'node_modules/typescript/bin/tsc'),
    'pomegranate-compiler',
  );
  const aliasTypes = aliasDeclarationFixture();
  await mkdir(join(consumer, 'alias-types'));
  await writeFile(
    join(consumer, 'alias-types-openapi.json'),
    JSON.stringify(aliasTypes.document),
  );
  await writeFile(
    join(consumer, 'alias-types-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './alias-types-openapi.json',
      output: './alias-types/source',
      ...aliasTypes.options,
    }),
  );
  await run(binary, [
    'generate',
    '--config',
    join(consumer, 'alias-types-pom.json'),
  ]);
  await verifyAliasDeclarations(
    join(consumer, 'alias-types'),
    join(consumer, 'node_modules/typescript/bin/tsc'),
  );
  for (const name of (await readdir(join(consumer, 'generated'))).filter(
    (name) => name.endsWith('.ts'),
  )) {
    const source = await readFile(join(consumer, 'generated', name), 'utf8');
    assert.doesNotMatch(
      source,
      /pomegranate-compiler|oxfmt|prettier|node:|\/Users\//,
    );
  }
  const wide = wideDeclarationFixture();
  await writeFile(
    join(consumer, 'wide-openapi.json'),
    JSON.stringify(wide.document),
  );
  await writeFile(
    join(consumer, 'wide-pom.json'),
    JSON.stringify({
      version: 2,
      openapi: './wide-openapi.json',
      output: './wide-generated',
      ...wide.selection,
    }),
  );
  // Generate through the installed package before exercising wide inferred
  // exports with minimum peers and the TypeScript 5.7 compiler line.
  await run(binary, ['generate', '--config', join(consumer, 'wide-pom.json')]);
  const compositionRoot = join(consumer, 'type-composition');
  await mkdir(compositionRoot);
  await writeFile(
    join(compositionRoot, 'openapi.json'),
    JSON.stringify(typeCompositionFixture()),
  );
  const compositionConfig = join(compositionRoot, 'pom.json');
  await writeFile(
    compositionConfig,
    JSON.stringify({
      version: 2,
      openapi: './openapi.json',
      output: './generated',
      ...typeCompositionSelection,
    }),
  );
  await run(binary, ['generate', '--config', compositionConfig]);
  await run(binary, ['check', '--config', compositionConfig]);
  // Removing the actual compiler installation proves application execution does
  // not reach back into the compiler, its source checkout, or a sibling project.
  await rm(join(consumer, 'node_modules/pomegranate-compiler'), {
    recursive: true,
  });
  await rm(join(consumer, 'node_modules/oxfmt'), { recursive: true });
  await rm(join(consumer, 'node_modules/yaml'), { recursive: true });
  await rm(join(consumer, 'node_modules/@eslint-community/regexpp'), {
    recursive: true,
  });
  await run(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    await assert.rejects(import('pomegranate-compiler'), {code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(import('oxfmt'), {code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(import('yaml'), {code:'ERR_MODULE_NOT_FOUND'});
    await assert.rejects(import('@eslint-community/regexpp'), {code:'ERR_MODULE_NOT_FOUND'});
  `,
  ]);
  await verifyQueryDeclarations(
    consumer,
    join(consumer, 'node_modules/typescript/bin/tsc'),
    join(repo, 'test/query-types.ts'),
    join(repo, 'test/infinite-types.ts'),
    join(repo, 'test/offset-types.ts'),
  );
  await verifyExecutionDeclarations(
    consumer,
    join(consumer, 'node_modules/typescript/bin/tsc'),
    join(repo, 'test/execution-types.ts'),
  );
  await verifyWideDeclarations(
    consumer,
    join(consumer, 'node_modules/typescript/bin/tsc'),
  );
  await verifyTypeComposition(
    compositionRoot,
    join(consumer, 'node_modules/typescript/bin/tsc'),
  );
  await writeFile(
    join(consumer, 'media-declarations.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        declaration: true,
        emitDeclarationOnly: true,
        rewriteRelativeImportExtensions: true,
        rootDir: './media-generated',
        outDir: './media-declarations',
      },
      include: ['media-generated/*.ts'],
    }),
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'media-declarations.json'),
  ]);
  await writeFile(
    join(consumer, 'media-published.ts'),
    `
    import {parsePreferred} from './media-declarations/consumer.js';
    const result=parsePreferred({status:200,headers:{},body:''});
    if(result.kind!=='protocol' && result.status===200) {
      if(result.contentType==='application/a+json') {
        const flag:true=result.data;
        // @ts-expect-error Published media discrimination excludes other JSON payloads.
        void result.data.code;
        void flag;
      } else if(result.contentType==='application/json') {
        const code:'ok'=result.data.code; void code;
      }
    }
  `,
  );
  await writeFile(
    join(consumer, 'media-published.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
      },
      include: ['media-published.ts', 'media-declarations/*.d.ts'],
    }),
  );
  await run(process.execPath, [
    join(consumer, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(consumer, 'media-published.json'),
  ]);
  const mediaExecutionChecks = `
    for(const scoped of [false,true]) {
      let observed;
      const execute=async (_request,execution)=>scoped?execution.validateResponse(observed):observed;
      const config={namespace:'installed-media-'+scoped,execute};
      const api=mediaClient.createClient(config);
      const query=mediaQueries.createQueries(config).readRepresentations;
      const cache=new (await import('@tanstack/query-core')).QueryClient({defaultOptions:{queries:{gcTime:Infinity,retry:false}}});
      try {
        for(const [contentType,body,data] of [
          ['application/json','{"code":"ok"}',{code:'ok'}],
          ['application/a+json','true',true],
          ['application/vnd.zeta+json','2',2],
          ['text/plain','{"ok":true}','{"ok":true}'],
        ]) {
          observed={status:200,headers:{'Content-Type':contentType},body};
          const called=await api.readRepresentations.call({context:{}});
          assert.equal(called.contentType,contentType);
          assert.deepEqual(called.data,data);
          const envelope=await cache.fetchQuery(query.options({context:{}}));
          assert.equal(envelope.contentType,contentType);
          assert.deepEqual(envelope.data,data);
          assert.deepEqual(await cache.fetchQuery(query.body().options({context:{}})),data);
        }
        observed={status:400,headers:{'Content-Type':'text/plain'},body:'hello'};
        await assert.rejects(api.readRepresentations.call({context:{}}),error=>api.readRepresentations.isError(error)&&error.result.kind==='error'&&error.result.contentType==='text/plain'&&error.result.data==='hello');
      } finally {cache.clear();}
    }
  `;
  // Both runtimes execute the same sources; Node strips only erasable syntax.
  const sourceChecks = `
    import assert from 'node:assert/strict';
    import * as extensionClient from './extension-generated/client.consumer.ts';
    import {verifyExtensionData} from './verification/extension-fixture.ts';
    verifyExtensionData(extensionClient);
    import * as parameterClient from './parameter-generated/client.consumer.ts';
    import * as parameterStaff from './parameter-generated/client.staff.ts';
    import {verifyParameterReferences} from './verification/parameter-reference-fixture.ts';
    verifyParameterReferences(parameterClient, parameterStaff);
    import * as responseClient from './response-generated/client.consumer.ts';
    import * as responseStaff from './response-generated/client.staff.ts';
    import {verifyResponseReferences} from './verification/response-reference-fixture.ts';
    verifyResponseReferences(responseClient, responseStaff);
    import * as bodyHeaderBrowser from './body-header-generated/client.browser.ts';
    import * as bodyHeaderNative from './body-header-generated/client.native.ts';
    import {verifyBodyHeaderReferences} from './verification/body-header-reference-fixture.ts';
    verifyBodyHeaderReferences(bodyHeaderBrowser, bodyHeaderNative);
    import * as ipCommentClient from './ip-comment-generated/client.consumer.ts';
    import * as ipv4 from './ip-comment-generated/standalone.ipv4.ts';
    import * as ipv6 from './ip-comment-generated/standalone.ipv6.ts';
    import {verifyIpComment} from './verification/ip-comment-fixture.ts';
    verifyIpComment(ipCommentClient, ipv4, ipv6);
    import * as propertyCountClient from './property-count-generated/client.consumer.ts';
    import * as propertyCountSchemas from './property-count-generated/client.consumer.schemas.ts';
    import {verifyPropertyCounts} from './verification/property-count-fixture.ts';
    verifyPropertyCounts(propertyCountClient, propertyCountSchemas);
    import * as queryCsvClient from './query-csv-generated/client.consumer.ts';
    import {verifyQueryCsv} from './verification/query-csv-fixture.ts';
    verifyQueryCsv(queryCsvClient);
    import * as openapi30Client from './openapi30-generated/client.consumer.ts';
    import * as openapi30Request from './openapi30-generated/standalone.request.ts';
    import * as openapi30Response from './openapi30-generated/standalone.response.ts';
    import {verifyOpenapi30} from './verification/openapi30-fixture.ts';
    verifyOpenapi30(openapi30Client, openapi30Request, openapi30Response);
    import * as toleranceClient from './tolerance-generated/client.consumer.ts';
    import * as toleranceInt64 from './tolerance-generated/standalone.int64.ts';
    import {verifyTolerance} from './verification/tolerance-fixture.ts';
    verifyTolerance(toleranceClient, toleranceInt64);
    import * as anyJsonClient from './any-json-generated/client.json.ts';
    import * as anyJsonInput from './any-json-generated/standalone.input.ts';
    import * as anyJsonOutput from './any-json-generated/standalone.output.ts';
    import {verifyAnyJson} from './verification/any-json-fixture.ts';
    verifyAnyJson(anyJsonClient, anyJsonInput, anyJsonOutput);
    import * as mediaClient from './media-generated/client.consumer.ts';
    import * as mediaQueries from './media-generated/client.consumer.queries.ts';
    import {verifyMedia} from './verification/media-fixture.ts';
    verifyMedia(mediaClient);
    ${mediaExecutionChecks}
    import * as registeredFormatsClient from './registered-formats-generated/client.consumer.ts';
    import * as registeredSlug from './registered-formats-generated/standalone.slug.ts';
    import * as registeredInput from './registered-formats-generated/standalone.input.ts';
    import * as registeredOutput from './registered-formats-generated/standalone.output.ts';
    import {verifyRegisteredFormats} from './verification/registered-formats-fixture.ts';
    verifyRegisteredFormats(registeredFormatsClient, registeredSlug, registeredInput, registeredOutput);
    import * as numericProfilesClient from './numeric-format-profiles-generated/client.consumer.ts';
    import * as numericDecimal from './numeric-format-profiles-generated/standalone.decimal.ts';
    import * as numericSingle from './numeric-format-profiles-generated/standalone.single.ts';
    import {verifyNumericFormatProfiles} from './verification/numeric-format-profiles-fixture.ts';
    verifyNumericFormatProfiles(numericProfilesClient, numericDecimal, numericSingle);
    import * as directionalClient from './directional-generated/client.consumer.ts';
    import * as operationIdsClient from './operation-ids-generated/client.consumer.ts';
    import * as operationIdsQueries from './operation-ids-generated/client.consumer.queries.ts';
    import {verifyOperationIds} from './verification/operation-ids-checks.ts';
    await verifyOperationIds(operationIdsClient, operationIdsQueries);
    import * as directionalQueries from './directional-generated/client.consumer.queries.ts';
    import * as directionalRequest from './directional-generated/standalone.request.ts';
    import * as directionalResponse from './directional-generated/standalone.response.ts';
    import * as directionalEmptyRequest from './directional-generated/standalone.empty-request.ts';
    import * as directionalEmptyResponse from './directional-generated/standalone.empty-response.ts';
    import {verifyDirectional} from './verification/directional-fixture.ts';
    await verifyDirectional(directionalClient,directionalQueries,directionalRequest,directionalResponse,directionalEmptyRequest,directionalEmptyResponse);
    import {verifyCompatibility} from './compatibility-consumer.ts';
    verifyCompatibility();
    import {schema as portablePattern} from './pattern-generated/standalone.pattern.ts';
    assert.equal(portablePattern.parse('\\u{105C0}\\u{105C0}'),'\\u{105C0}\\u{105C0}');
    assert.equal(portablePattern.safeParse('aa').success,false);
    import {operations as dOperations} from './d-generated/client._d.ts';
    import {schema as dSchema} from './d-generated/standalone._d.ts';
    const dValue = {value: 'kept', nested: {count: 1}};
    assert.deepEqual(dSchema.parse(dValue), dValue);
    const dResult = dOperations.read.build().parseResponse({status:200, headers:{'Content-Type':'application/json'}, body:JSON.stringify(dValue)});
    assert.equal(dResult.kind, 'success');
    assert.deepEqual(dResult.data, dValue);
    import * as executionModule from './execution-generated/client.consumer.ts';
    import * as executionQueries from './execution-generated/client.consumer.queries.ts';
    import * as executionStaff from './execution-generated/client.staff.ts';
    import {verifyExecutions, verifyExecutableMultipart, verifyExecutionParsing} from './verification/execution-checks.ts';
    await verifyExecutions(executionModule,executionQueries,executionStaff);
    import * as executionSchemas from './execution-generated/client.consumer.schemas.ts';
    import * as exampleTransport from './transport.ts';
    await verifyExecutionParsing(executionModule,executionSchemas,exampleTransport);
    import * as browserModule from './multipart-generated/client.browser.ts';
    import * as nativeModule from './multipart-generated/client.native.ts';
    await verifyExecutableMultipart(browserModule,nativeModule);
    import {createQueries, QueryResponseError} from './query-generated/client.consumer.queries.ts';
    import {verifyQueries} from './verification/query-checks.ts';
    await verifyQueries(createQueries, QueryResponseError);
    import {createInfiniteQueries} from './query-generated/client.consumer.queries.ts';
    import {verifyInfiniteQueries} from './verification/infinite-checks.ts';
    await verifyInfiniteQueries(createInfiniteQueries, QueryResponseError);
    import * as infiniteModule from './query-generated/client.consumer.queries.ts';
    import * as errorStaff from './query-generated/client.staff.queries.ts';
    import {verifyQueryErrors} from './verification/query-error-checks.ts';
    await verifyQueryErrors(infiniteModule, errorStaff);
    import {verifyQuerySharing} from './verification/query-sharing-checks.ts';
    await verifyQuerySharing(infiniteModule);
    import {verifyInfiniteLifecycle} from './verification/infinite-lifecycle-checks.ts';
    await verifyInfiniteLifecycle(infiniteModule);
    import * as offsetModule from './offset-generated/client.consumer.queries.ts';
    import {verifyOffsets} from './verification/offset-checks.ts';
    await verifyOffsets(offsetModule);
    import {operations} from './generated/client.consumer.ts';
    import {operations as schemaOperations, RequestValidationError as SchemaError} from './schema-generated/client.samples.ts';
    import {schema as message} from './schema-generated/standalone.message.ts';
    import {schema as input} from './schema-generated/standalone.input.ts';
    import {schema as empty} from './schema-generated/standalone.empty.ts';
    import {verifySchemas, verifyStandalone} from './verification/schema-fixture.ts';
    import {operations as browser} from './multipart-generated/client.browser.ts';
    import {operations as native, RequestValidationError} from './multipart-generated/client.native.ts';
    import {verifyMultipart} from './verification/multipart-fixture.ts';
    import {operations as deep, RequestValidationError as DeepError} from './deep-generated/client.deep.ts';
    import {verifyDeep} from './verification/deep-fixture.ts';
    import {operations as symbols, RequestValidationError as SymbolError} from './symbol-generated/client.symbols.ts';
    import {verifySymbols} from './verification/symbol-fixture.ts';
    assert.equal(operations.checkHealth.build().method, 'HEAD');
    verifySchemas(schemaOperations, SchemaError);
    verifyStandalone(message, input);
    assert.deepEqual(empty.parse({}), {});
    assert.equal(empty.safeParse(42).success, false);
    await verifyMultipart(browser, native, RequestValidationError);
    verifyDeep(deep, DeepError);
    verifySymbols(symbols, SymbolError);
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
    import {verifyCompatibility} from './.build/compatibility-consumer.js';
    verifyCompatibility();
    import * as extensionClient from './.build/extension-generated/client.consumer.js';
    import {verifyExtensionData} from './verification/extension-fixture.ts';
    verifyExtensionData(extensionClient);
    import * as parameterClient from './.build/parameter-generated/client.consumer.js';
    import * as parameterStaff from './.build/parameter-generated/client.staff.js';
    import {verifyParameterReferences} from './verification/parameter-reference-fixture.ts';
    verifyParameterReferences(parameterClient, parameterStaff);
    import * as responseClient from './.build/response-generated/client.consumer.js';
    import * as responseStaff from './.build/response-generated/client.staff.js';
    import {verifyResponseReferences} from './verification/response-reference-fixture.ts';
    verifyResponseReferences(responseClient, responseStaff);
    import * as bodyHeaderBrowser from './.build/body-header-generated/client.browser.js';
    import * as bodyHeaderNative from './.build/body-header-generated/client.native.js';
    import {verifyBodyHeaderReferences} from './verification/body-header-reference-fixture.ts';
    verifyBodyHeaderReferences(bodyHeaderBrowser, bodyHeaderNative);
    import * as ipCommentClient from './.build/ip-comment-generated/client.consumer.js';
    import * as ipv4 from './.build/ip-comment-generated/standalone.ipv4.js';
    import * as ipv6 from './.build/ip-comment-generated/standalone.ipv6.js';
    import {verifyIpComment} from './verification/ip-comment-fixture.ts';
    verifyIpComment(ipCommentClient, ipv4, ipv6);
    import * as propertyCountClient from './.build/property-count-generated/client.consumer.js';
    import * as propertyCountSchemas from './.build/property-count-generated/client.consumer.schemas.js';
    import {verifyPropertyCounts} from './verification/property-count-fixture.ts';
    verifyPropertyCounts(propertyCountClient, propertyCountSchemas);
    import * as queryCsvClient from './.build/query-csv-generated/client.consumer.js';
    import {verifyQueryCsv} from './verification/query-csv-fixture.ts';
    verifyQueryCsv(queryCsvClient);
    import * as openapi30Client from './.build/openapi30-generated/client.consumer.js';
    import * as openapi30Request from './.build/openapi30-generated/standalone.request.js';
    import * as openapi30Response from './.build/openapi30-generated/standalone.response.js';
    import {verifyOpenapi30} from './verification/openapi30-fixture.ts';
    verifyOpenapi30(openapi30Client, openapi30Request, openapi30Response);
    import * as toleranceClient from './.build/tolerance-generated/client.consumer.js';
    import * as toleranceInt64 from './.build/tolerance-generated/standalone.int64.js';
    import {verifyTolerance} from './verification/tolerance-fixture.ts';
    verifyTolerance(toleranceClient, toleranceInt64);
    import * as anyJsonClient from './.build/any-json-generated/client.json.js';
    import * as anyJsonInput from './.build/any-json-generated/standalone.input.js';
    import * as anyJsonOutput from './.build/any-json-generated/standalone.output.js';
    import {verifyAnyJson} from './verification/any-json-fixture.ts';
    verifyAnyJson(anyJsonClient, anyJsonInput, anyJsonOutput);
    import * as mediaClient from './.build/media-generated/client.consumer.js';
    import * as mediaQueries from './.build/media-generated/client.consumer.queries.js';
    import {verifyMedia} from './verification/media-fixture.ts';
    verifyMedia(mediaClient);
    ${mediaExecutionChecks}
    import * as registeredFormatsClient from './.build/registered-formats-generated/client.consumer.js';
    import * as registeredSlug from './.build/registered-formats-generated/standalone.slug.js';
    import * as registeredInput from './.build/registered-formats-generated/standalone.input.js';
    import * as registeredOutput from './.build/registered-formats-generated/standalone.output.js';
    import {verifyRegisteredFormats} from './verification/registered-formats-fixture.ts';
    verifyRegisteredFormats(registeredFormatsClient, registeredSlug, registeredInput, registeredOutput);
    import * as numericProfilesClient from './.build/numeric-format-profiles-generated/client.consumer.js';
    import * as numericDecimal from './.build/numeric-format-profiles-generated/standalone.decimal.js';
    import * as numericSingle from './.build/numeric-format-profiles-generated/standalone.single.js';
    import {verifyNumericFormatProfiles} from './verification/numeric-format-profiles-fixture.ts';
    verifyNumericFormatProfiles(numericProfilesClient, numericDecimal, numericSingle);
    import * as directionalClient from './.build/directional-generated/client.consumer.js';
    import * as operationIdsClient from './.build/operation-ids-generated/client.consumer.js';
    import * as operationIdsQueries from './.build/operation-ids-generated/client.consumer.queries.js';
    import {verifyOperationIds} from './verification/operation-ids-checks.ts';
    await verifyOperationIds(operationIdsClient, operationIdsQueries);
    import * as directionalQueries from './.build/directional-generated/client.consumer.queries.js';
    import * as directionalRequest from './.build/directional-generated/standalone.request.js';
    import * as directionalResponse from './.build/directional-generated/standalone.response.js';
    import * as directionalEmptyRequest from './.build/directional-generated/standalone.empty-request.js';
    import * as directionalEmptyResponse from './.build/directional-generated/standalone.empty-response.js';
    import {verifyDirectional} from './verification/directional-fixture.ts';
    await verifyDirectional(directionalClient,directionalQueries,directionalRequest,directionalResponse,directionalEmptyRequest,directionalEmptyResponse);
    import * as executionModule from './.build/execution-generated/client.consumer.js';
    import * as executionQueries from './.build/execution-generated/client.consumer.queries.js';
    import * as executionStaff from './.build/execution-generated/client.staff.js';
    import {verifyExecutions, verifyExecutableMultipart, verifyExecutionParsing} from './verification/execution-checks.ts';
    await verifyExecutions(executionModule,executionQueries,executionStaff);
    import * as executionSchemas from './.build/execution-generated/client.consumer.schemas.js';
    import * as exampleTransport from './.build/transport.js';
    await verifyExecutionParsing(executionModule,executionSchemas,exampleTransport);
    import * as browserModule from './.build/multipart-generated/client.browser.js';
    import * as nativeModule from './.build/multipart-generated/client.native.js';
    await verifyExecutableMultipart(browserModule,nativeModule);
    import {createQueries, QueryResponseError} from './.build/query-generated/client.consumer.queries.js';
    import {verifyQueries} from './verification/query-checks.ts';
    await verifyQueries(createQueries, QueryResponseError);
    import {createInfiniteQueries} from './.build/query-generated/client.consumer.queries.js';
    import {verifyInfiniteQueries} from './verification/infinite-checks.ts';
    await verifyInfiniteQueries(createInfiniteQueries, QueryResponseError);
    import * as infiniteModule from './.build/query-generated/client.consumer.queries.js';
    import * as errorStaff from './.build/query-generated/client.staff.queries.js';
    import {verifyQueryErrors} from './verification/query-error-checks.ts';
    await verifyQueryErrors(infiniteModule, errorStaff);
    import {verifyQuerySharing} from './verification/query-sharing-checks.ts';
    await verifyQuerySharing(infiniteModule);
    import {verifyInfiniteLifecycle} from './verification/infinite-lifecycle-checks.ts';
    await verifyInfiniteLifecycle(infiniteModule);
    import * as offsetModule from './.build/offset-generated/client.consumer.queries.js';
    import {verifyOffsets} from './verification/offset-checks.ts';
    await verifyOffsets(offsetModule);
    import {operations, RequestValidationError} from './.build/generated/client.consumer.js';
    import {operations as schemaOperations, RequestValidationError as SchemaError} from './.build/schema-generated/client.samples.js';
    import {verifySchemas,verifyStandalone} from './verification/schema-fixture.ts';
    import {operations as symbols, RequestValidationError as SymbolError} from './.build/symbol-generated/client.symbols.js';
    import {verifySymbols} from './verification/symbol-fixture.ts';
    verifySymbols(symbols, SymbolError);
    import {schema as message} from './.build/schema-generated/standalone.message.js';
    import {schema as input} from './.build/schema-generated/standalone.input.js';
    verifySchemas(schemaOperations, SchemaError);
    verifyStandalone(message,input);
    import {operations as browserUploads} from './.build/multipart-generated/client.browser.js';
    import {operations as nativeUploads, RequestValidationError as UploadError} from './.build/multipart-generated/client.native.js';
    import {verifyMultipart} from './verification/multipart-fixture.ts';
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
    assert.equal(staff.getStaffReport.build().policy.auth, 'partnerStaff');
  assert.deepEqual({ ...staff.getStaffReport.build().security }, {
    transport: 'bearer',
    scheme: 'WidgetSession',
  });
    assert.equal(operations.checkHealth.build().policy.auth, 'public');
  assert.deepEqual({ ...operations.checkHealth.build().security }, { transport: 'none' });
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
    `Packed install passed: ${paths.length} allowed files; no schema library; TanStack ${minimumQueryVersion}; npm engine-strict install, CLI, library, drift, strict types, transport, queries and compiler-free Node/Bun source and emitted JavaScript execution`,
  );
} finally {
  await rm(scratch, { recursive: true, force: true });
}
