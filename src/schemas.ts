import { RegExpSyntaxError, RegExpValidator } from '@eslint-community/regexpp';
import {
  arrayValues,
  ContractError,
  contractField,
  fail,
  keys,
  record,
  ownRecord,
  safeKey,
  text,
  stringArray,
  validComponentName,
} from './diagnostics.js';
import { localComponentReference } from './component-references.js';
import {
  jsonAnnotation,
  schemaAnnotations,
  schemaAnnotationKeys,
} from './annotations.js';
import type {
  ConstraintInput,
  Constraints,
  Scalar,
  Schema,
  SchemaDraft,
  SchemaTable,
  SchemaFormat,
  RegisteredStringFormat,
} from './model.js';
import {
  assertScalarRules,
  intersectConstraints,
  literalViolation,
} from './scalar-rules.js';
import {
  constraintRecord,
  constraintNames,
  hasConstraints,
  schemaNode,
} from './schema-node.js';
import { schemaAccess } from './directional.js';
import {
  builtInFormat,
  expectedStringFormats,
  numericFormatMessages,
  numericFormatRules,
  stringFormatHelpers,
} from './formats.js';
import type { StringFormat } from './runtime.js';
import { createSchemaAdmission } from './input-limits.js';

export type FormatRegistry = ReadonlyMap<string, RegisteredStringFormat>;

export function normalizeFormats(input: unknown = {}): FormatRegistry {
  const definitions = record(input, 'formats');
  return new Map(
    Object.keys(definitions)
      .sort()
      .map((name) => {
        const location = `formats.${name}`;
        safeKey(text(name, 'formats'), location);
        if (builtInFormat(name))
          fail(location, 'built-in formats cannot be overridden');
        const definition = record(definitions[name], location);
        keys(definition, ['type', 'pattern'], location);
        if (definition.type !== 'string')
          fail(`${location}.type`, 'registered formats require type string');
        if (typeof definition.pattern !== 'string')
          fail(`${location}.pattern`, 'expected a pattern string');
        // Reuse the schema pattern syntax and nesting budget, including for unused
        // definitions. The caller's definitions never enter the generated graph.
        const pattern = constraints(definition, location).pattern!;
        return [name, { name, pattern }];
      }),
  );
}

const stringConstraints = ['minLength', 'maxLength', 'pattern'];
const numberConstraints = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
];
const arrayConstraints = ['minItems', 'maxItems'];
const objectConstraints = ['minProperties', 'maxProperties'];
const constraintKeys = [
  ...stringConstraints,
  ...numberConstraints,
  ...arrayConstraints,
  ...objectConstraints,
];

const maximumSchemaNesting = 128;
const maximumInlineSchemaNesting = 32;
const maximumPatternNesting = 128;

function assertInlineSchemaNesting(nesting: number, location: string): void {
  if (nesting > maximumInlineSchemaNesting)
    fail(
      location,
      `inline schema nesting exceeds the supported limit of ${maximumInlineSchemaNesting} levels; use component references to split inline schemas within the ${maximumSchemaNesting}-level structural limit`,
    );
}

function patternFailure(error: unknown, pattern: string): string {
  if (!(error instanceof SyntaxError)) return '';
  const prefix = 'Invalid regular expression: ';
  const sourceEnd = prefix.length + 1 + pattern.length;
  let reason: string;
  // The pinned validator and V8 echo the complete source before their reason.
  // Use its known length: the pattern can itself contain the delimiter /u: .
  if (
    error.message.startsWith(`${prefix}/`) &&
    error.message.startsWith('/u: ', sourceEnd)
  )
    reason = error.message.slice(sourceEnd + '/u: '.length);
  else if (
    error.message.startsWith(prefix) &&
    !error.message.startsWith('/', prefix.length)
  )
    // JavaScriptCore reports a reason without echoing the source or an offset.
    reason = error.message.slice(prefix.length);
  else return '';
  if (!reason) return '';
  const maximum = 160;
  const escaped = JSON.stringify(reason.slice(0, maximum))
    .slice(1, -1)
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
  const detail =
    escaped.slice(0, maximum) +
    (reason.length > maximum || escaped.length > maximum ? '…' : '');
  // regexpp's index is a zero-based UTF-16 offset, including end-of-input.
  const position =
    error instanceof RegExpSyntaxError
      ? `at UTF-16 offset ${error.index}: `
      : '';
  return `; ${position}${detail}`;
}

