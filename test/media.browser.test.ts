import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { compile } from '../dist/index.js';
import { generatedTestWorkspace } from './generated-workspace.ts';
import { mediaFixture, mediaSelection } from './media-fixture.ts';
import type { MediaClient } from './media-fixture.ts';
import {
  interoperabilityFixture,
  interoperabilitySelection,
} from './interoperability-fixture.ts';

void test('Chromium preserves selected request bytes and dispatches every declared response representation', async (t) => {
  const root = await generatedTestWorkspace(t, {
    ...(await compile(mediaFixture(), mediaSelection)),
    ...(await compile(interoperabilityFixture(), {
      ...interoperabilitySelection,
      clients: ['interop'],
      surfaces: { interop: interoperabilitySelection.surfaces.consumer },
    })),
  });
  await writeFile(
    join(root, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        types: [],
        outDir: 'built',
        rewriteRelativeImportExtensions: true,
      },
      include: ['*.ts'],
    }),
  );
  await promisify(execFile)(process.execPath, [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '-p',
    join(root, 'tsconfig.json'),
  ]);
  const received: {
    url: string;
    contentType: string | undefined;
    bytes: Buffer;
  }[] = [];
  const requests: Record<string, readonly [string, string]> = {
    '/unicode-text': ['POST', 'text/plain'],
    '/suffix': ['POST', 'application/problem+json'],
    '/preferred': ['POST', 'application/json'],
    '/records/a%2Fb.json': ['DELETE', 'text/json; charset=utf-8'],
    '/text0': ['OPTIONS', 'text/html'],
    '/text1': ['OPTIONS', 'text/csv'],
    '/text2': ['OPTIONS', 'application/yaml'],
  };
  const server = createServer((request, response) => {
    void (async () => {
      assert.ok(request.url);
      const expected = requests[request.url];
      if (expected) {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          assert.ok(Buffer.isBuffer(chunk));
          chunks.push(chunk);
        }
        const bytes = Buffer.concat(chunks);
        const contentType = request.headers['content-type'];
        received.push({ url: request.url, contentType, bytes });
        assert.equal(request.method, expected[0]);
        assert.equal(contentType, expected[1]);
        if (request.url === '/preferred') {
          const media = request.headers['x-reply-media'];
          assert.ok(typeof media === 'string');
          const replies: Readonly<Record<string, string>> = {
            'application/json': '{"code":"ok"}',
            'application/a+json': 'true',
            'application/vnd.zeta+json': '2',
            'text/plain': 'text',
          };
          assert.ok(Object.hasOwn(replies, media));
          response.writeHead(200, {
            'Content-Type': `${media}; charset=utf-8`,
            'X-Echo-Content-Type': contentType,
          });
          response.end(replies[media]);
          return;
        }
        response.writeHead(200, {
          'Content-Type':
            request.headers['x-wrong-media'] === 'yes'
              ? 'application/json'
              : contentType,
          'X-Echo-Content-Type': contentType,
        });
        response.end(bytes);
        return;
      }
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Selected media</title>');
        return;
      }
      if (request.url === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      assert.ok(request.url.startsWith('/generated/'));
      const directory = join(root, 'built');
      const path = resolve(directory, request.url.slice('/generated/'.length));
      assert.ok(path.startsWith(directory + sep));
      response.setHeader('Content-Type', 'text/javascript');
      response.end(await readFile(path));
    })().catch((error) => {
      response.writeHead(500);
      response.end(String(error));
    });
  });
  server.listen(0, '127.0.0.1');
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async (specifier) => {
    const client = (await import(specifier)) as MediaClient;
    const text = client.operations['unicodeText'];
    const suffix = client.operations['suffix'];
    const preferred = client.operations['preferred'];
    if (!text || !suffix || !preferred)
      throw new Error('Missing generated media operations');
    let network = 0;
    const send = async (
      request: ReturnType<typeof text.build>,
      wrong = false,
      replyType?: string,
    ) => {
      if (request.bodyKind !== 'json' && request.bodyKind !== 'text')
        throw new Error('Expected a represented request body');
      network++;
      const observed = await fetch(request.url, {
        method: request.method,
        headers: request.validateHeaders({
          ...request.headers,
          'Content-Type': request.contentType,
          ...(wrong ? { 'X-Wrong-Media': 'yes' } : {}),
          ...(replyType ? { 'X-Reply-Media': replyType } : {}),
        }),
        body:
          request.bodyKind === 'json'
            ? JSON.stringify(request.body)
            : String(request.body),
      });
      const body = await observed.text();
      return {
        echoedType: observed.headers.get('X-Echo-Content-Type'),
        body,
        parsed: request.parseResponse({
          status: observed.status,
          headers: Object.fromEntries(observed.headers),
          body,
        }),
      };
    };
    const texts = [];
    for (const body of ['', '\nline\n', '😀', '{"code":"ok"}'])
      texts.push(await send(text.build({ body })));
    const json = await send(suffix.build({ body: { code: 'ok' } }));
    const wrong = await send(suffix.build({ body: { code: 'ok' } }), true);
    const representations = [];
    for (const media of [
      'application/json',
      'application/a+json',
      'application/vnd.zeta+json',
      'text/plain',
    ])
      representations.push({
        media,
        response: await send(
          preferred.build({ body: { code: 'ok' } }),
          false,
          media,
        ),
      });
    const rejected = [];
    for (const body of ['\ud800', '\udc00']) {
      try {
        await send(text.build({ body }));
        rejected.push(false);
      } catch (error) {
        rejected.push(error instanceof client.RequestValidationError);
      }
    }
    const interopSpecifier = '/generated/client.interop.js';
    const interop = (await import(interopSpecifier)) as MediaClient;
    const interoperability = [];
    for (const [name, input] of [
      [
        'remove',
        { path: { id: 'a/b' }, body: { kind: 'Cat', id: 1, amount: 0.5 } },
      ],
      ...['text0', 'text1', 'text2'].map(
        (name) => [name, { body: '<p>😀</p>\ntext' }] as const,
      ),
    ] as const) {
      const operation = interop.operations[name];
      if (!operation)
        throw new Error(`Missing interoperability operation ${name}`);
      interoperability.push(await send(operation.build(input)));
    }
    return {
      texts,
      json,
      wrong,
      rejected,
      representations,
      interoperability,
      network,
    };
  }, '/generated/client.consumer.js');
  const bodies = ['', '\nline\n', '😀', '{"code":"ok"}'];
  for (const [index, observed] of result.texts.entries()) {
    assert.equal(observed.echoedType, 'text/plain');
    assert.equal(observed.body, bodies[index]);
    assert.equal(observed.parsed.kind, 'success');
    assert.equal(observed.parsed.data, bodies[index]);
    assert.equal(observed.parsed.contentType, 'text/plain');
  }
  assert.equal(result.json.echoedType, 'application/problem+json');
  assert.equal(result.json.body, '{"code":"ok"}');
  assert.equal(result.json.parsed.kind, 'success');
  assert.deepEqual(result.json.parsed.data, { code: 'ok' });
  assert.equal(result.json.parsed.contentType, 'application/problem+json');
  const expected = [{ code: 'ok' }, true, 2, 'text'];
  for (const [index, { media, response }] of result.representations.entries()) {
    assert.equal(response.echoedType, 'application/json');
    assert.equal(response.parsed.kind, 'success');
    assert.equal(response.parsed.contentType, media);
    assert.deepEqual(response.parsed.data, expected[index]);
  }
  assert.equal(result.wrong.parsed.kind, 'protocol');
  assert.deepEqual(result.rejected, [true, true]);
  for (const [index, response] of result.interoperability.entries()) {
    assert.equal(response.parsed.kind, 'success');
    assert.deepEqual(
      response.parsed.data,
      index === 0 ? { kind: 'Cat', id: 1, amount: 0.5 } : '<p>😀</p>\ntext',
    );
  }
  assert.equal(result.network, 14);
  assert.equal(received.length, 14);
  const expectedBodies = [
    ...bodies,
    ...Array.from({ length: 6 }, () => '{"code":"ok"}'),
    { kind: 'Cat', id: 1, amount: 0.5 },
    ...Array.from({ length: 3 }, () => '<p>😀</p>\ntext'),
  ];
  for (const [index, observed] of received.entries()) {
    const expected = expectedBodies[index]!;
    if (typeof expected === 'string')
      assert.deepEqual(observed.bytes, Buffer.from(expected));
    else
      assert.deepEqual(JSON.parse(observed.bytes.toString('utf8')), expected);
  }
});
