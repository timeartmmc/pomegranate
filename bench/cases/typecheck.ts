import assert from 'node:assert/strict';
import { record } from '../controller.ts';

export const typecheckCase = { id: 'core-typecheck', version: 2 } as const;

export interface TypecheckProfile {
  readonly id: string;
  readonly components: number;
  readonly operations: number;
  // Extra string fields; every object also has kind, score and tags.
  readonly width: number;
}

export const typecheckSmoke: TypecheckProfile = {
  id: 'smoke',
  components: 2,
  operations: 3,
  width: 2,
};
export const typecheckProfiles: readonly TypecheckProfile[] = [
  { id: 'base', components: 32, operations: 32, width: 1 },
  ...[600, 1200, 3000].map((count) => ({
    id: `distinct-${count}`,
    components: count,
    operations: count,
    width: 1,
  })),
  // 125 extra fields stays at the 128-property table boundary; 128 crosses
  // into chunked parsers. Keep both so the representation cliff is visible.
  ...[32, 125, 128].map((width) => ({
    id: `width-${width}`,
    components: 32,
    operations: 32,
    width,
  })),
  ...[1, 8].map((components) => ({
    id: `shared-${components}`,
    components,
    operations: 32,
    width: 1,
  })),
  { id: 'shared-wide', components: 1, operations: 32, width: 32 },
];

const modelName = (index: number) => `Model${String(index).padStart(5, '0')}`;
const operationId = (index: number) => `write${String(index).padStart(5, '0')}`;
const fields = (index: number, width: number) =>
  Array.from(
    { length: width },
    (_, offset) => `field${(index % 32) + offset * 32}`,
  );

export function typecheckWorkload(profile: TypecheckProfile) {
  const { components: count, operations, width } = profile;
  const ids = Array.from({ length: operations }, (_, index) =>
    operationId(index),
  );

  return {
    document: {
      openapi: '3.1.2',
      info: { title: 'Synthetic distinct parser graphs', version: '1' },
      components: {
        schemas: Object.fromEntries(
          Array.from({ length: count }, (_, index) => [
            modelName(index),
            {
              type: 'object',
              required: ['kind', 'score', 'tags', ...fields(index, width)],
              properties: {
                kind: { type: 'string', enum: [`kind${index}`] },
                ...Object.fromEntries(
                  fields(index, width).map((field) => [
                    field,
                    {
                      type: 'string',
                      minLength: (index % 32) + 1,
                    },
                  ]),
                ),
                score: { type: 'integer', minimum: 0 },
                tags: { type: 'array', items: { type: 'string' } },
              },
            },
          ]),
        ),
      },
      paths: Object.fromEntries(
        ids.map((operationId, index) => {
          const content = {
            'application/json': {
              schema: {
                $ref: `#/components/schemas/${modelName(index % count)}`,
              },
            },
          };
          return [
            `/items/${index}`,
            {
              post: {
                operationId,
                requestBody: { required: true, content },
                responses: {
                  200: { description: 'Synthetic success', content },
                },
              },
            },
          ];
        }),
      ),
    },
    options: {
      clients: ['consumer'],
      surfaces: { consumer: ids },
    },
  };
}

export const scaleCompilerOptions = {
  target: 'ES2022',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noUnusedLocals: true,
  noUnusedParameters: true,
  types: [],
  noEmit: true,
  allowImportingTsExtensions: true,
  skipLibCheck: false,
} as const;

// Qualification checks complete registries independently of the bounded type
// consumers. Omitting unprobed graphs must not look like a checking improvement.
export function verifyTypecheckInventory(
  profile: TypecheckProfile,
  client: unknown,
  schemas: unknown,
) {
  const operationIds = Array.from({ length: profile.operations }, (_, index) =>
    operationId(index),
  ).sort();
  const schemaNames = Array.from({ length: profile.components }, (_, index) =>
    modelName(index),
  ).sort();
  assert.deepEqual(
    Object.keys(record(record(client).operations)).sort(),
    operationIds,
    'generated operation inventory differs from workload',
  );
  for (const name of ['requestSchemas', 'responseSchemas']) {
    assert.deepEqual(
      Object.keys(record(record(schemas)[name])).sort(),
      schemaNames,
      `${name} inventory differs from workload`,
    );
  }
  return { operationIds, schemaNames };
}

// Small application-shaped call sites touch first, middle and last graphs. The
// project includes every generated module, independent of these selected uses.
export function typecheckConsumer(profile: TypecheckProfile): string {
  const selected = [
    ...new Set([0, Math.floor(profile.operations / 2), profile.operations - 1]),
  ];
  return `import {operations} from './client.consumer.ts';
import {requestSchemas, responseSchemas} from './client.consumer.schemas.ts';
declare function text(value: string): void;
declare function number(value: number): void;
declare function wrongKind(value: 'outside-contract'): void;
${selected
  .map((index) => {
    const component = index % profile.components;
    const model = modelName(component);
    const operation = operationId(index);
    return `export function consume${index}(input: unknown) {
  const parsed = requestSchemas.${model}.safeParse(input);
  if (!parsed.success) return;
  const body = parsed.data;
  const kind: 'kind${component}' = body.kind;
  text(kind);
  number(body.score);
  // @ts-expect-error Numeric fields must not become any.
  text(body.score);
  // @ts-expect-error Array elements must not become any.
  number(body.tags[0]!);
  body.tags.map(tag => tag.toUpperCase());
  ${fields(component, profile.width)
    .map((field) => `text(body.${field});`)
    .join('\n')}
  // @ts-expect-error String fields must not become any.
  number(body.${fields(component, profile.width)[0]!});
  // @ts-expect-error Literal identity must survive inference.
  wrongKind(body.kind);
  // @ts-expect-error Required input must remain required.
  operations.${operation}.build();
  const request = operations.${operation}.build({body});
  text(request.body.${fields(component, profile.width).at(-1)!});
  // @ts-expect-error Prepared body retains field types.
  number(request.body.${fields(component, profile.width)[0]!});
  const response = request.parseResponse({status: 200, headers: {}, body: ''});
  if (response.kind === 'success') {
    const status: 200 = response.status;
    const output = responseSchemas.${model}.parse(response.data);
    text(output.${fields(component, profile.width).at(-1)!});
    // @ts-expect-error Parsed numeric output must remain typed.
    text(output.score);
    // @ts-expect-error Parsed array elements must remain typed.
    number(output.tags[0]!);
    // @ts-expect-error Protocol numeric output must remain typed.
    text(response.data.score);
    // @ts-expect-error Protocol array output must remain typed.
    number(response.data.tags[0]!);
    // @ts-expect-error Validator output retains exact literals.
    wrongKind(output.kind);
    // @ts-expect-error Response data must remain typed.
    number(response.data.${fields(component, profile.width)[0]!});
    return {status, kind: output.kind, score: response.data.score};
  }
}`;
  })
  .join('\n')}
`;
}
