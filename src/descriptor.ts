import {
  annotations,
  contractField,
  fail,
  keys,
  record,
  safeKey,
  stringArray,
  text,
  validHeaderName,
  wellFormedUnicode,
} from './diagnostics.js';
import type {
  ContractResponse,
  AuthTransport,
  Descriptor,
  Direction,
  SchemaTable,
  Operation,
  MultipartField,
  Parameter,
  PolicyVocabulary,
  ResponseHeader,
  Schema,
} from './model.js';
import {
  componentName,
  normalizeSchema,
  orderSchemas,
  resolveSchema,
  validateSchema,
  schemaValidation,
} from './schemas.js';
import {
  normalizeMemberships,
  normalizeOperationPolicy,
  normalizeVocabulary,
} from './policy.js';
import { normalizeSecurity, normalizeSecuritySchemes } from './security.js';
import { projectSchemas } from './directional.js';
import {
  deprecatedAnnotation,
  exampleAnnotations,
  exampleComponents,
  exampleKeys,
  infoAnnotations,
  externalDocsAnnotation,
  serverAnnotations,
} from './annotations.js';

const methods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;

type Validation = ReturnType<typeof schemaValidation>;

type SchemaContext = Readonly<{
  source: SchemaTable;
  projection: ReturnType<typeof projectSchemas>;
  sourceValidation: Validation;
  directionValidation: Readonly<Record<Direction, Validation>>;
}>;

type OperationContext = Readonly<{
  vocabulary: PolicyVocabulary;
  schemas: SchemaContext;
  examples: ReadonlySet<string>;
  parameterComponents: ReadonlyMap<string, Parameter>;
  bearerSchemes: ReadonlySet<string>;
  inheritedSecurity: AuthTransport;
  memberships: ReadonlyMap<string, readonly string[]> | undefined;
}>;

function normalizeFor(
  input: unknown,
  location: string,
  context: SchemaContext,
  direction: Direction,
  usage: Direction | 'multipart' = direction,
): Schema {
  const source = normalizeSchema(input, location);
  // Source validation stays complete before projection: an excluded property
  // cannot hide malformed declarations or unresolved references.
  validateSchema(
    source,
    context.source,
    location,
    'component',
    context.sourceValidation,
  );
  const schema = context.projection.schema(source, direction);
  validateSchema(
    schema,
    context.projection.schemas[direction],
    location,
    usage,
    context.directionValidation[direction],
  );
  return schema;
}

// Endpoint declarations must survive browser Fetch unchanged. These fields
// belong to the transport, including value-dependent method overrides and the
// User-Agent field that Chromium still filters. See Fetch §2.2.2.
const transportRequestHeaders = new Set([
  'accept',
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'authorization',
  'connection',
  'content-length',
  'content-type',
  'cookie',
  'cookie2',
  'date',
  'dnt',
  'expect',
  'host',
  'keep-alive',
  'origin',
  'permissions-policy',
  'proxy-authorization',
  'referer',
  'set-cookie',
  'set-cookie2',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'user-agent',
  'via',
  'x-http-method',
  'x-http-method-override',
  'x-method-override',
]);

function optionalBoolean(
  value: Record<string, unknown>,
  key: string,
  location: string,
): boolean {
  if (!Object.hasOwn(value, key)) return false;
  if (typeof value[key] !== 'boolean')
    fail(`${location}.${key}`, 'expected a boolean');
  return value[key];
}

function jsonSchema(
  input: unknown,
  location: string,
  examples: ReadonlySet<string>,
  context: SchemaContext,
): Schema {
  const content = record(input, location);
  keys(content, ['application/json'], location);
  if (!Object.hasOwn(content, 'application/json'))
    fail(location, 'expected exactly application/json');
  const media = record(
    content['application/json'],
    `${location}.application/json`,
  );
  keys(media, ['schema', ...exampleKeys], `${location}.application/json`);
  exampleAnnotations(media, `${location}.application/json`, examples);
  return normalizeFor(
    media.schema,
    `${location}.application/json.schema`,
    context,
    'response',
  );
}

