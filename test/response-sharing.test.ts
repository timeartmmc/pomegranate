import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { build } from 'esbuild';
import { stringify } from 'yaml';
import { compile } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import { present, record } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import { temporary } from './helpers.ts';
import type { RuntimeClient } from './runtime-types.ts';
import type { Schema } from './schema-helpers.ts';

const exec = promisify(execFile);
type Header = { schema: Schema; required?: boolean };
type Response = {
  description: string;
  headers?: Record<string, Header>;
  content?: Record<string, { schema: Schema }>;
};
type ResponseEntry = Response | { $ref: string };

function fixture(
  count = 12,
  references = false,
  errorStatuses: readonly number[] = [400, 404, 500],
) {
  const schemas: Record<string, Schema> = {
    Problem: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        code: { type: 'integer' },
      },
      required: ['message', 'code'],
    },
  };
  const error = (): Response => ({
    description: 'Synthetic common error',
    headers: {
      'X-Trace': {
        required: true,
        schema: { type: 'string', minLength: 1, pattern: '^[a-z0-9-]+$' },
      },
      'X-Mode': { schema: { type: 'string', enum: ['full', 'short'] } },
    },
    content: {
      'application/json': { schema: { $ref: '#/components/schemas/Problem' } },
      'application/problem+json': {
        schema: { $ref: '#/components/schemas/Problem' },
      },
      'text/plain': { schema: { type: 'string', minLength: 1 } },
    },
  });
  const ids: string[] = [];
  const paths: Record<
    string,
    { get: { operationId: string; responses: Record<string, ResponseEntry> } }
  > = {};
  for (let index = 0; index < count; index++) {
    const name = `Result${index}`;
    schemas[name] = {
      type: 'object',
      properties: { id: { type: 'string', const: `result${index}` } },
      required: ['id'],
    };
    const id = `read${index}`;
    ids.push(id);
    paths[`/items/${index}`] = {
      get: {
        operationId: id,
        responses: {
          200: {
            description: 'Synthetic success',
            content: {
              'application/json': {
                schema: { $ref: `#/components/schemas/${name}` },
              },
            },
          },
          204: { description: 'Synthetic empty success' },
          ...Object.fromEntries(
            errorStatuses.map((status) => [
              status,
              references
                ? { $ref: '#/components/responses/ErrorAlias' }
                : error(),
            ]),
          ),
        },
      },
    };
  }
  return {
    document: {
      openapi: '3.1.2',
      info: { title: 'Synthetic shared responses', version: '1' },
      components: {
        schemas,
        responses: {
          Error: error(),
          ErrorAlias: { $ref: '#/components/responses/Error' },
        },
      },
      paths,
    },
    options: { clients: ['consumer'], surfaces: { consumer: ids } },
  };
}

async function bundle(root: string, source: string): Promise<string> {
  const result = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: root },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    minify: true,
    logLevel: 'silent',
  });
  return present(result.outputFiles[0]).text;
}

void test('unique and small repeated response tables retain inline descriptors', async () => {
  for (const repeated of [false, true]) {
    const input = fixture(2);
    for (const path of Object.values(input.document.paths)) {
      path.get.responses = repeated
        ? { 204: { description: 'Synthetic empty response' } }
        : { 200: present(path.get.responses['200']) };
    }
    const files = await compile(input.document, input.options);
    // These tables cannot repay a separate typed binding; keep their small
    // literal representation instead of increasing generated-file overhead.
    assert.doesNotMatch(
      present(files['client.consumer.operations.ts']),
      /const response_[0-9]+:/,
    );
  }
});

void test('common responses retain inline/reference/YAML equivalence and bounded bundle growth', async (t) => {
  const input = fixture();
  const before = structuredClone(input);
  const files = await compile(input.document, input.options);
  assert.deepEqual(input, before);
  const referenced = fixture(12, true);
  assert.deepEqual(
    await compile(referenced.document, referenced.options),
    files,
  );
  assert.deepEqual(
    await compile(
      parseYaml(stringify(input.document), 'shared.yaml'),
      input.options,
    ),
    files,
  );
  input.document.paths = Object.fromEntries(
    Object.entries(input.document.paths).reverse(),
  );
  assert.deepEqual(await compile(input.document, input.options), files);
  const root = await generatedTestWorkspace(t, files);
  const one = await bundle(
    root,
    "export {operation_read0} from './client.consumer.operations.ts';",
  );
  const all = await bundle(
    root,
    "export {operations} from './client.consumer.operations.ts';",
  );
  // Each additional operation has its own success parser and binding. Its common
  // three errors must not add three more full media/header descriptor objects.
  assert.ok(Buffer.byteLength(all) < Buffer.byteLength(one) + 11 * 850);
});

