import {
  ContractError,
  ContractWorkError,
  createOwnRecord,
  atSource,
  fail,
  ownDescriptors,
  ownRecord,
} from './diagnostics.js';
import { openApiMethods } from './operations.js';

type Node =
  | 'document'
  | 'info'
  | 'annotation'
  | 'tag'
  | 'server'
  | 'components'
  | 'pathItem'
  | 'operation'
  | 'callback'
  | 'parameter'
  | 'requestBody'
  | 'media'
  | 'encoding'
  | 'response'
  | 'header'
  | 'schema'
  | 'discriminator'
  | 'example'
  | 'link'
  | 'securityScheme'
  | 'oauthFlows'
  | 'oauthFlow';
type Context =
  | Node
  | `map:${Node}`
  | `list:${Node}`
  | 'paths'
  | 'responses'
  | 'content';
type Fields = Readonly<Partial<Record<string, Context>>>;

export const referenceContexts: ReadonlySet<string> = new Set([
  'schema',
  'parameter',
  'response',
  'requestBody',
  'header',
  'example',
  'link',
  'securityScheme',
]);

// Map entries are names, not extension keywords. Only their values enter the
// object grammar. Opaque JSON annotations, discriminator mappings, security
// requirements and POM policy payloads deliberately have no traversal edge.
const children: Readonly<Record<Node, Fields>> = {
  document: {
    info: 'info',
    paths: 'paths',
    components: 'components',
    tags: 'list:tag',
    servers: 'list:server',
    externalDocs: 'annotation',
  },
  info: { license: 'annotation', contact: 'annotation' },
  annotation: {},
  tag: { externalDocs: 'annotation' },
  server: { variables: 'map:annotation' },
  components: {
    schemas: 'map:schema',
    parameters: 'map:parameter',
    responses: 'map:response',
    requestBodies: 'map:requestBody',
    headers: 'map:header',
    examples: 'map:example',
    links: 'map:link',
    securitySchemes: 'map:securityScheme',
  },
  pathItem: {
    ...Object.fromEntries(
      openApiMethods.map((method) => [method, 'operation' as const]),
    ),
    parameters: 'list:parameter',
    servers: 'list:server',
  },
  operation: {
    callbacks: 'map:callback',
    parameters: 'list:parameter',
    requestBody: 'requestBody',
    responses: 'responses',
    servers: 'list:server',
    externalDocs: 'annotation',
  },
  callback: {},
  parameter: { schema: 'schema', examples: 'map:example', content: 'content' },
  requestBody: { content: 'content' },
  media: {
    schema: 'schema',
    examples: 'map:example',
    encoding: 'map:encoding',
  },
  encoding: { headers: 'map:header' },
  response: { content: 'content', headers: 'map:header', links: 'map:link' },
  header: { schema: 'schema', examples: 'map:example', content: 'content' },
  schema: {
    properties: 'map:schema',
    items: 'schema',
    additionalProperties: 'schema',
    anyOf: 'list:schema',
    allOf: 'list:schema',
    oneOf: 'list:schema',
    discriminator: 'discriminator',
    externalDocs: 'annotation',
    xml: 'annotation',
  },
  discriminator: {},
  example: {},
  link: { server: 'server' },
  securityScheme: { flows: 'oauthFlows' },
  oauthFlows: {
    implicit: 'oauthFlow',
    password: 'oauthFlow',
    clientCredentials: 'oauthFlow',
    authorizationCode: 'oauthFlow',
  },
  // Scope map keys are application-defined identities, not extension keywords.
  oauthFlow: {},
};

type Shape = Readonly<{
  list: boolean;
  entries: Node | undefined;
  fields: Fields | undefined;
  keywords: boolean;
}>;

function shape(context: Context): Shape {
  // Callback expression keys name Path Items. Traverse them for exclusions and
  // audit attribution even though retained callbacks are not supported yet.
  if (context === 'callback')
    return {
      list: false,
      entries: 'pathItem',
      fields: children.callback,
      keywords: true,
    };
  if (context.startsWith('list:'))
    return {
      list: true,
      entries: context.slice(5) as Node,
      fields: undefined,
      keywords: false,
    };
  if (context.startsWith('map:'))
    return {
      list: false,
      entries: context.slice(4) as Node,
      fields: undefined,
      keywords: false,
    };
  // These containers use path/status/media-type keys, so x- names are metadata
  // rather than application-defined identifiers such as header/property names.
  if (context === 'paths')
    return {
      list: false,
      entries: 'pathItem',
      fields: undefined,
      keywords: true,
    };
  if (context === 'responses')
    return {
      list: false,
      entries: 'response',
      fields: undefined,
      keywords: true,
    };
  if (context === 'content')
    return { list: false, entries: 'media', fields: undefined, keywords: true };
  return {
    list: false,
    entries: undefined,
    fields: children[context as Node],
    keywords: true,
  };
}