function normalizeParameter(
  input: unknown,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  location: string,
): Parameter {
  const value = record(input, location);
  keys(
    value,
    [
      'name',
      'in',
      'required',
      'schema',
      'description',
      'style',
      'explode',
      'allowReserved',
      'deprecated',
      ...exampleKeys,
    ],
    location,
  );
  annotations(value, location);
  deprecatedAnnotation(value, location);
  exampleAnnotations(value, location, examples);
  const name = contractField(
    text(value.name, `${location}.name`),
    `${location}.name`,
  );
  const position = value.in;
  if (position !== 'path' && position !== 'query' && position !== 'header')
    fail(
      `${location}.in`,
      'only path, query and header parameters are supported',
    );
  if (position === 'query' && !wellFormedUnicode(name))
    fail(
      `${location}.name`,
      'query parameter names must contain well-formed Unicode',
    );
  const required = optionalBoolean(value, 'required', location);
  if (position === 'path' && !required)
    fail(`${location}.required`, 'path parameters must be required');
  if (
    Object.hasOwn(value, 'style') &&
    value.style !== (position === 'query' ? 'form' : 'simple')
  )
    fail(`${location}.style`, 'unsupported parameter serialization');
  if (Object.hasOwn(value, 'explode'))
    optionalBoolean(value, 'explode', location);
  if (
    Object.hasOwn(value, 'allowReserved') &&
    (position !== 'query' || value.allowReserved !== false)
  )
    fail(
      `${location}.allowReserved`,
      'only false on query parameters is supported',
    );
  const schema = normalizeFor(
    value.schema,
    `${location}.schema`,
    context,
    'request',
  );
  const schemas = context.projection.schemas.request;
  const resolved = resolveSchema(schema, schemas);
  const primitive = (candidate: Schema): boolean =>
    ['string', 'number', 'integer', 'boolean'].includes(
      resolveSchema(candidate, schemas).kind,
    );
  const nullable =
    resolved.kind === 'union' &&
    resolved.branches.length === 2 &&
    resolved.branches.some(
      (branch) => resolveSchema(branch, schemas).kind === 'null',
    );
  const nullableHeader =
    position === 'header' &&
    nullable &&
    resolved.branches.some(
      (branch) => resolveSchema(branch, schemas).kind === 'string',
    );
  const nullableQuery =
    position === 'query' && nullable && resolved.branches.some(primitive);
  const queryArray =
    position === 'query' &&
    resolved.kind === 'array' &&
    primitive(resolved.items);
  if (queryArray && value.explode === false)
    fail(
      `${location}.explode`,
      'query arrays require form serialization with explode true',
    );
  if (nullableHeader && required)
    fail(
      `${location}.required`,
      'nullable headers must be optional; null represents omission',
    );
  if (nullableQuery && required)
    fail(
      `${location}.required`,
      'nullable query parameters must be optional; null represents omission',
    );
  if (!primitive(resolved) && !nullableHeader && !nullableQuery && !queryArray)
    fail(
      `${location}.schema`,
      'parameters require primitive schemas, primitive query arrays, optional nullable primitive queries, or optional nullable string headers',
    );
  if (position === 'header') {
    if (!validHeaderName(name))
      fail(`${location}.name`, 'invalid HTTP header name');
    // The merged-header schema uses HTTP's case-insensitive names as keys.
    safeKey(name.toLowerCase(), `${location}.name`);
    if (
      transportRequestHeaders.has(name.toLowerCase()) ||
      /^(?:proxy|sec)-/i.test(name)
    )
      fail(`${location}.name`, 'transport-owned or reserved request header');
    if (resolved.kind !== 'string' && !nullableHeader)
      fail(`${location}.schema`, 'header parameters require string schemas');
  }
  return { name, in: position, required, schema };
}

