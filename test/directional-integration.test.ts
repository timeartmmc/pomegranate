import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { compile, ContractError } from '../dist/index.js';
import type {
  PreparedRequest,
  RequestValidationError,
} from '../src/runtime.ts';
import { temporary } from './helpers.ts';

type ClientModule = {
  operations: Record<string, { build: (input?: unknown) => PreparedRequest }>;
  RequestValidationError: typeof RequestValidationError;
};
async function save(
  files: Readonly<Record<string, string>>,
  root: string,
): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(join(root, 'package.json'), '{"type":"module"}');
  for (const [name, source] of Object.entries(files))
    await writeFile(join(root, name), source);
}
async function client(root: string, surface: string): Promise<ClientModule> {
  return (await import(
    pathToFileURL(join(root, `client.${surface}.ts`)).href
  )) as ClientModule;
}

function uploadFixture() {
  const response = {
    200: {
      description: 'Synthetic upload receipt',
      content: {
        'application/json': { schema: { $ref: '#/components/schemas/Upload' } },
      },
    },
  };
  return {
    openapi: '3.1.0',
    info: { title: 'Synthetic directional multipart', version: '1' },
    components: {
      schemas: {
        UploadFile: { type: 'string', format: 'binary', writeOnly: true },
        Upload: {
          type: 'object',
          properties: {
            file: { $ref: '#/components/schemas/UploadFile' },
            caption: { type: 'string' },
            receipt: {
              type: 'object',
              readOnly: true,
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
          required: ['file', 'caption', 'receipt'],
          additionalProperties: false,
        },
      },
    },
    paths: {
      '/uploads': {
        post: {
          operationId: 'upload',
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: { $ref: '#/components/schemas/Upload' },
              },
            },
          },
          responses: response,
        },
      },
      '/receipts': {
        get: { operationId: 'receipt', responses: response },
      },
    },
  };
}
const memberships = { uploads: ['upload'], receipts: ['receipt'] };

void test('multipart fields and JSON response validation use their own projections', async (t) => {
  const document = uploadFixture();
  const before = structuredClone(document);
  const files = await compile(document, {
    clients: ['uploads'],
    surfaces: memberships,
    targets: { uploads: 'native' },
  });
  assert.deepEqual(document, before);
  const root = await temporary(t);
  await save(files, root);
  const module = await client(root, 'uploads');
  const operation = module.operations.upload;
  assert.ok(operation);
  const body = {
    file: { uri: 'file:///synthetic-upload' },
    caption: 'Visible',
  };
  const request = operation.build({ body });
  assert.equal(request.bodyKind, 'multipart');
  if (request.bodyKind !== 'multipart') throw new Error('Expected multipart');
  assert.deepEqual(request.multipart, [
    { name: 'caption', kind: 'text', multiple: false, required: true },
    { name: 'file', kind: 'file', multiple: false, required: true },
  ]);
  assert.deepEqual(request.body, body);
  assert.throws(
    () => operation.build({ body: { ...body, receipt: undefined } }),
    module.RequestValidationError,
  );
  assert.throws(
    () => operation.build({ body: { caption: 'Missing file' } }),
    module.RequestValidationError,
  );
  const response = request.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      caption: 'Visible',
      receipt: { id: 'receipt', extra: 'stripped' },
      file: { invalid: 'must be stripped without binary validation' },
    }),
  });
  assert.equal(response.kind, 'success');
  if (response.kind === 'success')
    assert.deepEqual(response.data, {
      caption: 'Visible',
      receipt: { id: 'receipt' },
    });
});

void test('response-only selection excludes write-only binary dependencies and platform types', async (t) => {
  const files = await compile(uploadFixture(), {
    clients: ['receipts'],
    surfaces: memberships,
  });
  assert.equal(Object.hasOwn(files, 'runtime.browser.ts'), false);
  assert.doesNotMatch(
    files['client.receipts.schemas.ts'] ?? '',
    /UploadFile|NativeFile|File/,
  );
  const root = await temporary(t);
  await save(files, root);
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import type {ResponseTypes} from './client.receipts.ts';
    export const receipt: ResponseTypes['Upload'] = {caption:'Visible',receipt:{id:'r'}};
    // @ts-expect-error Write-only file is absent from the response type.
    receipt.file;
    `,
  );
  await writeFile(
    join(root, 'platform.d.ts'),
    `declare class URLSearchParams {
      append(name: string, value: string): void;
      toString(): string;
    }`,
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
        lib: ['ES2022'],
        types: [],
      },
      include: ['./*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

for (const offset of [false, true]) {
  void test(`infinite ${offset ? 'offset' : 'cursor'} bindings reject metadata removed from responses`, async () => {
    const properties = offset
      ? {
          items: { type: 'array', items: { type: 'string' } },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          total: { type: 'integer', writeOnly: true },
        }
      : {
          items: { type: 'array', items: { type: 'string' } },
          next: { type: ['string', 'null'], writeOnly: true },
        };
    const document = {
      openapi: '3.1.0',
      info: { title: 'Synthetic projected pagination', version: '1' },
      components: {
        schemas: {
          Page: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
          },
        },
      },
      paths: {
        '/pages': {
          get: {
            operationId: 'page',
            parameters: [
              {
                name: offset ? 'offset' : 'cursor',
                in: 'query',
                schema: { type: offset ? 'integer' : 'string' },
              },
            ],
            responses: {
              200: {
                description: 'Page',
                content: {
                  'application/json': {
                    schema: { $ref: '#/components/schemas/Page' },
                  },
                },
              },
            },
          },
        },
      },
    };
    const binding = offset
      ? {
          offset: 'offset',
          responseOffset: 'offset',
          responseLimit: 'limit',
          total: 'total',
          items: 'items',
        }
      : { cursor: 'cursor', nextCursor: 'next', items: 'items' };
    await assert.rejects(
      compile(document, {
        clients: ['consumer'],
        surfaces: { consumer: ['page'] },
        infiniteQueries: { consumer: { page: binding } },
      }),
      (error) => {
        assert.ok(error instanceof ContractError);
        assert.equal(
          error.location,
          'infiniteQueries.consumer.page.responses.200.content.application/json',
        );
        assert.match(
          error.message,
          /pagination field.*must name an existing top-level response property/,
        );
        return true;
      },
    );
  });
}