function constraints(
  value: Record<string, unknown>,
  location: string,
): Constraints {
  // Parse sibling syntax before folding null-only literals. Check whether the
  // interval admits a value only for a retained scalar, container or ref target.
  const result = {
    ...bounds(value, 'minLength', 'maxLength', location, true),
    ...bounds(value, 'minItems', 'maxItems', location, true),
    ...bounds(value, 'minProperties', 'maxProperties', location, true),
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
      let nesting = 0;
      const enter = () => {
        if (++nesting > maximumPatternNesting)
          fail(
            `${location}.pattern`,
            `pattern nesting exceeds the supported limit of ${maximumPatternNesting} groups and lookaround assertions`,
          );
      };
      const leave = () => {
        nesting--;
      };
      // Keep syntax independent of the compiler's Node version. The exact
      // regexpp 4.12.1 pin supplies Unicode 16.0 property names, matching both
      // supported Node floors; 4.12.2 adds names unavailable there. Validation
      // builds no AST; keep this instance local so its last source is released.
      // Enter hooks run before recursive descent; escaped parens and class
      // characters never enter, and sequential groups release their depth.
      new RegExpValidator({
        ecmaVersion: 2024,
        onGroupEnter: enter,
        onGroupLeave: leave,
        onCapturingGroupEnter: enter,
        onCapturingGroupLeave: leave,
        onLookaroundAssertionEnter: enter,
        onLookaroundAssertionLeave: leave,
      }).validatePattern(pattern, 0, pattern.length, { unicode: true });
      new RegExp(pattern, 'u');
    } catch (error) {
      if (error instanceof ContractError) throw error;
      if (error instanceof RangeError)
        fail(
          `${location}.pattern`,
          'pattern validation exceeded available parser resources',
        );
      fail(
        `${location}.pattern`,
        'expected a valid Unicode ECMAScript 2024 regular expression with Unicode 16.0 property names' +
          patternFailure(error, pattern),
      );
    }
  }
  return constraintRecord({
    ...result,
    ...(multipleOf === undefined ? {} : { multipleOf }),
    ...(pattern === undefined ? {} : { pattern }),
  });
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
  const seen = new Set<Scalar>();
  for (const item of arrayValues(raw)) {
    const matches =
      kind === 'null'
        ? item === null
        : kind === 'integer'
          ? typeof item === 'number' && Number.isInteger(item)
          : typeof item === kind;
    if ((!matches && !(nullable && item === null)) || !scalarValue(item))
      fail(location, `literal must match type ${kind}`);
    if (seen.has(item)) fail(location, 'duplicate literal');
    seen.add(item);
    result.push(item);
  }
  return result;
}

export function createSchemaNormalizer(registered: FormatRegistry) {
  const admit = createSchemaAdmission();
  return (input: unknown, location: string): Schema => {
    admit(input, location);
    return normalizeSchema(input, location, 1, registered);
  };
}

