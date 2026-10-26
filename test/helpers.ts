import {
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import example from '../examples/json/openapi.json' with { type: 'json' };
import type { Schema } from './schema-helpers.ts';

export const fixture = () => structuredClone(example);
// Keep the baseline document inferred from its JSON. Raw OpenAPI mutations use
// Object.assign when intentionally adding or replacing vocabulary, including
// malformed values for diagnostics; compile accepts unknown at this boundary.
export type Fixture = ReturnType<typeof fixture>;
export interface Parameter {
  name: string;
  in: string;
  required?: boolean;
  schema: Schema;
  [keyword: string]: unknown;
}
type Preparation =
  Fixture['paths']['/api/widgets/{widgetId}/preparations']['post'];
export const preparation = (
  document: Fixture,
): Omit<Preparation, 'parameters'> & { parameters: Parameter[] } =>
  document.paths['/api/widgets/{widgetId}/preparations'].post;

export async function temporary(t: TestContext) {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pom-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export async function fileSnapshot(root: string) {
  const result: Record<string, { source: string; mtime: number }> = {};
  for (const name of (await readdir(root)).sort()) {
    const entry = await stat(join(root, name));
    if (entry.isFile())
      result[name] = {
        source: await readFile(join(root, name), 'utf8'),
        mtime: entry.mtimeMs,
      };
  }
  return result;
}

export function generatedFixture() {
  const document = fixture();
  Object.assign(document.components.schemas.Widget.properties, {
    details: {
      type: 'object',
      required: ['visible'],
      properties: { visible: { type: 'boolean' } },
    },
  });
  const operation = preparation(document);
  Object.assign(operation.responses, {
    303: {
      description: 'Follow another resource',
      headers: {
        Location: { required: true, schema: { type: 'string' } },
      },
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/Problem' },
        },
      },
    },
  });
  operation.parameters.push(
    { name: 'X-Tab', in: 'header', schema: { type: 'string', const: 'a\tb' } },
    {
      name: 'X-Padded',
      in: 'header',
      schema: { type: 'string', const: ' a ' },
    },
  );
  Object.assign(operation.responses['202'].headers, {
    'X-Tab': {
      schema: { type: 'string', const: 'a\tb' },
    },
  });
  Object.assign(operation.responses['202'].headers, {
    'X-Key': {
      schema: { type: 'string' },
    },
  });
  const queryParameters: Parameter[] =
    document.paths['/api/widgets/{widgetId}'].get.parameters;
  queryParameters.push(
    { name: 'q', in: 'query', schema: { type: 'string' } },
    { name: '🔍', in: 'query', schema: { type: 'string' } },
    {
      name: 'brokenConst',
      in: 'query',
      schema: { type: 'string', const: '\ud800' },
    },
  );
  return document;
}
