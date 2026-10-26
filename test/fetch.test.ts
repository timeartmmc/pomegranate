import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { chromium } from 'playwright';
import { compile } from '../dist/index.js';
import { json, present } from './assertions.ts';
import { fixture } from './helpers.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));

void test('generated browser code preserves declared request and response fields through real Fetch', async (t) => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  const root = await mkdtemp(join(cache, 'pom-fetch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, source] of Object.entries(
    await compile(fixture(), { clients: ['consumer'] }),
  ))
    await writeFile(join(root, name), source);
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
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
    join(repo, 'node_modules/typescript/bin/tsc'),
    '-p',
    join(root, 'tsconfig.json'),
  ]);

  const received: {
    url: string;
    headers: IncomingHttpHeaders;
    body: string;
  }[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      assert.ok(typeof request.url === 'string');
      if (request.url.startsWith('/api/')) {
        let body = '';
        for await (const chunk of request) {
          assert.ok(Buffer.isBuffer(chunk));
          body += chunk.toString();
        }
        received.push({ url: request.url, headers: request.headers, body });
        response.writeHead(202, {
          'Content-Type': 'application/json',
          'X-Request-ID': 'browser-response',
          'Set-Cookie': 'synthetic=1; HttpOnly; SameSite=Lax',
        });
        response.end(
          JSON.stringify({ state: 'pending', reference: 'browser-reference' }),
        );
        return;
      }
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end(
          '<!doctype html><script type="importmap">{"imports":{"zod":"/zod/index.js"}}</script>',
        );
        return;
      }
      const mount = request.url.startsWith('/zod/') ? '/zod/' : '/generated/';
      const directory =
        mount === '/zod/'
          ? join(repo, 'node_modules/zod')
          : join(root, 'built');
      const path = resolve(directory, request.url.slice(mount.length));
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
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async (specifier) => {
    const { operations } = (await import(
      specifier
    )) as typeof import('./.generated/example/client.consumer.ts');
    const request = operations.prepareWidget.build({
      path: { widgetId: 'browser/widget' },
      headers: { 'Idempotency-Key': 'browser-attempt' },
      body: { acknowledged: true, label: 'Browser' },
    });
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.validateHeaders({
        ...request.headers,
        'Content-Type': 'application/json',
      }),
      body: JSON.stringify(request.body),
    });
    return {
      cookie: response.headers.get('Set-Cookie'),
      parsed: request.parseResponse({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      }),
    };
  }, '/generated/client.consumer.js');
  assert.equal(result.cookie, null);
  assert.equal(result.parsed.kind, 'success');
  assert.equal(result.parsed.status, 202);
  assert.equal(
    result.parsed.validatedHeaders['x-request-id'],
    'browser-response',
  );
  assert.equal(result.parsed.data.reference, 'browser-reference');
  assert.equal(received.length, 1);
  const first = present(received[0]);
  assert.equal(first.url, '/api/widgets/browser%2Fwidget/preparations');
  assert.equal(first.headers['idempotency-key'], 'browser-attempt');
  assert.deepEqual(json(first.body), {
    acknowledged: true,
    label: 'Browser',
  });
});
