import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { QueryClient } from '@tanstack/query-core';
import type { FetchInfiniteQueryOptions } from '@tanstack/query-core';
import { stringify } from 'yaml';
import { compile, ContractError } from '../dist/index.js';
import { parseYaml } from '../dist/yaml.js';
import type { OperationCall } from '../src/call-runtime.ts';
import type { Executor } from '../src/execution-runtime.ts';
import { defineOperation, report } from '../src/runtime.ts';
import type {
  ObservedResponse,
  Parse,
  ProtocolResult,
  Responses,
} from '../src/runtime.ts';
import { present } from './assertions.ts';
import {
  generatedTestWorkspace,
  importGenerated,
} from './generated-workspace.ts';
import type { Schema } from './schema-helpers.ts';

// Each declaration accepts only its own literal, as JSON or as plain text, so
// a result identifies the declaration that validated it.
const literal = (name: string): { schema: Schema } => ({
  schema: { type: 'string', enum: [name] },
});

function fixture(modern = true) {
  const page: Schema = {
    type: 'object',
    required: ['items', 'next'],
    properties: {
      items: { type: 'array', items: { type: 'string' } },
      next: modern
        ? { type: ['string', 'null'] }
        : { type: 'string', nullable: true },
    },
  };
  return {
    openapi: modern ? '3.1.2' : '3.0.4',
    info: { title: 'Synthetic response media ranges', version: '1' },
    paths: {
      '/ranges': {
        get: {
          operationId: 'readRanges',
          responses: {
            200: {
              description: 'Overlapping declarations',
              content: {
                'application/json': literal('exact'),
                'application/*': literal('application'),
                'text/*': literal('text'),
                '*/*': literal('any'),
              } as Record<string, { schema: Schema }>,
            },
          },
        },
      },
      '/pages': {
        get: {
          operationId: 'pages',
          parameters: [
            { name: 'cursor', in: 'query', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'A page',
              content: { '*/*': { schema: page } },
            },
          },
        },
      },
    },
  };
}

const selection = {
  clients: ['consumer'],
  executionClients: ['consumer'],
  surfaces: { consumer: ['readRanges', 'pages'] },
  queries: { consumer: ['readRanges', 'pages'] },
  infiniteQueries: {
    consumer: {
      pages: { cursor: 'cursor', nextCursor: 'next', items: 'items' },
    },
  },
} as const;

// Observed Content-Type, body, and the validated data or undefined for a
// protocol failure.
const cases: readonly (readonly [string | undefined, string, string?])[] = [
  ['application/json', '"exact"', 'exact'],
  ['Application/JSON; charset=utf-8', '"exact"', 'exact'],
  // Only the type and subtype are concrete: parameters keep the full token
  // and quoted-string grammar, wildcard characters included.
  ['application/json; flavor="*/*"', '"exact"', 'exact'],
  ['application/vnd.api+json', '"application"', 'application'],
  ['application/vnd.api+json; version=*', '"application"', 'application'],
  ['text/plain', 'text', 'text'],
  ['text/plain; charset=utf-8', 'text', 'text'],
  ['text/vnd.note+json', '"text"', 'text'],
  ['model/gltf+json', '"any"', 'any'],
  // The most specific key alone validates, even where a wider one would pass.
  ['application/json', '"application"'],
  ['application/json', '"any"'],
  ['application/vnd.api+json', '"any"'],
  ['text/plain', 'any'],
  // Text is never parsed as JSON, and JSON is never passed through as text.
  ['text/plain', '"text"'],
  ['text/vnd.note+json', 'text'],
  // A matching range still needs a body this runtime can decode. The wider
  // range does not rescue a type the narrower one covers.
  ['application/xml', '"application"'],
  ['application/octet-stream', '"any"'],
  ['text/html', 'text'],
  ['image/png', '"any"'],
  // A range is a declaration, never an observed media type. A wildcard in the
  // evidence is rejected before any range could match it or a decoder run.
  ['*/*', '"any"'],
  ['text/*', 'text'],
  ['application/*+json', '"application"'],
  ['application/*+json', '"any"'],
  ['*/vnd.api+json', '"any"'],
  ['*/*+json', '"any"'],
  ['text/pl*in', 'text'],
  [undefined, '"any"'],
  ['', '"any"'],
];

