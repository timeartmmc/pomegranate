import { fail } from './diagnostics.js';
import type {
  Descriptor,
  InfiniteQueryBinding,
  Operation,
  Schema,
  SchemaTable,
} from './model.js';
import { scalarValidationPlan } from './intersections.js';
import { resolveSchema } from './schemas.js';
import { literalViolation } from './scalar-rules.js';

function nullableString(schema: Schema, schemas: SchemaTable): boolean {
  const resolved = resolveSchema(schema, schemas);
  return (
    resolved.kind === 'union' &&
    !resolved.discriminator &&
    resolved.branches.length === 2 &&
    resolved.branches.some(
      (branch) => resolveSchema(branch, schemas).kind === 'null',
    ) &&
    resolved.branches.some(
      (branch) => resolveSchema(branch, schemas).kind === 'string',
    )
  );
}

export function validatePagination(
  operation: Operation,
  binding: InfiniteQueryBinding,
  descriptor: Descriptor,
  location: string,
): void {
  if (operation.method !== 'GET' || operation.body.kind !== 'none')
    fail(location, 'infinite queries require a bodyless GET operation');
  const offset = binding.kind === 'offset';
  const requestSchemas = descriptor.schemas.request;
  const responseSchemas = descriptor.schemas.response;
  const parameter = operation.parameters.find(
    (parameter) =>
      parameter.in === 'query' &&
      parameter.name === (offset ? binding.offset : binding.cursor),
  );
  if (offset) {
    if (
      !parameter ||
      resolveSchema(parameter.schema, requestSchemas).kind !== 'integer'
    )
      fail(
        `${location}.offset`,
        'offset must name a nonnullable integer query parameter',
      );
    // Offset traversal has an explicit zero origin, independent of OpenAPI
    // default annotations. Reference restrictions and allOf conjuncts combine
    // in the validator's scalar plan; its bounds and literals must admit that
    // origin. Every remaining multipleOf assertion accepts zero.
    const { base } = scalarValidationPlan(parameter.schema, requestSchemas);
    if (
      base.kind !== 'integer' ||
      literalViolation(base)(0) ||
      (base.literals && !base.literals.includes(0))
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
  } else {
    // Optional nullable queries serialize null as omission, matching the initial
    // page. Later string cursors still pass through the full request validator.
    if (
      !parameter ||
      parameter.required ||
      (resolveSchema(parameter.schema, requestSchemas).kind !== 'string' &&
        !nullableString(parameter.schema, requestSchemas))
    )
      fail(
        `${location}.cursor`,
        'cursor must name an optional string or nullable string query parameter',
      );
  }
  for (const response of operation.responses.filter(
    (response) => response.status < 300,
  )) {
    const responsePath = `${location}.responses.${response.status}`;
    if (response.body.kind === 'none')
      fail(
        responsePath,
        'every infinite-query success must have a JSON object body',
      );
    // Any declared representation can arrive. Pagination accessors must be valid
    // for all of them before a query can cache or traverse a successful page.
    for (const [contentType, representation] of response.body.content) {
      const path = `${responsePath}.content.${contentType}`;
      if (representation.kind !== 'json')
        fail(path, 'every infinite-query success must have a JSON object body');
      const body = resolveSchema(representation.schema, responseSchemas);
      if (body.kind !== 'object')
        fail(
          path,
          'every infinite-query success must have a fixed object body',
        );
      const fields = offset
        ? [
            binding.items,
            binding.responseOffset,
            binding.responseLimit,
            binding.total,
          ]
        : [binding.items, binding.nextCursor];
      for (const name of fields) {
        if (!body.properties.has(name)) {
          const hint =
            name.includes('.') || name.includes('[')
              ? '; nested paths are not supported in this version'
              : '';
          fail(
            path,
            `pagination field ${JSON.stringify(name)} must name an existing top-level response property${hint}`,
          );
        }
        if (!body.required.includes(name))
          fail(
            path,
            `pagination field ${JSON.stringify(name)} must be required`,
          );
      }
      const items = resolveSchema(
        body.properties.get(binding.items)!,
        responseSchemas,
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
            resolveSchema(body.properties.get(name)!, responseSchemas).kind !==
            'integer'
          )
            fail(
              `${path}.${name}`,
              'offset pagination metadata must name required nonnullable integer fields',
            );
        continue;
      }
      if (
        !nullableString(
          body.properties.get(binding.nextCursor)!,
          responseSchemas,
        )
      )
        fail(
          `${path}.${binding.nextCursor}`,
          'nextCursor must name a nullable string field',
        );
    }
  }
}