function normalizeHeaders(
  input: unknown,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  location: string,
): readonly ResponseHeader[] {
  const headers = record(input, location);
  const seen = new Set<string>();
  return Object.keys(headers)
    .sort()
    .map((rawName) => {
      // Case folding can turn non-ASCII characters into valid ASCII names.
      if (!validHeaderName(rawName))
        fail(`${location}.${rawName}`, 'invalid HTTP header name');
      const name = rawName.toLowerCase();
      safeKey(name, `${location}.${rawName}`);
      if (seen.has(name))
        fail(`${location}.${rawName}`, 'duplicate case-insensitive header');
      if (name === 'content-type')
        fail(
          `${location}.${rawName}`,
          'content-type is determined by response content',
        );
      // Fetch hides these even on same-origin responses. Requiring one would
      // reject a successful response; optional declarations cannot validate it.
      if (name === 'set-cookie' || name === 'set-cookie2')
        fail(
          `${location}.${rawName}`,
          'transport-owned response header is unavailable to browser Fetch',
        );
      seen.add(name);
      const headerLocation = `${location}.${rawName}`;
      const header = record(headers[rawName], headerLocation);
      keys(
        header,
        [
          'description',
          'required',
          'schema',
          'style',
          'explode',
          'deprecated',
          ...exampleKeys,
        ],
        headerLocation,
      );
      annotations(header, headerLocation);
      deprecatedAnnotation(header, headerLocation);
      exampleAnnotations(header, headerLocation, examples);
      if (Object.hasOwn(header, 'style') && header.style !== 'simple')
        fail(`${headerLocation}.style`, 'only simple headers are supported');
      if (Object.hasOwn(header, 'explode'))
        optionalBoolean(header, 'explode', headerLocation);
      const schema = normalizeFor(
        header.schema,
        `${headerLocation}.schema`,
        context,
        'response',
      );
      if (
        resolveSchema(schema, context.projection.schemas.response).kind !==
        'string'
      )
        fail(
          `${headerLocation}.schema`,
          'response headers require string schemas',
        );
      return {
        name,
        required: optionalBoolean(header, 'required', headerLocation),
        schema,
      };
    });
}

function pathTemplate(path: string, location: string): void {
  if (!path.startsWith('/') || path.startsWith('//'))
    fail(
      location,
      'expected a root-relative path beginning with a single slash',
    );
  for (const segment of path.slice(1).split('/')) {
    if (segment === '.' || segment === '..')
      fail(location, 'dot segments are unsupported');
    if (/^\{[^{}]*\}$/.test(segment)) {
      if (!/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment))
        fail(
          location,
          'path placeholder names must match [A-Za-z_][A-Za-z0-9_]*',
        );
      continue;
    }
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@-]*$/.test(segment))
      fail(
        location,
        'path placeholders must occupy a complete segment; encoded, query, fragment and non-ASCII path literals are unsupported',
      );
  }
}

function multipartFields(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
): readonly MultipartField[] {
  const object = resolveSchema(schema, schemas);
  if (object.kind !== 'object')
    fail(location, 'multipart requires a fixed object of text and file fields');
  return Object.entries(object.properties).map(([name, field]) => {
    if (!validHeaderName(name))
      fail(
        `${location}.properties.${name}`,
        'multipart field names must be HTTP tokens',
      );
    const resolved = resolveSchema(field, schemas);
    const multiple =
      resolved.kind === 'array' &&
      resolveSchema(resolved.items, schemas).kind === 'binary';
    if (resolved.kind !== 'string' && resolved.kind !== 'binary' && !multiple)
      fail(
        `${location}.properties.${name}`,
        'multipart fields require strings, files or arrays of files',
      );
    return {
      name,
      kind: resolved.kind === 'string' ? 'text' : 'file',
      multiple,
      required: object.required.includes(name),
    };
  });
}

function uniqueParameters(
  parameters: readonly Parameter[],
  location: string,
): void {
  const seen = new Set<string>();
  for (const parameter of parameters) {
    const key = `${parameter.in}:${parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name}`;
    if (seen.has(key)) fail(location, `duplicate parameter ${key}`);
    seen.add(key);
  }
}

function parameterComponentName(name: string, location: string): string {
  if (name.length === 0 || /[^A-Za-z0-9._-]/.test(name))
    fail(location, 'component parameter names must match [A-Za-z0-9._-]+');
  return safeKey(name, location);
}

