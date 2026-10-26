import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stringify } from 'yaml';
import { compile, ContractError, runProject } from '../dist/index.js';
import { commandError } from './assertions.ts';
import { fileSnapshot, fixture, temporary } from './helpers.ts';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const marker = 'ENCODING_MARKER';
const malformed = [[0xff], [0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80]];

function replaceMarker(source: string, replacement: readonly number[]): Buffer {
  const bytes = Buffer.from(source);
  const offset = bytes.indexOf(marker);
  assert.ok(offset >= 0);
  assert.equal(bytes.indexOf(marker, offset + marker.length), -1);
  return Buffer.concat([
    bytes.subarray(0, offset),
    Buffer.from(replacement),
    bytes.subarray(offset + marker.length),
  ]);
}

for (const format of ['json', 'yaml', 'config'] as const) {
  for (const existing of [false, true]) {
    void test(`${format} rejects malformed UTF-8 before changing ${existing ? 'existing' : 'missing'} output`, async (t) => {
      const root = await temporary(t);
      const input = join(
        root,
        format === 'yaml' ? 'openapi.yaml' : 'openapi.json',
      );
      const config = join(root, 'pom.json');
      const output = join(root, 'generated');
      const settings = {
        version: 2,
        openapi: format === 'yaml' ? './openapi.yaml' : './openapi.json',
        output: './generated',
        clients: ['consumer'],
      };
      const document = fixture();
      const serialize = format === 'yaml' ? stringify : JSON.stringify;
      await writeFile(input, serialize(document));
      await writeFile(config, JSON.stringify(settings));
      if (existing) await runProject(config);

      Object.assign(document.components.schemas.WidgetId, {
        enum: ['ok', `caf${marker}`],
      });
      const damaged = format === 'config' ? config : input;
      const source =
        format === 'config'
          ? JSON.stringify({ ...settings, output: `./generated-${marker}` })
          : serialize(document);
      const snapshot = async () => ({
        entries: (await readdir(root)).sort(),
        inputs: await Promise.all(
          [input, config].map(async (path) => ({
            path,
            bytes: await readFile(path),
            mtime: (await stat(path)).mtimeMs,
          })),
        ),
        output: existing
          ? {
              entries: (await readdir(output)).sort(),
              files: await fileSnapshot(output),
            }
          : undefined,
      });

      for (const replacement of malformed) {
        await writeFile(damaged, replaceMarker(source, replacement));
        const before = await snapshot();
        for (const check of [false, true]) {
          await assert.rejects(runProject(config, { check }), (error) => {
            assert.ok(error instanceof ContractError);
            assert.equal(error.location, damaged);
            assert.equal(error.message, `${damaged}: invalid UTF-8`);
            return true;
          });
          assert.deepEqual(await snapshot(), before);
        }
        for (const command of ['generate', 'check']) {
          await assert.rejects(
            exec(process.execPath, [cli, command, '--config', config]),
            (error) => {
              const failure = commandError(error);
              assert.equal(failure.code, 1);
              assert.equal(failure.stderr, `POM: ${damaged}: invalid UTF-8\n`);
              return true;
            },
          );
          assert.deepEqual(await snapshot(), before);
        }
      }
    });
  }
}

void test('valid Unicode, a literal replacement character and a leading BOM preserve contract bytes', async (t) => {
  const root = await temporary(t);
  const document = fixture();
  Object.assign(document.components.schemas.WidgetId, {
    enum: ['caf\ufffd😀'],
  });
  const expected = await compile(document, { clients: ['consumer'] });
  for (const extension of ['json', 'yaml']) {
    const input = join(root, `openapi.${extension}`);
    const source =
      extension === 'yaml' ? stringify(document) : JSON.stringify(document);
    const output = join(root, `generated-${extension}`);
    const config = join(root, `pom-${extension}.json`);
    await writeFile(input, `\ufeff${source}`);
    await writeFile(
      config,
      `\ufeff${JSON.stringify({
        version: 2,
        openapi: `./openapi.${extension}`,
        output,
        clients: ['consumer'],
      })}`,
    );
    const before = await readFile(input);
    await runProject(config);
    assert.equal((await runProject(config, { check: true })).clean, true);
    for (const [name, contents] of Object.entries(expected))
      assert.equal(await readFile(join(output, name), 'utf8'), contents);
    assert.deepEqual(await readFile(input), before);
  }
});
