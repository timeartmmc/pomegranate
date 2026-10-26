import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile } from '../dist/index.js';
import { invalidOptions } from './assertions.ts';
import {
  multipartFixture,
  multipartSelection,
  verifyMultipart,
} from './multipart-fixture.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
void test('multipart builders preserve browser/native files and field cardinality through application serialization', async (t) => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'pom-multipart-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sources = await compile(multipartFixture(), multipartSelection);
  await mkdir(join(root, 'multipart-generated'));
  for (const [name, source] of Object.entries(sources))
    await writeFile(join(root, 'multipart-generated', name), source);
  await cp(
    join(repo, 'test/multipart-types.ts'),
    join(root, 'multipart-types.ts'),
  );
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    rewriteRelativeImportExtensions: true,
    strict: true,
    noUncheckedIndexedAccess: true,
    noPropertyAccessFromIndexSignature: true,
    exactOptionalPropertyTypes: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    outDir: '.build',
    types: [],
    lib: ['ES2022', 'DOM', 'DOM.Iterable'],
  };
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: options,
      include: ['*.ts', 'multipart-generated/*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  const browser = (await import(
    pathToFileURL(join(root, '.build/multipart-generated/client.browser.js'))
      .href
  )) as typeof import('./.generated/multipart/client.browser.ts');
  const native = (await import(
    pathToFileURL(join(root, '.build/multipart-generated/client.native.js'))
      .href
  )) as typeof import('./.generated/multipart/client.native.ts');
  await verifyMultipart(
    browser.operations,
    native.operations,
    native.RequestValidationError,
  );

  const nativeOnly = await compile(multipartFixture(), {
    clients: ['native'],
    targets: { native: 'native' },
  });
  assert.equal(Object.hasOwn(nativeOnly, 'runtime.browser.ts'), false);
  for (const source of Object.values(nativeOnly))
    assert.doesNotMatch(
      source,
      /instanceof File|custom<File>|FormData|runtime\.browser/,
    );
  await mkdir(join(root, 'native-only'));
  for (const [name, source] of Object.entries(nativeOnly))
    await writeFile(join(root, 'native-only', name), source);
  await writeFile(
    join(root, 'native.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        lib: ['ES2022'],
        types: ['node'],
        noEmit: true,
      },
      include: ['native-only/*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'native.json'),
  ]);
});

void test('multipart selection requires explicit supported targets', async () => {
  for (const targets of [
    undefined,
    {},
    { browser: 'web', native: 'native' },
    { browser: 'browser', native: 'native', other: 'native' },
  ])
    await assert.rejects(
      invalidOptions(compile, multipartFixture(), {
        clients: ['browser', 'native'],
        targets,
      }),
      /targets/,
    );
  const document = multipartFixture();
  document['x-pom-policy'].surfaces = ['constructor'];
  for (const item of Object.values(document.paths))
    item.post['x-pom'].surfaces = ['constructor'];
  await assert.rejects(
    compile(document, { clients: ['constructor'] }),
    /targets.constructor.*explicit/,
  );
  const files = await compile(document, {
    clients: ['constructor'],
    targets: { constructor: 'browser' as const },
  });
  assert.ok(Object.hasOwn(files, 'client.constructor.ts'));
  assert.ok(Object.hasOwn(files, 'runtime.browser.ts'));
});

for (const [name, change, pattern] of [
  [
    'JSON binary body',
    (d) => {
      const request = d.paths['/file'].post.requestBody;
      Object.assign(request, {
        content: {
          'application/json': request.content['multipart/form-data'],
        },
      });
    },
    /binary values.*multipart/,
  ],
  [
    'JSON binary response reference',
    (d) => {
      Object.assign(
        d.paths['/file'].post.responses['201'].content['application/json'],
        { schema: { $ref: '#/components/schemas/Upload' } },
      );
    },
    /binary values.*multipart/,
  ],
  [
    'nested fields',
    (d) => {
      Object.assign(d.components.schemas.Upload.properties, {
        cover: {
          type: 'object',
          properties: { nested: { type: 'string' } },
        },
      });
    },
    /multipart fields/,
  ],
  [
    'number fields',
    (d) => {
      Object.assign(d.components.schemas.Upload.properties, {
        caption: { type: 'number' },
      });
    },
    /multipart fields/,
  ],
  [
    'nullable files',
    (d) => {
      Object.assign(d.components.schemas.Upload.properties, {
        cover: {
          anyOf: [{ type: 'string', format: 'binary' }, { type: 'null' }],
        },
      });
    },
    /multipart fields/,
  ],
  [
    'dynamic body',
    (d) => {
      Object.assign(d.components.schemas, {
        Upload: {
          type: 'object',
          additionalProperties: { type: 'string' },
        },
      });
    },
    /fixed object/,
  ],
  [
    'unsafe field names',
    (d) => {
      Object.assign(d.components.schemas.Upload.properties, {
        'bad\r\nname': {
          type: 'string',
        },
      });
    },
    /field names/,
  ],
  [
    'binary constraints',
    (d) => {
      Object.assign(d.components.schemas.File, { minLength: 1 });
    },
    /minLength.*unsupported/,
  ],
  [
    'binary media type',
    (d) => {
      d.components.schemas.RawFile.contentMediaType = 'image/png';
    },
    /octet-stream/,
  ],
  [
    'custom encoding',
    (d) => {
      Object.assign(
        d.paths['/file'].post.requestBody.content['multipart/form-data'],
        { encoding: { file: { contentType: 'image/png' } } },
      );
    },
    /encoding.*unsupported/,
  ],
] satisfies [
  string,
  (d: ReturnType<typeof multipartFixture>) => void,
  RegExp,
][])
  void test(`multipart rejects ${name} before projection`, async () => {
    const document = multipartFixture();
    change(document);
    await assert.rejects(compile(document, multipartSelection), pattern);
  });

void test('standalone JSON validators cannot select binary components', async () => {
  const document = multipartFixture();
  Object.assign(document, { paths: {} });
  for (const usage of ['request', 'response'] as const)
    await assert.rejects(
      compile(document, {
        clients: [],
        standalone: { file: { schema: '#/components/schemas/File', usage } },
      }),
      /binary values.*multipart/,
    );
});