function parameterReference(
  value: Record<string, unknown>,
  location: string,
): string | undefined {
  if (!Object.hasOwn(value, '$ref')) return undefined;
  // Reference Objects carry documentation, not parameter overrides. Resolve
  // them before name/location identity checks; never merge semantic siblings.
  keys(value, ['$ref', 'summary', 'description'], location);
  annotations(value, location);
  const prefix = '#/components/parameters/';
  if (typeof value.$ref !== 'string' || !value.$ref.startsWith(prefix))
    fail(
      `${location}.$ref`,
      'only local component parameter references are supported',
    );
  return parameterComponentName(
    value.$ref.slice(prefix.length),
    `${location}.$ref`,
  );
}

function normalizeParameterComponents(
  input: unknown,
  context: SchemaContext,
  examples: ReadonlySet<string>,
): ReadonlyMap<string, Parameter> {
  const location = 'components.parameters';
  const components = record(input, location);
  const parameters = new Map<string, Parameter>();
  const references = new Map<string, string>();
  for (const name of Object.keys(components).sort()) {
    const path = `${location}.${name}`;
    parameterComponentName(name, path);
    const value = record(components[name], path);
    const target = parameterReference(value, path);
    if (target === undefined) {
      // Unused declarations must satisfy request parameter rules too, including
      // directional projection, schema constraints and serialization limits.
      parameters.set(name, normalizeParameter(value, context, examples, path));
    } else {
      if (!Object.hasOwn(components, target))
        fail(`${path}.$ref`, `unresolved parameter reference ${target}`);
      references.set(name, target);
    }
  }
  for (const name of references.keys()) {
    const pending = new Set<string>();
    let current = name;
    // Alias depth is independent of schema nesting. Cache every visited alias
    // so long chains and shared tails take linear work without recursion.
    while (!parameters.has(current)) {
      if (pending.has(current))
        fail(`${location}.${current}.$ref`, 'cyclic parameter reference');
      pending.add(current);
      current = references.get(current)!;
    }
    const parameter = parameters.get(current)!;
    for (const alias of pending) parameters.set(alias, parameter);
  }
  return parameters;
}

function parameterList(
  input: unknown,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  components: ReadonlyMap<string, Parameter>,
  location: string,
): readonly Parameter[] {
  if (!Array.isArray(input)) fail(location, 'expected an array');
  const parameters = Array.from(input, (input, index) => {
    const path = `${location}[${index}]`;
    const value = record(input, path);
    const target = parameterReference(value, path);
    if (target === undefined)
      return normalizeParameter(value, context, examples, path);
    const parameter = components.get(target);
    if (!parameter)
      fail(`${path}.$ref`, `unresolved parameter reference ${target}`);
    return parameter;
  });
  uniqueParameters(parameters, location);
  return parameters;
}

function operationParameters(
  value: Record<string, unknown>,
  inherited: readonly Parameter[],
  context: SchemaContext,
  examples: ReadonlySet<string>,
  components: ReadonlyMap<string, Parameter>,
  path: string,
  location: string,
): readonly Parameter[] {
  const own = parameterList(
    Object.hasOwn(value, 'parameters') ? value.parameters : [],
    context,
    examples,
    components,
    `${location}.parameters`,
  );
  // Validate both declaration lists before merging so an override cannot hide
  // an unsupported contract. OAS 3.1 overrides use case-sensitive name/location
  // identity; differently cased headers still collide on the wire.
  const key = (parameter: Parameter): string =>
    `${parameter.in}:${parameter.name}`;
  const merged = new Map(
    inherited.map((parameter) => [key(parameter), parameter]),
  );
  for (const parameter of own) merged.set(key(parameter), parameter);
  const parameters = [...merged.values()];
  uniqueParameters(parameters, `${location}.parameters`);
  const placeholders = [...path.matchAll(/\{([^}]+)\}/g)].map(
    (match) => match[1]!,
  );
  if (new Set(placeholders).size !== placeholders.length)
    fail(location, 'repeated path placeholders are unsupported');
  const declaredPath = parameters
    .filter((parameter) => parameter.in === 'path')
    .map((parameter) => parameter.name);
  if (
    placeholders.length !== declaredPath.length ||
    placeholders.some((name) => !declaredPath.includes(name))
  )
    fail(
      `${location}.parameters`,
      'path placeholders and path parameters must match exactly',
    );
  return parameters;
}

