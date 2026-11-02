import { data, identifier, literal, object, propertyKey } from './code.js';
import type { Expression } from './code.js';
import { fail } from './diagnostics.js';
import type { Client, Constraints, Direction, Schema } from './model.js';
import { schemaType } from './schema-types.js';

// Follow references to the first non-reference component. Constraint sets are
// applied from the terminal component outwards, preserving sibling-rule order.
function aliasChain(
  value: Extract<Schema, { kind: 'ref' }>,
  schemas: Readonly<Record<string, Schema>>,
): { terminal: string; sets: Constraints[] } {
  const sets: Constraints[] = [value.constraints];
  let terminal = value.name;
  let target = schemas[terminal]!;
  while (target.kind === 'ref') {
    sets.push(target.constraints);
    terminal = target.name;
    target = schemas[terminal]!;
  }
  return { terminal, sets: sets.reverse() };
}

// Resolve pure links once per normalized schema table. Path compression shares
// suffixes without crossing a constrained alias or caching mutable input documents.
// Normalization has already diagnosed missing targets and reference cycles.
export function parserIdentities(
  schemas: Readonly<Record<string, Schema>>,
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
      const schema = schemas[target]!;
      if (schema.kind !== 'ref' || Object.keys(schema.constraints).length > 0)
        break;
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

const stringRules = ['minLength', 'maxLength', 'pattern'] as const;
const numberRules = [
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
] as const;
const arrayRules = ['minItems', 'maxItems'] as const;

function rules(
  limits: Constraints,
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

// Every generated parser is a flat named function over unknown input, with a
// checked contract return. Rule/key data stays static; scalar and container
// semantics stay in the shared runtime. Named child references bound both
// expression nesting and inference depth as schemas grow.
export function schemaRenderer(
  schemas: Readonly<Record<string, Schema>>,
  reference: (name: string, direction: Direction) => Expression,
  typeReference: (name: string, direction: Direction) => string,
  target?: Client['target'],
) {
  const identity = parserIdentities(schemas);
  const helpers = new Set<string>();
  const typeImports = new Set<string>();
  const declarations: string[] = [];
  const parts = new Map<string, number>();
  const use = (name: string): Expression => {
    helpers.add(name);
    return identifier(name);
  };
  // Reference a component's parser. A pure alias chain has no binding of its
  // own: it shares the first constrained target, or the terminal parser.
  const component = (name: string, direction: Direction): Expression => {
    return reference(identity(name), direction);
  };
  function declareType(
    name: string,
    value: Schema,
    direction: Direction,
  ): string {
    return `type ${name} = ${schemaType(value, direction, target, typeReference)};`;
  }

  function functionDeclaration(
    name: string,
    type: string,
    body: readonly string[],
    exported: boolean,
  ): string {
    typeImports.add('Issues');
    typeImports.add('Invalid');
    return `${exported ? 'export ' : ''}function ${name}(input: unknown, issues: Issues): ${type} | Invalid {
      ${body.join('\n')}
    }`;
  }

  // Module-level data constants (rule objects, key lists, tagged cases) contain
  // only literals and function names. Executable references stay inside
  // function declarations, where TypeScript's control-flow analysis is bounded
  // by the function instead of walking the whole generated module.
  function constant(name: string, value: string, type?: string): string {
    if (type && /^\w+$/.test(type)) typeImports.add(type);
    declarations.push(`const ${name}${type ? `: ${type}` : ''} = ${value};`);
    return name;
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
  ): void {
    // Bound TypeScript's failure-condition flow graph while retaining a checked
    // return for every field. Parse every chunk before testing failures so a
    // wide invalid object still reports all sibling issues in source order.
    if (fields.length > 128) {
      helpers.add('invalid');
      const body = [
        `const source = ${use('objectValue').source}(input, issues);`,
        'if (source === invalid) return invalid;',
      ];
      const values: string[] = [];
      for (let start = 0; start < fields.length; start += 64) {
        const group = fields.slice(start, start + 64);
        const parser = `${name}_fields${start / 64}`;
        const picked = group
          .map((entry) => JSON.stringify(entry.name))
          .join(' | ');
        objectParser(parser, `Pick<${type}, ${picked}>`, group, false);
        const value = `group${start / 64}`;
        values.push(value);
        body.push(`const ${value} = ${parser}(source, issues);`);
      }
      const failures = values.map((value) => `${value} === invalid`);
      if (strict) {
        const keys = constant(
          `keys_${name}`,
          data(fields.map((entry) => entry.name)).source,
        );
        body.push(
          `const extra = ${use('unknownKeys').source}(source, ${keys}, issues);`,
        );
        failures.push('extra');
      }
      body.push(`if (${failures.join(' || ')}) return invalid;`);
      body.push(`return {${values.map((value) => `...${value}`).join(',')}};`);
      declarations.push(functionDeclaration(name, type, body, exported));
      return;
    }
    helpers.add('invalid');
    const body = [
      `const source = ${use('objectValue').source}(input, issues);`,
      'if (source === invalid) return invalid;',
    ];
    const failures = fields.map((entry, index) => {
      const helper = use(entry.required ? 'field' : 'optionalField');
      body.push(
        `const v${index} = ${helper.source}(source, ${JSON.stringify(entry.name)}, ${entry.parse.source}, issues);`,
      );
      return `v${index} === invalid`;
    });
    if (strict) {
      const keys = fields.length
        ? constant(
            `keys_${name}`,
            data(fields.map((entry) => entry.name)).source,
          )
        : use('noKeys').source;
      body.push(
        `const extra = ${use('unknownKeys').source}(source, ${keys}, issues);`,
      );
      failures.push('extra');
    }
    if (failures.length)
      body.push(`if (${failures.join(' || ')}) return invalid;`);
    const properties = fields.map((entry, index) => {
      const key = propertyKey(entry.name);
      if (entry.required) return `${key}: v${index}`;
      helpers.add('absent');
      return `...(v${index} === absent ? {} : { ${key}: v${index} })`;
    });
    body.push(`return {${properties.join(',')}};`);
    declarations.push(functionDeclaration(name, type, body, exported));
  }

  // Return a Parse function name for a child schema. Unconstrained references,
  // binary targets and plain scalars use existing functions; everything else
  // gets a flat function declaration `${scope}_partN` with an inline type.
  function part(
    value: Schema,
    direction: Direction,
    location: string,
    scope: string,
  ): Expression {
    if (value.kind === 'ref' && Object.keys(value.constraints).length === 0)
      return component(value.name, direction);
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
    const index = parts.get(scope) ?? 0;
    parts.set(scope, index + 1);
    const name = `${scope}_part${index}`;
    define(
      value,
      direction,
      location,
      scope,
      name,
      schemaType(value, direction, target, typeReference),
      false,
    );
    return identifier(name);
  }

  function scalarRules(
    value: Extract<Schema, { kind: 'string' | 'number' | 'integer' }>,
  ): Expression | undefined {
    if (value.kind === 'string')
      return rules(
        value,
        stringRules,
        value.format === undefined ? [] : [['format', literal(value.format)]],
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
    const child = (schema: Schema, path: string) =>
      part(schema, direction, path, scope);
    const returns = (expression: string): void => {
      declarations.push(
        functionDeclaration(name, type, [`return ${expression};`], exported),
      );
    };
    const call = (helper: string, ...args: string[]) =>
      returns(
        `${use(helper).source}(${['input', 'issues', ...args].join(', ')})`,
      );
    switch (value.kind) {
      case 'binary':
        if (!target)
          fail(location, 'binary schema requires a multipart client target');
        return call(target === 'browser' ? 'browserFile' : 'nativeFile');
      case 'ref': {
        if (Object.keys(value.constraints).length === 0) return;
        // Resolve alias chains here: a pure alias binds the terminal parser
        // itself, and constrained chains become one wrapper with ordered rule
        // data. Neither runtime depth nor validator identity grows with chains.
        const { terminal, sets } = aliasChain(value, schemas);
        const base = reference(terminal, direction).source;
        const terminalSchema = schemas[terminal]!;
        if (terminalSchema.kind === 'array') {
          const minimum = [
            terminalSchema.minItems,
            ...sets.map((set) => set.minItems),
          ].filter((n): n is number => n !== undefined);
          const maximum = [
            terminalSchema.maxItems,
            ...sets.map((set) => set.maxItems),
          ].filter((n): n is number => n !== undefined);
          const merged: Constraints = {
            ...(minimum.length ? { minItems: Math.max(...minimum) } : {}),
            ...(maximum.length ? { maxItems: Math.min(...maximum) } : {}),
          };
          const limits = rules(merged, arrayRules);
          const items = child(terminalSchema.items, `${location}.items`).source;
          return limits
            ? call(
                'list',
                items,
                constant(`rules_${name}`, limits.source, 'ArrayRules'),
              )
            : call('list', items);
        }
        const isText = terminalSchema.kind === 'string';
        const keys = isText ? stringRules : numberRules;
        const limits = sets
          .map((set) => rules(set, keys))
          .filter((item) => item !== undefined);
        // A pure alias component needs no parser binding: every reference
        // and registry entry resolves to its canonical parser and validator.
        if (limits.length === 0) return;
        const rulesType = isText ? 'StringRules' : 'NumberRules';
        typeImports.add(rulesType);
        return call(
          isText ? 'refineText' : 'refineNumber',
          base,
          constant(
            `rules_${name}`,
            `[${limits.map((limit) => limit.source).join(',')}]`,
            `readonly ${rulesType}[]`,
          ),
        );
      }
      case 'map':
        return call(
          'map',
          value.values === true
            ? use('jsonValue').source
            : child(value.values, `${location}.additionalProperties`).source,
        );
      case 'union': {
        if (value.discriminator) {
          const { propertyName, mapping } = value.discriminator;
          const cases = constant(
            `cases_${name}`,
            object(
              Object.keys(mapping)
                .sort()
                .map((tag) => [tag, component(mapping[tag]!, direction)]),
            ).source,
          );
          return returns(
            `${use('taggedUnion').source}<${type}>(input, issues, ${JSON.stringify(propertyName)}, ${cases})`,
          );
        }
        const [left, right, ...rest] = value.branches.map((branch, index) =>
          child(branch, `${location}.anyOf[${index}]`),
        );
        if (!left || !right || rest.length > 0)
          fail(location, 'expected a two-branch union');
        return returns(
          `${use('union').source}<${type}>(input, issues, ${left.source}, ${right.source})`,
        );
      }
      case 'object':
        return objectParser(
          name,
          type,
          Object.entries(value.properties).map(([field, schema]) => ({
            name: field,
            required: value.required.includes(field),
            parse: child(schema, `${location}.properties.${field}`),
          })),
          direction === 'request',
          exported,
        );
      case 'array': {
        const limits = rules(value, arrayRules);
        const items = child(value.items, `${location}.items`).source;
        return limits
          ? call(
              'list',
              items,
              constant(`rules_${name}`, limits.source, 'ArrayRules'),
            )
          : call('list', items);
      }
      case 'boolean':
      case 'null':
        if (!value.literals || value.kind === 'null')
          return call(value.kind === 'null' ? 'nullValue' : 'booleanValue');
        break;
      case 'integer':
      case 'number':
      case 'string':
        if (!value.literals) {
          const limits = scalarRules(value);
          if (!limits)
            return call(
              value.kind === 'string'
                ? 'stringValue'
                : value.kind === 'integer'
                  ? 'integerValue'
                  : 'numberValue',
            );
          return call(
            value.kind === 'string' ? 'text' : 'numeric',
            constant(
              `rules_${name}`,
              limits.source,
              value.kind === 'string' ? 'StringRules' : 'NumberRules',
            ),
          );
        }
        break;
    }
    // Literal outputs come from TypeScript narrowing of the input itself, so
    // the declared literal type is checked and -0 keeps its sign.
    // Normalization proves every inline literal satisfies its own scalar rules.
    // Membership therefore completes validation; reference siblings still apply
    // their separate constraints in refineText/refineNumber.
    const expected = (value.literals ?? []).map((item) => JSON.stringify(item));
    const message = JSON.stringify(
      `expected ${expected.length === 1 ? expected[0] : `one of ${expected.join(', ')}`}`,
    );
    const body = [
      // Switch narrowing keeps large enums checked without a long flow chain.
      'switch (input) {',
      ...(value.literals ?? []).map((item) => `case ${JSON.stringify(item)}:`),
      'return input;',
      `default: return ${use('report').source}(issues, ${message}, true);`,
      '}',
    ];
    declarations.push(functionDeclaration(name, type, body, exported));
  }

  return {
    define,
    part,
    typeOf: (value: Schema, direction: Direction): string =>
      schemaType(value, direction, target, typeReference),
    objectParser,
    declareType,
    helpers,
    typeImports,
    use,
    push: (declaration: string) => {
      declarations.push(declaration);
    },
    takeDeclarations: () => declarations.splice(0).join('\n'),
  };
}

export type SchemaRenderer = ReturnType<typeof schemaRenderer>;