function verifyRanges(
  parse: (response: ObservedResponse) => ProtocolResult<Responses>,
): void {
  for (const [contentType, body, data] of cases) {
    const result = parse({
      status: 200,
      headers: contentType === undefined ? {} : { 'Content-Type': contentType },
      body,
    });
    const label = `${contentType} ${body}`;
    assert.equal(
      result.kind,
      data === undefined ? 'protocol' : 'success',
      label,
    );
    if (result.kind === 'protocol') continue;
    assert.equal(result.data, data, label);
    // Results report the observed type, without parameters, in lowercase.
    assert.equal(
      result.contentType,
      present(contentType).split(';')[0]!.toLowerCase(),
      label,
    );
  }
}

void test('media ranges produce the same output across dialects, YAML, key case and declaration order', async () => {
  const files = await compile(fixture(), selection);
  for (const modern of [true, false]) {
    const document = fixture(modern);
    const before = structuredClone(document);
    assert.deepEqual(await compile(document, selection), files);
    assert.deepEqual(document, before);
    assert.deepEqual(
      await compile(parseYaml(stringify(document), 'ranges.yaml'), selection),
      files,
    );
    const response = document.paths['/ranges'].get.responses[200];
    response.content = Object.fromEntries(
      Object.entries(response.content)
        .reverse()
        .map(([name, media]) => [name.toUpperCase(), media]),
    );
    assert.deepEqual(await compile(document, selection), files);
  }
});

void test('a range validates only when it is the most specific declaration and the observed type decodes as JSON or text', () => {
  const calls: string[] = [];
  const counted =
    (name: string): Parse<string> =>
    (input, issues) => {
      calls.push(name);
      return input === name ? name : report(issues, `expected ${name}`, true);
    };
  const media = (name: string, bodyKind: 'json' | 'observed') => ({
    bodyKind,
    schema: counted(name),
  });
  const operation = defineOperation({
    operationId: 'ranges',
    method: 'GET',
    path: '/ranges',
    bodyKind: 'none',
    security: { transport: 'none' },
    policy: {},
    parameters: [],
    options: () => undefined,
    headers: {},
    responses: {
      200: {
        bodyKind: 'content',
        headers: {},
        content: {
          'application/json': media('exact', 'json'),
          'application/*': media('application', 'observed'),
          'text/*': media('text', 'observed'),
          '*/*': media('any', 'observed'),
        },
      },
    },
  });
  verifyRanges((response) => operation.parseResponse(response));
  // Exactly one declaration saw each decodable body; undecodable and
  // undeclared types reached none.
  assert.deepEqual(calls, [
    'exact',
    'exact',
    'exact',
    'application',
    'application',
    'text',
    'text',
    'text',
    'any',
    'exact',
    'exact',
    'application',
    'text',
    'text',
  ]);
  const undecodable = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'image/png' },
    body: '"any"',
  });
  assert.equal(undecodable.kind, 'protocol');
  if (undecodable.kind === 'protocol')
    assert.deepEqual(undecodable.issues, [
      {
        part: 'content-type',
        message:
          'a declared media range accepts only JSON and text/plain response media types',
      },
    ]);
  const malformed = operation.parseResponse({
    status: 200,
    headers: { 'Content-Type': 'text/vnd.note+json' },
    body: '{',
  });
  assert.equal(malformed.kind, 'protocol');
  if (malformed.kind === 'protocol')
    assert.deepEqual(malformed.issues, [
      { part: 'body', message: 'invalid JSON response body' },
    ]);
});

