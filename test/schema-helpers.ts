// Fixture vocabulary, independent of POM's normalized contract types. Unknown
// keywords and annotation values are intentional inputs to compiler diagnostics.
export interface Schema {
  [keyword: string]: unknown;
  type?: string | string[];
  $ref?: string;
  properties?: Record<string, Schema>;
  required?: string[];
  items?: Schema;
  additionalProperties?: boolean | Schema;
  anyOf?: Schema[];
  oneOf?: Schema[];
  default?: unknown;
}

export interface SchemaCase {
  name: string;
  schema: Schema;
  samples: [unknown, boolean][];
}

export interface NullableCase extends SchemaCase {
  equivalent: Schema;
}

export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
export const nullable = <S extends Schema>(schema: S) => ({
  anyOf: [schema, { type: 'null' }],
});
export const object = <P extends Record<string, Schema>>(
  properties: P,
  required = Object.keys(properties),
) => ({ type: 'object', properties, required });
