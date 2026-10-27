import { fail } from './diagnostics.js';
import type {
  Client,
  Descriptor,
  Operation,
  Schema,
  Standalone,
} from './model.js';
import type { RootSelection, Selection } from './selection.js';
import { validatePagination } from './pagination.js';
import {
  normalizeSchema,
  schemaReferences,
  validateSchema,
} from './schemas.js';

function roots(
  operation: Operation,
  direction: 'request' | 'response',
): readonly Schema[] {
  if (direction === 'request')
    return [
      ...operation.parameters.map((parameter) => parameter.schema),
      ...(operation.body.kind !== 'none' ? [operation.body.schema] : []),
    ];
  return operation.responses.flatMap((response) => [
    ...response.headers.map((header) => header.schema),
    ...(response.body.kind === 'json' ? [response.body.schema] : []),
  ]);
}

function closure(
  descriptor: Descriptor,
  roots: readonly Schema[],
): readonly string[] {
  const needed = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const schema = pending.pop()!;
    for (const { name } of schemaReferences(schema)) {
      if (needed.has(name)) continue;
      needed.add(name);
      // buildDescriptor already resolved every reference and rejected cycles.
      pending.push(descriptor.schemas[name]!);
    }
  }
  return descriptor.schemaOrder.filter((name) => needed.has(name));
}

export function selectClients(
  descriptor: Descriptor,
  selection: Selection,
): readonly Client[] {
  const {
    clients: names,
    targets,
    transportHeaders,
    queries,
    infiniteQueries,
  } = selection;
  const declared = new Set(
    descriptor.operations.flatMap((operation) =>
      operation.parameters
        .filter((parameter) => parameter.in === 'header')
        .map((parameter) => parameter.name.toLowerCase()),
    ),
  );
  for (const name of transportHeaders)
    if (!declared.has(name))
      fail(
        'transportHeaders',
        `undeclared request header ${JSON.stringify(name)}`,
      );
  // Projection only receives a complete validated descriptor. Filtering raw
  // OpenAPI here would hide unsupported operations on unselected surfaces.
  return [...names].sort().map((name) => {
    if (!descriptor.policy.surfaces.includes(name))
      fail('clients', `undeclared surface ${JSON.stringify(name)}`);
    const operations = descriptor.operations.filter((operation) =>
      operation.surfaces.includes(name),
    );
    if (operations.length === 0)
      fail(
        'clients',
        `selected surface ${JSON.stringify(name)} has no operations`,
      );
    const target = Object.hasOwn(targets, name) ? targets[name] : undefined;
    if (
      target === undefined &&
      operations.some((operation) => operation.body.kind === 'multipart')
    )
      fail(
        `targets.${name}`,
        'multipart clients require an explicit browser or native target',
      );
    const queryIds = Object.hasOwn(queries, name) ? queries[name]! : [];
    const selectedQueries = queryIds.map((id) => {
      const operation = operations.find((candidate) => candidate.id === id);
      const location = `queries.${name}.${id}`;
      if (!operation)
        fail(location, 'query operation must belong to this client');
      if (
        (operation.method !== 'GET' && operation.method !== 'HEAD') ||
        operation.body.kind !== 'none'
      )
        fail(location, 'queries support only bodyless GET and HEAD operations');
      return operation;
    });
    const selectedInfinite = Object.entries(
      Object.hasOwn(infiniteQueries, name) ? infiniteQueries[name]! : {},
    ).map(([id, binding]) => {
      const location = `infiniteQueries.${name}.${id}`;
      const operation = operations.find((candidate) => candidate.id === id);
      if (!operation)
        fail(location, 'infinite query operation must belong to this client');
      validatePagination(operation, binding, descriptor, location);
      return { operation, binding };
    });
    return {
      name,
      ...(target === undefined ? {} : { target }),
      transportHeaders,
      operations,
      queries: selectedQueries,
      infiniteQueries: selectedInfinite,
      requestSchemas: closure(
        descriptor,
        operations.flatMap((operation) => roots(operation, 'request')),
      ),
      responseSchemas: closure(
        descriptor,
        operations.flatMap((operation) => roots(operation, 'response')),
      ),
    };
  });
}

export function selectStandalone(
  descriptor: Descriptor,
  selections: readonly RootSelection[],
): readonly Standalone[] {
  return selections.map((value) => {
    const { name } = value;
    const location = `standalone.${name}`;
    const schema = normalizeSchema(
      { $ref: value.schema },
      `${location}.schema`,
    );
    validateSchema(
      schema,
      descriptor.schemas,
      `${location}.schema`,
      value.usage,
    );
    return {
      name,
      schema,
      direction: value.usage,
      schemaOrder: closure(descriptor, [schema]),
    };
  });
}
