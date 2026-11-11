import { RegExpSyntaxError, RegExpValidator } from '@eslint-community/regexpp';
import {
  arrayValues,
  assertNever,
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
  unionKeyword,
} from './schema-node.js';
import { schemaAccess } from './directional.js';
import { scalarIntersectionBase } from './intersections.js';
import { schemaGraph } from './schema-graph.js';
import {
  builtInFormat,
  expectedStringFormats,
  numericFormatMessages,
  numericFormatRules,
  stringFormatHelpers,
} from './formats.js';
import type { StringFormat } from './runtime.js';

// One descriptor shares this counter across policy, component and HTTP roots.
// Reserve literal and declaration-list entries before their allocation/loops;
// opaque annotations retain their separate identity-aware JSON validation.
type WorkCounter = (amount: number, location: string) => void;

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
const referenceConstraints: readonly string[] = [
  ...stringConstraints,
  ...numberConstraints,
  ...arrayConstraints,
];
const constraintKeys = [...referenceConstraints, ...objectConstraints];

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
    ...uniqueness(value, location),
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

// uniqueItems: false is the JSON Schema default; only true adds an assertion.
function uniqueness(
  value: Record<string, unknown>,
  location: string,
): { uniqueItems?: true } {
  if (!Object.hasOwn(value, 'uniqueItems')) return {};
  if (typeof value.uniqueItems !== 'boolean')
    fail(`${location}.uniqueItems`, 'expected a boolean');
  return value.uniqueItems ? { uniqueItems: true } : {};
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

// Without a kind, every scalar is admitted and the caller derives the types.
function literals(
  value: Record<string, unknown>,
  kind: string | undefined,
  location: string,
  nullable = false,
  work?: WorkCounter,
): readonly Scalar[] | undefined {
  if (Object.hasOwn(value, 'const') && Object.hasOwn(value, 'enum'))
    fail(location, 'const and enum together are unsupported');
  const raw = Object.hasOwn(value, 'const') ? [value.const] : value.enum;
  if (!Object.hasOwn(value, 'const') && !Object.hasOwn(value, 'enum'))
    return undefined;
  if (!Array.isArray(raw) || raw.length === 0)
    fail(`${location}.enum`, 'expected a nonempty array');
  work?.(raw.length, location);
  const result: Scalar[] = [];
  const seen = new Set<Scalar>();
  for (const item of arrayValues(raw)) {
    const matches =
      kind === undefined ||
      (kind === 'null'
        ? item === null
        : kind === 'integer'
          ? typeof item === 'number' && Number.isInteger(item)
          : typeof item === kind);
    if ((!matches && !(nullable && item === null)) || !scalarValue(item))
      fail(
        location,
        kind === undefined
          ? 'enum and const values must be strings, finite numbers, booleans or null'
          : `literal must match type ${kind}`,
      );
    if (seen.has(item)) fail(location, 'duplicate literal');
    seen.add(item);
    result.push(item);
  }
  return result;
}

// One descriptor shares this budget across every normalization root. Reserve
// collection entries before building results; opaque annotations keep their
// separate JSON validation instead of another schema traversal or masking pass.
export function createSchemaNormalizer(
  registered: FormatRegistry,
  maximum = 1_000_000,
) {
  let remaining = maximum;
  const work: WorkCounter = (amount, location) => {
    if ((remaining -= amount) < 0)
      fail(
        location,
        `schema normalization work exceeds the supported limit of ${maximum} units; reduce or split the input contract, or replace repeated inline schemas with local $ref references`,
      );
  };
  return (input: unknown, location: string): Schema =>
    normalizeSchema(input, location, 1, registered, work);
}

export function normalizeSchema(
  input: unknown,
  location: string,
  nesting = 1,
  registered: FormatRegistry = new Map(),
  work?: WorkCounter,
  intersectionMember = false,
): Schema {
  // Bound schema recursion before entering either JS or the native formatter.
  // Annotation values have their own iterative validation and do not add depth.
  assertInlineSchemaNesting(nesting, location);
  work?.(1, location);
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
  const shape = normalizeShape(
    value,
    location,
    nesting,
    registered,
    work,
    intersectionMember,
  );
  const schema = {
    // Virtual nullable branches stay access-neutral. The source annotation
    // belongs to this declaration's outer node, including nullable wrappers.
    ...shape,
    readOnly: value.readOnly === true || shape.readOnly,
    writeOnly: value.writeOnly === true || shape.writeOnly,
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

function normalizeIntersection(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
  work?: WorkCounter,
): SchemaDraft {
  const raw = value.allOf;
  if (!Array.isArray(raw) || raw.length === 0)
    fail(`${location}.allOf`, 'expected a nonempty array of allOf branches');
  work?.(raw.length, location);
  const objectKeys = [
    'properties',
    'required',
    'additionalProperties',
    ...objectConstraints,
  ];
  const member = (input: unknown, path: string): Schema => {
    const branch = record(input, path);
    // Composition fragments commonly declare object assertions without type.
    // Infer only this supported object vocabulary, never arbitrary JSON Schema.
    const inferred =
      !Object.hasOwn(branch, 'type') &&
      !['$ref', 'allOf', 'anyOf', 'oneOf'].some((key) =>
        Object.hasOwn(branch, key),
      ) &&
      objectKeys.some((key) => Object.hasOwn(branch, key));
    const normalized = normalizeSchema(
      inferred ? { ...branch, type: 'object' } : branch,
      path,
      nesting + 1,
      registered,
      work,
      true,
    );
    if (!inferred) return normalized;
    if (normalized.kind === 'object')
      return { ...normalized, typeExplicit: false };
    if (normalized.kind === 'map' && normalized.values === true)
      return schemaNode({
        kind: 'object',
        properties: new Map(),
        required: [],
        typeExplicit: false,
        additionalPropertiesExplicit: normalized.additionalPropertiesExplicit,
        minProperties: normalized.minProperties,
        maxProperties: normalized.maxProperties,
        readOnly: normalized.readOnly,
        writeOnly: normalized.writeOnly,
      });
    fail(
      path,
      'allOf object fragments with dynamic additionalProperties require an explicit type and are unsupported in intersections',
    );
  };
  const branches = Array.from(arrayValues(raw), (branch, index) =>
    member(branch, `${location}.allOf[${index}]`),
  );
  const siblings = Object.fromEntries(
    Object.entries(value).filter(
      ([key]) => key !== 'allOf' && !annotationKeys.includes(key),
    ),
  );
  if (Object.keys(siblings).length > 0) {
    const only = branches.length === 1 ? branches[0] : undefined;
    if (
      only?.kind === 'ref' &&
      Object.keys(siblings).every((key) => referenceConstraints.includes(key))
    ) {
      // Untyped sibling constraints restrict the one referenced value, exactly
      // like 3.1 reference siblings. An unconstrained branch adds no rule, so
      // one constrained reference at the author's $ref represents the whole
      // schema. A constrained branch stays independent: a reference holds one
      // pattern or multipleOf, and sibling rules must not replace its own.
      const constrained = member(
        { ...siblings, $ref: `#/components/schemas/${only.name}` },
        location,
      );
      if (constrained.kind === 'ref' && !hasConstraints(only.constraints))
        return {
          ...constrained,
          location: only.location,
          readOnly: constrained.readOnly || only.readOnly,
          writeOnly: constrained.writeOnly || only.writeOnly,
        };
      branches.push(constrained);
    } else branches.push(member(siblings, location));
  }
  if (branches.length === 1) return branches[0]!;
  return { kind: 'intersection', branches, location: `${location}.allOf` };
}

function normalizeUnion(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
  work?: WorkCounter,
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
  work?.(raw.length, location);
  const branches = Array.from(arrayValues(raw), (branch: unknown, index) =>
    normalizeSchema(
      branch,
      `${location}.${keyword}[${index}]`,
      nesting + 1,
      registered,
      work,
    ),
  );
  if (keyword === 'anyOf')
    return { kind: 'union', cardinality: 'any', branches };
  // Without a tag, usage validation proves that the branches never overlap.
  if (!Object.hasOwn(value, 'discriminator'))
    return { kind: 'union', cardinality: 'one', branches };
  const discriminator = record(
    value.discriminator,
    `${location}.discriminator`,
  );
  keys(discriminator, ['propertyName', 'mapping'], `${location}.discriminator`);
  const propertyName = contractField(
    text(discriminator.propertyName, `${location}.discriminator.propertyName`),
    `${location}.discriminator.propertyName`,
  );
  const mappingSource = record(
    discriminator.mapping,
    `${location}.discriminator.mapping`,
  );
  work?.(Object.keys(mappingSource).length, location);
  // First positions only: a repeated reference leaves a branch unmapped, which
  // the coverage check rejects.
  const positions = new Map<string, number>();
  branches.forEach((branch, index) => {
    if (branch.kind === 'ref' && !positions.has(branch.name))
      positions.set(branch.name, index);
  });
  const mapping = new Map(
    Object.entries(mappingSource).map(([tag, ref]): [string, number] => {
      const name = referenceName(
        ref,
        `${location}.discriminator.mapping.${tag}`,
      );
      const index = positions.get(name);
      if (index === undefined)
        fail(
          `${location}.discriminator.mapping`,
          'must cover every distinct oneOf branch exactly once',
        );
      return [tag, index];
    }),
  );
  return {
    kind: 'union',
    cardinality: 'one',
    branches,
    discriminator: { propertyName, mapping },
  };
}

function normalizeObject(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
  work?: WorkCounter,
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
  const names = Object.keys(properties);
  work?.(names.length, location);
  const normalized = new Map(
    Object.entries(
      Object.fromEntries(
        names
          .sort()
          .map((name) => [
            contractField(name, `${location}.properties.${name}`),
            normalizeSchema(
              properties[name],
              `${location}.properties.${name}`,
              nesting + 1,
              registered,
              work,
            ),
          ]),
      ),
    ),
  );
  const required = Object.hasOwn(value, 'required') ? value.required : [];
  if (Array.isArray(required)) work?.(required.length, location);
  if (!stringArray(required))
    fail(`${location}.required`, 'expected an array of property names');
  if (new Set(required).size !== required.length)
    fail(`${location}.required`, 'duplicate required property');
  // A required name may lack a properties entry here: another allOf member can
  // declare it, and otherwise composition resolves it against object closure.
  // Either way it becomes a field, so it must be usable as one.
  for (const name of required) contractField(name, `${location}.required`);
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
      additionalPropertiesExplicit: true,
      ...limits,
      values:
        value.additionalProperties === true
          ? true
          : normalizeSchema(
              value.additionalProperties,
              `${location}.additionalProperties`,
              nesting + 1,
              registered,
              work,
            ),
    };
  }
  // JSON Schema admits any members when an object declares neither properties
  // nor additionalProperties. As a closed fixed object it would strip all
  // response data and reject every request member. additionalProperties: false
  // declares an object that must be empty.
  if (
    Object.keys(properties).length === 0 &&
    !Object.hasOwn(value, 'additionalProperties') &&
    required.length === 0
  )
    return { kind: 'map', values: true, ...limits };
  return {
    kind: 'object',
    closed: value.additionalProperties === false,
    additionalPropertiesExplicit: Object.hasOwn(value, 'additionalProperties'),
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
  work?: WorkCounter,
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
  const allowed = literals(value, kind, location, nullable, work);
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

// Without a type, enum and const alone decide what a value may be, so the
// listed values also fix its type. Values of several JSON types become one
// literal alternative per type, in order of first appearance.
function normalizeLiterals(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  work?: WorkCounter,
): Schema {
  // Other assertions apply per JSON type. Only a declared type says which one
  // they constrain, so they are not inferred from the listed values.
  for (const key of [...constraintKeys, 'format'])
    if (Object.hasOwn(value, key))
      fail(
        `${location}.${key}`,
        'enum and const fix the type only on their own; declare a type beside this keyword',
      );
  keys(value, [...annotationKeys, 'const', 'enum'], location, 'schema');
  const groups = new Map<string, Scalar[]>();
  for (const item of literals(value, undefined, location, false, work)!) {
    const type = item === null ? 'null' : typeof item;
    const group = groups.get(type);
    if (group) group.push(item);
    else groups.set(type, [item]);
  }
  const branches = Array.from(groups, ([type, items]): Schema => {
    if (type === 'null') return schemaNode({ kind: 'null' });
    if (type === 'string' || type === 'boolean')
      return schemaNode({ kind: type, literals: items });
    // The listed numbers already say whether fractions are accepted.
    return schemaNode({
      kind: items.every(Number.isInteger) ? 'integer' : 'number',
      literals: items,
    });
  });
  if (branches.length === 1) return branches[0]!;
  // The alternatives count just like explicit anyOf branches.
  assertInlineSchemaNesting(nesting + 1, location);
  return schemaNode({ kind: 'union', branches });
}

function normalizeNullableType(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
  work?: WorkCounter,
): Schema {
  const types = value.type;
  if (Array.isArray(types)) work?.(types.length, location);
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
    schema = normalizeScalar(value, location, kind, registered, true, work);
  } else {
    // The virtual branch counts just like an explicit anyOf branch. Keep the
    // original location for diagnostics and all semantic siblings for validation.
    assertInlineSchemaNesting(nesting + 1, location);
    const branch = normalizeShape(
      { ...value, type: kind },
      location,
      nesting + 1,
      registered,
      work,
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
  work?: WorkCounter,
  intersectionMember = false,
): Schema {
  return schemaNode(
    normalizeShapeValue(
      ownRecord(value),
      location,
      nesting,
      registered,
      work,
      intersectionMember,
    ),
  );
}

function normalizeShapeValue(
  value: Record<string, unknown>,
  location: string,
  nesting: number,
  registered: FormatRegistry,
  work?: WorkCounter,
  intersectionMember = false,
): SchemaDraft {
  if (Object.hasOwn(value, 'allOf'))
    return normalizeIntersection(value, location, nesting, registered, work);
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
    return normalizeUnion(value, location, nesting, registered, work);
  if (Object.keys(value).every((key) => annotationKeys.includes(key)))
    return { kind: 'json' };
  if (
    !Object.hasOwn(value, 'type') &&
    (Object.hasOwn(value, 'enum') || Object.hasOwn(value, 'const'))
  )
    return normalizeLiterals(value, location, nesting, work);
  const kind = value.type;
  if (Array.isArray(kind))
    return normalizeNullableType(value, location, nesting, registered, work);
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
    return normalizeObject(value, location, nesting, registered, work);
  if (kind === 'array') {
    keys(
      value,
      [...typedSchemaKeys, 'items', ...arrayConstraints],
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
        work,
      ),
      ...bounds(value, 'minItems', 'maxItems', location, true),
      ...uniqueness(value, location),
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
    return normalizeScalar(value, location, kind, registered, false, work);
  fail(
    `${location}.type`,
    // Only object keywords can infer their type from another allOf member.
    intersectionMember && kind === undefined
      ? 'allOf members without object keywords require an explicit type; declare the composed type here, for example "type": "string"'
      : 'supported types are object, array, string, number, integer, boolean and null; type arrays require one supported non-null type and null; implicit types are unsupported',
  );
}

export function schemaReferences(
  schema: Schema,
): readonly Extract<Schema, { kind: 'ref' }>[] {
  switch (schema.kind) {
    case 'ref':
      return [schema];
    case 'array':
      return schemaReferences(schema.items);
    case 'map':
      return schema.values === true ? [] : schemaReferences(schema.values);
    case 'intersection':
    case 'union':
      return schema.branches.flatMap(schemaReferences);
    case 'object':
      return [...schema.properties.values()].flatMap(schemaReferences);
    case 'json':
    case 'binary':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return [];
    default:
      return assertNever(schema);
  }
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
    : `${location}.${unionKeyword(schema)}[${index}]`;
}

function measureSchema(
  schema: Schema,
  schemas: SchemaTable,
  location: string,
  depths: Map<Schema, number>,
): number {
  const known = depths.get(schema);
  if (known !== undefined) return known;
  const graph = schemaGraph([schema], schemas, (value) => depths.has(value));
  for (let index = 0; index < graph.groups.length; index++) {
    const group = graph.groups[index]!;
    let structure = 0;
    let dependency = 0;
    for (const node of group) {
      const value = graph.nodes[node]!;
      structure += depths.get(value) ?? (value.kind === 'ref' ? 0 : 1);
      for (const target of graph.edges[node]!) {
        const child = graph.nodes[target]!;
        if (graph.groupFor.get(child) !== index)
          dependency = Math.max(dependency, depths.get(child)!);
      }
    }
    // A recursive region contributes its distinct structural nodes once. On a
    // DAG this is the existing longest-path depth; aliases contribute no level.
    const depth = structure + dependency;
    if (depth > maximumSchemaNesting)
      fail(
        location,
        `schema nesting exceeds the supported limit of ${maximumSchemaNesting} levels; reduce structural nesting, including recursive regions and referenced schemas`,
      );
    for (const node of group) depths.set(graph.nodes[node]!, depth);
  }
  return depths.get(schema)!;
}

type JsonType = 'null' | 'boolean' | 'string' | 'number' | 'array' | 'object';
const allJsonTypes: readonly JsonType[] = [
  'null',
  'boolean',
  'string',
  'number',
  'array',
  'object',
];

// Union analyses visit each normalized node once per table, so shared union
// graphs stay linear in the contract instead of in their expanded paths.
function tableCache<T>(
  caches: WeakMap<SchemaTable, WeakMap<Schema, T>>,
  schemas: SchemaTable,
): WeakMap<Schema, T> {
  let cache = caches.get(schemas);
  if (!cache) {
    cache = new WeakMap();
    caches.set(schemas, cache);
  }
  return cache;
}

// The JSON types a schema can accept. Constraints and formats only narrow
// values within a type, so they never make two alternatives disjoint.
const jsonTypesByTable = new WeakMap<
  SchemaTable,
  WeakMap<Schema, readonly JsonType[]>
>();
function jsonTypes(schema: Schema, schemas: SchemaTable): readonly JsonType[] {
  const resolved = resolveSchema(schema, schemas);
  const cache = tableCache(jsonTypesByTable, schemas);
  const known = cache.get(resolved);
  if (known) return known;
  let types: readonly JsonType[];
  switch (resolved.kind) {
    case 'null':
    case 'boolean':
    case 'string':
      types = [resolved.kind];
      break;
    case 'number':
    case 'integer':
      types = ['number'];
      break;
    case 'array':
      types = ['array'];
      break;
    case 'object':
    case 'map':
      types = ['object'];
      break;
    case 'union':
      types = [
        ...new Set(
          resolved.branches.flatMap((branch) => jsonTypes(branch, schemas)),
        ),
      ];
      break;
    case 'json':
    case 'binary':
    case 'intersection':
    case 'ref':
      types = allJsonTypes;
      break;
    default:
      return assertNever(resolved);
  }
  cache.set(resolved, types);
  return types;
}

// Untagged unions try branches in order, and every branch accepting a value's
// JSON type may evaluate that value and its children again. Bound the product
// across nested overlapping alternatives at compile time, so runtime work stays
// within a fixed multiple of the input size. Recursive regions keep their
// runtime traversal budget; saturating at the limit keeps this arithmetic small.
const maximumAlternativeVisits = 1024;
const visitsByTable = new WeakMap<SchemaTable, WeakMap<Schema, number>>();
function alternativeVisits(schema: Schema, schemas: SchemaTable): number {
  const cache = tableCache(visitsByTable, schemas);
  const known = cache.get(schema);
  if (known !== undefined) return known;
  const visits = (value: Schema) => alternativeVisits(value, schemas);
  let count = 1;
  switch (schema.kind) {
    case 'ref': {
      // Walk alias chains iteratively; they add no value nesting.
      const recursive = recursiveSchemas(schemas).members;
      let target: Schema = schema;
      while (target.kind === 'ref' && !recursive.has(target.name))
        target = schemas.get(target.name)!;
      if (target.kind !== 'ref') count = visits(target);
      break;
    }
    case 'object':
      for (const value of schema.properties.values())
        count = Math.max(count, visits(value));
      break;
    case 'array':
      count = visits(schema.items);
      break;
    case 'map':
      if (schema.values !== true) count = visits(schema.values);
      break;
    case 'union':
      if (schema.discriminator)
        for (const branch of schema.branches)
          count = Math.max(count, visits(branch));
      else
        for (const type of allJsonTypes) {
          let total = 0;
          for (const branch of schema.branches)
            if (jsonTypes(branch, schemas).includes(type))
              total = Math.min(
                maximumAlternativeVisits + 1,
                total + visits(branch),
              );
          count = Math.max(count, total);
        }
      break;
    case 'json':
    case 'binary':
    case 'intersection':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      break;
    default:
      return assertNever(schema);
  }
  cache.set(schema, count);
  return count;
}

function validateUnion(
  schema: Extract<Schema, { kind: 'union' }>,
  schemas: SchemaTable,
  location: string,
  usage: Usage,
): void {
  if (!schema.discriminator) {
    if (alternativeVisits(schema, schemas) > maximumAlternativeVisits)
      fail(
        location,
        `overlapping union alternatives can validate one value more than ${maximumAlternativeVisits} times; use a discriminator, remove repeated alternatives or reduce nested overlapping alternatives`,
      );
    // anyOf returns the first matching branch. oneOf requires exactly one
    // match; without a tag, POM proves it by admitting only branches whose JSON
    // types are disjoint, so first-match evaluation cannot hide a second match.
    if (schema.cardinality === 'any') return;
    const seen = new Set<JsonType>();
    for (const branch of schema.branches)
      for (const type of jsonTypes(branch, schemas)) {
        if (seen.has(type))
          fail(
            location,
            `oneOf alternatives without a discriminator must accept disjoint JSON types; several accept ${type} values, so use a discriminator for object alternatives or anyOf to accept the first match`,
          );
        seen.add(type);
      }
    return;
  }
  const { propertyName, mapping } = schema.discriminator;
  // Source mappings name component branches. allOf composition may replace a
  // mapped branch with its composed object at the same position.
  if (
    schema.branches.some(
      (branch) => branch.kind === 'ref' && hasConstraints(branch.constraints),
    )
  )
    fail(
      location,
      'discriminated oneOf branches must be component references without constraints',
    );
  const positions = [...mapping.values()];
  if (
    positions.length !== schema.branches.length ||
    new Set(positions).size !== positions.length
  )
    fail(
      `${location}.discriminator.mapping`,
      'must cover every distinct oneOf branch exactly once',
    );
  for (const [tag, index] of mapping) {
    const branch = resolveSchema(schema.branches[index]!, schemas);
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
  switch (schema.kind) {
    case 'ref': {
      const resolved = resolveSchema(schema, schemas);
      const allowed: readonly string[] =
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
      return;
    }
    case 'array':
      visit(schema.items, `${location}.items`);
      return;
    case 'map':
      if (schema.values !== true)
        visit(schema.values, `${location}.additionalProperties`);
      return;
    case 'object':
      for (const [name, value] of schema.properties)
        visit(value, `${location}.properties.${name}`);
      return;
    case 'intersection':
      scalarIntersectionBase(schema, schemas);
      schema.branches.forEach((value, index) =>
        visit(value, `${schema.location}[${index}]`),
      );
      return;
    case 'union':
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
      return;
    case 'json':
    case 'binary':
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null':
      return;
    default:
      assertNever(schema);
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

function sameValueReferences(
  schema: Schema,
): readonly Extract<Schema, { kind: 'ref' }>[] {
  if (schema.kind === 'ref') return [schema];
  if (schema.kind === 'intersection' || schema.kind === 'union')
    return schema.branches.flatMap(sameValueReferences);
  return [];
}

function dependencyOrder(
  schemas: SchemaTable,
  sameValue: boolean,
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
    if (pending.has(name)) {
      if (sameValue)
        fail(
          location,
          `recursive schemas must descend through an object property, array item or map value (${name}); same-value reference and composition cycles are unsupported`,
        );
      return;
    }
    if (!schemas.has(name)) fail(location, `unresolved reference ${name}`);
    pending.add(name);
    stack.push({
      name,
      targets: (sameValue
        ? sameValueReferences(schemas.get(name)!)
        : schemaReferences(schemas.get(name)!)
      ).values(),
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

export function orderSchemas(schemas: SchemaTable): readonly string[] {
  // Same-value applicators cannot make progress through a recursive instance.
  // Productive cycles are permitted in the full graph; DAG order stays stable.
  dependencyOrder(schemas, true);
  return dependencyOrder(schemas, false);
}

// Renderers share immutable normalized tables across clients and standalone
// roots. Retain one graph analysis per table without retaining old descriptors.
type RecursiveSchemas = Readonly<{
  members: ReadonlySet<string>;
  reachable: ReadonlySet<string>;
}>;
const recursionByTable = new WeakMap<SchemaTable, RecursiveSchemas>();

export function recursiveSchemas(schemas: SchemaTable): RecursiveSchemas {
  const known = recursionByTable.get(schemas);
  if (known) return known;
  const graph = schemaGraph([...schemas.values()], schemas);
  const recursiveGroups = new Set<number>();
  const reachableGroups = new Set<number>();
  for (let index = 0; index < graph.groups.length; index++) {
    const group = graph.groups[index]!;
    if (group.length > 1 || graph.edges[group[0]!]!.includes(group[0]!))
      recursiveGroups.add(index);
    // Groups are dependency-ordered. An acyclic wrapper must own the same
    // traversal budget as the recursive values reachable beneath it.
    if (
      recursiveGroups.has(index) ||
      group.some((node) =>
        graph.edges[node]!.some((target) =>
          reachableGroups.has(graph.groupFor.get(graph.nodes[target]!)!),
        ),
      )
    )
      reachableGroups.add(index);
  }
  const members = new Set<string>();
  const reachable = new Set<string>();
  for (const [name, schema] of schemas) {
    const group = graph.groupFor.get(schema)!;
    if (recursiveGroups.has(group)) members.add(name);
    if (reachableGroups.has(group)) reachable.add(name);
  }
  const result = { members, reachable };
  recursionByTable.set(schemas, result);
  return result;
}

// A normalized schema table belongs to one descriptor and is never mutated.
// Cache only terminal resolution: usage checks must still visit intermediate
// sibling constraints. Weak keys release the cache with its table,
// and compiling the same mutable input again creates a separate normalized table.
const terminalSchemas = new WeakMap<SchemaTable, WeakMap<Schema, Schema>>();

export function resolveSchema(schema: Schema, schemas: SchemaTable): Schema {
  // Same-value reference cycles are rejected before resolving contract shapes.
  if (schema.kind === 'intersection')
    return scalarIntersectionBase(schema, schemas);
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
  if (resolved.kind === 'intersection')
    resolved = scalarIntersectionBase(resolved, schemas);
  for (const alias of aliases) cache.set(alias, resolved);
  return resolved;
}

// Constraint siblings never change a reference's declaration identity. Types
// and container refinements share the terminal declaration of a whole chain.
const terminalNames = new WeakMap<SchemaTable, Map<string, string>>();

export function terminalName(name: string, schemas: SchemaTable): string {
  let cache = terminalNames.get(schemas);
  if (!cache) {
    cache = new Map();
    terminalNames.set(schemas, cache);
  }
  const aliases: string[] = [];
  let current = name;
  for (;;) {
    const known = cache.get(current);
    if (known !== undefined) {
      current = known;
      break;
    }
    const schema = schemas.get(current)!;
    if (schema.kind !== 'ref') break;
    aliases.push(current);
    current = schema.name;
  }
  for (const alias of aliases) cache.set(alias, current);
  return current;
}