function requestBody(
  value: Record<string, unknown>,
  method: (typeof methods)[number],
  context: SchemaContext,
  examples: ReadonlySet<string>,
  location: string,
): Operation['body'] {
  let body: Operation['body'] = { kind: 'none' };
  if (Object.hasOwn(value, 'requestBody')) {
    if (method === 'get' || method === 'head')
      fail(
        `${location}.requestBody`,
        `${method.toUpperCase()} bodies are unsupported`,
      );
    const request = record(value.requestBody, `${location}.requestBody`);
    keys(
      request,
      ['description', 'required', 'content'],
      `${location}.requestBody`,
    );
    annotations(request, `${location}.requestBody`);
    const required = optionalBoolean(
      request,
      'required',
      `${location}.requestBody`,
    );
    const contentLocation = `${location}.requestBody.content`;
    const content = record(request.content, contentLocation);
    keys(content, ['application/json', 'multipart/form-data'], contentLocation);
    const mediaType = Object.keys(content)[0];
    if (Object.keys(content).length !== 1 || !mediaType)
      fail(
        contentLocation,
        'expected exactly one JSON or multipart media type',
      );
    const media = record(content[mediaType], `${contentLocation}.${mediaType}`);
    keys(media, ['schema', ...exampleKeys], `${contentLocation}.${mediaType}`);
    exampleAnnotations(media, `${contentLocation}.${mediaType}`, examples);
    const schemaLocation = `${contentLocation}.${mediaType}.schema`;
    const multipart = mediaType === 'multipart/form-data';
    if (multipart && !required)
      fail(
        `${location}.requestBody.required`,
        'optional multipart request bodies are unsupported',
      );
    const schema = normalizeFor(
      media.schema,
      schemaLocation,
      context,
      'request',
      multipart ? 'multipart' : 'request',
    );
    body = multipart
      ? {
          kind: 'multipart',
          schema,
          fields: multipartFields(
            schema,
            context.projection.schemas.request,
            schemaLocation,
          ),
        }
      : { kind: 'json', schema, required };
  }
  return body;
}

function operationResponses(
  value: Record<string, unknown>,
  method: (typeof methods)[number],
  context: SchemaContext,
  examples: ReadonlySet<string>,
  location: string,
): readonly ContractResponse[] {
  const rawResponses = record(value.responses, `${location}.responses`);
  const responses: ContractResponse[] = Object.keys(rawResponses)
    .sort()
    .map((statusText) => {
      if (!/^[2-5][0-9]{2}$/.test(statusText))
        fail(
          `${location}.responses.${statusText}`,
          'only exact numeric final HTTP statuses 200–599 are supported',
        );
      const status = Number(statusText);
      const responseLocation = `${location}.responses.${statusText}`;
      const response = record(rawResponses[statusText], responseLocation);
      keys(response, ['description', 'content', 'headers'], responseLocation);
      if (typeof response.description !== 'string')
        fail(
          `${responseLocation}.description`,
          'expected a response description',
        );
      let responseBody: ContractResponse['body'] = { kind: 'none' };
      if (Object.hasOwn(response, 'content')) {
        if (method === 'head' || [204, 205, 304].includes(status))
          fail(
            `${responseLocation}.content`,
            'this HTTP method/status cannot carry a body',
          );
        const schema = jsonSchema(
          response.content,
          `${responseLocation}.content`,
          examples,
          context,
        );
        responseBody = { kind: 'json', schema };
      }
      const headers = Object.hasOwn(response, 'headers')
        ? normalizeHeaders(
            response.headers,
            context,
            examples,
            `${responseLocation}.headers`,
          )
        : [];
      return { status, body: responseBody, headers };
    });
  if (!responses.some((response) => response.status < 300))
    fail(`${location}.responses`, 'at least one 2xx response is required');
  return responses;
}