interface Generated {
  operations: Record<
    string,
    { parseResponse(response: ObservedResponse): ProtocolResult<Responses> }
  >;
  createClient(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, OperationCall<undefined, Responses>>;
}
interface PageFactory {
  options(args: {
    context: Record<string, never>;
  }): FetchInfiniteQueryOptions<unknown, Error>;
  body(): PageFactory;
}
interface Queries {
  createInfiniteQueries(config: {
    namespace: string;
    execute: Executor;
  }): Record<string, PageFactory>;
}

void test('generated range responses validate, type the observed media type and reach calls and paginated queries', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(fixture(), selection),
  );
  const module = await importGenerated<Generated>(root, 'client.consumer.ts');
  const readRanges = present(module.operations.readRanges);
  verifyRanges((response) => readRanges.parseResponse(response));
  let observed: ObservedResponse = {
    status: 200,
    headers: { 'Content-Type': 'application/hal+json' },
    body: '"application"',
  };
  const execute: Executor = async () => observed;
  const config = { namespace: 'ranges', execute };
  const call = present(module.createClient(config).readRanges);
  const called = await call.call({ context: {} });
  assert.equal(called.contentType, 'application/hal+json');
  assert.equal(called.data, 'application');
  observed = { ...observed, headers: { 'Content-Type': 'application/pdf' } };
  await assert.rejects(call.call({ context: {} }), (error) => {
    assert.ok(call.isError(error));
    assert.equal(error.result.kind, 'protocol');
    return true;
  });
  const page = { items: ['a'], next: null };
  const cache = new QueryClient();
  try {
    const pages = present(
      (
        await importGenerated<Queries>(root, 'client.consumer.queries.ts')
      ).createInfiniteQueries(config).pages,
    ).body();
    observed = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(page),
    };
    const data = await cache.fetchInfiniteQuery(pages.options({ context: {} }));
    assert.deepEqual(data.pages, [page]);
    // The page schema is an object, so plain text can never satisfy it.
    observed = { ...observed, headers: { 'Content-Type': 'text/plain' } };
    await assert.rejects(
      new QueryClient().fetchInfiniteQuery(pages.options({ context: {} })),
    );
  } finally {
    cache.clear();
  }
  await writeFile(
    join(root, 'consumer.ts'),
    `
    import { operations } from './client.consumer.ts';
    const ranges = operations.readRanges.parseResponse({ status: 200, headers: {}, body: '' });
    if (ranges.kind === 'success') {
      const media: \`\${string}/\${string}\` = ranges.contentType;
      void media;
      if (ranges.contentType === 'image/png') {
        // Only */* can report a type outside the other declarations.
        const data: 'any' = ranges.data; void data;
      } else if (ranges.contentType === 'text/plain') {
        const data: 'text' | 'any' = ranges.data;
        // @ts-expect-error No application declaration reports a text type.
        const other: 'exact' | 'application' = ranges.data;
        void [data, other];
      } else if (ranges.contentType === 'application/json') {
        // Overlapping ranges stay in the type; validation used the exact key.
        const data: 'exact' | 'application' | 'any' = ranges.data;
        // @ts-expect-error text/* cannot report an application type.
        const other: 'text' = ranges.data;
        void [data, other];
      }
    }
    const page = operations.pages.parseResponse({ status: 200, headers: {}, body: '' });
    if (page.kind === 'success') {
      const items: string[] = page.data.items;
      // @ts-expect-error A range reports the observed type rather than one literal.
      const json: 'application/json' = page.contentType;
      void [items, json];
    }
  `,
  );
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        exactOptionalPropertyTypes: true,
        noEmit: true,
        allowImportingTsExtensions: true,
      },
      include: ['./*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
});

void test('ranges stay response-only, whole-subtype declarations with decodable schemas', async () => {
  const rejects = async (
    change: (document: ReturnType<typeof fixture>) => void,
    location: string,
    message: RegExp,
  ) => {
    const document = fixture();
    change(document);
    await assert.rejects(compile(document, selection), (error) => {
      assert.ok(error instanceof ContractError, location);
      assert.equal(error.location, location);
      assert.match(error.message, message, location);
      return true;
    });
  };
  const content = 'paths./ranges.get.responses.200.content';
  for (const key of [
    '*/json',
    'application/*+json',
    'text/pl*',
    '*',
    '**/*',
    '*/*/*',
    '*/*; q=0.8',
    'text/*;charset=utf-8',
  ])
    await rejects(
      (document) => {
        document.paths['/ranges'].get.responses[200].content[key] =
          literal('any');
      },
      `${content}.${key}`,
      /expected a media type, or a type\/\* or \*\/\* range, without parameters$/,
    );
  await rejects(
    (document) => {
      document.paths['/ranges'].get.responses[200].content['TEXT/*'] =
        literal('text');
    },
    `${content}.text/*`,
    /duplicate case-insensitive media type$/,
  );
  await rejects(
    (document) => {
      document.paths['/ranges'].get.responses[200].content['image/*'] = {
        schema: { type: 'string', format: 'binary' },
      };
    },
    `${content}.image/*.schema`,
    /binary values are only supported in multipart request fields$/,
  );
  for (const key of ['*/*', 'application/*', 'text/*']) {
    const document = fixture();
    Object.assign(document.paths, {
      '/send': {
        post: {
          operationId: 'send',
          requestBody: { content: { [key]: literal('any') } },
          responses: { 204: { description: 'Sent' } },
        },
      },
    });
    await assert.rejects(
      compile(document, {
        ...selection,
        surfaces: { consumer: ['readRanges', 'pages', 'send'] },
      }),
      {
        name: 'ContractError',
        location: `paths./send.post.requestBody.content.${key}`,
        message:
          /expected a concrete media type without parameters or wildcards$/,
      },
    );
  }
});
