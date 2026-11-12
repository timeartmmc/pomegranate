import { text } from './diagnostics.js';

export const supportedMethods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

export const openApiMethods = [...supportedMethods, 'trace'] as const;

export function operationIdentifier(
  value: Record<string, unknown>,
  method: string,
  path: string,
): string {
  const location = `paths.${path}.${method}.operationId`;
  // Missing IDs use the exact method and path, without slugs or suffix counters.
  return Object.hasOwn(value, 'operationId')
    ? text(value.operationId, location)
    : `${method.toUpperCase()} ${path}`;
}