// Pointer resolution and traversal share this grammar: annotation payloads and
// dictionary keys never acquire schema meaning merely because they look like it.
function extensionKey(grammar: Shape, context: Context, key: string): boolean {
  // x-* dictionary names remain data. A concrete media name can itself start
  // with x-; its slash distinguishes that declaration from opaque metadata.
  return (
    grammar.keywords &&
    key.startsWith('x-') &&
    (context !== 'content' || !key.includes('/'))
  );
}

function childContext(
  grammar: Shape,
  context: Context,
  key: string,
): Context | undefined {
  if (extensionKey(grammar, context, key)) return undefined;
  if (grammar.list && !/^(?:0|[1-9][0-9]*)$/.test(key)) return undefined;
  return grammar.fields && Object.hasOwn(grammar.fields, key)
    ? grammar.fields[key]
    : grammar.entries;
}

export function openApiContext(path: readonly string[]): string | undefined {
  let context: Context | undefined = 'document';
  for (const key of path) {
    if (context === undefined) return undefined;
    context = childContext(shape(context), context, key);
  }
  return context;
}

export function openApiLocation(path: readonly string[]): string {
  let context: Context | undefined = 'document';
  let location = 'OpenAPI';
  for (const key of path) {
    const grammar: Shape | undefined =
      context === undefined ? undefined : shape(context);
    location = grammar?.list
      ? `${location}[${key}]`
      : context === 'document' && key !== 'externalDocs'
        ? key
        : `${location}.${key}`;
    context =
      grammar && context !== undefined
        ? childContext(grammar, context, key)
        : undefined;
  }
  return location;
}

export type OpenApiRoot = Readonly<{
  context: 'document' | 'schema';
  path: readonly string[];
  openApi30?: boolean;
}>;

function sourceOwner(path: readonly string[]): readonly string[] {
  if (path[0] === 'components' && path.length >= 3) return path.slice(0, 3);
  if (path[0] !== 'paths' || path.length < 2) return [];
  return path.slice(
    0,
    openApiMethods.some((method) => method === path[2]) ? 3 : 2,
  );
}

export function ignoreExtensions(
  document: unknown,
  names: ReadonlySet<string>,
  root?: OpenApiRoot,
): unknown {
  return walkDocument(document, undefined, names, true, root);
}

// Share the object grammar with dialect lowering. Map keys and opaque annotation
// payloads must never be mistaken for OpenAPI keywords in either pass.
export function mapOpenApi(
  document: unknown,
  transform: (
    value: Record<string, unknown>,
    context: string,
    location: string,
  ) => Record<string, unknown>,
  readAccessors = true,
  root?: OpenApiRoot,
  // Collect contract errors per declaration instead of stopping at the first.
  // The returned copy is then incomplete and must be discarded by the caller.
  onError?: (error: ContractError) => void,
): unknown {
  return walkDocument(
    document,
    transform,
    undefined,
    readAccessors,
    root,
    onError,
  );
}

