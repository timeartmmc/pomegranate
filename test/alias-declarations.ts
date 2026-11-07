import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { Schema } from './schema-helpers.ts';

export function aliasDeclarationFixture() {
  const schemas: Record<string, Schema> = {
    Base: {
      type: 'object',
      properties: { value: { type: 'string', const: 'ready' } },
      required: ['value'],
    },
  };
  for (let index = 0; index < 3000; index++)
    schemas[`Alias${index}`] = {
      $ref: `#/components/schemas/${index === 2999 ? 'Base' : `Alias${index + 1}`}`,
    };
  const content = {
    'application/json': { schema: { $ref: '#/components/schemas/Alias0' } },
  };
  return {
    document: {
      openapi: '3.1.2',
      info: { title: 'Synthetic published alias chain', version: '1' },
      components: { schemas },
      paths: {
        '/value': {
          post: {
            operationId: 'save',
            requestBody: { required: true, content },
            responses: { 200: { description: 'Synthetic value', content } },
          },
        },
      },
    },
    options: {
      clients: ['consumer'],
      surfaces: { consumer: ['save'] },
      standalone: {
        root: { schema: '#/components/schemas/Alias0', usage: 'request' },
      },
    },
  } as const;
}

export async function verifyAliasDeclarations(
  root: string,
  compiler: string,
): Promise<void> {
  const exec = promisify(execFile);
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    types: [],
    strict: true,
    exactOptionalPropertyTypes: true,
  };
  await writeFile(
    join(root, 'emit.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        rewriteRelativeImportExtensions: true,
        rootDir: './source',
        outDir: './declarations',
      },
      include: ['./source/*.ts'],
    }),
  );
  await exec(process.execPath, [compiler, '-p', join(root, 'emit.json')]);
  await rm(join(root, 'source'), { recursive: true, force: true });
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import {schema} from './declarations/standalone.root.js';
    import {operations} from './declarations/client.consumer.js';
    import type {RequestTypes,ResponseTypes} from './declarations/client.consumer.js';
    const value: RequestTypes['Alias0'] = schema.parse({value:'ready'});
    const response: ResponseTypes['Alias0'] = value;
    operations.save.build({body:response});
    // @ts-expect-error Published aliases preserve the terminal literal.
    operations.save.build({body:{value:'wrong'}});
    // @ts-expect-error Published aliases preserve required fields.
    const missing: RequestTypes['Alias0'] = {}; void missing;
  `,
  );
  for (const skipLibCheck of [true, false]) {
    const config = join(root, `consumer-${skipLibCheck}.json`);
    await writeFile(
      config,
      JSON.stringify({
        compilerOptions: { ...options, noEmit: true, skipLibCheck },
        include: ['./consumer.ts'],
      }),
    );
    await exec(process.execPath, [compiler, '-p', config]);
  }
}