export function normalizeSchema(
  input: unknown,
  location: string,
  nesting = 1,
  registered: FormatRegistry = new Map(),
): Schema {
  // Bound schema recursion before entering either JS or the native formatter.
  // Annotation values have their own iterative validation and do not add depth.
  assertInlineSchemaNesting(nesting, location);
  const value = record(input, location);
  if (Object.hasOwn(value, 'format')) {
    if (typeof value.format !== 'string')
      fail(`${location}.format`, 'expected a string');
    const type = value.type;
    const kind =
      Array.isArray(type) &&
      type.length === 2 &&
      stringArray(type) &&
      type.includes('null')
        ? type.find((name) => name !== 'null')
        : type;
    if (
      kind === 'boolean' ||
      kind === 'array' ||
      kind === 'object' ||
      kind === 'null'
    )
      fail(
        `${location}.format`,
        `format is not supported on ${kind} schemas in this version`,
      );
    if (!builtInFormat(value.format) && !registered.has(value.format)) {
      fail(
        `${location}.format`,
        kind === 'number' || kind === 'integer'
          ? numericFormatMessages[kind]
          : kind === 'string'
            ? 'unsupported format; use a built-in format or register a custom string format in formats'
            : 'unsupported format for this schema; supported formats require a string, number, or integer schema in this version',
      );
    }
  }
  schemaAnnotations(value, location);
  for (const name of ['readOnly', 'writeOnly'])
    if (Object.hasOwn(value, name) && typeof value[name] !== 'boolean')
      fail(`${location}.${name}`, 'expected a boolean');
  if (value.readOnly === true && value.writeOnly === true)
    fail(location, 'readOnly and writeOnly cannot both be true');
  const schema = {
    // Virtual nullable branches stay access-neutral. The source annotation
    // belongs to this declaration's outer node, including nullable wrappers.
    ...normalizeShape(value, location, nesting, registered),
    readOnly: value.readOnly === true,
    writeOnly: value.writeOnly === true,
  };
  // Defaults describe server behavior. Never make an omitted request field
  // present, or let a default rescue a missing required value.
  if (Object.hasOwn(value, 'default'))
    jsonAnnotation(value.default, `${location}.default`);
  return schema;
}

export function componentName(name: string, location: string): string {
  // OAS component names are map keys, not TypeScript identifiers. The emitter
  // uses private symbols and preserves these names in quoted schema maps.
  if (!validComponentName(name))
    fail(location, 'component schema names must match [A-Za-z0-9._-]+');
  return safeKey(name, location);
}

function referenceName(input: unknown, location: string): string {
  const ref = text(input, location);
  return componentName(
    localComponentReference(ref, 'schemas', location),
    location,
  );
}

const annotationKeys = [...schemaAnnotationKeys, 'readOnly', 'writeOnly'];
const typedSchemaKeys = [...annotationKeys, 'type'];

function normalizeUnion(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
): SchemaDraft {
  const keyword = Object.hasOwn(value, 'anyOf') ? 'anyOf' : 'oneOf';
  keys(
    value,
    [
      keyword,
      ...annotationKeys,
      ...(keyword === 'oneOf' ? ['discriminator'] : []),
    ],
    location,
    'schema',
  );
  const raw = value[keyword];
  if (!Array.isArray(raw) || raw.length < 2)
    fail(`${location}.${keyword}`, 'expected at least two union branches');
  const branches = Array.from(arrayValues(raw), (branch: unknown, index) =>
    normalizeSchema(
      branch,
      `${location}.${keyword}[${index}]`,
      nesting + 1,
      registered,
    ),
  );
  if (keyword === 'anyOf') return { kind: 'union', branches };
  if (!Object.hasOwn(value, 'discriminator'))
    fail(
      `${location}.discriminator`,
      'oneOf without a discriminator is not supported in this version; use anyOf for a non-null schema plus null, or string plus integer; tagged object alternatives require component references and a discriminator with propertyName and mapping',
    );
  const discriminator = record(
    value.discriminator,
    `${location}.discriminator`,
  );
  keys(discriminator, ['propertyName', 'mapping'], `${location}.discriminator`);
  const propertyName = contractField(
    text(discriminator.propertyName, `${location}.discriminator.propertyName`),
    `${location}.discriminator.propertyName`,
  );
  const mapping = new Map(
    Object.entries(
      Object.fromEntries(
        Object.entries(
          record(discriminator.mapping, `${location}.discriminator.mapping`),
        ).map(([tag, ref]) => [
          tag,
          referenceName(ref, `${location}.discriminator.mapping.${tag}`),
        ]),
      ),
    ),
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
  registered: FormatRegistry,
): SchemaDraft {
  keys(
    value,
    [
      ...typedSchemaKeys,
      'properties',
      'required',
      'additionalProperties',
      ...objectConstraints,
    ],
    location,
    'schema',
  );
  const limits = bounds(
    value,
    'minProperties',
    'maxProperties',
    location,
    true,
  );
  assertScalarRules('object', limits, undefined, location);
  const properties = record(
    Object.hasOwn(value, 'properties') ? value.properties : {},
    `${location}.properties`,
  );
  // Reapply ordinary record order: numeric property names enumerate first in
  // numeric order. Preserve that established ordering when moving into a Map.
  const normalized = new Map(
    Object.entries(
      Object.fromEntries(
        Object.keys(properties)
          .sort()
          .map((name) => [
            contractField(name, `${location}.properties.${name}`),
            normalizeSchema(
              properties[name],
              `${location}.properties.${name}`,
              nesting + 1,
              registered,
            ),
          ]),
      ),
    ),
  );
  const required = Object.hasOwn(value, 'required') ? value.required : [];
  if (!stringArray(required))
    fail(`${location}.required`, 'expected an array of property names');
  if (new Set(required).size !== required.length)
    fail(`${location}.required`, 'duplicate required property');
  for (const name of required)
    if (!normalized.has(name))
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
      ...limits,
      values:
        value.additionalProperties === true
          ? true
          : normalizeSchema(
              value.additionalProperties,
              `${location}.additionalProperties`,
              nesting + 1,
              registered,
            ),
    };
  }
  // JSON Schema admits any members when an object declares neither properties
  // nor additionalProperties. As a closed fixed object it would strip all
  // response data and reject every request member. additionalProperties: false
  // declares an object that must be empty.
  if (
    Object.keys(properties).length === 0 &&
    !Object.hasOwn(value, 'additionalProperties')
  )
    return { kind: 'map', values: true, ...limits };
  return {
    kind: 'object',
    properties: normalized,
    required: [...required].sort(),
    ...limits,
  };
}

