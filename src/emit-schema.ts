import {
  array,
  data,
  identifier,
  jsonSource,
  literal,
  object,
  propertyKey,
} from './code.js';
import type { Expression } from './code.js';
import { fail } from './diagnostics.js';
import type {
  Client,
  ConstraintInput,
  Constraints,
  SchemaTable,
  Direction,
  DirectionalSchemas,
  Schema,
  SchemaFormat,
} from './model.js';
import { hasConstraints, constraintRecord, schemaNode } from './schema-node.js';
import { hasUnicodeProperty, intersectConstraints } from './scalar-rules.js';
import { isRequired } from './required-index.js';
import { scalarValidationPlan } from './intersections.js';
import { stringFormatHelpers } from './formats.js';
import {
  numberConstraints,
  objectConstraints as objectRules,
  recursiveSchemas,
  resolveSchema,
  schemaBranchLocation,
  schemaReferences,
  stringConstraints as stringRules,
  terminalName,
} from './schemas.js';
import { sourceBudget } from './source-budget.js';

// Bounds are data, so sharing them by schema identity does not share emitted
// constants. Each parser still owns its own constant and directional behavior.
function containerConstraints(
  value: Extract<Schema, { kind: 'ref' }>,
  schemas: SchemaTable,
  cache: WeakMap<Schema, Constraints>,
  base: Constraints,
): Constraints {
  const pending: Extract<Schema, { kind: 'ref' }>[] = [];
  let current: Schema = value;
  while (current.kind === 'ref' && !cache.has(current)) {
    pending.push(current);
    current = schemas.get(current.name)!;
  }
  let limits = cache.get(current) ?? base;
  for (let index = pending.length - 1; index >= 0; index--) {
    const reference = pending[index]!;
    limits = intersectConstraints(limits, reference.constraints);
    cache.set(reference, limits);
  }
  return limits;
}

// Resolve pure links once per normalized schema table. Path compression shares
// suffixes without crossing a constrained alias or caching mutable input documents.
// Normalization has already diagnosed missing targets and same-value alias cycles.
export function parserIdentities(
  schemas: SchemaTable,
): (name: string) => string {
  const cache = new Map<string, string>();
  return (name) => {
    const path: string[] = [];
    let target = name;
    for (;;) {
      const known = cache.get(target);
      if (known !== undefined) {
        target = known;
        break;
      }
      const schema = schemas.get(target)!;
      if (schema.kind !== 'ref' || hasConstraints(schema.constraints)) break;
      path.push(target);
      target = schema.name;
    }
    cache.set(target, target);
    for (const alias of path) cache.set(alias, target);
    return target;
  };
}

export type ObjectField = Readonly<{
  name: string;
  required: boolean;
  parse: Expression;
}>;

// float is an internal format rule, never an accepted schema keyword.
const numberRules = ['float', ...numberConstraints] as const;

// Requests compare the parsed values they send. Responses compare received
// items, which fixed-object parsing may strip, as JSON Schema requires.
function arrayRules(
  limits: ConstraintInput,
  direction: Direction,
): Expression | undefined {
  return rules(
    limits,
    ['minItems', 'maxItems'],
    limits.uniqueItems
      ? [
          [
            'uniqueItems',
            literal(direction === 'request' ? 'sent' : 'received'),
          ],
        ]
      : [],
  );
}

function rules(
  limits: ConstraintInput,
  keys: readonly (keyof Constraints)[],
  extra: readonly (readonly [string, Expression])[] = [],
): Expression | undefined {
  const entries: (readonly [string, Expression])[] = [...extra];
  for (const key of keys) {
    const value = limits[key];
    if (value !== undefined) entries.push([key, literal(value)]);
  }
  return entries.length ? object(entries) : undefined;
}

