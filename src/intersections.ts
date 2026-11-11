import { assertNever, fail } from './diagnostics.js';
import type {
  ConstraintInput,
  Constraints,
  Scalar,
  Schema,
  SchemaFormat,
  SchemaTable,
} from './model.js';
import {
  constraintNames,
  constraintRecord,
  hasConstraints,
  propertyOrder,
  schemaNode,
  unionKeyword,
} from './schema-node.js';
import {
  assertScalarRules,
  hasUnicodeProperty,
  intersectConstraints,
  literalViolation,
} from './scalar-rules.js';

type ScalarKind = 'string' | 'number' | 'integer' | 'boolean' | 'null';
type Access = Readonly<{ readOnly: boolean; writeOnly: boolean }>;
const maximumCompositionWork = 1_000_000;
// Composition recurses through inline structure and, inside recursive component
// groups, through members not yet composed. Accepted output has at most 128
// structural levels; this bound leaves room for same-value allOf chains while
// stopping well before the JS stack (measured near 800 nested schemas with
// Node's default stack size).
const maximumCompositionNesting = 256;

function compositionBudget(): (amount: number, location: string) => void {
  let remaining = maximumCompositionWork;
  return (amount, location) => {
    if ((remaining -= amount) < 0)
      fail(
        location,
        `allOf composition work exceeds the supported limit of ${maximumCompositionWork} units; reduce or split the input contract`,
      );
  };
}

function accessFlags(left: Access, right: Access, location: string): Access {
  const access = {
    readOnly: left.readOnly || right.readOnly,
    writeOnly: left.writeOnly || right.writeOnly,
  };
  if (access.readOnly && access.writeOnly)
    fail(
      location,
      'readOnly and writeOnly cannot both be true through allOf or references',
    );
  return access;
}

function referenceTarget(
  schema: Extract<Schema, { kind: 'ref' }>,
  schemas: SchemaTable,
): Schema {
  const target = schemas.get(schema.name);
  if (!target) fail(schema.location, `unresolved reference ${schema.name}`);
  return target;
}

function schemaConstraints(schema: Schema): ConstraintInput {
  switch (schema.kind) {
    case 'string':
    case 'number':
    case 'integer':
    case 'object':
    case 'map':
    case 'array':
      return schema;
    case 'binary':
    case 'boolean':
    case 'intersection':
    case 'json':
    case 'null':
    case 'ref':
    case 'union':
      return {};
    default:
      return assertNever(schema);
  }
}

export type ScalarAssertion =
  | Readonly<{ kind: 'pattern'; pattern: string }>
  | Readonly<{ kind: 'format'; format: SchemaFormat }>
  | Readonly<{ kind: 'multipleOf'; value: number }>;
export type ScalarValidationPlan = Readonly<{
  base: Schema;
  assertions: readonly ScalarAssertion[];
  runtime: readonly ScalarAssertion[];
}>;

const scalarPlans = new WeakMap<
  SchemaTable,
  WeakMap<Schema, ScalarValidationPlan>
>();
const scalarWork = new WeakMap<
  SchemaTable,
  ReturnType<typeof compositionBudget>
>();

