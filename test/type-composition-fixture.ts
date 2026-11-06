import { execFile } from 'node:child_process';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { CompileOptions } from '../dist/index.js';
import { commandError } from './assertions.ts';
import { object, ref } from './schema-helpers.ts';
import type { Schema } from './schema-helpers.ts';

const roots = [
  ['wide', 'Wide'],
  ['access', 'Access'],
  ['inline-wide', 'InlineWide'],
  ['inline-thin', 'InlineThin'],
  ['maps', 'Maps'],
  ['arrays', 'Arrays'],
  ['varying-wide', 'VaryingWide'],
] as const;

export interface TypeCompositionCase {
  readonly name: string;
  readonly request: unknown;
  readonly response: unknown;
  readonly responseInput: unknown;
  readonly invalid: unknown;
}

function fixture() {
  const schemas: Record<string, Schema> = {};
  const cases: TypeCompositionCase[] = [];
  const fields = Object.fromEntries(
    Array.from({ length: 128 }, (_, index) => [
      `field${index}`,
      { type: 'string' },
    ]),
  );
  const values = Object.fromEntries(
    Object.keys(fields).map((name) => [name, name]),
  );
  // Selecting both directions combines width with a projected field.
  schemas.Wide = object(
    { ...fields, secret: { type: 'string', writeOnly: true } },
    ['field0', 'field127'],
  );
  cases.push({
    name: 'wide',
    request: { ...values, secret: 'private' },
    response: values,
    responseInput: { ...values, secret: 'removed' },
    invalid: { ...values, field127: 7 },
  });
  schemas.Access = object(
    {
      ...fields,
      id: { type: 'string', readOnly: true },
      optionalId: { type: 'string', readOnly: true },
      password: { type: 'string', writeOnly: true },
      note: { type: 'string', writeOnly: true },
    },
    ['field0', 'field127', 'id', 'password'],
  );
  cases.push({
    name: 'access',
    request: { ...values, password: 'private', note: 'private' },
    response: { ...values, id: 'record', optionalId: 'record' },
    responseInput: {
      ...values,
      id: 'record',
      optionalId: 'record',
      password: 'removed',
      note: 'removed',
    },
    invalid: { ...values, field127: 7 },
  });

  const leaf = object(
    {
      value: { type: 'string', const: 'leaf' },
      secret: { type: 'string', writeOnly: true },
    },
    ['value'],
  );
  // Thirty wrappers plus the leaf object/scalar reach the inline limit.
  for (const [name, component, depth, width] of [
    ['inline-wide', 'InlineWide', 4, 32],
    ['inline-thin', 'InlineThin', 30, 1],
  ] as const) {
    let schema: Schema = leaf;
    let request: unknown = { value: 'leaf', secret: 'private' };
    let response: unknown = { value: 'leaf' };
    let invalid: unknown = { value: 7 };
    for (let level = 0; level < depth; level++) {
      schema = object(
        {
          ...Object.fromEntries(
            Array.from({ length: width }, (_, index) => [
              `label${index}`,
              { type: 'string' },
            ]),
          ),
          child: schema,
          secret: { type: 'string', writeOnly: true },
        },
        ['child'],
      );
      request = { child: request, secret: 'private' };
      response = { child: response };
      invalid = { child: invalid };
    }
    schemas[component] = schema;
    cases.push({ name, request, response, responseInput: request, invalid });
  }

  schemas.Node = leaf;
  schemas.WrongNode = object({ value: { type: 'integer' } });
  schemas.RequiredNode = object({
    value: { type: 'string', const: 'leaf' },
    secret: { type: 'string', writeOnly: true },
  });
  // Runtime and declaration emission still cover the full supported data depth.
  // Cross-direction comparisons remain ordinary TypeScript comparisons.
  for (const [name, component, array] of [
    ['maps', 'Maps', false],
    ['arrays', 'Arrays', true],
  ] as const) {
    let previous = 'Node';
    for (let level = 1; level <= 126; level++) {
      const current = `${component}${level}`;
      schemas[current] = array
        ? { type: 'array', items: ref(previous) }
        : { type: 'object', additionalProperties: ref(previous) };
      previous = current;
    }
    schemas[component] = ref(previous);
    let request: unknown = { value: 'leaf', secret: 'private' };
    let response: unknown = { value: 'leaf' };
    let invalid: unknown = { value: 7 };
    for (let level = 0; level < 126; level++) {
      request = array ? [request] : { entry: request };
      response = array ? [response] : { entry: response };
      invalid = array ? [invalid] : { entry: invalid };
    }
    cases.push({ name, request, response, responseInput: request, invalid });
  }

  // Every common field inherits its directional difference through Node.
  schemas.VaryingWide = object(
    {
      ...Object.fromEntries(
        Object.keys(fields).map((name) => [name, ref('Node')]),
      ),
      secret: { type: 'string', writeOnly: true },
    },
    ['field0', 'field127'],
  );
  const varyingRequest = Object.fromEntries(
    Object.keys(fields).map((name) => [
      name,
      { value: 'leaf', secret: 'private' },
    ]),
  );
  const varyingResponse = Object.fromEntries(
    Object.keys(fields).map((name) => [name, { value: 'leaf' }]),
  );
  cases.push({
    name: 'varying-wide',
    request: { ...varyingRequest, secret: 'private' },
    response: varyingResponse,
    responseInput: { ...varyingRequest, secret: 'removed' },
    invalid: { ...varyingRequest, field127: { value: 7 } },
  });

  const response = (name: string) => ({
    200: {
      description: 'Synthetic composition',
      content: { 'application/json': { schema: ref(name) } },
    },
  });
  const save = (name: string, component: string) => ({
    operationId: name,
    requestBody: {
      required: true,
      content: { 'application/json': { schema: ref(component) } },
    },
    responses: response(component),
  });
  const paths: Record<string, unknown> = Object.fromEntries(
    roots.map(([name, component]) => [
      `/${name}`,
      { post: save(name, component) },
    ]),
  );
  paths['/wrong-node'] = {
    get: { operationId: 'wrongNode', responses: response('WrongNode') },
  };
  paths['/required-node'] = {
    post: save('requiredNode', 'RequiredNode'),
  };
  return {
    cases,
    document: {
      openapi: '3.1.2',
      info: { title: 'Synthetic directional compositions', version: '1' },
      components: { schemas },
      paths,
    },
  };
}

