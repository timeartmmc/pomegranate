import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
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
import type { RuntimeClient, StandaloneModule } from './runtime-types.ts';
import { ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const content = (schema: Schema) => ({ 'application/json': { schema } });
const response = (schema: Schema) => ({
  description: 'Synthetic dependency',
  content: content(schema),
});

void test('composed recursive parsers initialize their new component dependencies before imports execute', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const names of [
      ['Entry', 'Folder', 'User'],
      ['ZEntry', 'MFolder', 'AUser'],
    ] as const) {
      const [entryName, folderName, userName] = names;
      const document = {
        openapi,
        info: { title: 'Synthetic composed parser dependencies', version: '1' },
        components: {
          schemas: {
            [entryName]: {
              type: 'object',
              properties: {
                children: { type: 'array', items: ref(folderName) },
                owner: ref(userName),
              },
              required: ['owner'],
            },
            [folderName]: {
              allOf: [
                ref(entryName),
                {
                  type: 'object',
                  properties: { name: { type: 'string' } },
                  required: ['name'],
                },
              ],
            },
            [userName]: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
        paths: {
          '/folders': {
            post: {
              operationId: 'save',
              requestBody: {
                required: true,
                content: content(ref(folderName)),
              },
              responses: { 200: response(ref(folderName)) },
            },
          },
        },
      };
      const root = await generatedTestWorkspace(
        t,
        await compile(document, {
          clients: ['consumer'],
          surfaces: { consumer: ['save'] },
          standalone: {
            request: { schema: ref(folderName).$ref, usage: 'request' },
            response: { schema: ref(folderName).$ref, usage: 'response' },
          },
        }),
      );
      const client = await importGenerated<RuntimeClient>(
        root,
        'client.consumer.ts',
      );
      const value = {
        name: 'parent',
        owner: { id: 'owner' },
        children: [{ name: 'child', owner: { id: 'child-owner' } }],
      };
      const operation = entry(client.operations, 'save');
      assert.deepEqual(operation.build({ body: value }).body, value);
      const parsed = operation.parseResponse({
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(value),
      });
      assert.equal(parsed.kind, 'success');
      if (parsed.kind === 'success') assert.deepEqual(parsed.data, value);
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${usage}.ts`,
        );
        assert.deepEqual(schema.parse(value), value);
        assert.equal(
          schema.safeParse({ ...value, owner: { id: 1 } }).success,
          false,
        );
      }
    }
});

void test('parser initialization follows projected dependencies when directional fields break source cycles', async (t) => {
  for (const openapi of ['3.0.4', '3.1.2'])
    for (const annotation of ['readOnly', 'writeOnly']) {
      const document = {
        openapi,
        info: {
          title: 'Synthetic projected parser dependencies',
          version: '1',
        },
        components: {
          schemas: {
            A: {
              type: 'object',
              properties: {
                b: { allOf: [ref('B')], [annotation]: true },
                id: { type: 'string' },
              },
              required: ['id'],
            },
            B: {
              type: 'object',
              properties: { a: ref('A') },
              required: ['a'],
            },
          },
        },
        paths: {
          '/records': {
            post: {
              operationId: 'save',
              requestBody: { required: true, content: content(ref('B')) },
              responses: { 200: response(ref('B')) },
            },
          },
        },
      };
      const root = await generatedTestWorkspace(
        t,
        await compile(document, {
          clients: ['consumer'],
          surfaces: { consumer: ['save'] },
          standalone: {
            request: { schema: ref('B').$ref, usage: 'request' },
            response: { schema: ref('B').$ref, usage: 'response' },
          },
        }),
      );
      const client = await importGenerated<RuntimeClient>(
        root,
        'client.consumer.ts',
      );
      const value = { a: { id: 'visible' } };
      const operation = entry(client.operations, 'save');
      assert.deepEqual(operation.build({ body: value }).body, value);
      assert.equal(
        operation.parseResponse({
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(value),
        }).kind,
        'success',
      );
      for (const usage of ['request', 'response']) {
        const { schema } = await importGenerated<StandaloneModule>(
          root,
          `standalone.${usage}.ts`,
        );
        assert.deepEqual(schema.parse(value), value);
        assert.equal(schema.safeParse({ a: { id: 1 } }).success, false);
      }
    }
});

void test('consumer type closures exclude private components when canonical declarations share inline aliases across directions', async (t) => {
  for (const richRequest of [true, false]) {
    const exchange = (id: string, name: string, request: boolean) =>
      request
        ? {
            operationId: id,
            requestBody: { required: true, content: content(ref(name)) },
            responses: { 204: { description: 'Done' } },
          }
        : { operationId: id, responses: { 200: response(ref(name)) } };
    const document = {
      openapi: '3.1.2',
      info: { title: 'Synthetic directional type ownership', version: '1' },
      components: {
        schemas: {
          Base: {
            type: 'object',
            properties: {
              child: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
            required: ['child'],
          },
          Extended: {
            allOf: [
              ref('Base'),
              {
                type: 'object',
                properties: { extra: { type: 'string' } },
                required: ['extra'],
              },
            ],
          },
          Private: {
            type: 'object',
            properties: { privateOnly: { type: 'string' } },
            required: ['privateOnly'],
          },
        },
      },
      paths: {
        '/rich': { post: exchange('rich', 'Extended', richRequest) },
        '/base': { post: exchange('base', 'Base', richRequest) },
        '/private': { post: exchange('private', 'Private', richRequest) },
        '/lean': { post: exchange('lean', 'Extended', !richRequest) },
      },
    };
    const root = await generatedTestWorkspace(
      t,
      await compile(document, {
        clients: ['alpha', 'beta'],
        surfaces: { alpha: ['rich', 'base', 'private'], beta: ['lean'] },
        standalone: {
          lean: {
            schema: ref('Extended').$ref,
            usage: richRequest ? 'response' : 'request',
          },
        },
      }),
    );
    const type = richRequest ? 'ResponseTypes' : 'RequestTypes';
    await writeFile(
      join(root, 'consumer.ts'),
      `import type { ${type} } from './client.beta.ts';
       import type { Output } from './standalone.lean.ts';
       export const value: ${type}['Extended'] = {child:{value:'public'},extra:'public'};
       export const standalone: Output = value;
       // @ts-expect-error Unselected components are not part of this client.
       export type Private = ${type}['Private'];
       // @ts-expect-error Inline aliases retain their field types.
       export const invalid: Output = {child:{value:1},extra:'public'};
      `,
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
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
    const reachable = stdout
      .trim()
      .split(/\r?\n/)
      .filter((path) => {
        const name = relative(root, path);
        return (
          !name.startsWith(`..${sep}`) && !name.startsWith(`node_modules${sep}`)
        );
      });
    assert.ok(reachable.includes(join(root, 'consumer.ts')));
    assert.ok(reachable.some((path) => path.includes('schema-types.')));
    for (const path of reachable)
      assert.ok(
        !(await readFile(path, 'utf8')).includes('privateOnly'),
        `private component reached through ${relative(root, path)}`,
      );
  }
});
