import { assertNever, fail } from './diagnostics.js';
import type { ConstraintInput, Scalar, Schema, SchemaTable } from './model.js';
import {
  constraintNames,
  hasConstraints,
  stringConstraints,
  numberConstraints,
  arrayConstraints,
  objectConstraints,
  schemaBranchLocation,
  maximumSchemaNesting,
} from './schema-node.js';
import {
  assertScalarRules,
  intersectConstraints,
  literalViolation,
} from './scalar-rules.js';
import { schemaAccess } from './directional.js';
import { scalarIntersectionBase } from './intersections.js';
import {
  schemaGraph,
  recursiveSchemas,
  resolveSchema,
} from './schema-graph.js';
import type { WorkCounter } from './schema-constraints.js';

type Usage = 'component' | 'request' | 'response' | 'multipart';
type ReferenceConstraints = {
  limits: ConstraintInput;
  literals: readonly Scalar[] | undefined;
};
export function schemaValidation() {
  const maximum = 1_000_000;
  let remaining = maximum;
  return {
    depths: new Map<Schema, number>(),
    checked: new Map<Usage, Set<Schema>>(),
    constraints: new Map<Schema, ReferenceConstraints>(),
    // A small alias graph can multiply a wide enum's candidate scans. Charge
    // the complete scan before filtering, shared across this validation pass.
    work: (amount: number, location: string): void => {
      if ((remaining -= amount) < 0)
        fail(
          location,
          `schema validation work exceeds the supported limit of ${maximum} units; reduce or split the input contract, or reduce repeated constrained references to wide enums`,
        );
    },
  };
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
  const pending: { node: number; next: number; childDepth: number }[] = [];
  for (let index = 0; index < graph.groups.length; index++) {
    for (const root of graph.groups[index]!) {
      if (depths.has(graph.nodes[root]!)) continue;
      pending.push({ node: root, next: 0, childDepth: 0 });
      while (pending.length > 0) {
        const frame = pending[pending.length - 1]!;
        const value = graph.nodes[frame.node]!;
        const target = graph.edges[frame.node]![frame.next++];
        if (target !== undefined) {
          const child = graph.nodes[target]!;
          // A structural member reaching a named reference in its own recursive
          // group starts another iteration. Keep its inline wrappers, but stop
          // that edge. Ref-to-target edges remain so aliases stay transparent.
          if (
            value.kind !== 'ref' &&
            child.kind === 'ref' &&
            graph.groupFor.get(child) === index
          )
            continue;
          const depth = depths.get(child);
          if (depth === undefined)
            pending.push({ node: target, next: 0, childDepth: 0 });
          else frame.childDepth = Math.max(frame.childDepth, depth);
          continue;
        }
        const depth = (value.kind === 'ref' ? 0 : 1) + frame.childDepth;
        if (depth > maximumSchemaNesting)
          fail(
            location,
            `schema nesting exceeds the supported limit of ${maximumSchemaNesting} levels; reduce structural nesting, including recursive regions and referenced schemas`,
          );
        depths.set(value, depth);
        pending.pop();
        const parent = pending[pending.length - 1];
        if (parent) parent.childDepth = Math.max(parent.childDepth, depth);
      }
    }
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
  // Same-value reference cycles were rejected before validation. Productive
  // groups can still contain long union paths: cache children before their
  // union on a heap stack, retaining branch order for overlap diagnostics.
  const pending = [{ schema: resolved, next: 0 }];
  while (pending.length > 0) {
    const frame = pending[pending.length - 1]!;
    const current = frame.schema;
    if (current.kind === 'union' && frame.next < current.branches.length) {
      const child = resolveSchema(current.branches[frame.next++]!, schemas);
      if (!cache.has(child)) pending.push({ schema: child, next: 0 });
      continue;
    }
    let types: readonly JsonType[];
    switch (current.kind) {
      case 'null':
      case 'boolean':
      case 'string':
        types = [current.kind];
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
            current.branches.flatMap((branch) =>
              cache.get(resolveSchema(branch, schemas))!,
            ),
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
        return assertNever(current);
    }
    cache.set(current, types);
    pending.pop();
  }
  return cache.get(resolved)!;
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
      const aliases: Schema[] = [];
      let target: Schema = schema;
      while (
        target.kind === 'ref' &&
        !recursive.has(target.name) &&
        !cache.has(target)
      ) {
        aliases.push(target);
        target = schemas.get(target.name)!;
      }
      count = cache.get(target) ?? (target.kind === 'ref' ? 1 : visits(target));
      // Different unions often enter the same long alias suffix. Retain every
      // visited suffix, not only the first reference that requested its cost.
      for (const alias of aliases) cache.set(alias, count);
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
  work: WorkCounter,
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
      work(literals.length, location);
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
  work: WorkCounter,
): void {
  if (checked.has(schema)) return;
  type Frame =
    | { kind: 'schema' | 'branch'; schema: Schema; location: string }
    | {
        kind: 'union';
        schema: Extract<Schema, { kind: 'union' }>;
        location: string;
      };
  const pending: Frame[] = [{ kind: 'schema', schema, location }];
  const visit = (value: Schema, path: string): void => {
    pending.push({ kind: 'schema', schema: value, location: path });
  };
  // Productive reference groups can be wide without deep member bodies. Keep
  // depth-first diagnostics without consuming the JS stack across their members.
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (frame.kind === 'union') {
      validateUnion(frame.schema, schemas, frame.location, usage);
      continue;
    }
    const { schema, location } = frame;
    if (frame.kind === 'branch') {
      const access = schemaAccess(schema, schemas);
      if (access.readOnly || access.writeOnly)
        fail(
          location,
          'readOnly and writeOnly on union branches are not supported in this version; remove the annotation from the branch or its referenced component; use separate request and response schemas when their shapes differ',
        );
    }
    if (checked.has(schema)) continue;
    checked.add(schema);
    const access = schemaAccess(schema, schemas);
    if (access.readOnly && access.writeOnly)
      fail(
        location,
        'readOnly and writeOnly cannot both be true through references',
      );
    if (usage !== 'component') {
      const excluded =
        usage === 'response' ? access.writeOnly : access.readOnly;
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
          work,
        );
        visit(target, targetLocation);
        continue;
      }
      case 'array':
        visit(schema.items, `${location}.items`);
        continue;
      case 'map':
        if (schema.values !== true)
          visit(schema.values, `${location}.additionalProperties`);
        continue;
      case 'object':
        for (const [name, value] of [...schema.properties].reverse())
          visit(value, `${location}.properties.${name}`);
        continue;
      case 'intersection':
        scalarIntersectionBase(schema, schemas);
        for (let index = schema.branches.length - 1; index >= 0; index--)
          visit(
            schema.branches[index]!,
            schema.branchLocations?.[index] ?? `${schema.location}[${index}]`,
          );
        continue;
      case 'union':
        pending.push({ kind: 'union', schema, location });
        for (let index = schema.branches.length - 1; index >= 0; index--)
          pending.push({
            kind: 'branch',
            schema: schema.branches[index]!,
            location: schemaBranchLocation(schema, location, index),
          });
        continue;
      case 'json':
      case 'binary':
      case 'string':
      case 'number':
      case 'integer':
      case 'boolean':
      case 'null':
        continue;
      default:
        assertNever(schema);
    }
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
  validateUsage(
    schema,
    schemas,
    location,
    usage,
    checked,
    cache.constraints,
    cache.work,
  );
}
