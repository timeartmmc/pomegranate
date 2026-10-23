import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildDescriptor } from './descriptor.js';
import { fail, keys, record, text } from './diagnostics.js';
import { render } from './emit.js';
import { synchronizeOutputs } from './outputs.js';
import type { OutputResult } from './outputs.js';
import { selectClients } from './projection.js';

export type CompileOptions = Readonly<{ clients: readonly string[] }>;

async function readJson(path: string): Promise<unknown> {
  const source = await readFile(path, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail(path, 'invalid JSON');
  }
}

export async function compile(
  document: unknown,
  options: CompileOptions,
): Promise<Readonly<Record<string, string>>> {
  const descriptor = buildDescriptor(document);
  const selection = record(options, 'compile options');
  keys(selection, ['clients'], 'compile options');
  return render(descriptor, selectClients(descriptor, selection.clients));
}

export async function runProject(
  configFile: string,
  options: Readonly<{ check?: boolean }> = {},
): Promise<OutputResult> {
  const configPath = await realpath(configFile);
  const config = record(await readJson(configPath), configPath);
  keys(config, ['version', 'openapi', 'output', 'clients'], configPath);
  if (config.version !== 2)
    fail(`${configPath}.version`, 'expected config version 2');
  const input = resolve(
    dirname(configPath),
    text(config.openapi, `${configPath}.openapi`),
  );
  const output = resolve(
    dirname(configPath),
    text(config.output, `${configPath}.output`),
  );
  const document = await readJson(input);
  const descriptor = buildDescriptor(document);
  const files = await render(
    descriptor,
    selectClients(descriptor, config.clients),
  );
  return synchronizeOutputs(
    output,
    files,
    [configPath, input],
    options.check ?? false,
  );
}
