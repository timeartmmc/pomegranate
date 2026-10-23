import { fail } from './diagnostics.js';
import type { Client, Descriptor, Operation, Schema } from './model.js';
import { surfaceNames } from './policy.js';
import { schemaReferences } from './schemas.js';

function roots(
  operation: Operation,
  direction: 'request' | 'response',
): readonly Schema[] {
  if (direction === 'request')
    return [
      ...operation.parameters.map((parameter) => parameter.schema),
      ...(operation.body.kind === 'json' ? [operation.body.schema] : []),
    ];
  return operation.responses.flatMap((response) => [
    ...response.headers.map((header) => header.schema),
    ...(response.body.kind === 'json' ? [response.body.schema] : []),
  ]);
}

function closure(
  descriptor: Descriptor,
  operations: readonly Operation[],
  direction: 'request' | 'response',
): readonly string[] {
  const needed = new Set<string>();
  const visit = (schema: Schema): void => {
    for (const name of schemaReferences(schema)) {
      if (needed.has(name)) continue;
      needed.add(name);
      // buildDescriptor already resolved every reference and rejected cycles.
      visit(descriptor.schemas[name]!);
    }
  };
  for (const operation of operations)
    for (const schema of roots(operation, direction)) visit(schema);
  return descriptor.schemaOrder.filter((name) => needed.has(name));
}

export function selectClients(
  descriptor: Descriptor,
  input: unknown,
): readonly Client[] {
  const names = surfaceNames(input, 'clients');
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
    return {
      name,
      operations,
      requestSchemas: closure(descriptor, operations, 'request'),
      responseSchemas: closure(descriptor, operations, 'response'),
    };
  });
}
