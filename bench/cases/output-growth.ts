import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { record } from '../controller.ts';
import {
  jsonResponseExpected,
  jsonResponseInput,
  jsonResponseWorkload,
  verifyJsonResponseRejection,
  verifyJsonResponseValue,
} from './json-response.ts';

export const outputGrowthCase = Object.freeze({
  id: 'shared-contract-output',
  version: 1,
});
export const outputGrowthProfiles = Object.freeze([
  Object.freeze({ id: 'small', operations: 1, sections: 1 }),
  Object.freeze({ id: 'operations', operations: 32, sections: 1 }),
  Object.freeze({ id: 'schemas', operations: 1, sections: 8 }),
  Object.freeze({ id: 'combined', operations: 32, sections: 8 }),
] as const);
export type OutputGrowthProfile = (typeof outputGrowthProfiles)[number];

const suffix = (index: number) => String(index).padStart(3, '0');
const sectionNames = (profile: OutputGrowthProfile) =>
  Array.from(
    { length: profile.sections },
    (_, index) => `section${suffix(index)}`,
  );
const operationIds = (profile: OutputGrowthProfile) =>
  Array.from(
    { length: profile.operations },
    (_, index) => `summary${suffix(index)}`,
  );

export function outputGrowthWorkload(profile: OutputGrowthProfile) {
  assert.ok(
    outputGrowthProfiles.some(
      (known) =>
        known.id === profile.id &&
        known.operations === profile.operations &&
        known.sections === profile.sections,
    ),
  );
  const base = jsonResponseWorkload();
  const sections = sectionNames(profile);
  const schemas: Record<string, unknown> = {
    Record: base.document.components.schemas.Record,
    Summary: {
      type: 'object',
      required: ['sections'],
      properties: {
        sections: {
          type: 'object',
          required: sections,
          properties: Object.fromEntries(
            sections.map((name) => [
              name,
              { $ref: `#/components/schemas/${name}` },
            ]),
          ),
        },
      },
    },
  };
  for (const name of sections) {
    const page = structuredClone(base.document.components.schemas.RecordList);
    schemas[name] = {
      ...page,
      required: [...page.required, 'kind'],
      properties: {
        ...page.properties,
        kind: { type: 'string', enum: [name] },
      },
    };
  }
  return {
    options: base.options,
    document: {
      ...base.document,
      info: { title: 'Synthetic shared summaries', version: '1' },
      components: { schemas },
      paths: Object.fromEntries(
        operationIds(profile).map((id, index) => [
          `/summaries/${suffix(index)}`,
          {
            get: {
              operationId: id,
              'x-pom': { surfaces: ['consumer'] },
              responses: {
                '200': {
                  description: 'Shared summary',
                  content: {
                    'application/json': {
                      schema: { $ref: '#/components/schemas/Summary' },
                    },
                  },
                },
              },
            },
          },
        ]),
      ),
    },
  };
}

export function outputGrowthValues(profile: OutputGrowthProfile) {
  const names = sectionNames(profile);
  return {
    input: {
      sections: Object.fromEntries(
        names.map((name) => [name, { ...jsonResponseInput(), kind: name }]),
      ),
      serverOnly: 'strip',
    },
    expected: {
      sections: Object.fromEntries(
        names.map((name) => [name, { ...jsonResponseExpected(), kind: name }]),
      ),
    },
  };
}

export function outputGrowthConsumer(profile: OutputGrowthProfile): string {
  return `import {responseSchemas} from './client.consumer.schemas.ts';
import {operations} from './client.consumer.ts';
declare function text(value: string): void;
declare function number(value: number): void;
declare function otherKind(value: 'not-a-section'): void;
export function consume(input: unknown) {
  const result = responseSchemas.Summary.safeParse(input);
  operations.${operationIds(profile).at(-1)!}.build();
  if (result.success) {
    ${sectionNames(profile)
      .map(
        (name) => `{
      const page = result.data.sections.${name};
      const kind: '${name}' = page.kind;
      text(kind);
      const row = page.items[0]!;
      text(row.label);
      row.label = 'mutable output';
      // @ts-expect-error Response projection excludes the write-only field.
      row.secret;
      // @ts-expect-error A string label must not become any or a number.
      number(row.label);
      // @ts-expect-error Section discriminants must retain their exact literal.
      otherKind(page.kind);
    }`,
      )
      .join('\n')}
  }
}
`;
}