function normalizeScalar(
  value: Record<string, unknown>,
  location: string,
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'null',
  registered: FormatRegistry,
  nullable = false,
): Schema {
  const allowedConstraints =
    kind === 'string'
      ? [...stringConstraints, 'format']
      : kind === 'integer' || kind === 'number'
        ? [...numberConstraints, 'format']
        : [];
  keys(
    value,
    [...typedSchemaKeys, 'const', 'enum', ...allowedConstraints],
    location,
    'schema',
  );
  const allowed = literals(value, kind, location, nullable);
  let limits = constraints(value, location);
  let format: SchemaFormat | undefined;
  // The password format is a presentation hint, not a validation assertion.
  // Preserve ordinary string rules without emitting an always-true predicate.
  if (
    Object.hasOwn(value, 'format') &&
    !(kind === 'string' && value.format === 'password')
  ) {
    if (typeof value.format === 'string' && registered.has(value.format)) {
      if (kind !== 'string')
        fail(
          `${location}.format`,
          'registered formats require a string schema',
        );
      format = registered.get(value.format)!;
    } else {
      if (kind === 'number' || kind === 'integer') {
        const rules =
          typeof value.format === 'string'
            ? numericFormatRules(kind, value.format)
            : undefined;
        if (rules === undefined)
          fail(`${location}.format`, numericFormatMessages[kind]);
        // Lower numeric wire profiles to shared scalar rules for literals,
        // reference intersections and generated parsers.
        limits = intersectConstraints(limits, rules);
      } else if (
        typeof value.format !== 'string' ||
        !Object.hasOwn(stringFormatHelpers, value.format)
      )
        fail(
          `${location}.format`,
          `unsupported format; expected ${expectedStringFormats}`,
        );
      else format = value.format as StringFormat;
    }
  }
  const nonNull = nullable ? allowed?.filter((item) => item !== null) : allowed;
  // A null-only literal assertion removes the non-null branch. Sibling syntax
  // must still be supported, but its numeric interval need not admit a value.
  if (nullable && nonNull?.length === 0) return schemaNode({ kind: 'null' });
  assertScalarRules(kind, limits, allowed, location, format);
  const scalar: Schema = schemaNode({
    kind,
    ...limits,
    ...(format === undefined ? {} : { format }),
    ...(nonNull ? { literals: nonNull } : {}),
  });
  if (!nullable) return scalar;
  // type, enum and const are independent assertions. A nullable type must not
  // add null to an enum/const that excludes it, or retain non-null values when
  // the literal assertion permits only null.
  return allowed === undefined || allowed.includes(null)
    ? schemaNode({
        kind: 'union',
        branches: [scalar, schemaNode({ kind: 'null' })],
      })
    : scalar;
}