void test('shared response metadata preserves status/media/header failures and detached data', async (t) => {
  const errorStatuses = [
    400, 401, 403, 404, 405, 409, 410, 412, 415, 422, 429, 500,
  ];
  const input = fixture(12, false, errorStatuses);
  for (const path of Object.values(input.document.paths))
    Object.assign(present(path.get.responses['200']), {
      headers: {
        'X-Receipt': {
          required: true,
          schema: { type: 'string', const: 'accepted' },
        },
      },
    });
  const files = await compile(input.document, input.options);
  // This many shared statuses selects the merged-map path. The assertions below
  // must exercise both halves, including their independent header/body rules.
  assert.match(
    present(files['client.consumer.operations.ts']),
    /mergeResponses\(/,
  );
  const root = await generatedTestWorkspace(t, files);
  const client = await importGenerated<RuntimeClient>(
    root,
    'client.consumer.ts',
  );
  for (const index of [0, 11]) {
    const operation = present(client.operations[`read${index}`]);
    for (const status of errorStatuses) {
      for (const contentType of [
        'application/json',
        'application/problem+json',
        'text/plain',
      ]) {
        const text = contentType === 'text/plain';
        const body = text
          ? 'problem'
          : JSON.stringify({ message: 'problem', code: status });
        const headers = {
          'content-type': contentType,
          'x-trace': 'trace',
          'x-mode': 'full',
        };
        const observed = { status, headers, body };
        const result = operation.parseResponse(observed);
        assert.equal(result.kind, 'error');
        if (result.kind === 'error') {
          assert.equal(result.status, status);
          assert.equal(result.contentType, contentType);
          assert.deepEqual(
            result.data,
            text ? 'problem' : { message: 'problem', code: status },
          );
          if (!text) {
            record(result.data).message = 'mutated';
            const other = present(
              client.operations[index === 0 ? 'read11' : 'read0'],
            );
            const repeated = other.parseResponse(observed);
            assert.equal(repeated.kind, 'error');
            if (repeated.kind === 'error')
              assert.deepEqual(repeated.data, {
                message: 'problem',
                code: status,
              });
          }
        }
        for (const invalidHeaders of [
          { ...headers, 'x-trace': 'INVALID!' },
          { ...headers, 'x-mode': 'unknown' },
          { 'content-type': contentType },
          { ...headers, 'content-type': 'application/unknown+json' },
        ])
          assert.equal(
            operation.parseResponse({ ...observed, headers: invalidHeaders })
              .kind,
            'protocol',
          );
        assert.equal(
          operation.parseResponse({
            ...observed,
            body: text ? '' : '{"code":"bad"}',
          }).kind,
          'protocol',
        );
      }
    }
    const success = operation.parseResponse({
      status: 200,
      headers: { 'content-type': 'application/json', 'x-receipt': 'accepted' },
      body: JSON.stringify({ id: `result${index}`, extra: 'stripped' }),
    });
    assert.equal(success.kind, 'success');
    if (success.kind === 'success')
      assert.deepEqual(success.data, { id: `result${index}` });
    for (const observed of [
      {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: `result${index}` }),
      },
      {
        status: 200,
        headers: { 'content-type': 'application/json', 'x-receipt': 'wrong' },
        body: JSON.stringify({ id: `result${index}` }),
      },
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-receipt': 'accepted',
        },
        body: JSON.stringify({ id: 'wrong' }),
      },
    ])
      assert.equal(operation.parseResponse(observed).kind, 'protocol');
    const empty = operation.parseResponse({
      status: 204,
      headers: {},
      body: '',
    });
    assert.equal(empty.kind, 'success');
    if (empty.kind === 'success') assert.equal(empty.data, undefined);
    assert.equal(
      operation.parseResponse({ status: 204, headers: {}, body: 'unexpected' })
        .kind,
      'protocol',
    );
    assert.equal(
      operation.parseResponse({ status: 501, headers: {}, body: '' }).kind,
      'protocol',
    );
  }
});

