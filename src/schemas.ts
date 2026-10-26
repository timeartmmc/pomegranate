import {
  contractField,
  fail,
  keys,
  record,
  safeKey,
  text,
  stringArray,
} from './diagnostics.js';
import {
  jsonAnnotation,
  schemaAnnotations,
  schemaAnnotationKeys,
} from './annotations.js';
import type { Constraints, Scalar, Schema } from './model.js';
import {
  assertScalarRules,
  intersectConstraints,
  literalViolation,
} from './scalar-rules.js';

const stringConstraints = ['minLength', 'maxLength', 'pattern'];
const numberConstraints = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
];
const arrayConstraints = ['minItems', 'maxItems'];
const constraintKeys = [
  ...stringConstraints,
  ...numberConstraints,
  ...arrayConstraints,
];

const maximumSchemaNesting = 128;
const maximumInlineSchemaNesting = 32;

function assertInlineSchemaNesting(nesting: number, location: string): void {
  if (nesting > maximumInlineSchemaNesting)
    fail(
      location,
      `inline schema nesting exceeds the supported limit of ${maximumInlineSchemaNesting} levels; use component references`,
    );
}

export function assertSchemaNesting(nesting: number, location: string): void {
  if (nesting > maximumSchemaNesting)
    fail(
      location,
      `schema nesting exceeds the supported limit of ${maximumSchemaNesting} levels`,
    );
}

function constraints(
  value: Record<string, unknown>,
  location: string,
): Constraints {
  // Parse sibling syntax before folding null-only literals. Check whether the
  // interval admits a value only for a retained scalar, array or ref target.
  const result = {
    ...bounds(value, 'minLength', 'maxLength', location, true),
    ...bounds(value, 'minItems', 'maxItems', location, true),
    ...bounds(value, 'minimum', 'maximum', location, false),
    ...bounds(value, 'exclusiveMinimum', 'exclusiveMaximum', location, false),
  };
  const multipleOf = bound(value, 'multipleOf', location, false);
  if (multipleOf !== undefined && multipleOf <= 0)
    fail(`${location}.multipleOf`, 'expected a positive number');
  let pattern: string | undefined;
  if (Object.hasOwn(value, 'pattern')) {
    if (typeof value.pattern !== 'string')
      fail(`${location}.pattern`, 'expected a string');
    pattern = value.pattern;
    try {
      new RegExp(pattern, 'u');
    } catch {
      fail(
        `${location}.pattern`,
        'expected a valid Unicode ECMAScript regular expression',
      );
    }
  }
  return {
    ...result,
    ...(multipleOf === undefined ? {} : { multipleOf }),
    ...(pattern === undefined ? {} : { pattern }),
  };
}

function bound(
  value: Record<string, unknown>,
  key: string,
  location: string,
  integer: boolean,
): number | undefined {
  if (!Object.hasOwn(value, key)) return undefined;
  const number = value[key];
  if (
    typeof number !== 'number' ||
    !Number.isFinite(number) ||
    (integer && (!Number.isSafeInteger(number) || number < 0))
  ) {
    fail(
      `${location}.${key}`,
      integer
        ? 'expected a nonnegative safe integer'
        : 'expected a finite number',
    );
  }
  return number;
}

function bounds(
  value: Record<string, unknown>,
  minimum: string,
  maximum: string,
  location: string,
  integer: boolean,
): Record<string, number> {
  const min = bound(value, minimum, location, integer);
  const max = bound(value, maximum, location, integer);
  return {
    ...(min === undefined ? {} : { [minimum]: min }),
    ...(max === undefined ? {} : { [maximum]: max }),
  };
}

