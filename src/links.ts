import {
  componentReference,
  normalizeComponents,
} from './component-references.js';
import {
  fail,
  keys,
  record,
  stringFields,
  text,
  validComponentName,
} from './diagnostics.js';
import { jsonAnnotation, serverObject } from './annotations.js';

// Links are descriptive relationships, not generated calls. Check their shape
// and local component references without evaluating expressions or resolving
// operation targets; external operationRef URLs remain unfetched metadata.
function linkObject(link: Record<string, unknown>, location: string): void {
  keys(
    link,
    [
      'operationRef',
      'operationId',
      'parameters',
      'requestBody',
      'description',
      'server',
    ],
    location,
  );
  const hasRef = Object.hasOwn(link, 'operationRef');
  if (hasRef === Object.hasOwn(link, 'operationId'))
    fail(
      location,
      'a link requires exactly one of operationId or operationRef',
    );
  const target = hasRef ? 'operationRef' : 'operationId';
  text(link[target], `${location}.${target}`);
  stringFields(link, ['description'], location);
  if (Object.hasOwn(link, 'parameters')) {
    const parameters = record(link.parameters, `${location}.parameters`);
    for (const name of Object.keys(parameters))
      text(name, `${location}.parameters`);
    jsonAnnotation(parameters, `${location}.parameters`);
  }
  if (Object.hasOwn(link, 'requestBody'))
    jsonAnnotation(link.requestBody, `${location}.requestBody`);
  if (Object.hasOwn(link, 'server'))
    serverObject(link.server, `${location}.server`);
}

export function linkComponents(input: unknown): ReadonlySet<string> {
  return new Set(normalizeComponents(input, 'links', linkObject).keys());
}

export function responseLinks(
  input: unknown,
  location: string,
  names: ReadonlySet<string>,
): void {
  const links = record(input, location);
  for (const name of Object.keys(links).sort()) {
    const path = `${location}.${name}`;
    if (!validComponentName(name))
      fail(path, 'link names must match [A-Za-z0-9._-]+');
    const link = record(links[name], path);
    const target = componentReference(link, 'links', path);
    if (target === undefined) linkObject(link, path);
    else if (!names.has(target))
      fail(`${path}.$ref`, `unresolved link reference ${target}`);
  }
}