void test('shared response constants retain exact published metadata and isolated declarations', async (t) => {
  const input = fixture();
  const files = await compile(input.document, input.options);
  const root = await generatedTestWorkspace(t, files);
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import {operations} from './client.consumer.ts';
    import type {Operation,ObservedResponse} from './runtime.ts';
    type Cases=typeof operations.read0 extends Operation<infer _O,infer R,infer _B>?R:never;
    export function metadata(value:Cases): {required:true;optional:false;json:'json';text:'text'} {
      return {required:value[400].headers['x-trace'].required,optional:value[400].headers['x-mode'].required,json:value[400].content['application/problem+json'].bodyKind,text:value[400].content['text/plain'].bodyKind};
    }
    export function parse(value:ObservedResponse):ReturnType<typeof operations.read0.parseResponse> { return operations.read0.parseResponse(value); }
    const response=parse({status:400,headers:{},body:''});
    if(response.kind==='error'&&response.status===400) {
      if(response.contentType==='text/plain') { const text:string=response.data;void text; }
      else { const code:number=response.data.code; void code;
        // @ts-expect-error JSON error data preserves its declared numeric type.
        const wrong:string=response.data.code;void wrong;
      }
    }
  `,
  );
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    types: [],
  };
  const tsc = fileURLToPath(
    new URL('../node_modules/typescript/bin/tsc', import.meta.url),
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        allowImportingTsExtensions: true,
        outDir: './declarations',
      },
      include: ['./*.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'tsconfig.json')]);
  await Promise.all(
    [...Object.keys(files), 'consumer.ts'].map((name) => rm(join(root, name))),
  );
  await writeFile(
    join(root, 'published.ts'),
    `
    import {metadata,parse} from './declarations/consumer.js';
    const data=parse({status:200,headers:{},body:''});
    if(data.kind==='success'&&data.status===200) { const id:'result0'=data.data.id;void id; }
    type Metadata=ReturnType<typeof metadata>;
    const exact:Metadata={required:true,optional:false,json:'json',text:'text'};void exact;
    // @ts-expect-error Published requiredness stays literal.
    const wrong:Metadata={required:false,optional:false,json:'json',text:'text'};void wrong;
  `,
  );
  await writeFile(
    join(root, 'published.json'),
    JSON.stringify({
      compilerOptions: { ...options, noEmit: true },
      include: ['./published.ts'],
    }),
  );
  await exec(process.execPath, [tsc, '-p', join(root, 'published.json')]);
});

void test('response sharing preserves sparse operation/query and cross-client isolation', async (t) => {
  const input = fixture();
  input.document.components.schemas.PrivateError = {
    type: 'string',
    const: 'CANARY_UNUSED_RESPONSE',
  };
  input.document.components.schemas.StaffOnly = {
    type: 'string',
    const: 'CANARY_STAFF_RESPONSE',
  };
  for (const id of ['private0', 'private1', 'private2']) {
    input.options.surfaces.consumer.push(id);
    input.document.paths[`/${id}`] = {
      get: {
        operationId: id,
        responses: {
          200: {
            description: 'Private error',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/PrivateError' },
              },
            },
          },
        },
      },
    };
  }
  input.document.paths['/staff'] = {
    get: {
      operationId: 'staffOnly',
      responses: {
        200: {
          description: 'Staff response',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/StaffOnly' },
            },
          },
        },
      },
    },
  };
  const root = await generatedTestWorkspace(
    t,
    await compile(input.document, {
      ...input.options,
      clients: ['consumer', 'staff'],
      surfaces: { ...input.options.surfaces, staff: ['staffOnly'] },
      queries: { consumer: ['read0'] },
    }),
  );
  for (const source of [
    "export {operation_read0} from './client.consumer.operations.ts';",
    "export {createQueries} from './client.consumer.queries.ts';",
  ]) {
    const code = await bundle(root, source);
    for (const canary of [
      'CANARY_UNUSED_RESPONSE',
      'CANARY_STAFF_RESPONSE',
      '/private0',
      '/staff',
      '/items/11',
    ])
      assert.ok(!code.includes(canary), canary);
  }
  const full = await bundle(
    root,
    "export {operations} from './client.consumer.operations.ts';",
  );
  assert.ok(full.includes('CANARY_UNUSED_RESPONSE'));
  assert.ok(!full.includes('CANARY_STAFF_RESPONSE'));
});

void test('distinct policy profiles reject excessive source before formatting in a bounded child', async (t) => {
  const root = await temporary(t);
  const path = join(root, 'probe.mjs');
  await writeFile(
    path,
    `
    import assert from 'node:assert/strict';
    import {registerHooks} from 'node:module';
    registerHooks({resolve(specifier,context,next){if(specifier==='oxfmt')return {shortCircuit:true,url:'data:text/javascript,export function format(){throw new Error("formatting must follow admission")}'};return next(specifier,context)}});
    const {compile,ContractError}=await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
    const note='x'.repeat(256*1024),paths={},ids=[];
    // The large scalar is shared in input, while a small policy value makes
    // every emitted profile distinct. Actual source must still exceed 32 MiB.
    for(let i=0;i<200;i++){const id='read'+i;ids.push(id);paths['/items/'+i]={get:{operationId:id,'x-pom':{note,ordinal:i},responses:{204:{description:'Empty'}}}};}
    await assert.rejects(compile({openapi:'3.1.2',info:{title:'Synthetic prepared budget',version:'1'},'x-pom-policy':{version:3,fields:{note:{type:'string'},ordinal:{type:'integer'}}},paths},{clients:['consumer'],surfaces:{consumer:ids}}),error=>error instanceof ContractError&&/generated source exceeds the 32 MiB limit/.test(error.message));
    console.log('bounded rejection');
  `,
  );
  const result = await exec(
    process.execPath,
    ['--max-old-space-size=128', path],
    { timeout: 20_000 },
  );
  assert.equal(result.stdout, 'bounded rejection\n');
});
