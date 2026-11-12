import {
  arrayValues,
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
  Scalar,
  Schema,
  SchemaDraft,
  SchemaFormat,
  RegisteredStringFormat,
} from './model.js';
import { assertScalarRules, intersectConstraints } from './scalar-rules.js';
import {
  schemaNode,
  stringConstraints,
  numberConstraints,
  arrayConstraints,
  objectConstraints,
  referenceConstraints,
  constraintKeys,
  maximumSchemaNesting,
} from './schema-node.js';
import {
  constraints,
  bounds,
  uniqueness,
  literals,
} from './schema-constraints.js';
import type { WorkCounter } from './schema-constraints.js';
import {
  builtInFormat,
  expectedStringFormats,
  numericFormatMessages,
  numericFormatRules,
  stringFormatHelpers,
} from './formats.js';
import type { StringFormat } from './runtime.js';

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

const maximumInlineSchemaNesting = 32;
function assertInlineSchemaNesting(nesting: number, location: string): void {
  if (nesting > maximumInlineSchemaNesting)
    fail(
      location,
      `inline schema nesting exceeds the supported limit of ${maximumInlineSchemaNesting} levels; use component references to split inline schemas within the ${maximumSchemaNesting}-level structural limit`,
    );
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
  const normalize = schemaNormalizer(registered, work);
  return (input: unknown, location: string): Schema =>
    normalize(input, location);
}

export const normalizeSchema: (input: unknown, location: string) => Schema =
  schemaNormalizer(new Map());

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

