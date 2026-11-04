import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

export async function generatedWorkspace(
  files: Readonly<Record<string, string>>,
  subdirectory = '.',
): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'pom-generated-'));
  try {
    await symlink(
      fileURLToPath(new URL('../node_modules', import.meta.url)),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
    const output = join(root, subdirectory);
    await mkdir(output, { recursive: true });
    for (const [name, source] of Object.entries(files))
      await writeFile(join(output, name), source);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function generatedTestWorkspace(
  context: TestContext,
  files: Readonly<Record<string, string>>,
  subdirectory = '.',
): Promise<string> {
  const root = await generatedWorkspace(files, subdirectory);
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Runtime imports cross the generated-file boundary. Consumer type/declaration
// tests independently check these signatures against the emitted modules.
export async function importGenerated<Module>(
  root: string,
  name: string,
): Promise<Module> {
  return (await import(pathToFileURL(join(root, name)).href)) as Module;
}