export const typeCompositionFixture = () => fixture().document;
export const typeCompositionCases = () => fixture().cases;
export const typeCompositionSelection = {
  clients: ['consumer'],
  surfaces: {
    consumer: [...roots.map(([name]) => name), 'wrongNode', 'requiredNode'],
  },
  standalone: Object.fromEntries(
    roots.flatMap(([name, component]) =>
      (['request', 'response'] as const).map((usage) => [
        `${name}-${usage}`,
        { schema: ref(component).$ref, usage },
      ]),
    ),
  ),
} satisfies CompileOptions;

export const typeCompositionConsumer = `
import {operations} from './generated/client.consumer.ts';
import type {RequestTypes,ResponseTypes} from './generated/client.consumer.ts';
${roots
  .flatMap(([name], index) =>
    (['request', 'response'] as const).map(
      (usage) =>
        `import {schema as ${usage}${index}} from './generated/standalone.${name}-${usage}.ts';`,
    ),
  )
  .join('\n')}
${roots
  .map(
    ([name, component], index) => `
export function consume${component}(raw:unknown) {
  const input:RequestTypes['${component}']=request${index}.parse(raw);
  const output:ResponseTypes['${component}']=response${index}.parse(raw);
  operations['${name}'].build({body:input});
  ${
    ['maps', 'arrays', 'inline-thin'].includes(name)
      ? ''
      : `${name === 'access' ? '// @ts-expect-error Responses lack the required write-only password and include forbidden id fields.' : ''}
  operations['${name}'].build({body:output});
  ${name === 'access' ? '// @ts-expect-error Requests omit the required read-only id.' : ''}
  const compatible:ResponseTypes['${component}']=input;
  void compatible;`
  }
  const observed=operations['${name}'].parseResponse({status:200,headers:{},body:''});
  if(observed.kind==='success') {
    const exact:ResponseTypes['${component}']=observed.data;
    void exact;
  }
  return {input,output};
}`,
  )
  .join('\n')}
export function exactFields(wide:RequestTypes['Wide'],varying:RequestTypes['VaryingWide'],thin:RequestTypes['InlineThin']) {
  const first:string=wide.field0;
  const last:string=wide.field127;
  const optional:string|undefined=wide.field64;
  const leaf:'leaf'=varying.field127.value;
  const deep:'leaf'=thin${'.child'.repeat(30)}.value;
  // @ts-expect-error A declared string field must remain a string.
  const wrong:number=wide.field127;
  // @ts-expect-error Declared child literals remain exact.
  const widened:'other'=varying.field0.value;
  // @ts-expect-error Undeclared fields remain absent.
  void wide.field128;
  void [first,last,optional,leaf,deep,wrong,widened];
}
export function access(input:RequestTypes['Access'],output:ResponseTypes['Access']) {
  // @ts-expect-error A read-only key remains forbidden when spreading a valid request.
  operations.access.build({body:{...input,id:'forbidden'}});
  // @ts-expect-error Optional read-only keys are forbidden too.
  operations.access.build({body:{...input,optionalId:'forbidden'}});
  // @ts-expect-error Required write-only fields cannot become optional.
  operations.access.build({body:{field0:'first',field127:'last'}});
  const id:string=output.id;
  // @ts-expect-error Write-only fields are absent from response types.
  void output.password;
  void id;
}
export function incompatible(wrong:ResponseTypes['WrongNode'],required:ResponseTypes['RequiredNode']) {
  // @ts-expect-error Named scalar fields retain their declared type.
  const input:RequestTypes['Node']=wrong;
  // @ts-expect-error A response omits the required write-only leaf field.
  operations.requiredNode.build({body:required});
  void input;
}
`;

