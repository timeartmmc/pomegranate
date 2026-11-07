import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { commandError } from './assertions.ts';

export function responseDescriptorFixture() {
  return {
    openapi: '3.1.2',
    info: { title: 'Synthetic exact response descriptors', version: '1' },
    components: {
      schemas: {
        Payload: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
    },
    paths: {
      '/read': {
        get: {
          operationId: 'read',
          responses: {
            200: {
              description: 'Distinct media schemas and header requiredness',
              headers: {
                'X-Trace': {
                  required: true,
                  schema: { type: 'string', enum: ['AF', 'BE'] },
                },
                'X-Byte': { schema: { type: 'string', format: 'byte' } },
              },
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Payload' },
                },
                'application/vnd.audit+json': {
                  schema: { type: 'array', items: { type: 'integer' } },
                },
                'text/plain': { schema: { type: 'string', enum: ['plain'] } },
              },
            },
            206: {
              description: 'The same media has a different exact-status type',
              content: {
                'application/vnd.audit+json': {
                  schema: { type: 'boolean', enum: [true] },
                },
              },
            },
            400: {
              description: 'Declared text error',
              content: {
                'text/plain': { schema: { type: 'string', enum: ['denied'] } },
              },
            },
            410: {
              description: 'Bodyless error with exact header metadata',
              headers: {
                'X-State': {
                  required: true,
                  schema: { type: 'string', enum: ['gone'] },
                },
              },
            },
          },
        },
      },
      '/empty': {
        get: {
          operationId: 'empty',
          responses: { 204: { description: 'No body or declared headers' } },
        },
      },
    },
  };
}

export async function verifyResponseDescriptorDeclarations(
  directory: string,
  compiler: string,
): Promise<void> {
  await writeFile(
    join(directory, 'consumer.ts'),
    `import { operations } from './client.consumer.ts';
    import type { Operation, Parse } from './runtime.ts';
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Check<T extends true> = T;
    type Table<T> = T extends Operation<infer _Input, infer R, infer _Kind> ? R : never;
    type Parsed<T> = T extends Parse<infer Value> ? Value : never;
    export type ResponseTable = Table<typeof operations.read>;
    export type ExactMetadata = [
      Check<Same<ResponseTable[200]['headers']['x-trace']['required'], true>>,
      Check<Same<ResponseTable[200]['headers']['x-byte']['required'], false>>,
      Check<Same<Parsed<ResponseTable[200]['headers']['x-trace']['schema']>, 'AF' | 'BE'>>,
      Check<Same<ResponseTable[410]['headers']['x-state']['required'], true>>,
      Check<Same<Parsed<ResponseTable[410]['headers']['x-state']['schema']>, 'gone'>>,
      Check<Same<keyof ResponseTable[206]['headers'], never>>,
      Check<Same<keyof Table<typeof operations.empty>[204]['headers'], never>>,
      Check<Same<keyof ResponseTable[200]['content'], 'application/json' | 'application/vnd.audit+json' | 'text/plain'>>,
      Check<Same<ResponseTable[200]['content']['application/json']['bodyKind'], 'json'>>,
      Check<Same<ResponseTable[200]['content']['text/plain']['bodyKind'], 'text'>>,
      Check<Same<Parsed<ResponseTable[200]['content']['application/vnd.audit+json']['schema']>, number[]>>,
      Check<Same<Parsed<ResponseTable[206]['content']['application/vnd.audit+json']['schema']>, true>>,
      Check<Same<ResponseTable[410]['bodyKind'], 'none'>>
    ];
    export const parse: typeof operations.read.parseResponse = operations.read.parseResponse;
    export function readonlyMetadata(table: ResponseTable): void {
      // @ts-expect-error Header requiredness remains readonly.
      table[200].headers['x-trace'].required = true;
      // @ts-expect-error Media entries remain readonly.
      table[200].content['text/plain'] = table[200].content['text/plain'];
    }
    `,
  );
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    lib: ['ES2022', 'DOM'],
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    skipLibCheck: false,
  };
  await writeFile(
    join(directory, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        rewriteRelativeImportExtensions: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  const published = join(directory, 'published');
  await mkdir(published);
  const consumer = join(published, 'consumer.ts');
  await writeFile(
    consumer,
    `import {parse} from '../declarations/consumer.js';
    import type {ResponseTable, ExactMetadata} from '../declarations/consumer.js';
    type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
    type Check<T extends true> = T;
    export type Published = [ExactMetadata, Check<Same<ResponseTable[200]['headers']['x-trace']['required'], true>>, Check<Same<ResponseTable[200]['headers']['x-byte']['required'], false>>];
    const result = parse({status: 200, headers: {}, body: ''});
    if (result.kind === 'success' && result.status === 200) {
      if (result.contentType === 'application/json') {
        const id: string = result.data.id;
        // @ts-expect-error Object media cannot become text.
        const wrong: string = result.data;
        void [id, wrong];
      } else if (result.contentType === 'application/vnd.audit+json') {
        const values: number[] = result.data;
        // @ts-expect-error This exact status returns an array, not the 206 literal.
        const wrong: true = result.data;
        void [values, wrong];
      } else {
        const text: 'plain' = result.data;
        void text;
      }
    }
    if (result.kind === 'success' && result.status === 206) { const value: true = result.data; void value; }
    if (result.kind === 'error' && result.status === 400) { const text: 'denied' = result.data; void text; }
    if (result.kind === 'error' && result.status === 410) { const data: undefined = result.data; const media: undefined = result.contentType; void [data, media]; }
    if (result.kind === 'protocol') {
      // @ts-expect-error Protocol failures never gain data.
      void result.data;
    }
    `,
  );
  await writeFile(
    join(published, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      files: ['consumer.ts'],
    }),
  );
  try {
    await promisify(execFile)(process.execPath, [
      compiler,
      '-p',
      join(directory, 'tsconfig.json'),
    ]);
    const { stdout } = await promisify(execFile)(process.execPath, [
      compiler,
      '-p',
      join(published, 'tsconfig.json'),
      '--listFiles',
    ]);
    const files = stdout
      .trim()
      .split(/\r?\n/)
      .map((file) => resolve(file));
    assert.ok(files.includes(consumer));
    assert.ok(files.includes(join(directory, 'declarations', 'consumer.d.ts')));
    assert.ok(
      files.every(
        (file) =>
          !file.startsWith(directory) ||
          file === consumer ||
          file.endsWith('.d.ts'),
      ),
    );
  } catch (error) {
    const failure = commandError(error);
    failure.message += `\n${failure.stdout}${failure.stderr}`;
    throw failure;
  }
}