function normalizeOperation(
  input: unknown,
  method: (typeof methods)[number],
  path: string,
  inheritedParameters: readonly Parameter[],
  context: OperationContext,
): Operation {
  const {
    vocabulary,
    schemas,
    examples,
    bearerSchemes,
    inheritedSecurity,
    memberships,
  } = context;
  const location = `paths.${path}.${method}`;
  const value = record(input, location);
  keys(
    value,
    [
      'operationId',
      'summary',
      'description',
      'tags',
      'parameters',
      'requestBody',
      'responses',
      'security',
      'x-pom',
      'deprecated',
      'externalDocs',
    ],
    location,
  );
  annotations(value, location);
  externalDocsAnnotation(value, location);
  deprecatedAnnotation(value, location);
  // Presence matters: [] and [{}] deliberately clear a document bearer
  // requirement; absence inherits it. Do not merge these alternatives.
  const transport = Object.hasOwn(value, 'security')
    ? normalizeSecurity(value.security, bearerSchemes, `${location}.security`)
    : inheritedSecurity;
  const id = safeKey(
    text(value.operationId, `${location}.operationId`),
    `${location}.operationId`,
  );
  // Operation IDs are public, case-sensitive strings, not TypeScript symbols.
  // The emitter encodes private names without changing keys or cache identity.
  const metadata = normalizeOperationPolicy(
    Object.hasOwn(value, 'x-pom') ? value['x-pom'] : {},
    vocabulary,
    transport,
    `${location}.x-pom`,
    memberships === undefined ? undefined : (memberships.get(id) ?? []),
  );
  if (
    Object.hasOwn(value, 'tags') &&
    (!stringArray(value.tags) || value.tags.some((tag) => tag.length === 0))
  )
    fail(
      `${location}.tags`,
      'expected an array of nonempty documentation tags',
    );
  const parameters = operationParameters(
    value,
    inheritedParameters,
    schemas,
    examples,
    context.parameterComponents,
    path,
    location,
  );
  const body = requestBody(value, method, schemas, examples, location);
  const responses = operationResponses(
    value,
    method,
    schemas,
    examples,
    location,
  );
  return {
    id,
    method: method.toUpperCase() as Operation['method'],
    path,
    security: { transport },
    policy: metadata.policy,
    surfaces: metadata.surfaces,
    parameters,
    body,
    responses,
  };
}

