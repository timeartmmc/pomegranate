import { fail } from './diagnostics.js';
import type { Descriptor, InfiniteQueryBinding, Operation } from './model.js';
import { resolveSchema } from './schemas.js';
import { literalViolation } from './scalar-rules.js';

export function validatePagination(
  operation: Operation,
  binding: InfiniteQueryBinding,
  descriptor: Descriptor,
  location: string,
): void {
  if (operation.method !== 'GET' || operation.body.kind !== 'none')
    fail(location, 'infinite queries require a bodyless GET operation');
  const offset = 'offset' in binding;
  const parameter = operation.parameters.find(
    (parameter) =>
      parameter.in === 'query' &&
      parameter.name === (offset ? binding.offset : binding.cursor),
  );
  if (
    !parameter ||
    (!offset && parameter.required) ||
    resolveSchema(parameter.schema, descriptor.schemas).kind !==
      (offset ? 'integer' : 'string')
  )
    fail(
      `${location}.${offset ? 'offset' : 'cursor'}`,
      offset
        ? 'offset must name a nonnullable integer query parameter'
        : 'cursor must name an optional, nonnullable string query parameter',
    );
  if (offset) {
    // Offset traversal has an explicit zero origin, independent of OpenAPI
    // default annotations. Every reference restriction must admit that origin.
    let schema = parameter.schema;
    while (schema.kind === 'ref') {
      if (literalViolation(schema.constraints)(0))
        fail(
          `${location}.offset`,
          'offset schema must accept the initial value 0',
        );
      schema = descriptor.schemas[schema.name]!;
    }
    if (
      schema.kind !== 'integer' ||
      literalViolation(schema)(0) ||
      (schema.literals && !schema.literals.includes(0))
    )
      fail(
        `${location}.offset`,
        'offset schema must accept the initial value 0',
      );
    if (
      new Set([
        binding.responseOffset,
        binding.responseLimit,
        binding.total,
        binding.items,
      ]).size !== 4
    )
      fail(location, 'offset pagination response fields must be distinct');
  }
  for (const response of operation.responses.filter(
    (response) => response.status < 300,
  )) {
    const path = `${location}.responses.${response.status}`;
    if (response.body.kind !== 'json')
      fail(path, 'every infinite-query success must have a JSON object body');
    const body = resolveSchema(response.body.schema, descriptor.schemas);
    if (body.kind !== 'object')
      fail(path, 'every infinite-query success must have a fixed object body');
    const fields = offset
      ? [
          binding.items,
          binding.responseOffset,
          binding.responseLimit,
          binding.total,
        ]
      : [binding.items, binding.nextCursor];
    for (const name of fields)
      if (!body.required.includes(name))
        fail(path, `pagination field ${JSON.stringify(name)} must be required`);
    const items = resolveSchema(
      body.properties[binding.items]!,
      descriptor.schemas,
    );
    if (items.kind !== 'array')
      fail(`${path}.${binding.items}`, 'items must name an array field');
    if (offset) {
      for (const name of [
        binding.responseOffset,
        binding.responseLimit,
        binding.total,
      ])
        if (
          resolveSchema(body.properties[name]!, descriptor.schemas).kind !==
          'integer'
        )
          fail(
            `${path}.${name}`,
            'offset pagination metadata must name required nonnullable integer fields',
          );
      continue;
    }
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
