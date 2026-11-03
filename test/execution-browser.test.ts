import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { compile } from '../dist/index.js';
import { executionFixture, executionSelection } from './execution-fixture.ts';
import { multipartFixture, multipartSelection } from './multipart-fixture.ts';
import { generatedWorkspace } from './generated-workspace.ts';
import { json, record } from './assertions.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
void test('one application executor serves real Chromium calls, uploads and mounted ordinary, cursor, offset and mutation hooks', async (t) => {
  const root = await generatedWorkspace(
    await compile(executionFixture(), executionSelection),
    'execution-generated',
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'multipart-generated'));
  for (const [name, source] of Object.entries(
    await compile(multipartFixture(), multipartSelection),
  ))
    await writeFile(join(root, 'multipart-generated', name), source);
  await writeFile(
    join(root, 'app.ts'),
    (await readFile(join(repo, 'test/execution-browser-app.ts'), 'utf8'))
      .replaceAll('./.generated/execution/', './execution-generated/')
      .replaceAll('./.generated/multipart/', './multipart-generated/'),
  );
  await promisify(execFile)(
    'bun',
    [
      'build',
      join(root, 'app.ts'),
      '--target=browser',
      `--outfile=${join(root, 'app.js')}`,
    ],
    { cwd: repo, env: { ...process.env, NODE_ENV: 'development' } },
  );
  const methods = new Set<string>();
  const failures: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url!, 'http://synthetic.invalid');
      if (url.pathname === '/') {
        response.setHeader('Content-Type', 'text/html');
        response.end('<!doctype html><title>Executable client</title>');
        return;
      }
      if (url.pathname === '/app.js') {
        response.setHeader('Content-Type', 'text/javascript');
        response.end(await readFile(join(root, 'app.js')));
        return;
      }
      if (url.pathname === '/favicon.ico') {
        response.writeHead(204);
        response.end();
        return;
      }
      assert.equal(request.headers['authorization'], 'Bearer synthetic');
      assert.equal(request.headers['x-language'], 'en');
      methods.add(request.method!);
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        assert.ok(Buffer.isBuffer(chunk));
        chunks.push(chunk);
      }
      const send = (status: number, data: unknown) => {
        response.writeHead(status, {
          'Content-Type': 'application/json',
          'X-Request-ID': 'browser',
          // Equal-refetch assertions compare the complete response envelope.
          Date: 'Mon, 02 Nov 2026 00:00:00 GMT',
        });
        response.end(JSON.stringify(data));
      };
      if (
        request.method === 'HEAD' ||
        request.method === 'OPTIONS' ||
        request.method === 'DELETE'
      ) {
        response.writeHead(204);
        response.end();
        return;
      }
      if (url.pathname === '/uploads') {
        const form = await new Response(new Uint8Array(Buffer.concat(chunks)), {
          headers: { 'Content-Type': request.headers['content-type']! },
        }).formData();
        assert.deepEqual([...form.keys()].sort(), [
          'attachments',
          'attachments',
          'caption',
          'cover',
          'extras',
          'note',
        ]);
        assert.equal(form.get('caption'), 'a\r\nb');
        assert.equal(form.get('note'), 'a\r\nb');
        for (const file of [
          ...form.getAll('attachments'),
          form.get('cover'),
          form.get('extras'),
        ]) {
          assert.ok(file instanceof File);
          assert.equal(await file.text(), 'synthetic file');
          assert.equal(file.name, 'sample.txt');
        }
        send(201, { count: 6 });
        return;
      }
      if (url.pathname === '/commands') {
        assert.equal(request.headers['idempotency-key'], 'browser-attempt');
        const body = record(json(Buffer.concat(chunks).toString()));
        assert.deepEqual(body['values'], ['one']);
        if (body['label'] === 'Denied')
          send(409, { detail: 'Synthetic denial' });
        else send(201, { id: 'created', label: body['label'] });
        return;
      }
      if (url.pathname.startsWith('/collections/')) {
        const next = url.searchParams.has('after');
        send(next ? 206 : 200, {
          results: [next ? { code: 2 } : { id: 'one', label: 'First' }],
          continuation: next ? null : 'next',
        });
        return;
      }
      if (url.pathname.startsWith('/records/')) {
        const next = url.searchParams.get('start') === '1';
        send(next ? 206 : 200, {
          entries: [{ id: next ? 'two' : 'one' }],
          start: next ? 1 : 0,
          size: 1,
          count: 2,
          next: null,
          ...(next ? { segment: 'partial' } : {}),
        });
        return;
      }
      if (url.pathname === '/items/slow') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.write('{"id":"slow",');
        // Keep the body pending until the browser cancels its read.
        return;
      }
      if (url.pathname.startsWith('/items/')) {
        send(200, { id: 'item', label: 'Browser' });
        return;
      }
      assert.fail(
        `unexpected browser request ${request.method} ${request.url}`,
      );
    })().catch((error: unknown) => {
      failures.push(error);
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${address.port}`);
  const result = await page.evaluate(async () => {
    const path = '/app.js';
    const module = (await import(
      path
    )) as typeof import('./execution-browser-app.ts');
    return module.runExecutionBrowser();
  });
  assert.deepEqual(failures, []);
  assert.deepEqual([...methods].sort(), [
    'DELETE',
    'GET',
    'HEAD',
    'OPTIONS',
    'PATCH',
    'POST',
    'PUT',
  ]);
  // Each of the four mounted matrix cases now restores an optimistic offset page.
  assert.equal(result.requests, 60);
  assert.equal(result.reads, 60);
  assert.equal(result.effects, 1);
  assert.equal(result.scopedValidations, 22);
  assert.deepEqual(result.mixedInvalidations, ['raw/cursor', 'scoped/offset']);
  assert.deepEqual(result.mountedCombinations, [
    'raw/envelope/ordinary',
    'raw/envelope/cursor',
    'raw/envelope/offset',
    'raw/body/ordinary',
    'raw/body/cursor',
    'raw/body/offset',
    'scoped/envelope/ordinary',
    'scoped/envelope/cursor',
    'scoped/envelope/offset',
    'scoped/body/ordinary',
    'scoped/body/cursor',
    'scoped/body/offset',
  ]);
});
