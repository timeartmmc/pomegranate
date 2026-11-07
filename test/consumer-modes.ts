import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import type { Schema } from './schema-helpers.ts';

export function consumerModesFixture() {
  const document = executionFixture();
  const schemas: Record<string, Schema> = {};
  const standalone: Record<
    string,
    { schema: string; usage: 'request' | 'response' }
  > = {};
  schemas.NullFields = {
    type: 'object',
    required: ['required'],
    properties: {
      required: { type: 'null' },
      optional: { type: 'null' },
      read: { type: 'null', readOnly: true },
      write: { type: 'null', writeOnly: true },
    },
  };
  for (const usage of ['request', 'response'] as const)
    standalone[`null-${usage}`] = {
      schema: '#/components/schemas/NullFields',
      usage,
    };
  const content = {
    'application/json': { schema: { $ref: '#/components/schemas/NullFields' } },
  };
  Object.assign(document.paths, {
    '/nulls': {
      post: {
        operationId: 'saveNulls',
        'x-pom': {
          auth: 'session',
          retry: 'never',
          timeout: 'interactive',
          surfaces: ['consumer'],
        },
        requestBody: { required: true, content },
        responses: { 200: { description: 'Synthetic null fields', content } },
      },
    },
  });
  // Distinct chains exercise flattened rule dependencies, pure links and shared
  // ancestors in both directions, without depending on a random seed.
  for (let index = 0; index < 21; index++) {
    const base = `Base${index}`;
    const middle = `Middle${index}`;
    const end = `End${index}`;
    schemas[base] = { type: 'string', minLength: 1 };
    schemas[middle] = { $ref: `#/components/schemas/${base}`, maxLength: 32 };
    schemas[end] = {
      $ref: `#/components/schemas/${middle}`,
      pattern: '^[a-z]+$',
      minLength: 2,
    };
    const root = `Root${index}`;
    schemas[root] =
      index % 3 === 0
        ? { $ref: `#/components/schemas/${end}` }
        : {
            type: 'object',
            properties: { value: { $ref: `#/components/schemas/${end}` } },
            required: ['value'],
          };
    standalone[`root${index}`] = {
      schema: `#/components/schemas/${root}`,
      usage: index % 2 === 0 ? 'request' : 'response',
    };
  }
  Object.assign(document.components.schemas, schemas);
  return { document, options: { ...executionSelection, standalone } };
}

export async function verifyConsumerModes(
  root: string,
  compiler: string,
  apiModule: string,
): Promise<void> {
  await writeFile(
    join(root, 'compiler-api.ts'),
    `
    import {compile, runProject} from ${JSON.stringify(apiModule)};
    import type {CompileOptions} from ${JSON.stringify(apiModule)};
    export const options: CompileOptions = {clients: []};
    export const output: ReturnType<typeof compile> = compile({}, options);
    export const project: typeof runProject = runProject;
  `,
  );
  for (const [name, options] of [
    [
      'strict',
      {
        strict: true,
        exactOptionalPropertyTypes: true,
        noUncheckedIndexedAccess: true,
      },
    ],
    ['nonstrict', { strict: false }],
    ['nonstrict-implicit', { strict: false, noImplicitAny: true }],
  ] as const) {
    const config = join(root, `${name}.json`);
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          types: [],
          noEmit: true,
          allowImportingTsExtensions: true,
          noUnusedLocals: true,
          noUnusedParameters: true,
          skipLibCheck: false,
          ...options,
        },
        include: ['./*.ts'],
      }),
    );
    await promisify(execFile)(process.execPath, [compiler, '-p', config], {
      cwd: root,
    });
  }
}
