import { json, record } from './assertions.ts';
import type { Schema } from './schema-helpers.ts';

// Shared with the isolated installed-package check. These values deliberately
// resemble unsupported schemas/policies: examples remain documentation data.
const sample = () =>
  json(
    '{"type":"not-a-schema","allOf":[],"default":null,"x-pom":{"auth":"unknown"},"__proto__":{"synthetic":true}}',
  );

function annotateSchema(schema: Schema) {
  schema.example = sample();
  schema.examples = [null, false, 0, '', sample()];
  schema.deprecated = true;
  for (const child of Object.values(schema.properties ?? {}))
    annotateSchema(child);
  if (schema.items) annotateSchema(schema.items);
  if (schema.additionalProperties && schema.additionalProperties !== true)
    annotateSchema(schema.additionalProperties);
  for (const child of schema.anyOf ?? schema.oneOf ?? []) annotateSchema(child);
}

function namedExamples() {
  return {
    local: {
      $ref: '#/components/examples/SampleAlias',
      summary: 'Local sample',
      description: 'Reference annotation',
    },
    inline: {
      value: sample(),
      summary: 'Inline sample',
      description: 'Example annotation',
    },
    external: { externalValue: 'https://example.invalid/never-fetched.json' },
    empty: {},
    null: { value: null },
    false: { value: false },
    zero: { value: 0 },
    text: { value: '' },
  };
}

// Read optional OpenAPI maps without assuming the caller's static document type.
const mapValues = (map: unknown) =>
  Object.values(record(map ?? {})).map(record);

export function annotateDocument<T extends object>(document: T): T {
  const root = record(document);
  record(root.info).license = { name: 'Synthetic license', identifier: 'MIT' };
  root.components ??= {};
  const components = record(root.components);
  components.examples = {
    Sample: { value: sample() },
    SampleAlias: { $ref: '#/components/examples/Sample', summary: 'Alias' },
  };
  for (const schema of mapValues(components.schemas)) annotateSchema(schema);
  for (const path of mapValues(root.paths)) {
    for (const method of [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'head',
      'options',
    ]) {
      if (!path[method]) continue;
      const operation = record(path[method]);
      operation.deprecated = true;
      const parameters: unknown[] = Array.isArray(operation.parameters)
        ? operation.parameters
        : [];
      for (const [index, value] of parameters.entries()) {
        const parameter = record(value);
        parameter.deprecated = index % 2 === 0;
        if (index % 2 === 0) parameter.example = sample();
        else parameter.examples = namedExamples();
        annotateSchema(record(parameter.schema));
      }
      const requestBody = record(operation.requestBody ?? {});
      for (const media of mapValues(requestBody.content)) {
        media.example = sample();
        annotateSchema(record(media.schema));
      }
      for (const response of mapValues(operation.responses)) {
        for (const media of mapValues(response.content)) {
          media.examples = namedExamples();
          annotateSchema(record(media.schema));
        }
        for (const header of mapValues(response.headers)) {
          header.deprecated = false;
          header.examples = namedExamples();
          annotateSchema(record(header.schema));
        }
      }
    }
  }
  return document;
}
