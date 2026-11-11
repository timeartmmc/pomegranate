import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { compile } from '../dist/index.js';
import { entry } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { RuntimeClient } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const content = (schema: Schema, media = 'application/json') => ({
  [media]: { schema },
});
const exchange = (operationId: string, name: string, multipart = false) => ({
  operationId,
  requestBody: {
    required: true,
    content: content(
      ref(name),
      multipart ? 'multipart/form-data' : 'application/json',
    ),
  },
  responses: {
    200: { description: 'Synthetic type graph', content: content(ref(name)) },
  },
});

const consumer = `
import type { RequestTypes as BrowserRequest, ResponseTypes as BrowserResponse } from './generated/client.browser.ts';
import type { RequestTypes as NativeRequest, ResponseTypes as NativeResponse } from './generated/client.native.ts';
import type { Output as StandaloneRequest } from './generated/standalone.request.ts';
import type { Output as StandaloneResponse } from './generated/standalone.response.ts';

export const request: BrowserRequest['Node'] = {
  label:'root',secret:'request',
  children:[{label:'child',secret:'nested'}],
  index:{child:{label:'indexed',secret:'nested'}},
};
export const nativeRequest: NativeRequest['Node'] = request;
export const alias: NativeRequest['Alias'] = nativeRequest;
export const standaloneRequest: StandaloneRequest = alias;
export const response: BrowserResponse['Node'] = {
  label:'root',id:'response',
  children:[{label:'child',id:'nested'}],
  index:{child:{label:'indexed',id:'nested'}},
};
export const nativeResponse: NativeResponse['Node'] = response;
export const standaloneResponse: StandaloneResponse = nativeResponse;
export const browserUpload: BrowserRequest['Upload'] = {label:'upload',file:new File(['bytes'],'file.txt')};
export const nativeUpload: NativeRequest['Upload'] = {label:'upload',file:{uri:'file:///synthetic/file.txt'}};
export const uploadResponse: BrowserResponse['Upload'] = {label:'upload',id:'response'};
export const sharedUploadResponse: NativeResponse['Upload'] = uploadResponse;
// @ts-expect-error Recursive map values preserve their object type.
export const invalidMap: StandaloneRequest = {label:'root',secret:'request',index:{child:1}};
// @ts-expect-error Recursive children retain directional requirements.
export const missingSecret: StandaloneRequest = {label:'root',secret:'request',children:[{label:'child'}]};
// @ts-expect-error Request types forbid read-only values, including spreads.
export const forbiddenId: StandaloneRequest = {...request,id:'response'};
// @ts-expect-error Response types exclude write-only fields.
export const forbiddenSecret: StandaloneResponse = {...response,secret:'request'};
// @ts-expect-error Browser files cannot be replaced with native references.
export const wrongBrowserFile: BrowserRequest['Upload'] = nativeUpload;
// @ts-expect-error Native references cannot be replaced with browser files.
export const wrongNativeFile: NativeRequest['Upload'] = browserUpload;
`;