export function buildDescriptor(
  input: unknown,
  membership: { surfaces?: unknown } = {},
): Descriptor {
  const value = record(input, 'OpenAPI');
  keys(
    value,
    [
      'openapi',
      'info',
      'paths',
      'components',
      'tags',
      'security',
      'x-pom-policy',
      'servers',
      'externalDocs',
    ],
    'OpenAPI',
  );
  // OAS 3.1 patch releases clarify the same feature set. Match the whole value
  // so malformed versions, prereleases and trailing line breaks cannot pass.
  if (
    typeof value.openapi !== 'string' ||
    /^3\.1\.(?:0|[1-9][0-9]*)$/.exec(value.openapi)?.[0] !== value.openapi
  )
    fail('openapi', 'expected an OpenAPI 3.1.x version');
  const info = record(value.info, 'info');
  keys(
    info,
    [
      'title',
      'version',
      'description',
      'summary',
      'license',
      'contact',
      'termsOfService',
    ],
    'info',
  );
  text(info.title, 'info.title');
  text(info.version, 'info.version');
  annotations(info, 'info');
  infoAnnotations(info);
  externalDocsAnnotation(value, 'OpenAPI');
  serverAnnotations(value);
  if (Object.hasOwn(value, 'tags')) {
    if (!Array.isArray(value.tags)) fail('tags', 'expected an array');
    for (const [index, rawTag] of value.tags.entries()) {
      const tag = record(rawTag, `tags[${index}]`);
      keys(tag, ['name', 'description', 'externalDocs'], `tags[${index}]`);
      text(tag.name, `tags[${index}].name`);
      annotations(tag, `tags[${index}]`);
      externalDocsAnnotation(tag, `tags[${index}]`);
    }
  }
  let vocabulary = normalizeVocabulary(
    Object.hasOwn(value, 'x-pom-policy')
      ? value['x-pom-policy']
      : { version: 3 },
  );
  let memberships: Map<string, string[]> | undefined;
  const configured = Object.hasOwn(membership, 'surfaces')
    ? normalizeMemberships(membership.surfaces)
    : undefined;
  if (configured !== undefined) {
    if (
      Object.hasOwn(value, 'x-pom-policy') &&
      Object.hasOwn(record(value['x-pom-policy'], 'x-pom-policy'), 'surfaces')
    )
      fail(
        'x-pom-policy.surfaces',
        'cannot combine inline and configured surface membership',
      );
    vocabulary = { ...vocabulary, surfaces: Object.keys(configured) };
    memberships = new Map();
    for (const [surface, ids] of Object.entries(configured)) {
      for (const id of ids) {
        const names = memberships.get(id) ?? [];
        names.push(surface);
        memberships.set(id, names);
      }
    }
  }
  const components = Object.hasOwn(value, 'components')
    ? record(value.components, 'components')
    : {};
  keys(
    components,
    ['schemas', 'securitySchemes', 'examples', 'parameters'],
    'components',
  );
  const examples = exampleComponents(
    Object.hasOwn(components, 'examples') ? components.examples : {},
  );
  const bearerSchemes = normalizeSecuritySchemes(
    Object.hasOwn(components, 'securitySchemes')
      ? components.securitySchemes
      : {},
  );
  const inheritedSecurity = Object.hasOwn(value, 'security')
    ? normalizeSecurity(value.security, bearerSchemes, 'security')
    : 'none';
  const rawSchemas = Object.hasOwn(components, 'schemas')
    ? record(components.schemas, 'components.schemas')
    : {};
  const schemas = Object.fromEntries(
    Object.keys(rawSchemas)
      .sort()
      .map((name) => [
        componentName(name, `components.schemas.${name}`),
        normalizeSchema(rawSchemas[name], `components.schemas.${name}`),
      ]),
  );
  const schemaOrder = orderSchemas(schemas);
  // Share traversal work only within this descriptor. The cache separates
  // usage checks so request defaults and multipart values cannot weaken responses.
  const validation = schemaValidation();
  for (const name of schemaOrder)
    validateSchema(
      schemas[name]!,
      schemas,
      `components.schemas.${name}`,
      'component',
      validation,
    );
  const context: SchemaContext = {
    source: schemas,
    projection: projectSchemas(schemas),
    sourceValidation: validation,
    directionValidation: {
      request: schemaValidation(),
      response: schemaValidation(),
    },
  };
  const parameterComponents = normalizeParameterComponents(
    Object.hasOwn(components, 'parameters') ? components.parameters : {},
    context,
    examples,
  );
  const operationContext: OperationContext = {
    vocabulary,
    schemas: context,
    examples,
    parameterComponents,
    bearerSchemes,
    inheritedSecurity,
    memberships,
  };
  const paths = record(value.paths, 'paths');
  const operations: Operation[] = [];
  for (const path of Object.keys(paths).sort()) {
    pathTemplate(path, `paths.${path}`);
    const pathItem = record(paths[path], `paths.${path}`);
    keys(
      pathItem,
      [...methods, 'summary', 'description', 'parameters'],
      `paths.${path}`,
    );
    annotations(pathItem, `paths.${path}`);
    if (!methods.some((method) => Object.hasOwn(pathItem, method)))
      fail(`paths.${path}`, 'expected at least one supported operation');
    const inheritedParameters = parameterList(
      Object.hasOwn(pathItem, 'parameters') ? pathItem.parameters : [],
      context,
      examples,
      parameterComponents,
      `paths.${path}.parameters`,
    );
    for (const method of methods)
      if (Object.hasOwn(pathItem, method))
        operations.push(
          normalizeOperation(
            pathItem[method],
            method,
            path,
            inheritedParameters,
            operationContext,
          ),
        );
  }
  const ids = new Map<string, string>();
  for (const operation of operations) {
    const location = `paths.${operation.path}.${operation.method.toLowerCase()}.operationId`;
    if (ids.has(operation.id))
      fail(
        location,
        `duplicate operation identifier ${JSON.stringify(operation.id)}; first declared at ${ids.get(operation.id)!}`,
      );
    ids.set(operation.id, location);
  }
  for (const [surface, configuredIds] of Object.entries(configured ?? {})) {
    for (const id of configuredIds) {
      if (!ids.has(id))
        fail(
          `surfaces.${surface}`,
          `unknown operation identifier ${JSON.stringify(id)}`,
        );
    }
  }
  return {
    policy: vocabulary,
    schemas: context.projection.schemas,
    schemaOrder,
    operations: operations.sort((left, right) =>
      left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
    ),
  };
}
