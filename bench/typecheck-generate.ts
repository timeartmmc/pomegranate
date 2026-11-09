import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { record, writeJson } from './controller.ts';
import {
  typecheckConsumer,
  verifyTypecheckInventory,
  typecheckWorkload,
  scaleCompilerOptions,
} from './cases/typecheck.ts';
import type { TypecheckProfile } from './cases/typecheck.ts';

const [entry, directory, profilePath] = process.argv.slice(2);
assert.ok(
  entry && directory && profilePath,
  'expected compiler entry, output directory and profile',
);
const profile = JSON.parse(
  await readFile(profilePath, 'utf8'),
) as TypecheckProfile;
const input = typecheckWorkload(profile);
await mkdir(directory);
await writeJson(join(directory, 'input.json'), input);
const module = record(await import(pathToFileURL(entry).href));
assert.ok(
  typeof module.compile === 'function',
  'compiler must export compile()',
);
const files = record(
  await Reflect.apply(module.compile, module, [input.document, input.options]),
);
assert.ok(
  Object.keys(files).length > 0,
  'compiler returned no generated modules',
);
for (const [name, source] of Object.entries(files)) {
  assert.ok(
    /^[a-zA-Z0-9_.-]+\.ts$/.test(name),
    `unsupported generated name: ${name}`,
  );
  assert.ok(typeof source === 'string', `${name}: expected source text`);
  await writeFile(join(directory, name), source, { flag: 'wx' });
}
await writeFile(join(directory, 'consumer.ts'), typecheckConsumer(profile), {
  flag: 'wx',
});
await writeJson(join(directory, 'tsconfig.json'), {
  compilerOptions: scaleCompilerOptions,
  include: ['./*.ts'],
});

await writeJson(
  join(directory, 'inventory.json'),
  verifyTypecheckInventory(
    profile,
    await import(pathToFileURL(join(directory, 'client.consumer.ts')).href),
    await import(
      pathToFileURL(join(directory, 'client.consumer.schemas.ts')).href
    ),
  ),
);