function invoke(
  owner: Record<string, unknown>,
  key: string,
  ...args: unknown[]
): unknown {
  const fn = owner[key];
  assert.ok(typeof fn === 'function', `${key}: expected a generated function`);
  const value: unknown = Reflect.apply(fn, owner, args);
  return value;
}

// Output size is meaningful only after every declared operation and the shared
// graph retain their behavior. Expectations come from hand-written case values,
// never from the candidate's emitted declarations or schema descriptors.
export function verifyOutputGrowth(
  profile: OutputGrowthProfile,
  clientModule: unknown,
  schemaModule: unknown,
): void {
  const { input, expected } = outputGrowthValues(profile);
  const validator = record(
    record(record(schemaModule).responseSchemas).Summary,
  );
  const subject = {
    validate: (value: unknown) => invoke(validator, 'safeParse', value),
  };
  const first = record(verifyJsonResponseValue(subject, input, expected));
  const second = verifyJsonResponseValue(subject, input, expected);
  const names = sectionNames(profile);
  const last = names.at(-1)!;
  const page = record(record(first.sections)[last]);
  assert.ok(Array.isArray(page.items));
  record(page.items[0]).label = 'output mutation';
  for (const name of names.filter((name) => name !== last))
    assert.deepEqual(
      record(first.sections)[name],
      expected.sections[name],
      'distinct input sections must keep independent output records',
    );
  assert.deepEqual(second, expected, 'results must remain independent');
  assert.deepEqual(
    outputGrowthValues(profile).input,
    input,
    'output mutation must not affect inputs',
  );
  const rejections = names.flatMap((name) => {
    const badTag = structuredClone(input);
    record(badTag.sections[name]!.items[1].details).tags = [''];
    const wrongKind = structuredClone(input);
    wrongKind.sections[name]!.kind = 'not-a-section';
    return [
      {
        value: badTag,
        path: ['sections', name, 'items', 1, 'details', 'tags', 0],
        label: `${name}: invalid shared tag`,
      },
      {
        value: wrongKind,
        path: ['sections', name, 'kind'],
        label: `${name}: invalid section kind`,
      },
    ];
  });
  for (const probe of rejections)
    verifyJsonResponseRejection(
      subject,
      probe.value,
      [probe.path],
      `${profile.id}/${probe.label}`,
    );

  const operations = record(record(clientModule).operations);
  assert.deepEqual(Object.keys(operations).sort(), operationIds(profile));
  for (const [index, id] of operationIds(profile).entries()) {
    const operation = record(operations[id]);
    const request = record(invoke(operation, 'build'));
    assert.equal(request.method, 'GET');
    assert.equal(request.url, `/summaries/${suffix(index)}`);
    const observed = {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    };
    const success = record(invoke(operation, 'parseResponse', observed));
    assert.equal(success.kind, 'success');
    assert.equal(success.operationId, id);
    assert.deepEqual(success.data, expected);
    for (const probe of rejections) {
      const failure = record(
        invoke(operation, 'parseResponse', {
          ...observed,
          body: JSON.stringify(probe.value),
        }),
      );
      assert.equal(failure.kind, 'protocol');
      assert.equal(failure.operationId, id);
      assert.ok(Array.isArray(failure.issues));
      assert.ok(
        failure.issues.some((issue: unknown) => {
          const value = record(issue);
          return (
            value.part === 'body' && isDeepStrictEqual(value.path, probe.path)
          );
        }),
        `${id}/${probe.label}: operation must retain the expected body diagnostic`,
      );
    }
  }
}
