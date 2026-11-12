import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { compile } from '../dist/index.js';
import { generatedTestWorkspace } from './generated-workspace.ts';
import {
  serializationFixture,
  serializationSelection,
} from './serialization-fixture.ts';

void test('Chromium sends typed headers, literal form delimiters and omitted optional form bodies', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(serializationFixture(), serializationSelection),
  );
  const app = await readFile(
    fileURLToPath(new URL('./serialization-browser-app.ts', import.meta.url)),
    'utf8',
  );
  await writeFile(
    join(root, 'app.ts'),
    app.replaceAll('./.generated/serialization/', './'),
  );
  await promisify(execFile)('bun', [
    'build',
    join(root, 'app.ts'),
    '--target=browser',
    `--outfile=${join(root, 'app.js')}`,
  ]);
  const received: string[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<title>Wire serialization</title>');
        return;
      }
      if (request.url === '/app.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(join(root, 'app.js')));
        return;
      }
      if (request.url === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      received.push(request.url!);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.url === '/headers') {
        assert.equal(request.method, 'GET');
        assert.equal(request.headers['x-count'], '2');
        assert.equal(request.headers['x-enabled'], 'false');
        assert.equal(request.headers['x-values'], '0.5,1');
        response.writeHead(200, {
          'X-Count': '2',
          'X-Enabled': 'false',
          'X-Values': '0.5, 1',
        });
      } else if (request.url === '/form') {
        assert.equal(request.method, 'POST');
        assert.equal(
          request.headers['content-type'],
          'application/x-www-form-urlencoded',
        );
        const fields = new URLSearchParams(raw);
        assert.equal(fields.get('name'), 'demo + 🌱');
        assert.equal(fields.get('count'), '0');
        assert.equal(fields.get('enabled'), 'false');
        assert.deepEqual(fields.getAll('tags'), ['a,b', 'c d']);
        assert.equal(fields.get('note'), 'a\nb');
        assert.ok(raw.split('&').includes('ids=1,2'));
        assert.ok(raw.split('&').includes('csvTags=alpha%2Cbeta,c%20d'));
        response.writeHead(204);
      } else {
        assert.equal(request.url, '/optional-form');
        assert.equal(raw, '');
        assert.equal(request.headers['content-type'], undefined);
        response.writeHead(204);
      }
      response.end();
    })().catch((error) => {
      failures.push(error);
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
  const result = await page.evaluate(async () => {
    const specifier = '/app.js';
    const app = (await import(
      specifier
    )) as typeof import('./serialization-browser-app.ts');
    return app.runSerializationBrowser();
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(result, { statuses: [200, 204, 204], count: '2' });
  assert.deepEqual(received, ['/headers', '/form', '/optional-form']);
});