function scalarValue(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function literals(
  value: Record<string, unknown>,
  kind: string,
  location: string,
  nullable = false,
): readonly Scalar[] | undefined {
  if (Object.hasOwn(value, 'const') && Object.hasOwn(value, 'enum'))
    fail(location, 'const and enum together are unsupported');
  const raw = Object.hasOwn(value, 'const') ? [value.const] : value.enum;
  if (!Object.hasOwn(value, 'const') && !Object.hasOwn(value, 'enum'))
    return undefined;
  if (!Array.isArray(raw) || raw.length === 0)
    fail(`${location}.enum`, 'expected a nonempty array');
  const result: Scalar[] = [];
  for (const item of raw) {
    const matches =
      kind === 'null'
        ? item === null
        : kind === 'integer'
          ? typeof item === 'number' && Number.isInteger(item)
          : typeof item === kind;
    if ((!matches && !(nullable && item === null)) || !scalarValue(item))
      fail(location, `literal must match type ${kind}`);
    if (result.includes(item)) fail(location, 'duplicate literal');
    result.push(item);
  }
  return result;
}

export function normalizeSchema(
  input: unknown,
  location: string,
  nesting = 1,
): Schema {
  // Bound schema recursion before entering either JS or the native formatter.
  // Annotation values have their own iterative validation and do not add depth.
  assertInlineSchemaNesting(nesting, location);
  const value = record(input, location);
  schemaAnnotations(value, location);
  const schema = normalizeShape(value, location, nesting);
  // Defaults describe server behavior. Never make an omitted request field
  // present, or let a default rescue a missing required value.
  if (!Object.hasOwn(value, 'default')) return schema;
  jsonAnnotation(value.default, `${location}.default`);
  return { ...schema, hasDefault: true };
}

export function componentName(name: string, location: string): string {
  // OAS component names are map keys, not TypeScript identifiers. The emitter
  // uses private symbols and preserves these names in quoted schema maps.
  if (name.length === 0 || /[^A-Za-z0-9._-]/.test(name))
    fail(location, 'component schema names must match [A-Za-z0-9._-]+');
  return safeKey(name, location);
}

function referenceName(input: unknown, location: string): string {
  const ref = text(input, location);
  const prefix = '#/components/schemas/';
  if (!ref.startsWith(prefix))
    fail(location, 'only local component schema references are supported');
  return componentName(ref.slice(prefix.length), location);
}

const annotationKeys = schemaAnnotationKeys;
const typedSchemaKeys = [...annotationKeys, 'type'];

function normalizeUnion(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
): Schema {
  const keyword = Object.hasOwn(value, 'anyOf') ? 'anyOf' : 'oneOf';
  keys(
    value,
    [
      keyword,
      ...annotationKeys,
      ...(keyword === 'oneOf' ? ['discriminator'] : []),
    ],
    location,
  );
  const raw = value[keyword];
  if (!Array.isArray(raw) || raw.length < 2)
    fail(`${location}.${keyword}`, 'expected at least two union branches');
  const branches = Array.from(raw, (branch: unknown, index) =>
    normalizeSchema(branch, `${location}.${keyword}[${index}]`, nesting + 1),
  );
  if (keyword === 'anyOf') return { kind: 'union', branches };
  const discriminator = record(
    value.discriminator,
    `${location}.discriminator`,
  );
  keys(discriminator, ['propertyName', 'mapping'], `${location}.discriminator`);
  const propertyName = contractField(
    text(discriminator.propertyName, `${location}.discriminator.propertyName`),
    `${location}.discriminator.propertyName`,
  );
  const mapping = Object.fromEntries(
    Object.entries(
      record(discriminator.mapping, `${location}.discriminator.mapping`),
    ).map(([tag, ref]) => [
      tag,
      referenceName(ref, `${location}.discriminator.mapping.${tag}`),
    ]),
  );
  return {
    kind: 'union',
    branches,
    discriminator: { propertyName, mapping },
  };
}

function normalizeObject(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
): Schema {
  keys(
    value,
    [...typedSchemaKeys, 'properties', 'required', 'additionalProperties'],
    location,
  );
  const properties = record(
    Object.hasOwn(value, 'properties') ? value.properties : {},
    `${location}.properties`,
  );
  const normalized = Object.fromEntries(
    Object.keys(properties)
      .sort()
      .map((name) => [
        contractField(name, `${location}.properties.${name}`),
        normalizeSchema(
          properties[name],
          `${location}.properties.${name}`,
          nesting + 1,
        ),
      ]),
  );
  const required = Object.hasOwn(value, 'required') ? value.required : [];
  if (!stringArray(required))
    fail(`${location}.required`, 'expected an array of property names');
  if (new Set(required).size !== required.length)
    fail(`${location}.required`, 'duplicate required property');
  for (const name of required)
    if (!Object.hasOwn(normalized, name))
      fail(`${location}.required`, `unknown property ${JSON.stringify(name)}`);
  if (
    Object.hasOwn(value, 'additionalProperties') &&
    value.additionalProperties !== false
  ) {
    if (Object.keys(properties).length > 0 || required.length > 0)
      fail(
        `${location}.additionalProperties`,
        'mixed fixed properties and dynamic maps are unsupported',
      );
    return {
      kind: 'map',
      values:
        value.additionalProperties === true
          ? true
          : normalizeSchema(
              value.additionalProperties,
              `${location}.additionalProperties`,
              nesting + 1,
            ),
    };
  }
  return {
    kind: 'object',
    properties: normalized,
    required: [...required].sort(),
  };
}

function normalizeScalar(
  value: Record<string, unknown>,
  location: string,
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'null',
  nullable = false,
): Schema {
  const allowedConstraints =
    kind === 'string'
      ? [...stringConstraints, 'format']
      : kind === 'number' || kind === 'integer'
        ? numberConstraints
        : [];
  keys(
    value,
    [...typedSchemaKeys, 'const', 'enum', ...allowedConstraints],
    location,
  );
  const allowed = literals(value, kind, location, nullable);
  const limits = constraints(value, location);
  let format: 'date' | 'date-time' | 'uuid' | undefined;
  if (Object.hasOwn(value, 'format')) {
    if (
      value.format !== 'date' &&
      value.format !== 'date-time' &&
      value.format !== 'uuid'
    )
      fail(
        `${location}.format`,
        'unsupported format; expected date, date-time or uuid',
      );
    format = value.format;
  }
  const nonNull = nullable ? allowed?.filter((item) => item !== null) : allowed;
  // A null-only literal assertion removes the non-null branch. Sibling syntax
  // must still be supported, but its numeric interval need not admit a value.
  if (nullable && nonNull?.length === 0) return { kind: 'null' };
  assertScalarRules(kind, limits, allowed, location, format);
  const scalar: Schema = {
    kind,
    ...limits,
    ...(format === undefined ? {} : { format }),
    ...(nonNull ? { literals: nonNull } : {}),
  };
  if (!nullable) return scalar;
  // type, enum and const are independent assertions. A nullable type must not
  // add null to an enum/const that excludes it, or retain non-null values when
  // the literal assertion permits only null.
  return allowed === undefined || allowed.includes(null)
    ? { kind: 'union', branches: [scalar, { kind: 'null' }] }
    : scalar;
}

function normalizeNullableType(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
): Schema {
  const types = value.type;
  if (Array.isArray(types) && types.includes(null))
    fail(
      `${location}.type`,
      'type arrays require string type names; use "null" (quote it in YAML) instead of a null value',
    );
  if (
    !stringArray(types) ||
    types.length !== 2 ||
    types[0] === types[1] ||
    !types.includes('null')
  )
    fail(
      `${location}.type`,
      'type arrays require one supported non-null type and null',
    );
  const kind = types[types[0] === 'null' ? 1 : 0];
  if (
    !kind ||
    !['object', 'array', 'string', 'number', 'integer', 'boolean'].includes(
      kind,
    )
  )
    fail(
      `${location}.type`,
      'type arrays require one supported non-null type and null',
    );
  let schema: Schema;
  if (
    kind === 'number' ||
    kind === 'integer' ||
    kind === 'boolean' ||
    (kind === 'string' &&
      value.format !== 'binary' &&
      !Object.hasOwn(value, 'contentMediaType'))
  ) {
    schema = normalizeScalar(value, location, kind, true);
  } else {
    // The virtual branch counts just like an explicit anyOf branch. Keep the
    // original location for diagnostics and all semantic siblings for validation.
    assertInlineSchemaNesting(nesting + 1, location);
    const branch = normalizeShape(
      { ...value, type: kind },
      location,
      nesting + 1,
    );
    schema = { kind: 'union', branches: [branch, { kind: 'null' }] };
  }
  if (schema.kind === 'union') assertInlineSchemaNesting(nesting + 1, location);
  return schema;
}

function normalizeShape(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
): Schema {
  if (Object.hasOwn(value, '$ref')) {
    keys(value, ['$ref', ...annotationKeys, ...constraintKeys], location);
    return {
      kind: 'ref',
      constraints: constraints(value, location),
      name: referenceName(value.$ref, `${location}.$ref`),
      location: `${location}.$ref`,
    };
  }
  if (Object.hasOwn(value, 'anyOf') || Object.hasOwn(value, 'oneOf'))
    return normalizeUnion(value, location, nesting);
  const kind = value.type;
  if (Array.isArray(kind))
    return normalizeNullableType(value, location, nesting);
  if (
    kind === 'string' &&
    (value.format === 'binary' || Object.hasOwn(value, 'contentMediaType'))
  ) {
    keys(value, [...typedSchemaKeys, 'format', 'contentMediaType'], location);
    if (Object.hasOwn(value, 'format') && value.format !== 'binary')
      fail(`${location}.format`, 'binary fields require format binary');
    if (
      Object.hasOwn(value, 'contentMediaType') &&
      value.contentMediaType !== 'application/octet-stream'
    )
      fail(
        `${location}.contentMediaType`,
        'only application/octet-stream binary fields are supported',
      );
    return { kind: 'binary' };
  }
  if (kind === 'object') return normalizeObject(value, location, nesting);
  if (kind === 'array') {
    keys(
      value,
      [...typedSchemaKeys, 'items', 'minItems', 'maxItems'],
      location,
    );
    const schema: Schema = {
      kind,
      items: normalizeSchema(value.items, `${location}.items`, nesting + 1),
      ...bounds(value, 'minItems', 'maxItems', location, true),
    };
    assertScalarRules(kind, schema, undefined, location);
    return schema;
  }
  if (
    kind === 'string' ||
    kind === 'number' ||
    kind === 'integer' ||
    kind === 'boolean' ||
    kind === 'null'
  )
    return normalizeScalar(value, location, kind);
  fail(
    `${location}.type`,
    'supported types are object, array, string, number, integer, boolean and null; type arrays require one supported non-null type and null; implicit types are unsupported',
  );
}

export function schemaReferences(
  schema: Schema,
): readonly Extract<Schema, { kind: 'ref' }>[] {
  if (schema.kind === 'ref') return [schema];
  if (schema.kind === 'array') return schemaReferences(schema.items);
  if (schema.kind === 'map')
    return schema.values === true ? [] : schemaReferences(schema.values);
  if (schema.kind === 'union') return schema.branches.flatMap(schemaReferences);
  if (schema.kind === 'object')
    return Object.values(schema.properties).flatMap(schemaReferences);
  return [];
}

type Usage = 'component' | 'request' | 'response' | 'multipart';
type ReferenceConstraints = {
  limits: Constraints;
  literals: readonly Scalar[] | undefined;
};
export function schemaValidation() {
  return {
    depths: new Map<Schema, number>(),
    checked: new Map<Usage, Set<Schema>>(),
    constraints: new Map<Schema, ReferenceConstraints>(),
  };
}

function measureSchema(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
  depths: Map<Schema, number>,
): number {
  const known = depths.get(schema);
  if (known !== undefined) return known;
  if (schema.kind === 'ref') {
    const aliases: Schema[] = [];
    let target: Schema = schema;
    let targetLocation = location;
    while (target.kind === 'ref' && !depths.has(target)) {
      if (!Object.hasOwn(schemas, target.name))
        fail(target.location, `unresolved reference ${target.name}`);
      aliases.push(target);
      targetLocation += ` -> components.schemas.${target.name}`;
      target = schemas[target.name]!;
    }
    const depth = measureSchema(target, schemas, targetLocation, depths);
    for (const alias of aliases) depths.set(alias, depth);
    return depth;
  }
  let depth = 1;
  const child = (value: Schema, path: string) => {
    depth = Math.max(depth, 1 + measureSchema(value, schemas, path, depths));
  };
  if (schema.kind === 'array') child(schema.items, `${location}.items`);
  else if (schema.kind === 'map' && schema.values !== true)
    child(schema.values, `${location}.additionalProperties`);
  else if (schema.kind === 'object')
    for (const [name, value] of Object.entries(schema.properties))
      child(value, `${location}.properties.${name}`);
  else if (schema.kind === 'union')
    schema.branches.forEach((value, index) =>
      child(
        value,
        `${location}.${schema.discriminator ? 'oneOf' : 'anyOf'}[${index}]`,
      ),
    );
  // This is a structural runtime bound. Emitted expression depth and compiler
  // inference are handled by flat typed bindings, without semantic cost weights.
  assertSchemaNesting(depth, location);
  depths.set(schema, depth);
  return depth;
}

function validateUnion(
  schema: Extract<Schema, { kind: 'union' }>,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
): void {
  if (!schema.discriminator) {
    const kinds = schema.branches
      .map((branch) => resolveSchema(branch, schemas).kind)
      .sort();
    if (
      kinds.length !== 2 ||
      !(
        kinds.filter((kind) => kind === 'null').length === 1 ||
        (kinds[0] === 'integer' && kinds[1] === 'string')
      )
    )
      fail(
        location,
        'supported anyOf forms are a nullable schema or string/integer union',
      );
    return;
  }
  const { propertyName, mapping } = schema.discriminator;
  const names = schema.branches.map((branch) => {
    if (
      branch.kind !== 'ref' ||
      Object.keys(branch.constraints).length > 0 ||
      branch.hasDefault
    )
      fail(
        location,
        'discriminated oneOf branches must be component references without constraints or defaults',
      );
    return branch.name;
  });
  if (
    new Set(names).size !== names.length ||
    Object.values(mapping).length !== names.length ||
    new Set(Object.values(mapping)).size !== names.length ||
    names.some((name) => !Object.values(mapping).includes(name))
  )
    fail(
      `${location}.discriminator.mapping`,
      'must cover every distinct oneOf branch exactly once',
    );
  for (const [tag, name] of Object.entries(mapping)) {
    const branch = resolveSchema(schemas[name]!, schemas);
    if (branch.kind !== 'object' || !branch.required.includes(propertyName))
      fail(
        location,
        'discriminator requires an object with a required tag field',
      );
    const field = resolveSchema(branch.properties[propertyName]!, schemas);
    if (
      field.kind !== 'string' ||
      field.literals?.length !== 1 ||
      field.literals[0] !== tag
    )
      fail(
        `${location}.discriminator.mapping.${tag}`,
        'tag must match the branch required string literal',
      );
  }
}

function validateReferenceConstraints(
  schema: Extract<Schema, { kind: 'ref' }>,
  resolved: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
  cache: Map<Schema, ReferenceConstraints>,
): void {
  if (
    resolved.kind !== 'string' &&
    resolved.kind !== 'number' &&
    resolved.kind !== 'integer' &&
    resolved.kind !== 'array'
  )
    return;
  const chain: Extract<Schema, { kind: 'ref' }>[] = [];
  let target: Schema = schema;
  while (target.kind === 'ref' && !cache.has(target)) {
    chain.push(target);
    target = schemas[target.name]!;
  }
  let rules = cache.get(target) ?? {
    limits: resolved,
    literals: resolved.kind === 'array' ? undefined : resolved.literals,
  };
  for (const reference of chain.reverse()) {
    const limits = intersectConstraints(rules.limits, reference.constraints);
    assertScalarRules(resolved.kind, limits, undefined, location);
    const violation = literalViolation(reference.constraints);
    const literals = rules.literals?.filter(
      (item) => violation(item) === undefined,
    );
    if (literals?.length === 0)
      fail(location, 'reference constraints admit no literal value');
    rules = { limits, literals };
    cache.set(reference, rules);
  }
}

function validateUsage(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
  usage: Usage,
  checked: Set<Schema>,
  constraintCache: Map<Schema, ReferenceConstraints>,
): void {
  if (checked.has(schema)) return;
  checked.add(schema);
  const visit = (value: Schema, path: string) =>
    validateUsage(value, schemas, path, usage, checked, constraintCache);
  if (usage === 'response' && schema.hasDefault)
    fail(`${location}.default`, 'response schemas must not declare defaults');
  if (
    schema.kind === 'binary' &&
    usage !== 'component' &&
    usage !== 'multipart'
  )
    fail(
      location,
      'binary values are only supported in multipart request fields',
    );
  if (schema.kind === 'ref') {
    const resolved = resolveSchema(schema, schemas);
    const allowed =
      resolved.kind === 'string'
        ? stringConstraints
        : resolved.kind === 'number' || resolved.kind === 'integer'
          ? numberConstraints
          : resolved.kind === 'array'
            ? arrayConstraints
            : [];
    // Alias depth is independent of data depth. Walk long chains iteratively,
    // checking intermediate defaults and constraints in this usage context.
    let target: Schema = schema;
    let targetLocation = location;
    while (target.kind === 'ref') {
      if (target !== schema && checked.has(target)) break;
      checked.add(target);
      if (usage === 'response' && target.hasDefault)
        fail(
          `${targetLocation}.default`,
          'response schemas must not declare defaults',
        );
      for (const name of Object.keys(target.constraints))
        if (!allowed.includes(name))
          fail(
            `${targetLocation}.${name}`,
            `constraint is unsupported on referenced ${resolved.kind}`,
          );
      targetLocation += ` -> components.schemas.${target.name}`;
      target = schemas[target.name]!;
    }
    validateReferenceConstraints(
      schema,
      resolved,
      schemas,
      location,
      constraintCache,
    );
    visit(target, targetLocation);
  } else if (schema.kind === 'array') visit(schema.items, `${location}.items`);
  else if (schema.kind === 'map' && schema.values !== true)
    visit(schema.values, `${location}.additionalProperties`);
  else if (schema.kind === 'object')
    for (const [name, value] of Object.entries(schema.properties))
      visit(value, `${location}.properties.${name}`);
  else if (schema.kind === 'union') {
    schema.branches.forEach((value, index) =>
      visit(
        value,
        `${location}.${schema.discriminator ? 'oneOf' : 'anyOf'}[${index}]`,
      ),
    );
    validateUnion(schema, schemas, location);
  }
}

export function validateSchema(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
  usage: Usage = 'component',
  cache = schemaValidation(),
): void {
  measureSchema(schema, schemas, location, cache.depths);
  let checked = cache.checked.get(usage);
  if (!checked) {
    checked = new Set();
    cache.checked.set(usage, checked);
  }
  validateUsage(schema, schemas, location, usage, checked, cache.constraints);
}

export function orderSchemas(
  schemas: Readonly<Record<string, Schema>>,
): readonly string[] {
  const ordered: string[] = [];
  const visited = new Set<string>();
  const pending = new Set<string>();
  const stack: {
    name: string;
    targets: Iterator<Extract<Schema, { kind: 'ref' }>>;
  }[] = [];
  const enter = (name: string, location: string): void => {
    if (visited.has(name)) return;
    if (pending.has(name))
      fail(location, `recursive schemas are unsupported (${name})`);
    if (!Object.hasOwn(schemas, name))
      fail(location, `unresolved reference ${name}`);
    pending.add(name);
    stack.push({ name, targets: schemaReferences(schemas[name]!).values() });
  };
  // Component aliases add no value nesting, so their graph can be much deeper
  // than an inline schema. Preserve depth-first order without the JS call stack.
  for (const name of Object.keys(schemas).sort()) {
    enter(name, `components.schemas.${name}`);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame.targets.next();
      if (next.done) {
        pending.delete(frame.name);
        visited.add(frame.name);
        ordered.push(frame.name);
        stack.pop();
      } else enter(next.value.name, next.value.location);
    }
  }
  return ordered;
}

export function resolveSchema(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
): Schema {
  // orderSchemas rejects cycles before any contract context resolves a schema.
  let resolved = schema;
  while (resolved.kind === 'ref') {
    if (!Object.hasOwn(schemas, resolved.name))
      fail(resolved.location, `unresolved reference ${resolved.name}`);
    resolved = schemas[resolved.name]!;
  }
  return resolved;
}
