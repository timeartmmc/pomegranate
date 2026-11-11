import { fail, ownRecord } from './diagnostics.js';

type Node =
  | 'document'
  | 'info'
  | 'annotation'
  | 'tag'
  | 'server'
  | 'components'
  | 'pathItem'
  | 'operation'
  | 'parameter'
  | 'requestBody'
  | 'media'
  | 'response'
  | 'header'
  | 'schema'
  | 'discriminator'
  | 'example'
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
    securitySchemes: 'map:securityScheme',
  },
  pathItem: {
    get: 'operation',
    post: 'operation',
    put: 'operation',
    patch: 'operation',
    delete: 'operation',
    head: 'operation',
    options: 'operation',
    parameters: 'list:parameter',
    servers: 'list:server',
  },
  operation: {
    parameters: 'list:parameter',
    requestBody: 'requestBody',
    responses: 'responses',
    servers: 'list:server',
    externalDocs: 'annotation',
  },
  parameter: { schema: 'schema', examples: 'map:example' },
  requestBody: { content: 'content' },
  media: { schema: 'schema', examples: 'map:example' },
  response: { content: 'content', headers: 'map:header' },
  header: { schema: 'schema', examples: 'map:example' },
  schema: {
    properties: 'map:schema',
    items: 'schema',
    additionalProperties: 'schema',
    anyOf: 'list:schema',
    allOf: 'list:schema',
    oneOf: 'list:schema',
    discriminator: 'discriminator',
    externalDocs: 'annotation',
  },
  discriminator: {},
  example: {},
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

export function ignoreExtensions(
  document: unknown,
  names: ReadonlySet<string>,
): unknown {
  return walkDocument(document, undefined, names);
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
): unknown {
  return walkDocument(document, transform, undefined, readAccessors);
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
): unknown {
  const seen = new WeakMap<object, Map<Context, object>>();
  const pending: {
    source: object;
    target: object;
    context: Context;
    shape: Shape;
    location: string;
  }[] = [];
  function visit(input: unknown, context: Context, location: string): unknown {
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
        (Object.create(null) as object);
    contexts.set(context, target);
    pending.push({ source: input, target, context, shape: grammar, location });
    return target;
  }
  const result = visit(document, 'document', 'OpenAPI');
  let openApi30 = false;
  // Iteration and context-specific identity caching bound shared/cyclic input
  // graphs without a new recursion limit. The owning parsers still diagnose
  // malformed containers and unsupported schema structure.
  while (pending.length > 0) {
    const frame = pending.pop()!;
    const source =
      transform && frame.shape.fields
        ? transform(
            ownRecord(frame.source as Record<string, unknown>),
            frame.context,
            frame.location,
          )
        : frame.source;
    const descriptors = Object.getOwnPropertyDescriptors(source);
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
        names !== undefined &&
        frame.shape.keywords &&
        descriptor.enumerable &&
        key.startsWith('x-') &&
        // A concrete media type can itself start with x-. The slash makes it
        // a content declaration rather than an extension keyword.
        (frame.context !== 'content' || !key.includes('/')) &&
        key !== 'x-pom' &&
        key !== 'x-pom-policy'
      ) {
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
      let context: Context | undefined = frame.shape.entries;
      if (frame.shape.list && !/^(?:0|[1-9][0-9]*)$/.test(key)) continue;
      if (frame.shape.fields && Object.hasOwn(frame.shape.fields, key))
        context = frame.shape.fields[key];
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
          frame.context === 'header')
      )
        continue;
      if (
        reference &&
        frame.context === 'schema' &&
        ((key !== 'externalDocs' && key !== 'allOf') || openApi30)
      )
        continue;
      const value: unknown =
        'value' in descriptor ? descriptor.value : Reflect.get(source, key);
      const child = visit(
        value,
        context,
        frame.context === 'document' && key !== 'externalDocs' ? key : location,
      );
      descriptors[key] = {
        value: child,
        enumerable: descriptor.enumerable ?? false,
        configurable: descriptor.configurable ?? false,
        writable: 'writable' in descriptor ? descriptor.writable : true,
      };
    }
    Object.defineProperties(frame.target, descriptors);
  }
  return result;
}