function walkDocument(
  document: unknown,
  transform?: (
    value: Record<string, unknown>,
    context: string,
    location: string,
  ) => Record<string, unknown>,
  names?: ReadonlySet<string>,
  readAccessors = true,
  root: OpenApiRoot = { context: 'document', path: [] },
  onError?: (error: ContractError) => void,
): unknown {
  const seen = new WeakMap<object, Map<Context, object>>();
  const pending: {
    source: object;
    target: object;
    context: Context;
    shape: Shape;
    location: string;
    path: readonly string[];
    depth: number;
    owner: readonly string[];
  }[] = [];
  function visit(
    input: unknown,
    context: Context,
    location: string,
    path: readonly string[],
    depth: number,
    owner: readonly string[],
  ): unknown {
    if (input === null || typeof input !== 'object') return input;
    const grammar = shape(context);
    const prototype = Object.getPrototypeOf(input) as object | null;
    if (
      grammar.list
        ? !Array.isArray(input)
        : Array.isArray(input) ||
          (prototype !== Object.prototype && prototype !== null)
    )
      return input;
    let contexts = seen.get(input);
    const known = contexts?.get(context);
    if (known) return known;
    if (!contexts) {
      contexts = new Map();
      seen.set(input, contexts);
    }
    const target: object = grammar.list
      ? (Object.setPrototypeOf([], prototype) as object)
      : // This is already the compiler's detached copy. Give records the own-only
        // view expected by record() so later passes do not copy descriptors again.
        createOwnRecord();
    contexts.set(context, target);
    pending.push({
      source: input,
      target,
      context,
      shape: grammar,
      location,
      path,
      depth,
      owner,
    });
    return target;
  }
  const result = visit(
    document,
    root.context,
    openApiLocation(root.path),
    root.path.slice(0, 3),
    root.path.length,
    root.context === 'schema' ? root.path : sourceOwner(root.path),
  );
  let openApi30 = root.openApi30 === true;
  // Iteration and context-specific identity caching bound shared/cyclic input
  // graphs without a new recursion limit. The owning parsers still diagnose
  // malformed containers and unsupported schema structure.
  const expand = (frame: (typeof pending)[number]): void =>
    atSource(frame.owner, () => {
      const source =
        transform && frame.shape.fields
          ? transform(
              ownRecord(frame.source as Record<string, unknown>),
              frame.context,
              frame.location,
            )
          : frame.source;
      // A list keeps its array descriptors. Every other node is a record, whose
      // own string keys are all declarations whatever their enumerability.
      const descriptors: PropertyDescriptorMap = frame.shape.list
        ? Object.getOwnPropertyDescriptors(source)
        : ownDescriptors(source);
      if (names !== undefined && frame.context === 'document') {
        const version: unknown = Object.hasOwn(source, 'openapi')
          ? Reflect.get(source, 'openapi')
          : undefined;
        openApi30 = typeof version === 'string' && version.startsWith('3.0.');
      }
      const reference = Object.hasOwn(frame.source, '$ref');
      for (const key of Object.keys(descriptors)) {
        const descriptor = descriptors[key]!;
        const location = frame.shape.list
          ? `${frame.location}[${key}]`
          : `${frame.location}.${key}`;
        if (
          extensionKey(frame.shape, frame.context, key) &&
          key !== 'x-pom' &&
          key !== 'x-pom-policy'
        ) {
          // Extension payloads are opaque to dependency and dialect walks.
          // Filtering still owns whether an extension may be removed.
          if (names === undefined) continue;
          // This flag declares path semantics, not documentation. Keep it visible
          // as an unsupported contract until multi-segment handling is defined.
          if (key === 'x-multi-segment')
            fail(
              location,
              'unsupported semantic extension; x-multi-segment affects path parameters and cannot be ignored with ignoreExtensions',
            );
          if (!names.has(key))
            fail(
              location,
              'unsupported keyword; list documentation-only extensions in ignoreExtensions to ignore them',
            );
          delete descriptors[key];
          continue;
        }
        // Array metadata can have numeric-looking own keys that are not array
        // indices (for example 4294967295). It is not another schema member.
        if (
          frame.shape.list &&
          Number(key) >= (frame.source as readonly unknown[]).length
        )
          continue;
        const context = childContext(frame.shape, frame.context, key);
        if (!context) continue;
        if (!readAccessors && !Object.hasOwn(descriptor, 'value')) continue;
        // Semantic siblings of Reference Objects remain the owning parser's
        // error. Schema refs in 3.1 also admit allOf, whose branches still need
        // extension filtering. In 3.0, annotation siblings such as externalDocs
        // are discarded before annotation validation, including their extensions.
        if (
          reference &&
          (frame.context === 'parameter' ||
            frame.context === 'response' ||
            frame.context === 'requestBody' ||
            frame.context === 'header' ||
            frame.context === 'callback')
        )
          continue;
        if (
          reference &&
          frame.context === 'schema' &&
          ((key !== 'externalDocs' && key !== 'xml' && key !== 'allOf') ||
            openApi30)
        )
          continue;
        const value: unknown =
          'value' in descriptor ? descriptor.value : Reflect.get(source, key);
        // Ordinary diagnostics need only the component or operation owner.
        // Deeper nodes share that bounded prefix; detached schema roots already
        // carry their full original target path as the fixed owner.
        const depth = frame.depth + 1;
        const childPath =
          root.context === 'document' && depth <= 3
            ? [...frame.path, key]
            : frame.path;
        const child = visit(
          value,
          context,
          frame.context === 'document' && key !== 'externalDocs'
            ? key
            : location,
          childPath,
          depth,
          root.context === 'document' && depth <= 3
            ? sourceOwner(childPath)
            : frame.owner,
        );
        descriptors[key] = {
          value: child,
          enumerable: descriptor.enumerable ?? false,
          configurable: descriptor.configurable ?? false,
          writable: 'writable' in descriptor ? descriptor.writable : true,
        };
      }
      Object.defineProperties(frame.target, descriptors);
    });
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (!onError) expand(frame);
    else
      try {
        expand(frame);
      } catch (error) {
        // Work limits end the walk: they do not belong to one declaration.
        if (
          !(error instanceof ContractError) ||
          error instanceof ContractWorkError
        )
          throw error;
        onError(error);
      }
  }
  return result;
}
