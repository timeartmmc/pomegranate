import { fail } from './diagnostics.js';
import type {
  Client,
  Descriptor,
  Direction,
  Operation,
  Schema,
  Standalone,
} from './model.js';
import type { RootSelection, Selection } from './selection.js';
import { validatePagination } from './pagination.js';
import { normalizeSchema } from './schemas.js';
import { schemaReferences } from './schema-graph.js';
import { validateSchema } from './schema-validation.js';

export function operationSchemas(
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
    ...(response.body.kind !== 'none'
      ? Array.from(
          response.body.content.values(),
          (representation) => representation.schema,
        )
      : []),
  ]);
}

function closure(
  descriptor: Descriptor,
  roots: readonly Schema[],
  direction: Direction,
): readonly string[] {
  const needed = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const schema = pending.pop()!;
    for (const { name } of schemaReferences(schema)) {
      if (needed.has(name)) continue;
      needed.add(name);
      // The visited set retains productive recursive dependencies once; source
      // validation already rejected unresolved or nonproductive references.
      pending.push(descriptor.schemas[direction].get(name)!);
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
    executionClients,
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
        `request header ${JSON.stringify(name)} is undeclared or ignored by OpenAPI`,
      );
  const operationIds = new Set(
    descriptor.operations.map((operation) => operation.id),
  );
  // Projection only receives a complete validated descriptor. Filtering raw
  // OpenAPI here would hide unsupported operations on unselected surfaces.
  return [...names].sort().map((name) => {
    if (!descriptor.policy.surfaces.includes(name)) {
      const surfaces = descriptor.policy.surfaces;
      const listed = surfaces
        .slice(0, 8)
        .map((surface) => JSON.stringify(surface))
        .join(', ');
      const remaining = surfaces.length - 8;
      fail(
        'clients',
        `undeclared surface ${JSON.stringify(name)}; declared surfaces: ${listed || '(none)'}${remaining > 0 ? `, ... (${remaining} more)` : ''}`,
      );
    }
    const operations = descriptor.operations.filter((operation) =>
      operation.surfaces.includes(name),
    );
    if (operations.length === 0)
      fail(
        'clients',
        `selected surface ${JSON.stringify(name)} has no operations`,
      );
    const target = targets.get(name);
    if (
      target === undefined &&
      operations.some((operation) => operation.body.kind === 'multipart')
    )
      fail(
        `targets.${name}`,
        'multipart clients require an explicit browser or native target',
      );
    const queryOperation = (
      id: string,
      location: string,
      kind: 'query' | 'infinite query',
    ) => {
      const operation = operations.find((candidate) => candidate.id === id);
      if (!operation)
        fail(
          location,
          operationIds.has(id)
            ? `${kind} operation must belong to this client; include ${JSON.stringify(id)} in surface ${JSON.stringify(name)} or select a client that includes it`
            : `unknown operationId ${JSON.stringify(id)}; use an operationId declared in paths`,
        );
      return operation;
    };
    const queryIds = queries.get(name) ?? [];
    const selectedQueries = queryIds.map((id) => {
      const location = `queries.${name}.${id}`;
      const operation = queryOperation(id, location, 'query');
      if (
        (operation.method !== 'GET' && operation.method !== 'HEAD') ||
        operation.body.kind !== 'none'
      )
        fail(location, 'queries support only bodyless GET and HEAD operations');
      return operation;
    });
    const selectedInfinite = [...(infiniteQueries.get(name) ?? [])].map(
      ([id, binding]) => {
        const location = `infiniteQueries.${name}.${id}`;
        const operation = queryOperation(id, location, 'infinite query');
        validatePagination(operation, binding, descriptor, location);
        return { operation, binding };
      },
    );
    return {
      name,
      execution: executionClients.includes(name),
      target,
      transportHeaders,
      operations,
      queries: selectedQueries,
      infiniteQueries: selectedInfinite,
      requestSchemas: closure(
        descriptor,
        operations.flatMap((operation) =>
          operationSchemas(operation, 'request'),
        ),
        'request',
      ),
      responseSchemas: closure(
        descriptor,
        operations.flatMap((operation) =>
          operationSchemas(operation, 'response'),
        ),
        'response',
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
      descriptor.schemas[value.usage],
      `${location}.schema`,
      value.usage,
    );
    return {
      name,
      schema,
      direction: value.usage,
      schemaOrder: closure(descriptor, [schema], value.usage),
    };
  });
}