function schemaNormalizer(registered: FormatRegistry, work?: WorkCounter) {
  function normalize(
    input: unknown,
    location: string,
    nesting = 1,
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
    // Virtual nullable branches stay access-neutral. Source annotations belong
    // to this declaration's outer node, including nullable wrappers.
    const schema = schemaNode(
      normalizeShape(value, location, nesting, intersectionMember),
      {
        readOnly: value.readOnly === true,
        writeOnly: value.writeOnly === true,
      },
    );
    // Defaults describe server behavior. Never make an omitted request field
    // present, or let a default rescue a missing required value.
    if (Object.hasOwn(value, 'default'))
      jsonAnnotation(value.default, `${location}.default`);
    return schema;
  }

  function normalizeIntersection(
    value: Record<string, unknown>,
    location: string,
    nesting: number,
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
      const normalized = normalize(
        inferred ? { ...branch, type: 'object' } : branch,
        path,
        nesting + 1,
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
    const branchLocations = branches.map(
      (_, index) => `${location}.allOf[${index}]`,
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
        // schema. Comparable bounds merge; distinct patterns and multipleOf
        // assertions stay independent because a reference holds only one of each.
        const constrained = member(
          { ...siblings, $ref: `#/components/schemas/${only.name}` },
          location,
        );
        const independent = ['pattern', 'multipleOf'] as const;
        if (
          constrained.kind === 'ref' &&
          !independent.some(
            (key) =>
              only.constraints[key] !== undefined &&
              constrained.constraints[key] !== undefined &&
              only.constraints[key] !== constrained.constraints[key],
          )
        )
          return {
            ...constrained,
            constraints: intersectConstraints(
              only.constraints,
              constrained.constraints,
            ),
            location: only.location,
            readOnly: constrained.readOnly || only.readOnly,
            writeOnly: constrained.writeOnly || only.writeOnly,
          };
        branches.push(constrained);
      } else branches.push(member(siblings, location));
      branchLocations.push(location);
    }
    if (branches.length === 1) return branches[0]!;
    return {
      kind: 'intersection',
      branches,
      branchLocations,
      location: `${location}.allOf`,
    };
  }

  function normalizeUnion(
    value: Record<string, unknown>,
    location: string,
    nesting: number,
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
      normalize(branch, `${location}.${keyword}[${index}]`, nesting + 1),
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
    keys(
      discriminator,
      ['propertyName', 'mapping'],
      `${location}.discriminator`,
    );
    const propertyName = contractField(
      text(
        discriminator.propertyName,
        `${location}.discriminator.propertyName`,
      ),
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
              normalize(
                properties[name],
                `${location}.properties.${name}`,
                nesting + 1,
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
            : normalize(
                value.additionalProperties,
                `${location}.additionalProperties`,
                nesting + 1,
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
      additionalPropertiesExplicit: Object.hasOwn(
        value,
        'additionalProperties',
      ),
      properties: normalized,
      required: [...required].sort(),
      ...limits,
    };
  }

  function normalizeScalar(
    value: Record<string, unknown>,
    location: string,
    kind: 'string' | 'number' | 'integer' | 'boolean' | 'null',
    nullable = false,
  ): SchemaDraft {
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
    const nonNull = nullable
      ? allowed?.filter((item) => item !== null)
      : allowed;
    // A null-only literal assertion removes the non-null branch. Sibling syntax
    // must still be supported, but its numeric interval need not admit a value.
    if (nullable && nonNull?.length === 0) return { kind: 'null' };
    assertScalarRules(kind, limits, allowed, location, format);
    const scalar: SchemaDraft = {
      kind,
      ...limits,
      format,
      literals: nonNull,
    };
    if (!nullable) return scalar;
    // type, enum and const are independent assertions. A nullable type must not
    // add null to an enum/const that excludes it, or retain non-null values when
    // the literal assertion permits only null.
    return allowed === undefined || allowed.includes(null)
      ? {
          kind: 'union',
          branches: [schemaNode(scalar), schemaNode({ kind: 'null' })],
        }
      : scalar;
  }

  // Without a type, enum and const alone decide what a value may be, so the
  // listed values also fix its type. Values of several JSON types become one
  // literal alternative per type, in order of first appearance.
  function normalizeLiterals(
    value: Record<string, unknown>,
    location: string,
    nesting: number,
  ): SchemaDraft {
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
    const branches = Array.from(groups, ([type, items]): SchemaDraft => {
      if (type === 'null') return { kind: 'null' };
      if (type === 'string' || type === 'boolean')
        return { kind: type, literals: items };
      // The listed numbers already say whether fractions are accepted.
      return {
        kind: items.every(Number.isInteger) ? 'integer' : 'number',
        literals: items,
      };
    });
    if (branches.length === 1) return branches[0]!;
    // The alternatives count just like explicit anyOf branches.
    assertInlineSchemaNesting(nesting + 1, location);
    return {
      kind: 'union',
      branches: branches.map((branch) => schemaNode(branch)),
      sourceLiterals: true,
    };
  }

  function normalizeNullableType(
    value: Record<string, unknown>,
    location: string,
    nesting: number,
  ): SchemaDraft {
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
    let schema: SchemaDraft;
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
      const branch = schemaNode(
        normalizeShape({ ...value, type: kind }, location, nesting + 1),
      );
      schema = {
        kind: 'union',
        branches: [branch, schemaNode({ kind: 'null' })],
      };
    }
    if (schema.kind === 'union') {
      assertInlineSchemaNesting(nesting + 1, location);
      return { ...schema, sourceTypeArray: true };
    }
    return schema;
  }

  function normalizeShape(
    input: Record<string, unknown>,
    location: string,
    nesting: number,
    intersectionMember = false,
  ): SchemaDraft {
    const value = ownRecord(input);
    if (Object.hasOwn(value, 'allOf'))
      return normalizeIntersection(value, location, nesting);
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
      return normalizeUnion(value, location, nesting);
    if (Object.keys(value).every((key) => annotationKeys.includes(key)))
      return { kind: 'json' };
    if (
      !Object.hasOwn(value, 'type') &&
      (Object.hasOwn(value, 'enum') || Object.hasOwn(value, 'const'))
    )
      return normalizeLiterals(value, location, nesting);
    const kind = value.type;
    if (Array.isArray(kind))
      return normalizeNullableType(value, location, nesting);
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
    if (kind === 'object') return normalizeObject(value, location, nesting);
    if (kind === 'array') {
      keys(
        value,
        [...typedSchemaKeys, 'items', ...arrayConstraints],
        location,
        'schema',
      );
      const schema: SchemaDraft = {
        kind,
        items: normalize(value.items, `${location}.items`, nesting + 1),
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
      return normalizeScalar(value, location, kind);
    fail(
      `${location}.type`,
      // Only object keywords can infer their type from another allOf member.
      intersectionMember && kind === undefined
        ? 'allOf members without object keywords require an explicit type; declare the composed type here, for example "type": "string"'
        : 'supported types are object, array, string, number, integer, boolean and null; type arrays require one supported non-null type and null; implicit types are unsupported',
    );
  }

  return normalize;
}
