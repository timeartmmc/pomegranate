import { jsonResponseValidator } from './cases/json-response.ts';

// This adapter loads only generated validators. Compiler setup and operation
// protocol helpers are qualified by preparation, outside this measured profile.
export async function createPomAdapter(
  schemas: URL,
  identity: Record<string, string>,
) {
  const module: unknown = await import(schemas.href);
  return { identity, validate: jsonResponseValidator(module) };
}