function normalizeNullableType(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
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
    schema = normalizeScalar(value, location, kind, registered, true);
  } else {
    // The virtual branch counts just like an explicit anyOf branch. Keep the
    // original location for diagnostics and all semantic siblings for validation.
    assertInlineSchemaNesting(nesting + 1, location);
    const branch = normalizeShape(
      { ...value, type: kind },
      location,
      nesting + 1,
      registered,
    );
    schema = schemaNode({
      kind: 'union',
      branches: [branch, schemaNode({ kind: 'null' })],
    });
  }
  if (schema.kind === 'union') {
    assertInlineSchemaNesting(nesting + 1, location);
    return { ...schema, sourceTypeArray: true };
  }
  return schema;
}

function normalizeShape(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
): Schema {
  return schemaNode(
    normalizeShapeValue(ownRecord(value), location, nesting, registered),
  );
}

function normalizeShapeValue(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
): SchemaDraft {
  if (Object.hasOwn(value, 'allOf'))
    fail(`${location}.allOf`, 'allOf is not supported in this version');
  if (Object.hasOwn(value, '$ref')) {
    keys(
      value,
      ['$ref', ...annotationKeys, ...constraintKeys],
      location,
      'schema',
    );
    return {
      kind: 'ref',
      constraints: constraints(value, location),
      name: referenceName(value.$ref, `${location}.$ref`),
      location: `${location}.$ref`,
    };
  }
  if (Object.hasOwn(value, 'anyOf') || Object.hasOwn(value, 'oneOf'))
    return normalizeUnion(value, location, nesting, registered);
  if (Object.keys(value).every((key) => annotationKeys.includes(key)))
    return { kind: 'json' };
  const kind = value.type;
  if (Array.isArray(kind))
    return normalizeNullableType(value, location, nesting, registered);
  if (
    kind === 'string' &&
    (value.format === 'binary' || Object.hasOwn(value, 'contentMediaType'))
  ) {
    keys(
      value,
      [...typedSchemaKeys, 'format', 'contentMediaType'],
      location,
      'schema',
    );
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
  if (kind === 'object')
    return normalizeObject(value, location, nesting, registered);
  if (kind === 'array') {
    keys(
      value,
      [...typedSchemaKeys, 'items', 'minItems', 'maxItems'],
      location,
      'schema',
    );
    const schema: SchemaDraft = {
      kind,
      items: normalizeSchema(
        value.items,
        `${location}.items`,
        nesting + 1,
        registered,
      ),
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
    return normalizeScalar(value, location, kind, registered);
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
    return [...schema.properties.values()].flatMap(schemaReferences);
  return [];
}

type Usage = 'component' | 'request' | 'response' | 'multipart';
type ReferenceConstraints = {
  limits: ConstraintInput;
  literals: readonly Scalar[] | undefined;
};
export function schemaValidation() {
  return {
    depths: new Map<Schema, number>(),
    checked: new Map<Usage, Set<Schema>>(),
    constraints: new Map<Schema, ReferenceConstraints>(),
  };
}

export function schemaBranchLocation(
  schema: Extract<Schema, { kind: 'union' }>,
  location: string,
  index: number,
): string {
  return schema.sourceTypeArray
    ? location
    : `${location}.${schema.discriminator ? 'oneOf' : 'anyOf'}[${index}]`;
}

function measureSchema(
  schema: Schema,
  schemas: SchemaTable,
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
      if (!schemas.has(target.name))
        fail(target.location, `unresolved reference ${target.name}`);
      aliases.push(target);
      targetLocation += ` -> components.schemas.${target.name}`;
      target = schemas.get(target.name)!;
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
    for (const [name, value] of schema.properties)
      child(value, `${location}.properties.${name}`);
  else if (schema.kind === 'union')
    schema.branches.forEach((value, index) =>
      child(value, schemaBranchLocation(schema, location, index)),
    );
  // This is a structural runtime bound. Emitted expression depth and compiler
  // inference are handled by flat typed bindings, without semantic cost weights.
  if (depth > maximumSchemaNesting)
    fail(
      location,
      `schema nesting exceeds the supported limit of ${maximumSchemaNesting} levels; reduce structural nesting, including referenced schemas`,
    );
  depths.set(schema, depth);
  return depth;
}

function validateUnion(
  schema: Extract<Schema, { kind: 'union' }>,
  schemas: SchemaTable,
  location: string,
  usage: Usage,
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
    if (branch.kind !== 'ref' || hasConstraints(branch.constraints))
      fail(
        location,
        'discriminated oneOf branches must be component references without constraints',
      );
    return branch.name;
  });
  // Enumerating targets inside the membership loop makes large unions quadratic.
  const mappedNames = [...mapping.values()];
  const targets = new Set(mappedNames);
  if (
    new Set(names).size !== names.length ||
    mappedNames.length !== names.length ||
    targets.size !== names.length ||
    names.some((name) => !targets.has(name))
  )
    fail(
      `${location}.discriminator.mapping`,
      'must cover every distinct oneOf branch exactly once',
    );
  for (const [tag, name] of mapping) {
    const branch = resolveSchema(schemas.get(name)!, schemas);
    // Source validation already proved that the tag exists and is required.
    // Its absence from a projected object identifies a directional exclusion.
    if (
      usage !== 'component' &&
      branch.kind === 'object' &&
      !branch.properties.has(propertyName)
    ) {
      const direction = usage === 'response' ? 'responses' : 'requests';
      const annotation = usage === 'response' ? 'writeOnly' : 'readOnly';
      fail(
        `${location}.discriminator.propertyName`,
        `discriminator property ${JSON.stringify(propertyName)} must remain present and required in ${direction}; ${annotation} excludes it, so remove that annotation or use separate request and response schemas`,
      );
    }
    if (branch.kind !== 'object' || !branch.required.includes(propertyName))
      fail(
        location,
        'discriminator requires an object with a required tag field',
      );
    const field = resolveSchema(branch.properties.get(propertyName)!, schemas);
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
  schemas: SchemaTable,
  location: string,
  cache: Map<Schema, ReferenceConstraints>,
): void {
  if (
    resolved.kind !== 'string' &&
    resolved.kind !== 'number' &&
    resolved.kind !== 'integer' &&
    resolved.kind !== 'array' &&
    resolved.kind !== 'object' &&
    resolved.kind !== 'map'
  )
    return;
  const chain: Extract<Schema, { kind: 'ref' }>[] = [];
  let target: Schema = schema;
  while (target.kind === 'ref' && !cache.has(target)) {
    chain.push(target);
    target = schemas.get(target.name)!;
  }
  let rules = cache.get(target) ?? {
    limits: resolved,
    literals:
      resolved.kind === 'string' ||
      resolved.kind === 'number' ||
      resolved.kind === 'integer'
        ? resolved.literals
        : undefined,
  };
  for (const reference of chain.reverse()) {
    const limits = intersectConstraints(rules.limits, reference.constraints);
    assertScalarRules(resolved.kind, limits, undefined, location);
    // Literal sets are immutable. Pure references and constraints that retain
    // every member must not multiply the same wide enum in the validation cache.
    let literals = rules.literals;
    if (literals !== undefined && hasConstraints(reference.constraints)) {
      const violation = literalViolation(reference.constraints);
      const narrowed = literals.filter((item) => violation(item) === undefined);
      if (narrowed.length !== literals.length) literals = narrowed;
    }
    if (literals?.length === 0)
      fail(location, 'reference constraints admit no literal value');
    rules = { limits, literals };
    cache.set(reference, rules);
  }
}

function validateUsage(
  schema: Schema,
  schemas: SchemaTable,
  location: string,
  usage: Usage,
  checked: Set<Schema>,
  constraintCache: Map<Schema, ReferenceConstraints>,
): void {
  if (checked.has(schema)) return;
  checked.add(schema);
  const visit = (value: Schema, path: string) =>
    validateUsage(value, schemas, path, usage, checked, constraintCache);
  const access = schemaAccess(schema, schemas);
  if (access.readOnly && access.writeOnly)
    fail(
      location,
      'readOnly and writeOnly cannot both be true through references',
    );
  if (usage !== 'component') {
    const excluded = usage === 'response' ? access.writeOnly : access.readOnly;
    if (excluded)
      fail(
        location,
        `${usage === 'response' ? 'writeOnly' : 'readOnly'} schemas may only be omitted as object properties in ${usage === 'response' ? 'responses' : 'requests'}`,
      );
  }
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
            : resolved.kind === 'object' || resolved.kind === 'map'
              ? objectConstraints
              : [];
    // Alias depth is independent of data depth. Walk long chains iteratively,
    // checking intermediate constraints in this usage context.
    let target: Schema = schema;
    let targetLocation = location;
    while (target.kind === 'ref') {
      if (target !== schema && checked.has(target)) break;
      checked.add(target);
      for (const name of constraintNames(target.constraints))
        if (!allowed.includes(name))
          fail(
            `${targetLocation}.${name}`,
            `constraint is unsupported on referenced ${resolved.kind}`,
          );
      targetLocation += ` -> components.schemas.${target.name}`;
      target = schemas.get(target.name)!;
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
    for (const [name, value] of schema.properties)
      visit(value, `${location}.properties.${name}`);
  else if (schema.kind === 'union') {
    schema.branches.forEach((value, index) => {
      const branchLocation = schemaBranchLocation(schema, location, index);
      const branchAccess = schemaAccess(value, schemas);
      if (branchAccess.readOnly || branchAccess.writeOnly)
        fail(
          branchLocation,
          'readOnly and writeOnly on union branches are not supported in this version; remove the annotation from the branch or its referenced component; use separate request and response schemas when their shapes differ',
        );
      visit(value, branchLocation);
    });
    validateUnion(schema, schemas, location, usage);
  }
}

export function validateSchema(
  schema: Schema,
  schemas: SchemaTable,
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

export function orderSchemas(schemas: SchemaTable): readonly string[] {
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
    if (!schemas.has(name)) fail(location, `unresolved reference ${name}`);
    pending.add(name);
    stack.push({
      name,
      targets: schemaReferences(schemas.get(name)!).values(),
    });
  };
  // Component aliases add no value nesting, so their graph can be much deeper
  // than an inline schema. Preserve depth-first order without the JS call stack.
  for (const name of [...schemas.keys()].sort()) {
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

// A normalized schema table belongs to one descriptor and is never mutated.
// Cache only terminal resolution: usage checks must still visit intermediate
// sibling constraints. Weak keys release the cache with its table,
// and compiling the same mutable input again creates a separate normalized table.
const terminalSchemas = new WeakMap<SchemaTable, WeakMap<Schema, Schema>>();

export function resolveSchema(schema: Schema, schemas: SchemaTable): Schema {
  // orderSchemas rejects cycles before any contract context resolves a schema.
  if (schema.kind !== 'ref') return schema;
  let cache = terminalSchemas.get(schemas);
  if (!cache) {
    cache = new WeakMap();
    terminalSchemas.set(schemas, cache);
  }
  const aliases: Schema[] = [];
  let resolved: Schema = schema;
  while (resolved.kind === 'ref') {
    const known = cache.get(resolved);
    if (known) {
      resolved = known;
      break;
    }
    if (!schemas.has(resolved.name))
      fail(resolved.location, `unresolved reference ${resolved.name}`);
    aliases.push(resolved);
    resolved = schemas.get(resolved.name)!;
  }
  for (const alias of aliases) cache.set(alias, resolved);
  return resolved;
}