// One plan owns the conjunction, independently of the paths used to reference
// it. Bounds and literals combine once; independent rules retain their semantic
// identity. In particular a pattern searches, while a registered format matches
// the entire string and carries its own diagnostic identity.
export function scalarValidationPlan(
  schema: Schema,
  schemas: SchemaTable,
): ScalarValidationPlan {
  let cache = scalarPlans.get(schemas);
  if (!cache) {
    cache = new WeakMap();
    scalarPlans.set(schemas, cache);
  }
  const known = cache.get(schema);
  if (known) return known;
  // Callers plan composed intersections and constrained references.
  const location =
    schema.kind === 'intersection' || schema.kind === 'ref'
      ? schema.location
      : 'allOf';
  let charge = scalarWork.get(schemas);
  if (!charge) {
    charge = compositionBudget();
    scalarWork.set(schemas, charge);
  }
  const pending: { schema: Schema; afterReference: boolean }[] = [
    { schema, afterReference: false },
  ];
  const seen = new Set<Schema>();
  const assertions = new Map<string, ScalarAssertion>();
  const add = (assertion: ScalarAssertion): void => {
    const key = JSON.stringify(assertion);
    if (!assertions.has(key)) assertions.set(key, assertion);
  };
  const collect = (rules: ConstraintInput, format?: SchemaFormat): void => {
    if (rules.pattern !== undefined)
      add({ kind: 'pattern', pattern: rules.pattern });
    if (format !== undefined) add({ kind: 'format', format });
    if (rules.multipleOf !== undefined)
      add({ kind: 'multipleOf', value: rules.multipleOf });
  };
  let literals: readonly Scalar[] | undefined;
  let inherited: ScalarValidationPlan | undefined;
  let kind: ScalarKind | undefined;
  let limits = constraintRecord();
  let access: Access = { readOnly: false, writeOnly: false };
  while (pending.length > 0) {
    const task = pending.pop()!;
    let current = task.schema;
    if (task.afterReference && current.kind === 'ref') {
      limits = intersectConstraints(limits, current.constraints);
      collect(current.constraints);
      continue;
    }
    if (seen.has(current)) continue;
    seen.add(current);
    charge(1, location);
    const shared = cache.get(current);
    if (shared) {
      inherited ??= shared;
      charge(shared.assertions.length, location);
      for (const assertion of shared.assertions) add(assertion);
      current = shared.base;
    }
    access = accessFlags(access, current, location);
    if (current.kind === 'intersection') {
      charge(current.branches.length, location);
      for (let index = current.branches.length - 1; index >= 0; index--)
        pending.push({
          schema: current.branches[index]!,
          afterReference: false,
        });
      continue;
    }
    if (current.kind === 'ref') {
      pending.push({ schema: current, afterReference: true });
      pending.push({
        schema: referenceTarget(current, schemas),
        afterReference: false,
      });
      continue;
    }
    if (current.kind === 'json') continue;
    if (
      current.kind !== 'string' &&
      current.kind !== 'number' &&
      current.kind !== 'integer' &&
      current.kind !== 'boolean' &&
      current.kind !== 'null'
    )
      fail(
        location,
        'allOf supports object composition, compatible scalar intersections and unions of those forms; combined arrays, maps and binary schemas are unsupported',
      );
    if (kind !== undefined && kind !== current.kind) {
      if (
        (kind === 'number' && current.kind === 'integer') ||
        (kind === 'integer' && current.kind === 'number')
      )
        kind = 'integer';
      else fail(location, 'allOf branches have incompatible scalar types');
    } else kind = current.kind;
    const rules = schemaConstraints(current);
    limits = intersectConstraints(limits, rules);
    collect(rules, current.kind === 'string' ? current.format : undefined);
    if (current.literals !== undefined) {
      if (literals === undefined) literals = current.literals;
      else if (literals !== current.literals) {
        charge(literals.length + current.literals.length, location);
        const allowed = new Set(current.literals);
        const narrowed = literals.filter((value) => allowed.has(value));
        if (narrowed.length !== literals.length) literals = narrowed;
      }
    }
  }
  if (kind === undefined) {
    const plan = {
      base: schemaNode({ kind: 'json', ...access }),
      assertions: [],
      runtime: [],
    };
    cache.set(schema, plan);
    return plan;
  }
  const bounds = { ...limits, pattern: undefined, multipleOf: undefined };
  assertScalarRules(kind, bounds, undefined, location);
  const base = schemaNode({ kind, ...bounds, literals, ...access });
  const atoms = [...assertions.values()];
  // Reuse unchanged suffixes without copying wide enums or walking their
  // assertions again for every alias. A different bound or atom still receives
  // the full conjunction check below.
  if (
    inherited &&
    atoms.length === inherited.assertions.length &&
    atoms.every((atom, index) => atom === inherited.assertions[index]) &&
    Object.keys(base).every(
      (key) => Reflect.get(base, key) === Reflect.get(inherited.base, key),
    )
  ) {
    cache.set(schema, inherited);
    return inherited;
  }
  if (literals !== undefined) {
    charge(literals.length * (assertions.size + 1), location);
    const checks = [
      literalViolation(bounds),
      ...atoms.map((assertion) =>
        assertion.kind === 'pattern'
          ? literalViolation({ pattern: assertion.pattern })
          : assertion.kind === 'format'
            ? literalViolation({}, assertion.format)
            : literalViolation({ multipleOf: assertion.value }),
      ),
    ];
    const narrowed = literals.filter(
      (value) =>
        (kind !== 'integer' ||
          (typeof value === 'number' && Number.isInteger(value))) &&
        checks.every((check) => check(value) === undefined),
    );
    if (narrowed.length !== literals.length) literals = narrowed;
    if (literals.length === 0)
      fail(location, 'allOf constraints admit no literal value');
  }
  const plan = {
    base: schemaNode({ kind, ...bounds, literals, ...access }),
    assertions: atoms,
    // Membership proves stable constraints for every retained literal. Unicode
    // property classification belongs to the consuming engine, so those rules
    // remain in the runtime plan even when the compiler narrowed a finite set.
    runtime:
      literals === undefined
        ? atoms
        : atoms.filter((atom) =>
            atom.kind === 'pattern'
              ? hasUnicodeProperty(atom.pattern)
              : atom.kind === 'format' &&
                typeof atom.format !== 'string' &&
                hasUnicodeProperty(atom.format.pattern),
          ),
  };
  cache.set(schema, plan);
  return plan;
}