// Contract types stay independent of constructor metadata. Explicit Parse<T>
// bindings check each constructor against its contract and keep child graphs
// named, bounding expression and inference depth. Ordered and large objects
// retain checked return bodies when a keyed constructor would change behavior.
export function schemaRenderer(
  schemas: DirectionalSchemas,
  reference: (name: string, direction: Direction) => Expression,
  typeOf: (schema: Schema, direction: Direction) => string,
  target?: Client['target'],
) {
  const identities = {
    request: parserIdentities(schemas.request),
    response: parserIdentities(schemas.response),
  };
  const recursion = {
    request: recursiveSchemas(schemas.request).reachable,
    response: recursiveSchemas(schemas.response).reachable,
  };
  const containerBounds: Record<Direction, WeakMap<Schema, Constraints>> = {
    request: new WeakMap(),
    response: new WeakMap(),
  };
  const helpers = new Set<string>();
  const typeImports = new Set<string>();
  const declarations: string[] = [];
  const parts = new Map<string, number>();
  // Equivalent scalar leaves share constructors. Composite parts share by node
  // identity within one emission scope and direction, across declaration drains.
  // Separate entry points retain the same bindings whether their source was
  // inherited or repeated explicitly; parser reuse never reuses parsed values.
  const scalarParts = new Map<string, Expression>();
  const compositeParts: Record<
    Direction,
    Map<string, WeakMap<Schema, Expression>>
  > = {
    request: new Map(),
    response: new Map(),
  };
  // Validated names identify one format per output module. Retain these
  // identities across declaration drains so later components share them.
  const registeredFormats = new Map<string, Expression>();
  const account = sourceBudget();
  const append = (declaration: string, location = 'generated schema') => {
    // Charge each declaration before retaining it or joining a module. Draining
    // declarations must not reset the renderer's lifetime source budget.
    account(declaration, location);
    declarations.push(declaration);
  };
  const use = (name: string): Expression => {
    helpers.add(name);
    return identifier(name);
  };
  // Reference a component's parser. A pure alias chain has no binding of its
  // own: it shares the first constrained target, or the terminal parser.
  const component = (name: string, direction: Direction): Expression => {
    return reference(identities[direction](name), direction);
  };
  function functionDeclaration(
    name: string,
    type: string,
    body: readonly string[],
    exported: boolean,
    extraParameters = '',
  ): string {
    typeImports.add('Issues');
    typeImports.add('Invalid');
    return `${exported ? 'export ' : ''}function ${name}(input: unknown, issues: Issues${extraParameters}): ${type} | Invalid {
      ${body.join('\n')}
    }`;
  }

  function parserBinding(
    name: string,
    type: string,
    initializer: string,
    exported: boolean,
    location: string,
    arrayType = false,
  ): void {
    typeImports.add(arrayType ? 'ArrayParse' : 'Parse');
    const annotation = arrayType
      ? `ArrayParse<(${type})[number]>`
      : `Parse<${type}>`;
    append(
      // Bound TypeScript's control-flow walk at a function body. Referencing
      // earlier parsers in module-level constructors makes checking quadratic.
      // The factory still constructs and caches each parser exactly once.
      `function make_${name}(): ${annotation} { return ${initializer}; }
      ${exported ? 'export ' : ''}const ${name}: ${annotation} = /* @__PURE__ */ make_${name}();`,
      location,
    );
  }

  // Module-level rules and case tables contain only literals and named parser
  // references. Explicit parser annotations bound inference; constructors only
  // capture this private static data and defer validation until parsing.
  function constant(name: string, value: string, type?: string): string {
    if (type && /^\w+$/.test(type)) typeImports.add(type);
    append(
      `const ${name}${type ? `: ${type}` : ''} = ${value};`,
      `generated parser ${name}`,
    );
    return name;
  }

  function objectChecks(
    body: string[],
    failures: string[],
    name: string,
    fields: readonly ObjectField[],
    forbidden: readonly string[],
  ): void {
    if (forbidden.length) {
      const blocked = constant(`forbidden_${name}`, data(forbidden).source);
      body.push(
        `const blocked = ${use('forbiddenKeys').source}(source, ${blocked}, issues);`,
      );
      failures.push('blocked');
    }
    // Forbidden keys are known declarations: report their presence once, rather
    // than also classifying them as unknown enumerable fields.
    const known = [...fields.map((entry) => entry.name), ...forbidden];
    const keys = known.length
      ? constant(`keys_${name}`, data(known).source)
      : use('noKeys').source;
    body.push(
      `const extra = ${use('unknownKeys').source}(source, ${keys}, issues);`,
    );
    failures.push('extra');
  }

  // Declare a fixed-object parser. Request objects reject unknown keys; response
  // objects strip them because only declared fields enter the fresh result.
  // Optional keys use a conditional spread: TypeScript merges it into an
  // optional property, and declared key order is preserved.
  function objectParser(
    name: string,
    type: string,
    fields: readonly ObjectField[],
    strict: boolean,
    exported = false,
    forbidden: readonly string[] = [],
    limits?: Expression,
    chunk = false,
  ): void {
    const sizeCheck = (body: string[]) => {
      if (!limits) return;
      const bounds = constant(`rules_${name}`, limits.source, 'ObjectRules');
      // Request counts use the normalized value sent as JSON. Response counts
      // precede stripping; chunk parsers omit bounds so only the outer counts.
      body.push(
        `if (${use('propertyCount').source}(${strict ? 'output' : 'source'}, issues, ${bounds}${strict ? ', true' : ''})) return invalid;`,
      );
    };
    const admission = (body: string[]) => {
      // The complete object owns one entry check. Chunks must not repeat it
      // after earlier fields have already read or changed the caller's value.
      if (chunk) return '_missing';
      const names = fields
        .filter((field) => field.required)
        .map((field) => field.name);
      if (names.length === 0) return 'undefined';
      const required = constant(`required_${name}`, data(names).source);
      body.push(
        `const missing = ${use('requiredKeys').source}(source, ${required}, issues);`,
        'if (missing === invalid) return invalid;',
      );
      return 'missing';
    };
    // Bound TypeScript's failure-condition flow graph while retaining a checked
    // return for every field. Preserve sibling issues in source order until
    // the shared issue budget stops further chunks.
    if (fields.length > 128) {
      helpers.add('invalid');
      const body = [
        `const source = ${use('objectValue').source}(input, issues);`,
        'if (source === invalid) return invalid;',
      ];
      const missing = admission(body);
      if (!strict) sizeCheck(body);
      const values: string[] = [];
      for (let start = 0; start < fields.length; start += 64) {
        const group = fields.slice(start, start + 64);
        const parser = `${name}_fields${start / 64}`;
        const picked = group.map((entry) => jsonSource(entry.name)).join(' | ');
        objectParser(
          parser,
          `Pick<${type}, ${picked}>`,
          group,
          false,
          false,
          [],
          undefined,
          true,
        );
        const value = `group${start / 64}`;
        values.push(value);
        body.push(`const ${value} = ${parser}(source, issues, ${missing});`);
        body.push(`if (${use('exhausted').source}(issues)) return invalid;`);
      }
      const failures = values.map((value) => `${value} === invalid`);
      if (strict) objectChecks(body, failures, name, fields, forbidden);
      body.push(`if (${failures.join(' || ')}) return invalid;`);
      const output = `{${values.map((value) => `...${value}`).join(',')}}`;
      if (strict && limits) {
        body.push(`const output = ${output};`);
        sizeCheck(body);
        body.push('return output;');
      } else body.push(`return ${output};`);
      append(
        functionDeclaration(name, type, body, exported),
        `generated parser ${name}`,
      );
      return;
    }
    // A keyed table enumerates integer-like names in JS own-key order.
    // Parameter groups instead preserve the declared OpenAPI sequence, so use
    // the original body whenever those orders differ. Empty projected objects
    // and all chunks retain the original representation as well.
    const order = Object.keys(
      Object.fromEntries(fields.map((entry) => [entry.name, true])),
    );
    if (
      !chunk &&
      fields.length > 0 &&
      fields.every((entry, index) => entry.name === order[index])
    ) {
      const table = object([
        ...fields.map((entry): readonly [string, Expression] => [
          entry.name,
          entry.required ? entry.parse : array([entry.parse]),
        ]),
        ...forbidden.map((name): readonly [string, Expression] => [
          name,
          literal(false),
        ]),
      ]);
      parserBinding(
        name,
        type,
        `${use('fixedObject').source}<${type}>(${table.source}, ${strict}${limits ? `, ${limits.source}` : ''})`,
        exported,
        `generated parser ${name}`,
      );
      return;
    }
    helpers.add('invalid');
    const body = [
      `const source = ${use('objectValue').source}(input, issues);`,
      'if (source === invalid) return invalid;',
    ];
    const missing = admission(body);
    if (!strict) sizeCheck(body);
    // Required results have no symbol except Invalid. Checking its primitive
    // kind also handles null | Invalid widening to symbol without
    // strictNullChecks. Optional results must keep Absent distinct.
    const failures = fields.map((entry, index) => {
      const helper = use(entry.required ? 'field' : 'optionalField');
      body.push(
        `const v${index} = ${helper.source}(source, ${jsonSource(entry.name)}, ${entry.parse.source}, issues${entry.required ? `, ${missing}` : ''});`,
      );
      return entry.required
        ? `typeof v${index} === "symbol"`
        : `v${index} === invalid`;
    });
    if (strict) objectChecks(body, failures, name, fields, forbidden);
    if (failures.length)
      body.push(`if (${failures.join(' || ')}) return invalid;`);
    const properties = fields.map((entry, index) => {
      const key = propertyKey(entry.name);
      if (entry.required) return `${key}: v${index}`;
      helpers.add('absent');
      return `...(v${index} === absent ? {} : { ${key}: v${index} })`;
    });
    const output = `{${properties.join(',')}}`;
    if (strict && limits) {
      body.push(`const output = ${output};`);
      sizeCheck(body);
      body.push('return output;');
    } else body.push(`return ${output};`);
    append(
      functionDeclaration(
        name,
        type,
        body,
        exported,
        chunk ? ', _missing?: ReadonlySet<string>' : '',
      ),
      `generated parser ${name}`,
    );
  }

  // Return a Parse function name for a child schema. Unconstrained references,
  // binary targets, JSON and plain scalars use existing functions. Other scalar
  // leaves share checked functions; shared containers keep one flat binding.
  function part(
    value: Schema,
    direction: Direction,
    location: string,
    scope: string,
  ): Expression {
    if (value.kind === 'ref' && !hasConstraints(value.constraints))
      return component(value.name, direction);
    if (value.kind === 'json') return use('jsonValue');
    if (value.kind === 'binary') {
      if (!target)
        fail(location, 'binary schema requires a multipart client target');
      return use(target === 'browser' ? 'browserFile' : 'nativeFile');
    }
    if (value.kind === 'boolean' && !value.literals) return use('booleanValue');
    if (value.kind === 'null') return use('nullValue');
    if (
      (value.kind === 'string' && !value.literals && !scalarRules(value)) ||
      ((value.kind === 'number' || value.kind === 'integer') &&
        !value.literals &&
        !scalarRules(value))
    )
      return use(
        value.kind === 'string'
          ? 'stringValue'
          : value.kind === 'integer'
            ? 'integerValue'
            : 'numberValue',
      );
    const composites = compositeParts[direction].get(scope);
    const existing = value.kind === 'ref' ? undefined : composites?.get(value);
    if (existing) return existing;
    const type = typeOf(value, direction);
    // The complete normalized leaf and its declared return type preserve every
    // rule, format and literal order. Full keys avoid hash collisions; access
    // flags remain in the key conservatively even though projection ran first.
    const key =
      value.kind === 'string' ||
      value.kind === 'number' ||
      value.kind === 'integer' ||
      value.kind === 'boolean'
        ? JSON.stringify([type, value])
        : undefined;
    if (key !== undefined) {
      const known = scalarParts.get(key);
      if (known) return known;
    }
    let name: string;
    if (key !== undefined) {
      // A shared name must not repeat its first owner's potentially long ID at
      // every use. Scalar bindings stay short and local to this output module.
      name = `scalar_part${scalarParts.size}`;
    } else {
      const index = parts.get(scope) ?? 0;
      parts.set(scope, index + 1);
      name = `${scope}_part${index}`;
    }
    const result = identifier(name);
    if (key === undefined && value.kind !== 'ref') {
      const cache = composites ?? new WeakMap<Schema, Expression>();
      if (!composites) compositeParts[direction].set(scope, cache);
      cache.set(value, result);
    }
    define(value, direction, location, scope, name, type, false);
    if (key !== undefined) scalarParts.set(key, result);
    return result;
  }

  function stringFormat(format: SchemaFormat): Expression {
    if (typeof format === 'string') return use(stringFormatHelpers[format]);
    const known = registeredFormats.get(format.name);
    if (known) return known;
    const definition = object([
      ['pattern', literal(format.pattern)],
      ['message', literal(`expected ${format.name} format`)],
    ]);
    const value = identifier(
      constant(`registered_format${registeredFormats.size}`, definition.source),
    );
    registeredFormats.set(format.name, value);
    return value;
  }

  function scalarRules(
    value: Extract<Schema, { kind: 'string' | 'number' | 'integer' }>,
  ): Expression | undefined {
    if (value.kind === 'string')
      return rules(
        value,
        stringRules,
        value.format === undefined
          ? []
          : [['format', stringFormat(value.format)]],
      );
    if (!rules(value, numberRules)) return undefined;
    return rules(
      value,
      numberRules,
      value.kind === 'integer' ? [['integer', literal(true)]] : [],
    );
  }

  // Declare `name` as the parser for `value` with the explicit type `type`.
  function define(
    value: Schema,
    direction: Direction,
    location: string,
    scope: string,
    name: string,
    type: string,
    exported: boolean,
  ): void {
    // Pure aliases share their target's parser identity. Every other parser
    // containing recursive values owns one traversal, including acyclic outer
    // containers and inline HTTP schemas, so sibling values share one budget.
    const deferred =
      (value.kind !== 'ref' || hasConstraints(value.constraints)) &&
      schemaReferences(value).some(({ name }) =>
        recursion[direction].has(name),
      );
    const implementation = deferred ? `${name}_body` : name;
    if (deferred) {
      const array = value.kind === 'array';
      if (array) typeImports.add('ArrayRules');
      // Constructors capture a hoisted function before any recursive body is
      // initialized. Arrays also forward the bounds supplied by refined aliases.
      append(
        functionDeclaration(
          name,
          type,
          [
            `return ${use('recursiveParse').source}(input, issues, ${implementation}${array ? ', rules' : ''});`,
          ],
          exported,
          array ? ', rules?: ArrayRules' : '',
        ),
        location,
      );
    }
    defineBody(
      value,
      direction,
      location,
      scope,
      implementation,
      type,
      deferred ? false : exported,
    );
  }

  function defineBody(
    value: Schema,
    direction: Direction,
    location: string,
    scope: string,
    name: string,
    type: string,
    exported: boolean,
  ): void {
    const child = (schema: Schema, path: string) =>
      part(schema, direction, path, scope);
    const binding = (initializer: string): void =>
      parserBinding(name, type, initializer, exported, location);
    const direct = (helper: string): void => binding(use(helper).source);
    const construct = (
      helper: string,
      args: readonly string[],
      generic = type,
    ): void => binding(`${use(helper).source}<${generic}>(${args.join(', ')})`);
    const scalarPlan = (): void => {
      const plan = scalarValidationPlan(value, schemas[direction]);
      const base = child(plan.base, location);
      const checks = plan.runtime.map((assertion) =>
        child(
          assertion.kind === 'pattern'
            ? schemaNode({ kind: 'string', pattern: assertion.pattern })
            : assertion.kind === 'format'
              ? schemaNode({ kind: 'string', format: assertion.format })
              : schemaNode({ kind: 'number', multipleOf: assertion.value }),
          location,
        ),
      );
      // The base checks the independently emitted scalar type and combined
      // bounds. Shared parser parts apply each remaining unique assertion once.
      binding(
        `${use('scalarIntersection').source}(${base.source}, ${array(checks).source})`,
      );
    };
    switch (value.kind) {
      case 'json':
        return direct('jsonValue');
      case 'binary':
        if (!target)
          fail(location, 'binary schema requires a multipart client target');
        return direct(target === 'browser' ? 'browserFile' : 'nativeFile');
      case 'ref': {
        if (!hasConstraints(value.constraints)) return;
        const resolved = resolveSchema(value, schemas[direction]);
        if (
          resolved.kind === 'string' ||
          resolved.kind === 'number' ||
          resolved.kind === 'integer' ||
          resolved.kind === 'boolean' ||
          resolved.kind === 'null'
        )
          return scalarPlan();
        // Container aliases keep one terminal constructor and their merged
        // bounds; they never rebuild or replay the child graph.
        const terminal = terminalName(value.name, schemas[direction]);
        const terminalSchema = schemas[direction].get(terminal)!;
        const base = reference(terminal, direction).source;
        if (terminalSchema.kind === 'object' || terminalSchema.kind === 'map') {
          const merged = containerConstraints(
            value,
            schemas[direction],
            containerBounds[direction],
            constraintRecord(terminalSchema),
          );
          const limits = rules(merged, objectRules)!;
          return construct('refinedObject', [
            base,
            constant(`rules_${name}`, limits.source, 'ObjectRules'),
            jsonSource(terminalSchema.kind === 'map' ? 'map' : direction),
          ]);
        }
        if (terminalSchema.kind === 'array') {
          const merged = containerConstraints(
            value,
            schemas[direction],
            containerBounds[direction],
            constraintRecord(terminalSchema),
          );
          const limits = arrayRules(merged, direction)!;
          // The canonical parser owns its item parser and observes length once.
          // Supply the full intersection so all bounds run before any item read.
          return construct(
            'boundedArray',
            [base, constant(`rules_${name}`, limits.source, 'ArrayRules')],
            `(${type})[number]`,
          );
        }
        return;
      }
      case 'map': {
        const values =
          value.values === true
            ? use('jsonValue').source
            : child(value.values, `${location}.additionalProperties`).source;
        const limits = rules(value, objectRules);
        return construct(
          'mapParser',
          [
            values,
            ...(limits
              ? [constant(`rules_${name}`, limits.source, 'ObjectRules')]
              : []),
          ],
          `(${type})[string]`,
        );
      }
      case 'union': {
        if (value.discriminator) {
          const { propertyName, mapping } = value.discriminator;
          const cases = constant(
            `cases_${name}`,
            object(
              [...mapping.keys()].sort().map((tag) => {
                const index = mapping.get(tag)!;
                return [
                  tag,
                  child(
                    value.branches[index]!,
                    schemaBranchLocation(value, location, index),
                  ),
                ];
              }),
            ).source,
          );
          return construct('taggedParser', [jsonSource(propertyName), cases]);
        }
        // Validation proved any oneOf branches disjoint, so both cardinalities
        // use first-match parsing. One array argument keeps wide unions from
        // becoming variadic calls.
        return construct('unionParser', [
          array(
            value.branches.map((branch, index) =>
              child(branch, schemaBranchLocation(value, location, index)),
            ),
          ).source,
        ]);
      }
      case 'intersection':
        return scalarPlan();
      case 'object':
        return objectParser(
          name,
          type,
          [...value.properties].map(([field, schema]) => ({
            name: field,
            required: isRequired(value.required, field),
            parse: child(schema, `${location}.properties.${field}`),
          })),
          direction === 'request',
          exported,
          value.forbidden,
          rules(value, objectRules),
        );
      case 'array': {
        const limits = arrayRules(value, direction);
        const items = child(value.items, `${location}.items`).source;
        const defaults = limits
          ? constant(`rules_${name}`, limits.source, 'ArrayRules')
          : undefined;
        // The optional third argument still carries the complete intersection
        // from constrained aliases, before the item graph observes the input.
        parserBinding(
          name,
          type,
          `${use('arrayParser').source}<(${type})[number]>(${items}${defaults ? `, ${defaults}` : ''})`,
          exported,
          location,
          true,
        );
        return;
      }
      case 'boolean':
      case 'null':
        if (!value.literals || value.kind === 'null')
          return direct(value.kind === 'null' ? 'nullValue' : 'booleanValue');
        break;
      case 'integer':
      case 'number':
      case 'string':
        if (!value.literals) {
          const limits = scalarRules(value);
          if (!limits)
            return direct(
              value.kind === 'string'
                ? 'stringValue'
                : value.kind === 'integer'
                  ? 'integerValue'
                  : 'numberValue',
            );
          return binding(
            `${use(value.kind === 'string' ? 'textParser' : 'numberParser').source}(${constant(
              `rules_${name}`,
              limits.source,
              value.kind === 'string' ? 'StringRules' : 'NumberRules',
            )})`,
          );
        }
        break;
    }
    // Literal arrays are checked against independent T. The runtime membership
    // kernel returns the input itself, preserving -0; use an array argument so
    // large supported enums do not become variadic calls.
    // Normalization proves each inline literal's engine-independent scalar rules.
    // Membership completes those checks. Only Unicode-property patterns remain
    // deferred: the consuming engine can classify characters differently.
    // Reference siblings still apply their separate refinements.
    // This JSON is runtime message text; only the outer string is source-escaped.
    const expected = (value.literals ?? []).map((item) => JSON.stringify(item));
    const message = jsonSource(
      `expected ${expected.length === 1 ? expected[0] : `one of ${expected.join(', ')}`}`,
    );
    const deferredRules: (readonly [string, Expression])[] = [];
    if (value.kind === 'string') {
      if (value.pattern !== undefined && hasUnicodeProperty(value.pattern))
        deferredRules.push(['pattern', literal(value.pattern)]);
      if (
        value.format !== undefined &&
        typeof value.format !== 'string' &&
        hasUnicodeProperty(value.format.pattern)
      )
        deferredRules.push(['format', stringFormat(value.format)]);
    }
    const deferred =
      deferredRules.length > 0
        ? constant(`rules_${name}`, object(deferredRules).source, 'StringRules')
        : undefined;
    // Infer only the literal metadata, then check Parse<metadata union> against
    // the independent annotation in parserBinding. Explicit <T> here would
    // contextualize every array member against a potentially huge union.
    const members = [
      array((value.literals ?? []).map(literal)).source,
      message,
      ...(deferred ? [deferred] : []),
    ];
    binding(`${use('memberParser').source}(${members.join(', ')})`);
  }

  return {
    define,
    part,
    typeOf,
    objectParser,
    helpers,
    typeImports,
    use,
    push: append,
    takeDeclarations: () => declarations.splice(0).join('\n'),
  };
}

export type SchemaRenderer = ReturnType<typeof schemaRenderer>;