void test('shared type modules preserve recursive, directional and binary identities without additional canonical bodies', async (t) => {
  const label = { type: 'string', minLength: 1 };
  const document = {
    openapi: '3.1.2',
    info: { title: 'Synthetic dependency type modules', version: '1' },
    components: {
      schemas: {
        Label: label,
        LabelTwin: { ...label },
        Node: {
          type: 'object',
          properties: {
            label: ref('Label'),
            id: { type: 'string', readOnly: true },
            secret: { type: 'string', writeOnly: true },
            children: { type: 'array', items: ref('Node') },
            index: ref('Directory'),
          },
          required: ['label', 'id', 'secret'],
        },
        Alias: ref('Node'),
        Directory: { type: 'object', additionalProperties: ref('Alias') },
        SharedBase: {
          type: 'object',
          properties: {
            detail: {
              type: 'object',
              properties: { sharedInlineMarker: { type: 'string' } },
              required: ['sharedInlineMarker'],
            },
          },
          required: ['detail'],
        },
        SharedExtended: {
          allOf: [
            ref('SharedBase'),
            {
              type: 'object',
              properties: { note: { type: 'string' } },
              required: ['note'],
            },
          ],
        },
        File: { type: 'string', format: 'binary' },
        Upload: {
          type: 'object',
          properties: {
            label: ref('Label'),
            id: { type: 'string', readOnly: true },
            file: { allOf: [ref('File')], writeOnly: true },
          },
          required: ['label', 'id', 'file'],
        },
      },
    },
    paths: {
      '/nodes': { post: exchange('save', 'Alias') },
      '/upload': { post: exchange('upload', 'Upload', true) },
      '/shared-base': { post: exchange('sharedBase', 'SharedBase') },
      '/shared-extended': {
        post: exchange('sharedExtended', 'SharedExtended'),
      },
      '/twin': {
        get: {
          operationId: 'twin',
          responses: {
            200: {
              description: 'Separate public identity',
              content: content(ref('LabelTwin')),
            },
          },
        },
      },
    },
  };
  const files = await compile(document, {
    clients: ['browser', 'native', 'twin'],
    surfaces: {
      browser: ['save', 'upload', 'sharedBase', 'sharedExtended'],
      native: ['save', 'upload', 'sharedBase', 'sharedExtended'],
      twin: ['twin'],
    },
    targets: { browser: 'browser', native: 'native' },
    standalone: {
      request: { schema: ref('Alias').$ref, usage: 'request' },
      response: { schema: ref('Alias').$ref, usage: 'response' },
    },
  });
  const sources = Object.values(files).join('\n');
  for (const [name, expected] of [
    ['Label', 1],
    ['LabelTwin', 1],
    ['Node', 2],
    ['Directory', 2],
    ['Alias', 0],
    ['SharedBase', 1],
    ['SharedExtended', 1],
    ['Upload', 3],
    ['File', 2],
  ] as const) {
    assert.equal(
      sources.match(
        new RegExp(`export type type_${name}_(?:request|response)\\s*=`, 'g'),
      )?.length ?? 0,
      expected,
      `${name} canonical bodies must follow direction, terminal identity and binary target`,
    );
  }
  assert.equal(
    sources.match(/export type [^=;\n]+ = \{\s*sharedInlineMarker: string/g)
      ?.length,
    1,
    'a shared inline body must not be copied into its composed parents or directional variants',
  );
  const root = await generatedTestWorkspace(t, files, 'generated');
  for (const target of ['browser', 'native']) {
    const client = await importGenerated<RuntimeClient>(
      root,
      `generated/client.${target}.ts`,
    );
    const value = {
      label: 'root',
      secret: 'request',
      children: [{ label: 'child', secret: 'nested' }],
    };
    assert.deepEqual(
      entry(client.operations, 'save').build({ body: value }).body,
      value,
    );
    const result = entry(client.operations, 'save').parseResponse({
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: 'root', id: 'response', secret: 'strip' }),
    });
    assert.equal(result.kind, 'success');
    if (result.kind === 'success')
      assert.deepEqual(result.data, { label: 'root', id: 'response' });
  }
  await writeFile(join(root, 'consumer.ts'), consumer);
  const compiler = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    types: [],
  };
  const check = async (name: string, publication = false) => {
    const config = join(root, `${name}.json`);
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          ...options,
          ...(publication
            ? {
                declaration: true,
                emitDeclarationOnly: true,
                outDir: 'declarations',
                rootDir: '.',
              }
            : { noEmit: true }),
          allowImportingTsExtensions: true,
        },
        include: [`${name}.ts`],
      }),
    );
    const { stdout } = await promisify(execFile)(process.execPath, [
      compiler,
      '-p',
      config,
      '--listFiles',
    ]);
    const reachable = stdout
      .trim()
      .split(/\r?\n/)
      .filter((path) => {
        const name = relative(root, path);
        return (
          !name.startsWith(`..${sep}`) && !name.startsWith(`node_modules${sep}`)
        );
      });
    assert.ok(reachable.includes(join(root, `${name}.ts`)));
    for (const path of reachable)
      assert.doesNotMatch(
        await readFile(path, 'utf8'),
        /type_LabelTwin_(?:request|response)/,
        `unselected identity reached via ${relative(root, path)}`,
      );
  };
  await check('consumer', true);
  await rm(join(root, 'generated'), { recursive: true });
  await rm(join(root, 'consumer.ts'));
  await writeFile(
    join(root, 'published.ts'),
    consumer
      .replaceAll('./generated/', './declarations/generated/')
      .replaceAll(".ts';", ".js';"),
  );
  await check('published');
});

