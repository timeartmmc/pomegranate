import type {
  ConstraintInput,
  Constraints,
  Schema,
  SchemaDraft,
} from './model.js';

// These constructors consume compiler-created data. Source records retain their
// descriptor-preserving own-property view at the diagnostics.record boundary.
export function constraintRecord(input: ConstraintInput = {}): Constraints {
  const value = Object.assign(Object.create(null) as ConstraintInput, input);
  return {
    minLength: value.minLength,
    maxLength: value.maxLength,
    pattern: value.pattern,
    minimum: value.minimum,
    maximum: value.maximum,
    exclusiveMinimum: value.exclusiveMinimum,
    exclusiveMaximum: value.exclusiveMaximum,
    multipleOf: value.multipleOf,
    float: value.float,
    minItems: value.minItems,
    maxItems: value.maxItems,
    minProperties: value.minProperties,
    maxProperties: value.maxProperties,
  };
}

export function constraintNames(value: Constraints): readonly string[] {
  return Object.keys(value).filter(
    (name) => Reflect.get(value, name) !== undefined,
  );
}

export function hasConstraints(value: Constraints): boolean {
  return Object.values(value).some((value) => value !== undefined);
}

export function schemaNode(input: SchemaDraft): Schema {
  const value = Object.assign(Object.create(null) as SchemaDraft, input);
  const access = {
    readOnly: value.readOnly === true,
    writeOnly: value.writeOnly === true,
  };
  switch (value.kind) {
    case 'json':
    case 'binary':
      return { kind: value.kind, ...access };
    case 'ref':
      return {
        kind: value.kind,
        ...access,
        name: value.name,
        location: value.location,
        constraints: value.constraints,
      };
    case 'map':
      return {
        kind: value.kind,
        ...access,
        values: value.values,
        minProperties: value.minProperties,
        maxProperties: value.maxProperties,
      };
    case 'union':
      return {
        kind: value.kind,
        ...access,
        branches: value.branches,
        sourceTypeArray: value.sourceTypeArray,
        discriminator: value.discriminator,
      };
    case 'object':
      return {
        kind: value.kind,
        ...access,
        properties: value.properties,
        required: value.required,
        forbidden: value.forbidden,
        minProperties: value.minProperties,
        maxProperties: value.maxProperties,
      };
    case 'array':
      return {
        kind: value.kind,
        ...access,
        items: value.items,
        minItems: value.minItems,
        maxItems: value.maxItems,
      };
    case 'string':
      return {
        kind: value.kind,
        ...access,
        format: value.format,
        literals: value.literals,
        minLength: value.minLength,
        maxLength: value.maxLength,
        pattern: value.pattern,
      };
    case 'number':
    case 'integer':
      return {
        kind: value.kind,
        ...access,
        literals: value.literals,
        minimum: value.minimum,
        maximum: value.maximum,
        exclusiveMinimum: value.exclusiveMinimum,
        exclusiveMaximum: value.exclusiveMaximum,
        multipleOf: value.multipleOf,
        float: value.float,
      };
    case 'boolean':
    case 'null':
      return { kind: value.kind, ...access, literals: value.literals };
  }
}
