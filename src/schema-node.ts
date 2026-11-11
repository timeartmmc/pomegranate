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
    uniqueItems: value.uniqueItems,
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
    case 'intersection':
      return {
        kind: value.kind,
        ...access,
        branches: value.branches,
        location: value.location,
        literals: value.literals,
      };
    case 'map':
      return {
        kind: value.kind,
        ...access,
        additionalPropertiesExplicit:
          value.additionalPropertiesExplicit === true,
        values: value.values,
        minProperties: value.minProperties,
        maxProperties: value.maxProperties,
      };
    case 'union':
      return {
        kind: value.kind,
        ...access,
        branches: value.branches,
        cardinality: value.cardinality ?? 'any',
        sourceTypeArray: value.sourceTypeArray,
        discriminator: value.discriminator,
      };
    case 'object':
      return {
        kind: value.kind,
        ...access,
        closed: value.closed === true,
        typeExplicit: value.typeExplicit !== false,
        additionalPropertiesExplicit:
          value.additionalPropertiesExplicit === true,
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
        uniqueItems: value.uniqueItems,
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

// Property tables follow ordinary record order: integer-like names first, in
// numeric order, then the remaining names sorted.
export function propertyOrder(names: Iterable<string>): string[] {
  return Object.keys(
    Object.fromEntries([...names].sort().map((name) => [name, true])),
  );
}

// Diagnostics name the source keyword that produced a union's branches.
export function unionKeyword(
  schema: Extract<Schema, { kind: 'union' }>,
): 'anyOf' | 'oneOf' {
  return schema.cardinality === 'one' ? 'oneOf' : 'anyOf';
}
