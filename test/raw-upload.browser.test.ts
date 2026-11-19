import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { compile } from '../dist/index.js';
import { generatedTestWorkspace } from './generated-workspace.ts';
import {
  rawUploadFixture,
  rawUploadMediaType,
  rawUploadSelection,
} from './raw-upload-fixture.ts';

const app = `
import { createClient } from './client.consumer.ts';

export async function run() {
  const client = createClient({
    namespace: 'synthetic-browser-upload',
    execute: async (request, execution) => {
      await Promise.resolve();
      const headers = { ...request.headers };
      const init: RequestInit = { method: request.method, headers, signal: execution.signal };
      if (request.bodyKind === 'binary') {
        headers['Content-Type'] = request.contentType;
        init.body = request.body;
      }
      const response = await fetch(request.url, init);
      return execution.validateResponse({
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
      });
    },
  });
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const realm = frame.contentWindow as Window & typeof globalThis;
  const bytes = new realm.Uint8Array([11, 0, 255, 13, 10, 22]).subarray(1, 5);
  const pending = client.upload.call({ context: {}, input: { body: bytes } });
  bytes.fill(123);
  const present = await pending;
  const empty = await client.uploadOptional.call({ context: {}, input: { body: new Uint8Array() } });
  const absent = await client.uploadOptional.call({ context: {} });
  return [present.data.size, empty.data.size, absent.data.size];
}
`;

void test('Chromium Fetch sends owned raw bytes, empty bytes and omitted uploads', async (t) => {
  const root = await generatedTestWorkspace(
    t,
    await compile(rawUploadFixture(), rawUploadSelection),
  );
  const appPath = join(root, 'app.ts');
  await writeFile(appPath, app);
  const tsc = [
    fileURLToPath(
      new URL('../node_modules/typescript/bin/tsc', import.meta.url),
    ),
    '--strict',
    '--noEmit',
    '--exactOptionalPropertyTypes',
    '--allowImportingTsExtensions',
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
  ];
  const run = promisify(execFile);
  await run(
    process.execPath,
    [...tsc, '--lib', 'ES2022,DOM,DOM.Iterable', appPath],
    { cwd: root },
  );
  await run(
    process.execPath,
    [
      ...tsc,
      '--lib',
      'ES2022',
      '--types',
      'node',
      join(root, 'client.consumer.ts'),
    ],
    { cwd: root },
  );
  const bundle = await build({
    entryPoints: [appPath],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const received: unknown[] = [];
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      if (request.url === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<title>Synthetic raw upload</title>');
        return;
      }
      if (request.url === '/app.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(bundle.outputFiles[0]!.contents);
        return;
      }
      if (request.url === '/favicon.ico') {
        response.writeHead(204).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      received.push({
        url: request.url,
        method: request.method,
        contentType: request.headers['content-type'],
        bytes,
      });
      response.writeHead(201, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ size: bytes.length }));
    })().catch((error) => {
      failures.push(error);
      response.destroy(error instanceof Error ? error : undefined);
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
  const sizes = await page.evaluate(async () => {
    const url = '/app.js';
    const { run } = (await import(url)) as { run: () => Promise<number[]> };
    return run();
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(sizes, [4, 0, 0]);
  assert.deepEqual(received, [
    {
      url: '/upload',
      method: 'POST',
      contentType: rawUploadMediaType,
      bytes: Buffer.from([0, 255, 13, 10]),
    },
    {
      url: '/optional-upload',
      method: 'POST',
      contentType: rawUploadMediaType,
      bytes: Buffer.alloc(0),
    },
    {
      url: '/optional-upload',
      method: 'POST',
      contentType: undefined,
      bytes: Buffer.alloc(0),
    },
  ]);
});
