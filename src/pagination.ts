import { fail } from './diagnostics.js';
import type { Descriptor, InfiniteQueryBinding, Operation } from './model.js';
import { resolveSchema } from './schemas.js';

export function validatePagination(
  operation: Operation,
  binding: InfiniteQueryBinding,
  descriptor: Descriptor,
  location: string,
): void {
  if (operation.method !== 'GET' || operation.body.kind !== 'none')
    fail(location, 'infinite queries require a bodyless GET operation');
  const cursor = operation.parameters.find(
    (parameter) =>
      parameter.in === 'query' && parameter.name === binding.cursor,
  );
  if (
    !cursor ||
    cursor.required ||
    resolveSchema(cursor.schema, descriptor.schemas).kind !== 'string'
  )
    fail(
      `${location}.cursor`,
      'cursor must name an optional string query parameter',
    );
  for (const response of operation.responses.filter(
    (response) => response.status < 300,
  )) {
    const path = `${location}.responses.${response.status}`;
    if (response.body.kind !== 'json')
      fail(path, 'every infinite-query success must have a JSON object body');
    const body = resolveSchema(response.body.schema, descriptor.schemas);
    if (body.kind !== 'object')
      fail(path, 'every infinite-query success must have a fixed object body');
    for (const name of [binding.items, binding.nextCursor])
      if (!body.required.includes(name))
        fail(path, `pagination field ${JSON.stringify(name)} must be required`);
    const items = resolveSchema(
      body.properties[binding.items]!,
      descriptor.schemas,
    );
    if (items.kind !== 'array')
      fail(`${path}.${binding.items}`, 'items must name an array field');
    const next = resolveSchema(
      body.properties[binding.nextCursor]!,
      descriptor.schemas,
    );
    if (
      next.kind !== 'union' ||
      next.discriminator ||
      next.branches.length !== 2 ||
      !next.branches.some(
        (branch) => resolveSchema(branch, descriptor.schemas).kind === 'null',
      ) ||
      !next.branches.some(
        (branch) => resolveSchema(branch, descriptor.schemas).kind === 'string',
      )
    )
      fail(
        `${path}.${binding.nextCursor}`,
        'nextCursor must name a nullable string field',
      );
  }
}