// Share the same public assignments with the installed minimum-compiler check.
// Downstream declaration consumers run while the producer sources are hidden.
export async function verifyTypeComposition(
  root: string,
  compiler: string,
): Promise<void> {
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    noUncheckedIndexedAccess: true,
    noUnusedLocals: true,
    noUnusedParameters: true,
    skipLibCheck: false,
    types: [],
  };
  const source = join(root, 'composition-consumer.ts');
  const sourceConfig = join(root, 'composition-source.json');
  await writeFile(source, typeCompositionConsumer);
  await writeFile(
    sourceConfig,
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        rewriteRelativeImportExtensions: true,
        rootDir: '.',
        outDir: 'composition-declarations',
      },
      include: ['composition-consumer.ts', 'generated/*.ts'],
    }),
  );
  async function check(config: string) {
    try {
      await promisify(execFile)(process.execPath, [compiler, '-p', config], {
        cwd: root,
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      });
    } catch (error) {
      const failure = commandError(error);
      failure.message += `\n${failure.stdout}${failure.stderr}`;
      throw failure;
    }
  }
  await check(sourceConfig);
  const isolatedConfig = join(root, 'composition-isolated.json');
  await writeFile(
    isolatedConfig,
    JSON.stringify({
      compilerOptions: {
        ...options,
        declaration: true,
        emitDeclarationOnly: true,
        isolatedDeclarations: true,
        rewriteRelativeImportExtensions: true,
        rootDir: 'generated',
        outDir: 'composition-isolated',
      },
      include: ['generated/*.ts'],
    }),
  );
  await check(isolatedConfig);
  const generated = join(root, 'generated');
  const hidden = join(root, 'composition-producer');
  await rename(generated, hidden);
  try {
    await writeFile(
      join(root, 'composition-published.ts'),
      typeCompositionConsumer
        .replaceAll('./generated/', './composition-declarations/generated/')
        .replaceAll(".ts';", ".js';"),
    );
    const publishedConfig = join(root, 'composition-published.json');
    await writeFile(
      publishedConfig,
      JSON.stringify({
        compilerOptions: { ...options, noEmit: true },
        include: ['composition-published.ts'],
      }),
    );
    await check(publishedConfig);
  } finally {
    await rename(hidden, generated);
  }
}
