import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { compile } from '../dist/index.js';
import { generatedWorkspace } from './generated-workspace.ts';
import { multipartFixture } from './multipart-fixture.ts';

void test('generated browser uploads require current-environment Files and preserve transferred bytes', async (t) => {
  const root = await generatedWorkspace(
    await compile(multipartFixture(), {
      clients: ['browser'],
      targets: { browser: 'browser' },
    }),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = await build({
    entryPoints: [join(root, 'client.browser.ts')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
  });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent('<iframe></iframe>');
  const url = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]!.contents).toString('base64')}`;
  const result = await page.evaluate(async (url) => {
    const { operations } = (await import(url)) as {
      operations: {
        uploadInline: { build: (input: unknown) => { body: { file: File } } };
      };
    };
    const foreign = document.querySelector('iframe')!.contentWindow!;
    const foreignWindow = foreign as Window & typeof globalThis;
    const ForeignFile = foreignWindow.File;
    const local = new File(['local bytes'], 'local.txt', {
      type: 'text/plain',
    });
    const iframe = new ForeignFile(['iframe bytes'], 'iframe.txt', {
      type: 'text/plain',
    });
    const foreignSubclass = new (class extends ForeignFile {})(
      ['foreign subclass bytes'],
      'foreign-subclass.txt',
    );
    const cloned = structuredClone(iframe);
    const posted: unknown = await new Promise<unknown>((resolve) => {
      const receive = (event: MessageEvent<unknown>) => {
        const data = event.data;
        if (
          data === null ||
          typeof data !== 'object' ||
          !('tag' in data) ||
          data.tag !== 'pom-file-transfer' ||
          !('file' in data)
        )
          return;
        removeEventListener('message', receive);
        resolve(data.file);
      };
      addEventListener('message', receive);
      foreignWindow.eval(
        'parent.postMessage({tag:"pom-file-transfer",file:new File(["posted bytes"],"posted.txt")},"*")',
      );
    });
    if (
      !(cloned instanceof File) ||
      Object.getPrototypeOf(cloned) !== File.prototype ||
      !(posted instanceof File) ||
      Object.getPrototypeOf(posted) !== File.prototype
    )
      throw new Error('transfer did not produce a receiving-environment File');
    const subclass = new (class extends File {})(
      ['subclass bytes'],
      'subclass.txt',
    );
    const reparented = new File(['reparented bytes'], 'reparented.txt');
    Object.setPrototypeOf(reparented, Object.create(File.prototype) as object);
    let reads = 0;
    const overridden = new File(['native bytes'], 'native.txt');
    for (const property of ['name', 'size'])
      Object.defineProperty(overridden, property, {
        get() {
          reads++;
          throw new Error('input getter must not run');
        },
      });
    const accepted = [];
    for (const file of [
      local,
      cloned,
      posted,
      subclass,
      reparented,
      overridden,
    ]) {
      const request = operations.uploadInline.build({ body: { file } });
      if (request.body.file !== file) throw new Error('File identity changed');
      const form = new FormData();
      form.append('file', request.body.file);
      const decoded = await new Response(form).formData();
      const received = decoded.get('file');
      if (!(received instanceof File)) throw new Error('file became text');
      accepted.push({ name: received.name, text: await received.text() });
    }
    const revoked = Proxy.revocable(local, {});
    revoked.revoke();
    const fake: unknown = Object.create(File.prototype);
    const rejected = [];
    for (const file of [
      fake,
      iframe,
      foreignSubclass,
      new Proxy(local, {}),
      revoked.proxy,
      new Blob(['blob']),
      { [Symbol.toStringTag]: 'File' },
    ]) {
      try {
        operations.uploadInline.build({ body: { file } });
        rejected.push(false);
      } catch (error) {
        rejected.push(
          error instanceof Error && error.name === 'RequestValidationError',
        );
      }
    }
    return { accepted, rejected, reads };
  }, url);
  assert.deepEqual(result, {
    accepted: [
      { name: 'local.txt', text: 'local bytes' },
      { name: 'iframe.txt', text: 'iframe bytes' },
      { name: 'posted.txt', text: 'posted bytes' },
      { name: 'subclass.txt', text: 'subclass bytes' },
      { name: 'reparented.txt', text: 'reparented bytes' },
      { name: 'native.txt', text: 'native bytes' },
    ],
    rejected: [true, true, true, true, true, true, true],
    reads: 0,
  });
});
