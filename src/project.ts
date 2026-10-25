import { readFile, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { buildDescriptor } from './descriptor.js';
import { fail, keys, record, text } from './diagnostics.js';
import { render } from './emit.js';
import { synchronizeOutputs } from './outputs.js';
import type { OutputResult } from './outputs.js';
import { selectClients, selectStandalone } from './projection.js';
import type { Descriptor } from './model.js';
import { parseSelection, selectionKeys } from './selection.js';
import type { CompileOptions } from './selection.js';
export type { CompileOptions } from './selection.js';

async function readJson(path: string): Promise<unknown> {
  const source = await readFile(path, 'utf8');
  try {
    return JSON.parse(source) as unknown;
  } catch {
    fail(path, 'invalid JSON');
  }
}

function renderSelection(
  descriptor: Descriptor,
  selection: Record<string, unknown>,
) {
  const parsed = parseSelection(selection);
  const standalone = selectStandalone(descriptor, parsed.standalone);
  const clients = selectClients(descriptor, parsed);
  return render(descriptor, clients, standalone);
}

export async function compile(
  document: unknown,
  options: CompileOptions,
): Promise<Readonly<Record<string, string>>> {
  const descriptor = buildDescriptor(document);
  const selection = record(options, 'compile options');
  keys(selection, selectionKeys, 'compile options');
  return renderSelection(descriptor, selection);
}

export async function runProject(
  configFile: string,
  options: Readonly<{ check?: boolean }> = {},
): Promise<OutputResult> {
  // A misspelled read-only option must never fall back to generation, including
  // for JavaScript callers that do not receive TypeScript's excess-key check.
  const execution = record(options, 'project options');
  keys(execution, ['check'], 'project options');
  const check = Object.hasOwn(execution, 'check') ? execution.check : false;
  if (typeof check !== 'boolean')
    fail('project options.check', 'expected a boolean');
  const configPath = await realpath(configFile);
  const config = record(await readJson(configPath), configPath);
  keys(config, ['version', 'openapi', 'output', ...selectionKeys], configPath);
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
  const files = await renderSelection(descriptor, config);
  return synchronizeOutputs(output, files, [configPath, input], check);
}