for (const openapi of ['3.0.4', '3.1.2'])
  for (const scope of ['client', 'standalone'])
    void test(`parser annotations preserve ${scope} type isolation in OpenAPI ${openapi}`, async (t) => {
      const response = (name: string) => ({
        description: 'Synthetic annotation closure',
        content: content(ref(name)),
      });
      const files = await compile(
        {
          openapi,
          info: { title: 'Synthetic parser annotation roots', version: '1' },
          components: {
            schemas: {
              Kilo: {
                type: 'object',
                properties: {
                  p: {
                    type: 'object',
                    properties: { x: { type: 'string' } },
                  },
                },
              },
              Echo: {
                allOf: [
                  ref('Kilo'),
                  {
                    type: 'object',
                    properties: { privateMarker: { type: 'string' } },
                  },
                ],
              },
            },
          },
          paths: {
            '/kilo': { post: exchange('saveKilo', 'Kilo') },
            '/echo': {
              get: {
                operationId: 'getEcho',
                responses: { 200: response('Echo') },
              },
            },
          },
        },
        scope === 'client'
          ? {
              clients: ['c1', 'c2'],
              surfaces: { c1: ['getEcho'], c2: ['saveKilo'] },
            }
          : {
              clients: ['c1'],
              surfaces: { c1: ['getEcho', 'saveKilo'] },
              standalone: {
                request: { schema: ref('Kilo').$ref, usage: 'request' },
                response: { schema: ref('Kilo').$ref, usage: 'response' },
              },
            },
      );
      const root = await generatedTestWorkspace(t, files, 'generated');
      await writeFile(
        join(root, 'consumer.ts'),
        scope === 'client'
          ? `import type { RequestTypes, ResponseTypes } from './generated/client.c2.ts';
      export const request: RequestTypes['Kilo'] = {p:{x:'value'}};
      export const response: ResponseTypes['Kilo'] = request;
      // @ts-expect-error The other client's component is excluded.
      export type Unselected = ResponseTypes['Echo'];`
          : `
      import type { Output as Request } from './generated/standalone.request.ts';
      import type { Output as Response } from './generated/standalone.response.ts';
      export const standaloneRequest: Request = {p:{x:'value'}};
      export const standaloneResponse: Response = standaloneRequest;`,
      );
      await writeFile(
        join(root, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            strict: true,
            noEmit: true,
            allowImportingTsExtensions: true,
            types: [],
          },
          include: ['consumer.ts'],
        }),
      );
      const { stdout } = await promisify(execFile)(process.execPath, [
        fileURLToPath(
          new URL('../node_modules/typescript/bin/tsc', import.meta.url),
        ),
        '-p',
        join(root, 'tsconfig.json'),
        '--listFiles',
      ]);
      for (const path of stdout.trim().split(/\r?\n/))
        if (path.startsWith(`${join(root, 'generated')}${sep}`))
          assert.doesNotMatch(
            await readFile(path, 'utf8'),
            /type_Echo_|privateMarker/,
            `unselected component reached through ${relative(root, path)}`,
          );
    });
