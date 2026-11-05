import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { buildDescriptor, openApiDocument } from './descriptor.js';
import { fail, keys, record, text } from './diagnostics.js';
import { render } from './emit.js';
import { ignoreExtensions } from './extensions.js';
import { parseJson } from './json.js';
import { synchronizeOutputs } from './outputs.js';
import type { OutputResult } from './outputs.js';
import { selectClients, selectStandalone } from './projection.js';
import type { Descriptor } from './model.js';
import {
  parseIgnoredExtensions,
  parseSelection,
  selectionKeys,
} from './selection.js';
import type { CompileOptions } from './selection.js';
import { parseYaml } from './yaml.js';
export type { CompileOptions } from './selection.js';

const maximumInputBytes = 32 * 1024 * 1024;

async function readText(path: string): Promise<string> {
  // NONBLOCK prevents opening a FIFO from waiting for a writer. Inspect the
  // opened descriptor so replacing a path cannot bypass the regular-file check.
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes: Buffer;
  try {
    const metadata = await file.stat();
    if (!metadata.isFile()) fail(path, 'input must be a regular file');
    const tooLarge = () => fail(path, 'input exceeds the 32 MiB file limit');
    if (metadata.size > maximumInputBytes) tooLarge();
    const chunks: Buffer[] = [];
    let length = 0;
    while (true) {
      // Read at most one extra byte, including if a regular file grows after
      // stat. readFile() would allocate until EOF before a limit could run.
      const chunk = Buffer.allocUnsafe(
        Math.min(64 * 1024, maximumInputBytes - length + 1),
      );
      const { bytesRead } = await file.read(chunk);
      if (bytesRead === 0) break;
      length += bytesRead;
      if (length > maximumInputBytes) tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    bytes = Buffer.concat(chunks, length);
  } finally {
    await file.close();
  }
  // Buffer decoding would replace malformed bytes, changing contract values or
  // configured paths. Validate first and retain BOMs for the parser's positions.
  if (!isUtf8(bytes)) fail(path, 'invalid UTF-8');
  return bytes.toString('utf8');
}

async function readJson(path: string): Promise<unknown> {
  return parseJson(await readText(path), path);
}

async function readOpenApi(path: string): Promise<unknown> {
  if (['.yaml', '.yml'].includes(extname(path).toLowerCase()))
    return parseYaml(await readText(path), path);
  return readJson(path);
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

function describeInput(
  document: unknown,
  selection: Record<string, unknown>,
): Descriptor {
  return buildDescriptor(
    ignoreExtensions(
      openApiDocument(document),
      parseIgnoredExtensions(selection.ignoreExtensions),
    ),
    {
      ...(Object.hasOwn(selection, 'surfaces')
        ? { surfaces: selection.surfaces }
        : {}),
      ...(Object.hasOwn(selection, 'formats')
        ? { formats: selection.formats }
        : {}),
    },
  );
}

export async function compile(
  document: unknown,
  options: CompileOptions,
): Promise<Readonly<Record<string, string>>> {
  const selection = record(options, 'compile options');
  keys(selection, selectionKeys, 'compile options');
  const descriptor = describeInput(document, selection);
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
  const document = await readOpenApi(input);
  const descriptor = describeInput(document, config);
  const files = await renderSelection(descriptor, config);
  return synchronizeOutputs(output, files, [configPath, input], check);
}
