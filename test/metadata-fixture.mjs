// Shared with the isolated installed-package check. These values deliberately
// resemble unsupported schemas/policies: examples remain documentation data.
const sample = () =>
  JSON.parse(
    '{"type":"not-a-schema","allOf":[],"default":null,"x-pom":{"auth":"unknown"},"__proto__":{"synthetic":true}}',
  );

function annotateSchema(schema) {
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

export function annotateDocument(document) {
  document.info.license = { name: 'Synthetic license', identifier: 'MIT' };
  document.components ??= {};
  document.components.examples = {
    Sample: { value: sample() },
    SampleAlias: { $ref: '#/components/examples/Sample', summary: 'Alias' },
  };
  for (const schema of Object.values(document.components.schemas ?? {}))
    annotateSchema(schema);
  for (const path of Object.values(document.paths)) {
    for (const method of [
      'get',
      'post',
      'put',
      'patch',
      'delete',
      'head',
      'options',
    ]) {
      const operation = path[method];
      if (!operation) continue;
      operation.deprecated = true;
      for (const [index, parameter] of (operation.parameters ?? []).entries()) {
        parameter.deprecated = index % 2 === 0;
        if (index % 2 === 0) parameter.example = sample();
        else parameter.examples = namedExamples();
        annotateSchema(parameter.schema);
      }
      for (const media of Object.values(operation.requestBody?.content ?? {})) {
        media.example = sample();
        annotateSchema(media.schema);
      }
      for (const response of Object.values(operation.responses)) {
        for (const media of Object.values(response.content ?? {})) {
          media.examples = namedExamples();
          annotateSchema(media.schema);
        }
        for (const header of Object.values(response.headers ?? {})) {
          header.deprecated = false;
          header.examples = namedExamples();
          annotateSchema(header.schema);
        }
      }
    }
  }
  return document;
}