export function scalarIntersectionBase(
  schema: Schema,
  schemas: SchemaTable,
): Schema {
  return scalarValidationPlan(schema, schemas).base;
}

type Resolved = Readonly<{ schema: Schema; limits: Constraints } & Access>;

export function createIntersectionNormalizer(
  schemas: SchemaTable,
): (schema: Schema, location: string) => Schema {
  const normalized = new WeakMap<Schema, Schema>();
  const objects = new WeakMap<Schema, Extract<Schema, { kind: 'object' }>>();
  const resolved = new WeakMap<Schema, Resolved>();
  const processing = new Set<Schema>();
  const expandingObjects = new Set<Schema>();
  const charge = compositionBudget();

  const recursiveExpansion = (location: string): never =>
    fail(
      location,
      'recursive allOf object expansion is unsupported; keep recursive edges as local property, array-item or map-value references without overlapping object composition',
    );

  function resolve(input: Schema, location: string): Resolved {
    const path: Extract<Schema, { kind: 'ref' }>[] = [];
    let current = input;
    while (true) {
      if (current.kind === 'ref' && !resolved.has(current)) {
        charge(1, location);
        path.push(current);
        current = referenceTarget(current, schemas);
      } else if (current.kind === 'intersection') {
        const composed = normalize(current, current.location);
        if (composed === current) break;
        current = composed;
      } else break;
    }
    let value: Resolved = resolved.get(current) ?? {
      schema: current,
      limits: constraintRecord(schemaConstraints(current)),
      readOnly: current.readOnly,
      writeOnly: current.writeOnly,
    };
    for (let index = path.length - 1; index >= 0; index--) {
      const reference = path[index]!;
      if (value.schema.kind === 'object' || value.schema.kind === 'map') {
        for (const name of constraintNames(reference.constraints))
          if (name !== 'minProperties' && name !== 'maxProperties')
            fail(
              reference.location,
              `constraint ${JSON.stringify(name)} is not supported on an object reference`,
            );
      }
      if (
        value.schema.kind === 'json' &&
        constraintNames(reference.constraints).length > 0
      )
        fail(
          reference.location,
          'constraints on an unconstrained JSON reference are unsupported',
        );
      // Distribution composes a union's branches, not the reference node, so
      // its sibling constraints would otherwise disappear from the contract.
      if (
        value.schema.kind === 'union' &&
        constraintNames(reference.constraints).length > 0
      )
        fail(
          reference.location,
          'constraints on a union reference are unsupported',
        );
      value = {
        schema: value.schema,
        limits: intersectConstraints(value.limits, reference.constraints),
        ...accessFlags(value, reference, location),
      };
      resolved.set(reference, value);
    }
    return value;
  }

  function objectChildren(
    input: Extract<Schema, { kind: 'object' }>,
    location: string,
  ): Extract<Schema, { kind: 'object' }> {
    const known = objects.get(input);
    if (known) return known;
    if (expandingObjects.has(input)) recursiveExpansion(location);
    expandingObjects.add(input);
    charge(input.properties.size + input.required.length, location);
    const properties = new Map<string, Schema>();
    try {
      for (const [name, child] of input.properties)
        properties.set(
          name,
          normalize(child, `${location}.properties.${name}`),
        );
      const result = { ...input, properties };
      objects.set(input, result);
      objects.set(result, result);
      return result;
    } finally {
      expandingObjects.delete(input);
    }
  }

  // required also constrains members that no properties entry describes. An
  // open object must contain them, with any JSON value. A closed object
  // forbids every undeclared member, so requiring one is a contradiction.
  function requiredMembers(
    input: Extract<Schema, { kind: 'object' }>,
    location: string,
  ): Extract<Schema, { kind: 'object' }> {
    const declared = input.properties;
    const undeclared = input.required.filter((name) => !declared.has(name));
    if (undeclared.length === 0) return input;
    if (input.closed)
      fail(
        `${location}.required`,
        `unknown property ${JSON.stringify(undeclared[0])}`,
      );
    const anyJson = schemaNode({ kind: 'json' });
    return {
      ...input,
      properties: new Map(
        propertyOrder([...declared.keys(), ...undeclared]).map((name) => [
          name,
          declared.get(name) ?? anyJson,
        ]),
      ),
    };
  }

  function materializeObject(input: Schema, location: string): Schema {
    if (input.kind !== 'object') return input;
    if (!input.typeExplicit)
      fail(
        location,
        'allOf object fragments require an explicit type: object conjunct',
      );
    const object = requiredMembers(input, location);
    assertScalarRules('object', object, undefined, location);
    // Object fragments retain their assertions until composition completes.
    // With no declared fields, required names or explicit closure, those
    // assertions describe an open JSON map, even if they constrain its property
    // count. Derive the output constructor here, before directional projection:
    // a fixed object whose fields are later excluded must remain a fixed empty
    // object.
    if (object.properties.size === 0 && !object.closed)
      return schemaNode({
        kind: 'map',
        additionalPropertiesExplicit: object.additionalPropertiesExplicit,
        values: true,
        minProperties: object.minProperties,
        maxProperties: object.maxProperties,
        readOnly: object.readOnly,
        writeOnly: object.writeOnly,
      });
    return object;
  }

  function intersection(
    input: Extract<Schema, { kind: 'intersection' }>,
    location: string,
  ): Schema {
    const pending: Schema[] = [input];
    const branches: Schema[] = [];
    const seen = new Set<Schema>();
    const references = new Set<string>();
    let access: Access = { readOnly: false, writeOnly: false };
    // Flatten same-instance composition before checking required-only fragments.
    // Each source branch was normalized already, so deduplication loses no checks.
    while (pending.length > 0) {
      const current = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      charge(1, location);
      access = accessFlags(access, current, location);
      if (current.kind === 'intersection') {
        charge(current.branches.length, location);
        for (let index = current.branches.length - 1; index >= 0; index--)
          pending.push(current.branches[index]!);
      } else {
        const branch =
          current.kind === 'object'
            ? objectChildren(current, location)
            : normalize(current, location);
        const target = resolve(branch, location);
        access = accessFlags(access, target, location);
        // Repeating the same unrefined component adds no assertion. Keep the
        // reference (including its alias chain), and accumulate access first.
        // Different names or use-site constraints can carry distinct checks.
        if (branch.kind === 'ref' && !hasConstraints(branch.constraints)) {
          if (references.has(branch.name)) continue;
          references.add(branch.name);
        }
        if (target.schema.kind !== 'json') branches.push(branch);
      }
    }
    if (branches.length === 0) return schemaNode({ kind: 'json', ...access });
    if (branches.length === 1) {
      const branch = branches[0]!;
      return materializeObject({ ...branch, ...access }, location);
    }
    const targets = branches.map((branch) => resolve(branch, location));
    // A nullable type is a union with null, so every other conjunct would also
    // need to accept null. Name the supported nullable form instead of the
    // generic union restriction below.
    if (
      targets.some(
        ({ schema }) =>
          schema.kind === 'union' && schema.sourceTypeArray === true,
      )
    )
      fail(
        location,
        'allOf cannot combine a nullable type with other branches; wrap the composition in an outer anyOf with a null-only branch instead',
      );
    // allOf distributes over a union: A and (B or C) is (A and B) or (A and C).
    // Alternatives keep their positions, so cardinality and discriminator tags
    // still describe the composed branches; a contradictory alternative fails
    // instead of disappearing. Distribute untagged unions first so tagged ones
    // stay inside and can keep dispatching on their own tag.
    const unions = targets.flatMap(({ schema }, position) =>
      schema.kind === 'union' ? [{ union: schema, position }] : [],
    );
    const factor =
      unions.find(({ union }) => !union.discriminator) ?? unions[0];
    if (factor) {
      const { union, position } = factor;
      const others = branches.filter((_, index) => index !== position);
      charge(union.branches.length * branches.length, location);
      return schemaNode({
        kind: 'union',
        cardinality: union.cardinality,
        discriminator: union.discriminator,
        branches: union.branches.map((alternative, index) => {
          const path = `${location}.${unionKeyword(union)}[${index}]`;
          const composed = normalize(
            schemaNode({
              kind: 'intersection',
              branches: [alternative, ...others],
              location: path,
            }),
            path,
          );
          // Annotations from other conjuncts apply to the whole union. Keep the
          // alternative's own, so usage validation still rejects annotated
          // union branches instead of losing them through composition.
          const own = resolve(alternative, path);
          return composed.readOnly === own.readOnly &&
            composed.writeOnly === own.writeOnly
            ? composed
            : {
                ...composed,
                readOnly: own.readOnly,
                writeOnly: own.writeOnly,
              };
        }),
        ...access,
      });
    }
    if (targets.some(({ schema }) => schema.kind === 'object')) {
      if (
        targets.some(
          ({ schema }) =>
            schema.kind !== 'object' &&
            !(schema.kind === 'map' && schema.values === true),
        )
      )
        fail(
          location,
          'allOf object composition cannot combine objects with scalars, arrays, typed maps or binary schemas',
        );
      if (
        !targets.some(
          ({ schema }) =>
            schema.kind === 'map' ||
            (schema.kind === 'object' && schema.typeExplicit),
        )
      )
        fail(
          location,
          'allOf object fragments require an explicit type: object conjunct',
        );
      let limits = constraintRecord();
      let additionalPropertiesExplicit = false;
      let explicitlyOpen = false;
      const fields = new Map<string, Schema[]>();
      const required = new Set<string>();
      const closed: Extract<Schema, { kind: 'object' }>[] = [];
      for (const target of targets) {
        limits = intersectConstraints(limits, target.limits);
        const shape = target.schema;
        if (shape.kind === 'object' || shape.kind === 'map') {
          additionalPropertiesExplicit ||= shape.additionalPropertiesExplicit;
          explicitlyOpen ||=
            shape.additionalPropertiesExplicit &&
            (shape.kind === 'map' || !shape.closed);
        }
        if (target.schema.kind !== 'object') continue;
        const object = objectChildren(target.schema, location);
        charge(object.properties.size + object.required.length, location);
        if (object.closed) closed.push(object);
        for (const name of object.required) required.add(name);
        for (const [name, child] of object.properties) {
          const existing = fields.get(name);
          if (existing) existing.push(child);
          else fields.set(name, [child]);
        }
      }
      charge(
        closed.length * fields.size + fields.size + required.size,
        location,
      );
      // A bare object assertion is neutral. Explicit additionalProperties:true
      // declares map intent, which must retain the same admission limit as a
      // direct declaration mixing fixed properties with dynamic entries. A
      // required name is a fixed member as well, declared or not: resolving
      // it into a field below would drop the map's other entries.
      if ((fields.size > 0 || required.size > 0) && explicitlyOpen)
        fail(
          location,
          'mixed fixed properties and dynamic maps are unsupported',
        );
      for (const object of closed)
        for (const name of fields.keys())
          if (!object.properties.has(name))
            fail(
              location,
              `allOf property ${JSON.stringify(name)} is forbidden by branch-local additionalProperties: false; declare it in each closed branch or remove that restriction`,
            );
      const properties = new Map<string, Schema>();
      // Match ordinary object normalization, including numeric-key enumeration.
      for (const name of propertyOrder(fields.keys())) {
        const children = fields.get(name)!;
        properties.set(
          name,
          children.length === 1
            ? children[0]!
            : normalize(
                schemaNode({
                  kind: 'intersection',
                  branches: children,
                  location: `${location}.properties.${name}`,
                }),
                `${location}.properties.${name}`,
              ),
        );
      }
      const result = schemaNode({
        kind: 'object',
        properties,
        required: [...required].sort(),
        closed: closed.length > 0,
        typeExplicit: true,
        additionalPropertiesExplicit,
        minProperties: limits.minProperties,
        maxProperties: limits.maxProperties,
        ...access,
      });
      return materializeObject(result, location);
    }
    if (
      targets.every(
        ({ schema }) => schema.kind === 'map' && schema.values === true,
      )
    ) {
      let limits = constraintRecord();
      for (const target of targets)
        limits = intersectConstraints(limits, target.limits);
      assertScalarRules('map', limits, undefined, location);
      return schemaNode({
        kind: 'map',
        additionalPropertiesExplicit: targets.some(
          ({ schema }) =>
            schema.kind === 'map' && schema.additionalPropertiesExplicit,
        ),
        values: true,
        minProperties: limits.minProperties,
        maxProperties: limits.maxProperties,
        ...access,
      });
    }
    // Scalar conjunctions keep their branches for emission. Plan them once here
    // to diagnose contradictions before selection, and expose the narrowed
    // literals on the canonical node for generated types. Register the plan
    // under that node so later lookups in this table reuse it.
    const result = schemaNode({
      kind: 'intersection',
      branches,
      location,
      ...access,
    });
    const plan = scalarValidationPlan(result, schemas);
    const summary = plan.base;
    const canonical = schemaNode({
      kind: 'intersection',
      branches,
      location,
      ...access,
      literals: 'literals' in summary ? summary.literals : undefined,
    });
    scalarPlans.get(schemas)!.set(canonical, plan);
    return canonical;
  }

  function normalize(input: Schema, location: string): Schema {
    const known = normalized.get(input);
    if (known) return known;
    if (processing.has(input)) recursiveExpansion(location);
    if (processing.size >= maximumCompositionNesting)
      fail(
        location,
        `allOf composition exceeds the supported limit of ${maximumCompositionNesting} nested schemas; reduce structural nesting, recursive regions or chains of allOf references`,
      );
    processing.add(input);
    charge(1, location);
    try {
      let result: Schema;
      switch (input.kind) {
        case 'intersection':
          result = intersection(input, input.location);
          break;
        case 'object': {
          result = materializeObject(objectChildren(input, location), location);
          break;
        }
        case 'array':
          result = {
            ...input,
            items: normalize(input.items, `${location}.items`),
          };
          break;
        case 'map':
          result = {
            ...input,
            values:
              input.values === true
                ? true
                : normalize(input.values, `${location}.additionalProperties`),
          };
          break;
        case 'union':
          result = {
            ...input,
            branches: input.branches.map((branch, index) =>
              normalize(branch, `${location}.${unionKeyword(input)}[${index}]`),
            ),
          };
          break;
        case 'ref':
        case 'json':
        case 'binary':
        case 'string':
        case 'number':
        case 'integer':
        case 'boolean':
        case 'null':
          result = input;
          break;
        default:
          return assertNever(input);
      }
      normalized.set(input, result);
      normalized.set(result, result);
      return result;
    } finally {
      processing.delete(input);
    }
  }
  return normalize;
}
