import type {
  ConstraintInput,
  Constraints,
  Schema,
  SchemaDraft,
} from './model.js';

// Admission, reference checks and emission share the same source vocabulary.
export const stringConstraints = ['minLength', 'maxLength', 'pattern'] as const;
export const numberConstraints = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const;
export const arrayConstraints = [
  'minItems',
  'maxItems',
  'uniqueItems',
] as const;
export const objectConstraints = ['minProperties', 'maxProperties'] as const;
// Beside a single allOf reference, these restrict it like 3.1 reference
// siblings without repeating its type. Object count bounds instead compose as
// object fragments.
export const referenceConstraints: readonly string[] = [
  ...stringConstraints,
  ...numberConstraints,
  ...arrayConstraints,
];
export const constraintKeys = [...referenceConstraints, ...objectConstraints];

export const maximumSchemaNesting = 128;

// These constructors consume compiler-created data. Source records retain their
// descriptor-preserving own-property view at the diagnostics.record boundary.
// Read sparse metadata directly instead of allocating a temporary own-only copy.
function own<T extends object, K extends keyof T>(
  value: T,
  key: K,
): T[K] | undefined {
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

export function constraintRecord(value: ConstraintInput = {}): Constraints {
  return {
    minLength: own(value, 'minLength'),
    maxLength: own(value, 'maxLength'),
    pattern: own(value, 'pattern'),
    minimum: own(value, 'minimum'),
    maximum: own(value, 'maximum'),
    exclusiveMinimum: own(value, 'exclusiveMinimum'),
    exclusiveMaximum: own(value, 'exclusiveMaximum'),
    multipleOf: own(value, 'multipleOf'),
    float: own(value, 'float'),
    minItems: own(value, 'minItems'),
    maxItems: own(value, 'maxItems'),
    uniqueItems: own(value, 'uniqueItems'),
    minProperties: own(value, 'minProperties'),
    maxProperties: own(value, 'maxProperties'),
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

export function schemaNode(
  value: SchemaDraft,
  sourceAccess?: Pick<Schema, 'readOnly' | 'writeOnly'>,
): Schema {
  const access = {
    readOnly:
      own(value, 'readOnly') === true ||
      (sourceAccess !== undefined && own(sourceAccess, 'readOnly') === true),
    writeOnly:
      own(value, 'writeOnly') === true ||
      (sourceAccess !== undefined && own(sourceAccess, 'writeOnly') === true),
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
        branchLocations: own(value, 'branchLocations'),
        literals: own(value, 'literals'),
      };
    case 'map':
      return {
        kind: value.kind,
        ...access,
        additionalPropertiesExplicit:
          own(value, 'additionalPropertiesExplicit') === true,
        values: value.values,
        minProperties: own(value, 'minProperties'),
        maxProperties: own(value, 'maxProperties'),
      };
    case 'union':
      return {
        kind: value.kind,
        ...access,
        branches: value.branches,
        cardinality: own(value, 'cardinality') ?? 'any',
        sourceTypeArray: own(value, 'sourceTypeArray'),
        sourceLiterals: own(value, 'sourceLiterals'),
        discriminator: own(value, 'discriminator'),
      };
    case 'object':
      return {
        kind: value.kind,
        ...access,
        closed: own(value, 'closed') === true,
        typeExplicit: own(value, 'typeExplicit') !== false,
        additionalPropertiesExplicit:
          own(value, 'additionalPropertiesExplicit') === true,
        properties: value.properties,
        required: value.required,
        forbidden: own(value, 'forbidden'),
        minProperties: own(value, 'minProperties'),
        maxProperties: own(value, 'maxProperties'),
      };
    case 'array':
      return {
        kind: value.kind,
        ...access,
        items: value.items,
        minItems: own(value, 'minItems'),
        maxItems: own(value, 'maxItems'),
        uniqueItems: own(value, 'uniqueItems'),
      };
    case 'string':
      return {
        kind: value.kind,
        ...access,
        format: own(value, 'format'),
        literals: own(value, 'literals'),
        minLength: own(value, 'minLength'),
        maxLength: own(value, 'maxLength'),
        pattern: own(value, 'pattern'),
      };
    case 'number':
    case 'integer':
      return {
        kind: value.kind,
        ...access,
        literals: own(value, 'literals'),
        minimum: own(value, 'minimum'),
        maximum: own(value, 'maximum'),
        exclusiveMinimum: own(value, 'exclusiveMinimum'),
        exclusiveMaximum: own(value, 'exclusiveMaximum'),
        multipleOf: own(value, 'multipleOf'),
        float: own(value, 'float'),
      };
    case 'boolean':
    case 'null':
      return { kind: value.kind, ...access, literals: own(value, 'literals') };
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

export function schemaBranchLocation(
  schema: Extract<Schema, { kind: 'union' }>,
  location: string,
  index: number,
): string {
  return schema.sourceTypeArray
    ? location
    : `${location}.${unionKeyword(schema)}[${index}]`;
}
