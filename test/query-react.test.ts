import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { compile } from '../dist/index.js';
import type { MountedCase } from './query-react-app.ts';
import { infiniteFixture, infiniteSelection } from './infinite-fixture.ts';

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const exec = promisify(execFile);
let root: string;
let browser: Browser;
let origin: string;
const server = createServer((request, response) => {
  if (request.url === '/') {
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><title>Synthetic query integration</title>');
  } else if (request.url === '/query-react-app.js') {
    response.setHeader('Content-Type', 'text/javascript');
    void readFile(join(root, 'query-react-app.js')).then(
      (body) => response.end(body),
      (error: unknown) => {
        response.writeHead(500);
        response.end(String(error));
      },
    );
  } else {
    response.writeHead(404);
    response.end();
  }
});

before(async () => {
  const cache = join(repo, 'node_modules/.cache');
  await mkdir(cache, { recursive: true });
  root = await mkdtemp(join(cache, 'pom-react-query-'));
  await mkdir(join(root, 'query-generated'));
  for (const [name, source] of Object.entries(
    await compile(infiniteFixture(), infiniteSelection),
  ))
    await writeFile(join(root, 'query-generated', name), source);
  const application = await readFile(
    join(repo, 'test/query-react-app.ts'),
    'utf8',
  );
  await writeFile(
    join(root, 'query-react-app.ts'),
    application
      .replaceAll('./.generated/queries/', './query-generated/')
      .replaceAll('./.generated/infinite/', './query-generated/'),
  );
  // Bun is the repository's pinned bundler; the tested hooks run in Chromium
  // with React DOM, independently of Node's browser-global emulation.
  await exec(
    'bun',
    [
      'build',
      join(root, 'query-react-app.ts'),
      '--target=browser',
      `--outfile=${join(root, 'query-react-app.js')}`,
    ],
    { cwd: repo, env: { ...process.env, NODE_ENV: 'development' } },
  );
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  if (root) await rm(root, { recursive: true, force: true });
});

const cases: readonly (readonly [MountedCase, string])[] = [
  [
    'infinite',
    'mounted infinite queries paginate, retain failed pages, and isolate cancelled session work',
  ],
  [
    'skip',
    'mounted skipped queries wait for real inputs and remain inert through invalidation and refetch',
  ],
  [
    'identity',
    'mounted input and context transitions abort old requests and isolate late responses',
  ],
  [
    'filters',
    'mounted operation filters refetch parameter variants within the complete requested identity',
  ],
  [
    'failures',
    'mounted refetches validate exact statuses, retain previous data and preserve executor retries',
  ],
  [
    'maps',
    'mounted hooks and selections preserve legal dynamic map entries on refetch',
  ],
  [
    'unmount',
    'unmounting the final React observer aborts execution and rejects late data',
  ],
];

for (const [name, description] of cases)
  void test(description, async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (
        message.type() === 'error' &&
        !message
          .text()
          .startsWith('Attempted to invoke queryFn when set to skipToken.')
      )
        errors.push(message.text());
    });
    await page.goto(origin);
    await page.evaluate(
      async ({ name: selected, specifier }) => {
        const application = (await import(
          specifier
        )) as typeof import('./query-react-app.ts');
        await application.runMountedCase(selected);
      },
      { name, specifier: '/query-react-app.js' },
    );
    assert.deepEqual(errors, []);
  });
