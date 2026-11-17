import { assertNever, ContractWorkError, fail } from './diagnostics.js';
import type { WarnSchema } from './diagnostics.js';
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
  constraintTypes,
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
import { createJsonTypeAnalysis } from './schema-domain.js';
import { assertUnionBranchAccess } from './directional.js';

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
      throw new ContractWorkError(
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

function assertionViolation(assertion: ScalarAssertion) {
  return assertion.kind === 'pattern'
    ? literalViolation({ pattern: assertion.pattern })
    : assertion.kind === 'format'
      ? literalViolation({}, assertion.format)
      : literalViolation({ multipleOf: assertion.value });
}

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
        'allOf branches have incompatible types or unsupported binary schemas; array items and map values must have compatible supported compositions',
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
    const checks = [literalViolation(bounds), ...atoms.map(assertionViolation)];
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
  // Composition replaces table entries as it completes them; see resolve().
  schemas: Map<string, Schema>,
  warn?: WarnSchema,
): (schema: Schema, location: string) => Schema {
  const normalized = new WeakMap<Schema, Schema>();
  const objects = new WeakMap<Schema, Extract<Schema, { kind: 'object' }>>();
  const resolved = new WeakMap<Schema, Resolved>();
  const processing = new Set<Schema>();
  const expandingObjects = new Set<Schema>();
  const charge = compositionBudget();
  const jsonTypes = createJsonTypeAnalysis(schemas, charge);
  const branchAccess = new WeakMap<Schema, Access>();

  function sourceAccess(input: Schema, location: string): Access {
    const known = branchAccess.get(normalized.get(input) ?? input);
    if (known) return known;
    // Inspect same-value annotations without composing an active ancestor. A
    // nullable recursive property may reference the allOf currently being built.
    // Canonical scalar intersections already own their effective flags: their
    // retained source conjuncts must not restore flags moved to an outer union.
    const frame = (schema: Schema) => {
      const current = normalized.get(schema) ?? schema;
      const children =
        current.kind === 'ref'
          ? [referenceTarget(current, schemas)]
          : current.kind === 'intersection' && !normalized.has(current)
            ? current.branches
            : [];
      charge(children.length + 1, location);
      return { schema: current, children, next: 0 };
    };
    const pending = [frame(input)];
    while (pending.length > 0) {
      const current = pending[pending.length - 1]!;
      const child = current.children[current.next++];
      if (child) {
        if (!branchAccess.has(normalized.get(child) ?? child))
          pending.push(frame(child));
        continue;
      }
      let access: Access = current.schema;
      for (const child of current.children)
        access = accessFlags(
          access,
          branchAccess.get(normalized.get(child) ?? child)!,
          location,
        );
      branchAccess.set(current.schema, access);
      pending.pop();
    }
    return branchAccess.get(normalized.get(input) ?? input)!;
  }

  function referenceConstraints(
    input: Extract<Schema, { kind: 'ref' }>,
    location: string,
  ): Schema {
    if (!hasConstraints(input.constraints)) return input;
    const types = jsonTypes(input, location);
    if (types.length !== 1) return input;
    const type = types[0]!;
    const ignored = constraintNames(input.constraints).filter((key) => {
      const appliesTo = constraintTypes.get(key);
      return appliesTo !== undefined && appliesTo !== type;
    });
    if (ignored.length === 0) return input;
    // Syntax was checked at the source boundary. A referenced single-type
    // schema proves these assertions inactive (JSON Schema Core §7.6.1).
    // Point at the source $ref: single-ref allOf folding may combine siblings
    // from its enclosing schema, so a synthesized keyword path could be wrong.
    for (const key of ignored)
      warn?.(
        input.location,
        `${key} has no effect on a reference to type ${type}; it applies only to ${constraintTypes.get(key)} values`,
      );
    return {
      ...input,
      constraints: constraintRecord(
        Object.fromEntries(
          Object.entries(input.constraints).filter(
            ([key]) => !ignored.includes(key),
          ),
        ),
      ),
    };
  }

  const recursiveExpansion = (location: string): never =>
    fail(
      location,
      'recursive allOf object expansion is unsupported; keep recursive edges as local property, array-item or map-value references without overlapping object composition',
    );

  // A distributed branch can be anchored at a source reference or virtual
  // enum/type assertion. Those values have no child schema fields to append.
  const childLocation = (location: string, suffix: string): string =>
    /\.(?:\$ref|enum|type)$/.test(location)
      ? location
      : `${location}.${suffix}`;

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
        // Publish a component composed out of name order. Type analysis and
        // scalar plans read the table too; seeing its raw entry instead would
        // let component names decide whether a composition succeeds.
        const owner = path.at(-1);
        if (owner && schemas.get(owner.name) === current)
          schemas.set(owner.name, composed);
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
          normalize(child, childLocation(location, `properties.${name}`)),
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
    // Synthesized required-only fields in a referenced component do not make
    // a composed map fixed. Only source-declared properties establish that.
    const map =
      !input.closed &&
      !input.hasDeclaredProperties &&
      (input.additionalPropertiesExplicit || input.required.length === 0);
    const object = map ? input : requiredMembers(input, location);
    assertScalarRules('object', object, undefined, location);
    // Object fragments retain their assertions until composition completes.
    // With no declared fields, fixed required names or explicit closure, those
    // assertions describe an open JSON map, even if they constrain its property
    // count. Derive the output constructor here, before directional projection:
    // a fixed object whose fields are later excluded must remain a fixed empty
    // object.
    if (map)
      return schemaNode({
        kind: 'map',
        additionalPropertiesExplicit: object.additionalPropertiesExplicit,
        values: true,
        required: object.required,
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
    enclosingWarnings?: Set<string>,
  ): Schema {
    // Distributed parts share their written composition's warning scope. A
    // part may reject null while another retains it; only the complete result
    // can establish that a source nullable type has no effect.
    const candidates = enclosingWarnings ?? new Set<string>();
    const result = composeIntersection(input, location, candidates);
    if (
      enclosingWarnings === undefined &&
      candidates.size > 0 &&
      !jsonTypes(result, location).includes('null')
    )
      for (const path of candidates)
        warn?.(
          path,
          'a nullable type has no effect here because another schema in the same composition never accepts null; to accept null, wrap the composition in an outer anyOf with a null-only branch',
        );
    return result;
  }

  function composeIntersection(
    input: Extract<Schema, { kind: 'intersection' }>,
    location: string,
    inactiveNulls: Set<string>,
  ): Schema {
    const pending: { schema: Schema; location: string }[] = [
      { schema: input, location },
    ];
    let branches: Schema[] = [];
    let branchLocations: string[] = [];
    const seen = new Set<Schema>();
    const references = new Set<string>();
    let access: Access = { readOnly: false, writeOnly: false };
    // Warn only where the nullable type was written in this composition. A
    // narrower use of a reference does not make its declaration ineffective.
    const inactiveNull = (index: number): void => {
      const written = branches[index]!;
      if (
        written.kind === 'union' &&
        written.typeArrayLocation === `${branchLocations[index]}.type`
      )
        inactiveNulls.add(written.typeArrayLocation);
    };
    // Flatten same-instance composition before checking required-only fragments.
    // Each source branch was normalized already, so deduplication loses no checks.
    while (pending.length > 0) {
      const { schema: current, location: currentLocation } = pending.pop()!;
      if (seen.has(current)) continue;
      seen.add(current);
      charge(1, location);
      access = accessFlags(access, current, location);
      if (current.kind === 'intersection') {
        charge(current.branches.length, location);
        for (let index = current.branches.length - 1; index >= 0; index--)
          pending.push({
            schema: current.branches[index]!,
            location:
              current.branchLocations?.[index] ??
              `${current.location}[${index}]`,
          });
      } else {
        const branch =
          current.kind === 'object'
            ? objectChildren(current, currentLocation)
            : normalize(current, currentLocation);
        if (branch.kind === 'object' && branch.closed)
          requiredMembers(branch, currentLocation);
        // Repeating the same unrefined component adds no assertion. Keep the
        // reference (including its alias chain), and accumulate own access first.
        // Different names or use-site constraints can carry distinct checks.
        if (branch.kind === 'ref' && !hasConstraints(branch.constraints)) {
          if (references.has(branch.name)) continue;
          references.add(branch.name);
        }
        access = accessFlags(access, branch, location);
        if (branch.kind !== 'json') {
          branches.push(branch);
          branchLocations.push(currentLocation);
        }
      }
    }
    // Inspect assertion-only aliases without composing their targets. Resolving
    // an active recursive allOf first would reenter it before a redundant type
    // can be removed. This cache is local: composition still mutates the table.
    const terminals = new WeakMap<Schema, Schema>();
    const unrefined = (input: Schema): Schema => {
      const path: Schema[] = [];
      let current = input;
      while (
        current.kind === 'ref' &&
        !hasConstraints(current.constraints) &&
        !terminals.has(current)
      ) {
        charge(1, location);
        path.push(current);
        current = referenceTarget(current, schemas);
      }
      const target = terminals.get(current) ?? current;
      for (const link of path) terminals.set(link, target);
      return target;
    };
    if (branches.length > 1) {
      const retained: string[] = [];
      branches = branches.filter((branch, index) => {
        const path = branchLocations[index]!;
        if (unrefined(branch).kind !== 'json') {
          retained.push(path);
          return true;
        }
        access = accessFlags(access, sourceAccess(branch, location), location);
        return false;
      });
      branchLocations = retained;
    }
    if (branches.length === 0) return schemaNode({ kind: 'json', ...access });
    if (branches.length === 1) {
      const branch = branches[0]!;
      return materializeObject({ ...branch, ...access }, location);
    }
    // A conjunct that only restates JSON types every other conjunct already
    // implies adds no rule, wherever it is written. Dropping it keeps the other
    // references intact, rather than merging and recursively expanding their
    // fields just to establish a top-level type.
    const bareObject = (schema: Schema): boolean =>
      schema.kind === 'map' &&
      schema.values === true &&
      !schema.additionalPropertiesExplicit &&
      schema.required.length === 0 &&
      schema.minProperties === undefined &&
      schema.maxProperties === undefined;
    const restated = (input: Schema): readonly string[] | undefined => {
      const schema = unrefined(input);
      if (bareObject(schema)) return ['object'];
      return schema.kind === 'union' &&
        schema.nullableType &&
        schema.branches.every((branch) => {
          const value = unrefined(branch);
          return value.kind === 'null' || bareObject(value);
        })
        ? ['object', 'null']
        : undefined;
    };
    const kept = branches.map(() => true);
    for (const [index, branch] of branches.entries()) {
      const types = restated(branch);
      if (!types) continue;
      const others = branches.filter(
        (_, position) => position !== index && kept[position],
      );
      charge(others.length, location);
      if (
        others.length === 0 ||
        !others.every((other) =>
          jsonTypes(other, location).every((type) => types.includes(type)),
        )
      )
        continue;
      access = accessFlags(access, sourceAccess(branch, location), location);
      kept[index] = false;
      if (
        types.includes('null') &&
        !others.every((other) => jsonTypes(other, location).includes('null'))
      )
        inactiveNull(index);
    }
    if (kept.includes(false)) {
      branches = branches.filter((_, index) => kept[index]);
      branchLocations = branchLocations.filter((_, index) => kept[index]);
      if (branches.length === 1)
        return materializeObject({ ...branches[0]!, ...access }, location);
    }
    const targets = branches.map((branch, index) =>
      resolve(branch, branchLocations[index]!),
    );
    for (const target of targets)
      access = accessFlags(access, target, location);
    const finiteValues = (input: Schema): readonly Scalar[] | undefined => {
      const target = resolve(input, location).schema;
      if (target.kind === 'union') {
        if (!target.sourceLiterals && !target.nullableType) return undefined;
        const values: Scalar[] = [];
        for (const branch of target.branches) {
          const members = finiteValues(branch);
          if (!members) return undefined;
          charge(members.length, location);
          for (const value of members) values.push(value);
        }
        return values;
      }
      const value =
        target.kind === 'intersection'
          ? scalarIntersectionBase(input, schemas)
          : target;
      if (value.kind === 'null') return [null];
      return 'literals' in value ? value.literals : undefined;
    };
    const finite = targets.some(({ schema }) => schema.kind === 'union')
      ? branches.map(finiteValues)
      : [];
    const literalNarrowing = finite.some((values) => values !== undefined);
    // allOf distributes over a union: A and (B or C) is (A and B) or (A and C).
    // Keep cardinality when narrowing: impossible type combinations contribute
    // zero matches to oneOf, while compatible alternatives can still overlap.
    // Deeper contradictions remain diagnostics, rather than guessing whether a
    // container with impossible children can still admit an empty value.
    // Distribute untagged unions first so tagged ones
    // stay inside and can keep dispatching on their own tag.
    const unions = targets.flatMap(({ schema }, position) =>
      schema.kind === 'union' ? [{ union: schema, position }] : [],
    );
    // Tagged dispatch needs object branches. Multiplying tagged factors would
    // instead nest one tagged union inside another's mapped branches.
    if (unions.filter(({ union }) => union.discriminator).length > 1)
      fail(
        location,
        'allOf cannot intersect multiple discriminated oneOf schemas in this version; use anyOf for a factor whose required, distinct literal tags make its branches disjoint',
      );
    // Type declarations distribute first: literal candidates then narrow them
    // the same way whichever member order the author chose.
    const factor =
      unions.find(({ union }) => union.nullableType) ??
      unions.find(
        ({ union }) => !union.discriminator && !union.sourceLiterals,
      ) ??
      unions[0];
    if (factor) {
      const { union, position } = factor;
      const others = branches.filter((_, index) => index !== position);
      const otherLocations = branchLocations.filter(
        (_, index) => index !== position,
      );
      const commonTypes = others.reduce<readonly string[]>(
        (types, branch) =>
          types.filter((type) =>
            jsonTypes(branch, location).some((own) => own === type),
          ),
        jsonTypes(branches[position]!, location),
      );
      // An untyped enum lists permitted scalar values; its different-type
      // groups are assertions to narrow, not explicit alternatives to retain.
      // Explicit anyOf/oneOf branches still diagnose incompatible conjuncts.
      const predicates = new WeakMap<Schema, (value: Scalar) => boolean>();
      const acceptsLiteral = (input: Schema): ((value: Scalar) => boolean) => {
        const known = predicates.get(input);
        if (known) return known;
        const target = resolve(input, location).schema;
        let accepts: (value: Scalar) => boolean;
        if (target.kind === 'json') accepts = () => true;
        else if (target.kind === 'union') {
          // Explicit alternatives remain structural: distribution, rather than
          // finite pruning, diagnoses any contradictory explicit branch.
          if (target.sourceLiterals || target.nullableType) {
            const alternatives = target.branches.map(acceptsLiteral);
            accepts = (value) => alternatives.some((branch) => branch(value));
          } else accepts = () => true;
        } else if (
          target.kind === 'intersection' ||
          target.kind === 'string' ||
          target.kind === 'number' ||
          target.kind === 'integer' ||
          target.kind === 'boolean' ||
          target.kind === 'null'
        ) {
          const plan = scalarValidationPlan(input, schemas);
          const base = plan.base;
          const checks = [
            literalViolation(schemaConstraints(base)),
            ...plan.assertions.map(assertionViolation),
          ];
          const literals = 'literals' in base ? base.literals : undefined;
          charge(literals?.length ?? 0, location);
          const members = literals && new Set(literals);
          accepts = (value) => {
            charge(checks.length + 1, location);
            return (
              (base.kind === 'null'
                ? value === null
                : base.kind === 'integer'
                  ? typeof value === 'number' && Number.isInteger(value)
                  : typeof value === base.kind) &&
              (!members || members.has(value)) &&
              checks.every((check) => check(value) === undefined)
            );
          };
        } else accepts = () => false;
        predicates.set(input, accepts);
        return accepts;
      };
      let candidates: readonly Scalar[] | undefined;
      if (literalNarrowing) {
        for (const values of finite) {
          if (!values) continue;
          charge(values.length + (candidates?.length ?? 0), location);
          const members = new Set(values);
          candidates = candidates?.filter((value) => members.has(value)) ?? [
            ...members,
          ];
        }
        if (candidates) {
          for (const branch of branches)
            candidates = candidates.filter(acceptsLiteral(branch));
        }
      }
      charge(union.branches.length * branches.length, location);
      const alternatives = union.branches
        .map((schema, index) => ({
          schema,
          index,
        }))
        .filter(({ schema: alternative }) => {
          return (
            jsonTypes(alternative, location).some((type) =>
              commonTypes.includes(type),
            ) &&
            (!candidates ||
              (!union.sourceLiterals && !union.nullableType) ||
              candidates.some(acceptsLiteral(alternative)))
          );
        });
      if (alternatives.length === 0)
        fail(
          location,
          candidates
            ? 'allOf constraints admit no literal value'
            : 'allOf branches admit no value of a common JSON type',
        );
      const acceptsNull = (alternative: Schema): boolean =>
        jsonTypes(alternative, location).includes('null');
      if (
        union.branches.some(acceptsNull) &&
        !alternatives.some(({ schema }) => acceptsNull(schema))
      )
        inactiveNull(position);
      const composedBranches = alternatives.map(
        ({ schema: alternative, index }) => {
          const source = branches[position]!;
          const path =
            source.kind === 'ref'
              ? source.location
              : union.sourceLiterals
                ? `${branchLocations[position]}.enum`
                : union.typeArrayLocation
                  ? `${branchLocations[position]}.type`
                  : `${branchLocations[position]}.${unionKeyword(union)}[${index}]`;
          const composed = normalize(
            schemaNode({
              kind: 'intersection',
              branches: [alternative, ...others],
              branchLocations: [path, ...otherLocations],
              location: path,
            }),
            path,
            inactiveNulls,
          );
          // Register the access-neutral alternative as canonical too. A later
          // composition must not rebuild it from conjuncts whose annotations
          // have already moved to the enclosing union.
          const own = resolve(alternative, path);
          if (
            composed.readOnly === own.readOnly &&
            composed.writeOnly === own.writeOnly
          )
            return composed;
          const projected = {
            ...composed,
            readOnly: own.readOnly,
            writeOnly: own.writeOnly,
          };
          normalized.set(projected, projected);
          return projected;
        },
      );
      const sourceLiterals =
        union.sourceLiterals ||
        (union.nullableType && literalNarrowing ? true : undefined);
      // One remaining anyOf alternative is that schema. An untagged oneOf
      // stays a union: its branch keeps source closure during matching.
      if (
        composedBranches.length === 1 &&
        (sourceLiterals ||
          (union.cardinality === 'any' && !union.discriminator))
      )
        return { ...composedBranches[0]!, ...access };
      const positions = new Map(
        alternatives.map(({ index }, position) => [index, position]),
      );
      return schemaNode({
        kind: 'union',
        cardinality: union.cardinality,
        nullableType: union.nullableType,
        discriminator: union.discriminator && {
          propertyName: union.discriminator.propertyName,
          mapping: new Map(
            [...union.discriminator.mapping].flatMap(([tag, index]) => {
              const position = positions.get(index);
              return position === undefined ? [] : [[tag, position] as const];
            }),
          ),
        },
        sourceLiterals,
        branches: composedBranches,
        ...access,
      });
    }
    const childComposition = (values: Schema[], locations: string[]): Schema =>
      values.length === 1
        ? normalize(values[0]!, locations[0]!)
        : normalize(
            schemaNode({
              kind: 'intersection',
              branches: values,
              branchLocations: locations,
              location: locations[0]!,
            }),
            locations[0]!,
          );
    const sourceChild = (index: number, suffix: string): string => {
      const source = branches[index]!;
      return source.kind === 'ref'
        ? source.location
        : childLocation(branchLocations[index]!, suffix);
    };
    if (targets.every(({ schema }) => schema.kind === 'array')) {
      let limits = constraintRecord();
      const items: Schema[] = [];
      const locations: string[] = [];
      for (const [index, target] of targets.entries()) {
        if (target.schema.kind !== 'array') continue;
        limits = intersectConstraints(limits, target.limits);
        items.push(target.schema.items);
        locations.push(sourceChild(index, 'items'));
      }
      // Compose once before projection. Runtime list parsing then observes each
      // item once, checks all container rules, and copies the combined shape.
      const result = schemaNode({
        kind: 'array',
        items: childComposition(items, locations),
        minItems: limits.minItems,
        maxItems: limits.maxItems,
        uniqueItems: limits.uniqueItems,
        ...access,
      });
      assertScalarRules(
        'array',
        schemaConstraints(result),
        undefined,
        location,
      );
      return result;
    }
    if (
      targets.some(({ schema }) => schema.kind === 'map') &&
      (targets.every(({ schema }) => schema.kind === 'map') ||
        targets.some(
          ({ schema }) =>
            schema.kind === 'map' && schema.additionalPropertiesExplicit,
        )) &&
      targets.every(
        ({ schema }) =>
          schema.kind === 'map' ||
          (schema.kind === 'object' &&
            !schema.hasDeclaredProperties &&
            !schema.closed),
      )
    ) {
      let limits = constraintRecord();
      const values: Schema[] = [];
      const locations: string[] = [];
      const required = new Set<string>();
      let explicit = false;
      for (const [index, target] of targets.entries()) {
        const map = target.schema;
        if (map.kind !== 'map' && map.kind !== 'object') continue;
        limits = intersectConstraints(limits, target.limits);
        explicit ||= map.additionalPropertiesExplicit;
        charge(map.required.length, location);
        for (const name of map.required) required.add(name);
        if (map.kind === 'map' && map.values !== true) {
          values.push(map.values);
          locations.push(sourceChild(index, 'additionalProperties'));
        }
      }
      // A required-only object contributes keys, not fixed fields. The map's
      // value conjunction validates every entry, including those required keys.
      const result = schemaNode({
        kind: 'map',
        values:
          values.length === 0 ? true : childComposition(values, locations),
        required: [...required].sort(),
        additionalPropertiesExplicit: explicit,
        minProperties: limits.minProperties,
        maxProperties: limits.maxProperties,
        ...access,
      });
      assertScalarRules('map', schemaConstraints(result), undefined, location);
      return result;
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
      const fields = new Map<string, Schema[]>();
      const fieldLocations = new Map<string, string[]>();
      const required = new Set<string>();
      const requiredLocations = new Map<string, string>();
      const closed: Extract<Schema, { kind: 'object' }>[] = [];
      const requireNames = (names: readonly string[], index: number): void => {
        const source = branches[index]!;
        for (const name of names) {
          required.add(name);
          requiredLocations.set(
            name,
            source.kind === 'ref'
              ? source.location
              : childLocation(branchLocations[index]!, 'required'),
          );
        }
      };
      for (const [index, target] of targets.entries()) {
        limits = intersectConstraints(limits, target.limits);
        if (target.schema.kind === 'map') {
          // A declared map's required keys join the conjunction like any other
          // required name: fields beside declared properties, keys of a map.
          charge(target.schema.required.length, location);
          requireNames(target.schema.required, index);
        }
        if (target.schema.kind !== 'object') continue;
        const object = objectChildren(target.schema, location);
        charge(object.properties.size + object.required.length, location);
        if (object.closed) closed.push(object);
        requireNames(object.required, index);
        for (const [name, child] of object.properties) {
          const existing = fields.get(name);
          if (existing) existing.push(child);
          else fields.set(name, [child]);
          const source = branches[index]!;
          const path =
            source.kind === 'ref'
              ? source.location
              : childLocation(branchLocations[index]!, `properties.${name}`);
          const locations = fieldLocations.get(name);
          if (locations) locations.push(path);
          else fieldLocations.set(name, [path]);
        }
      }
      charge(
        closed.length * fields.size + fields.size + required.size,
        location,
      );
      for (const object of closed)
        for (const name of fields.keys())
          if (!object.properties.has(name))
            fail(
              location,
              `allOf property ${JSON.stringify(name)} is forbidden by branch-local additionalProperties: false; declare it in each closed branch or remove that restriction`,
            );
      if (closed.length > 0)
        for (const name of required)
          if (!fields.has(name))
            fail(
              requiredLocations.get(name)!,
              `unknown property ${JSON.stringify(name)}`,
            );
      const properties = new Map<string, Schema>();
      // Match ordinary object normalization, including numeric-key enumeration.
      for (const name of propertyOrder(fields.keys())) {
        const children = fields.get(name)!;
        const locations = fieldLocations.get(name)!;
        properties.set(name, childComposition(children, locations));
      }
      const result = schemaNode({
        kind: 'object',
        properties,
        required: [...required].sort(),
        closed: closed.length > 0,
        typeExplicit: true,
        additionalPropertiesExplicit: targets.some(
          ({ schema }) =>
            (schema.kind === 'object' || schema.kind === 'map') &&
            schema.additionalPropertiesExplicit,
        ),
        hasDeclaredProperties: targets.some(
          ({ schema }) =>
            schema.kind === 'object' && schema.hasDeclaredProperties,
        ),
        minProperties: limits.minProperties,
        maxProperties: limits.maxProperties,
        ...access,
      });
      return materializeObject(result, location);
    }
    // Scalar conjunctions keep their branches for emission. Plan them once here
    // to diagnose contradictions before selection, and expose the narrowed
    // literals on the canonical node for generated types. Register the plan
    // under that node so later lookups in this table reuse it.
    const result = schemaNode({
      kind: 'intersection',
      branches,
      branchLocations,
      location,
      ...access,
    });
    const plan = scalarValidationPlan(result, schemas);
    const summary = plan.base;
    const canonical = {
      ...result,
      literals: 'literals' in summary ? summary.literals : undefined,
    };
    scalarPlans.get(schemas)!.set(canonical, plan);
    return canonical;
  }

  function normalize(
    input: Schema,
    location: string,
    enclosingWarnings?: Set<string>,
  ): Schema {
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
          result = intersection(input, input.location, enclosingWarnings);
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
        case 'union': {
          const branches = input.branches.map((branch, index) =>
            normalize(branch, `${location}.${unionKeyword(input)}[${index}]`),
          );
          // Validate each source union, including nested unions, before another
          // conjunction can remove a type-disjoint alternative.
          for (const [index, branch] of branches.entries())
            assertUnionBranchAccess(
              sourceAccess(branch, location),
              `${location}.${unionKeyword(input)}[${index}]`,
            );
          result = {
            ...input,
            branches,
          };
          break;
        }
        case 'ref':
          result = referenceConstraints(input, location);
          break;
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
