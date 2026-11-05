import {
  componentReference,
  normalizeComponents,
} from './component-references.js';
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
  RegisteredStringFormat,
} from './model.js';
import {
  componentName,
  normalizeSchema,
  normalizeFormats,
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
import { normalizeOpenApi30 } from './openapi30.js';
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
type ResponseDefinition = Omit<ContractResponse, 'status'>;
type HeaderDefinition = Omit<ResponseHeader, 'name'>;
type RequestBodyDefinition = Exclude<Operation['body'], { kind: 'none' }>;

type SchemaContext = Readonly<{
  formats: Readonly<Record<string, RegisteredStringFormat>>;
  source: SchemaTable;
  projection: ReturnType<typeof projectSchemas>;
  sourceValidation: Validation;
  directionValidation: Readonly<Record<Direction, Validation>>;
}>;

type OperationContext = Readonly<{
  openApi30: boolean;
  vocabulary: PolicyVocabulary;
  schemas: SchemaContext;
  examples: ReadonlySet<string>;
  parameterComponents: ReadonlyMap<string, Parameter>;
  responseComponents: ReadonlyMap<string, ResponseDefinition>;
  requestBodyComponents: ReadonlyMap<string, RequestBodyDefinition>;
  headerComponents: ReadonlyMap<string, HeaderDefinition>;
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
  const source = normalizeSchema(input, location, 1, context.formats);
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

type ContentDefinition = {
  kind: 'json' | 'text' | 'multipart';
  contentType: string;
  schema: Schema;
  fields?: readonly MultipartField[];
};

function contentDefinitions(
  input: unknown,
  location: string,
  examples: ReadonlySet<string>,
  context: SchemaContext,
  direction: Direction,
): readonly ContentDefinition[] {
  const content = record(input, location);
  const seen = new Set<string>();
  // Validate every declaration before request selection or response dispatch.
  const candidates = Object.keys(content)
    .sort()
    .map((name): ContentDefinition => {
      const path = `${location}.${name}`;
      const contentType = name.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(
          name,
        ) ||
        contentType.includes('*')
      )
        fail(
          path,
          'expected a concrete media type without parameters or wildcards',
        );
      if (seen.has(contentType))
        fail(path, 'duplicate case-insensitive media type');
      seen.add(contentType);
      const subtype = contentType.slice(contentType.indexOf('/') + 1);
      const kind =
        contentType === 'application/json' ||
        (subtype.length > 5 && subtype.endsWith('+json'))
          ? 'json'
          : contentType === 'text/plain'
            ? 'text'
            : direction === 'request' && contentType === 'multipart/form-data'
              ? 'multipart'
              : undefined;
      if (kind === undefined)
        fail(
          path,
          'unsupported keyword; supported media types are application/json, concrete +json types, text/plain and multipart requests',
        );
      const media = record(content[name], path);
      keys(media, ['schema', ...exampleKeys], path);
      exampleAnnotations(media, path, examples);
      const schemaLocation = `${path}.schema`;
      const schema = normalizeFor(
        media.schema,
        schemaLocation,
        context,
        direction,
        kind === 'multipart' ? 'multipart' : direction,
      );
      if (
        kind === 'text' &&
        resolveSchema(schema, context.projection.schemas[direction]).kind !==
          'string'
      )
        fail(schemaLocation, 'text/plain requires a nonnullable string schema');
      return {
        kind,
        contentType,
        schema,
        ...(kind === 'multipart'
          ? {
              fields: multipartFields(
                schema,
                context.projection.schemas.request,
                schemaLocation,
              ),
            }
          : {}),
      };
    });
  if (candidates.length === 0)
    fail(location, 'expected at least one supported media type');
  return candidates;
}

function preferredContent(
  candidates: readonly ContentDefinition[],
): ContentDefinition {
  const rank = (value: ContentDefinition) =>
    value.contentType === 'application/json'
      ? 0
      : value.kind === 'json'
        ? 1
        : value.kind === 'text'
          ? 2
          : 3;
  return [...candidates].sort(
    (left, right) =>
      rank(left) - rank(right) ||
      (left.contentType < right.contentType
        ? -1
        : left.contentType > right.contentType
          ? 1
          : 0),
  )[0]!;
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
  return {
    name,
    in: position,
    required,
    schema,
    ...(queryArray && value.explode === false
      ? { explode: false as const }
      : {}),
  };
}

function normalizeHeader(
  header: Record<string, unknown>,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  location: string,
): HeaderDefinition {
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
    location,
  );
  annotations(header, location);
  deprecatedAnnotation(header, location);
  exampleAnnotations(header, location, examples);
  if (Object.hasOwn(header, 'style') && header.style !== 'simple')
    fail(`${location}.style`, 'only simple headers are supported');
  if (Object.hasOwn(header, 'explode'))
    optionalBoolean(header, 'explode', location);
  const schema = normalizeFor(
    header.schema,
    `${location}.schema`,
    context,
    'response',
  );
  if (
    resolveSchema(schema, context.projection.schemas.response).kind !== 'string'
  )
    fail(`${location}.schema`, 'response headers require string schemas');
  return { required: optionalBoolean(header, 'required', location), schema };
}

function normalizeHeaders(
  input: unknown,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  components: ReadonlyMap<string, HeaderDefinition>,
  location: string,
): readonly ResponseHeader[] {
  const headers = record(input, location);
  const seen = new Set<string>();
  return Object.keys(headers)
    .sort()
    .map((rawName) => {
      // A reusable Header Object has no wire name. Check the binding here even
      // when its schema and requiredness came from a shared component.
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
      const value = record(headers[rawName], headerLocation);
      const target = componentReference(value, 'header', headerLocation);
      const header =
        target === undefined
          ? normalizeHeader(value, context, examples, headerLocation)
          : components.get(target);
      if (!header)
        fail(`${headerLocation}.$ref`, `unresolved header reference ${target}`);
      return { name, ...header };
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
  let bounded =
    object.minProperties !== undefined || object.maxProperties !== undefined;
  for (let target = schema; !bounded && target.kind === 'ref';) {
    bounded =
      target.constraints.minProperties !== undefined ||
      target.constraints.maxProperties !== undefined;
    target = schemas[target.name]!;
  }
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
    const required = object.required.includes(name);
    if (bounded && multiple && !required) {
      let nonempty = (resolved.minItems ?? 0) > 0;
      for (let target = field; !nonempty && target.kind === 'ref';) {
        nonempty = (target.constraints.minItems ?? 0) > 0;
        target = schemas[target.name]!;
      }
      // An optional empty file array emits no multipart field. Its presence
      // cannot participate in property counts; require a representable value
      // when present, with undefined/omission still meaning no field.
      if (!nonempty)
        fail(
          `${location}.properties.${name}`,
          'multipart property-count bounds require optional file arrays to declare minItems >= 1',
        );
    }
    return {
      name,
      kind: resolved.kind === 'string' ? 'text' : 'file',
      multiple,
      required,
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
    const target = componentReference(value, 'parameter', path);
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

function normalizeRequestBody(
  request: Record<string, unknown>,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  location: string,
): RequestBodyDefinition {
  keys(request, ['description', 'required', 'content'], location);
  annotations(request, location);
  const required = optionalBoolean(request, 'required', location);
  const selected = preferredContent(
    contentDefinitions(
      request.content,
      `${location}.content`,
      examples,
      context,
      'request',
    ),
  );
  // Multipart requiredness constrains the generated request, not alternatives
  // that have already been validated but were not selected.
  if (selected.kind === 'multipart' && !required)
    fail(
      `${location}.required`,
      'optional multipart request bodies are unsupported',
    );
  return selected.kind === 'multipart'
    ? {
        kind: 'multipart',
        schema: selected.schema,
        fields: selected.fields!,
      }
    : {
        kind: selected.kind,
        contentType: selected.contentType,
        schema: selected.schema,
        required,
      };
}

function requestBody(
  value: Record<string, unknown>,
  method: (typeof methods)[number],
  context: SchemaContext,
  examples: ReadonlySet<string>,
  components: ReadonlyMap<string, RequestBodyDefinition>,
  location: string,
): Operation['body'] {
  if (!Object.hasOwn(value, 'requestBody')) return { kind: 'none' };
  // Requiredness and media validation belong to the definition. Whether a body
  // is allowed belongs to each operation, including uses through aliases.
  const bodyLocation = `${location}.requestBody`;
  if (method === 'get' || method === 'head')
    fail(bodyLocation, `${method.toUpperCase()} bodies are unsupported`);
  const request = record(value.requestBody, bodyLocation);
  const target = componentReference(request, 'requestBody', bodyLocation);
  if (target === undefined)
    return normalizeRequestBody(request, context, examples, bodyLocation);
  const body = components.get(target);
  if (!body)
    fail(`${bodyLocation}.$ref`, `unresolved request body reference ${target}`);
  return body;
}

function normalizeResponse(
  response: Record<string, unknown>,
  context: SchemaContext,
  examples: ReadonlySet<string>,
  headers: ReadonlyMap<string, HeaderDefinition>,
  location: string,
): ResponseDefinition {
  keys(response, ['description', 'content', 'headers'], location);
  if (typeof response.description !== 'string')
    fail(`${location}.description`, 'expected a response description');
  let body: ContractResponse['body'] = { kind: 'none' };
  if (Object.hasOwn(response, 'content')) {
    const representations = contentDefinitions(
      response.content,
      `${location}.content`,
      examples,
      context,
      'response',
    );
    body = {
      kind: 'content',
      content: Object.fromEntries(
        representations.map((representation) => {
          // Response validation above excludes multipart. The shared helper's
          // return type also covers requests, so narrow it before building content.
          if (representation.kind === 'multipart')
            fail(`${location}.content`, 'multipart responses are unsupported');
          return [
            representation.contentType,
            { kind: representation.kind, schema: representation.schema },
          ];
        }),
      ),
    };
  }
  const responseHeaders = Object.hasOwn(response, 'headers')
    ? normalizeHeaders(
        response.headers,
        context,
        examples,
        headers,
        `${location}.headers`,
      )
    : [];
  return { body, headers: responseHeaders };
}

function operationResponses(
  value: Record<string, unknown>,
  method: (typeof methods)[number],
  context: SchemaContext,
  examples: ReadonlySet<string>,
  components: ReadonlyMap<string, ResponseDefinition>,
  headers: ReadonlyMap<string, HeaderDefinition>,
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
      const value = record(rawResponses[statusText], responseLocation);
      const target = componentReference(value, 'response', responseLocation);
      const response =
        target === undefined
          ? normalizeResponse(
              value,
              context,
              examples,
              headers,
              responseLocation,
            )
          : components.get(target);
      if (!response)
        fail(
          `${responseLocation}.$ref`,
          `unresolved response reference ${target}`,
        );
      // Definitions have no HTTP context: a shared JSON response may be valid
      // for GET 200 and invalid for HEAD or 204. Check every binding after resolution.
      if (
        response.body.kind !== 'none' &&
        (method === 'head' || [204, 205, 304].includes(status))
      )
        fail(
          `${responseLocation}.${target === undefined ? 'content' : '$ref'}`,
          'this HTTP method/status cannot carry a body' +
            (target === undefined
              ? ''
              : ` (response reference ${JSON.stringify(`#/components/responses/${target}`)})`),
        );
      return { status, ...response };
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
    Object.hasOwn(value, 'operationId')
      ? text(value.operationId, `${location}.operationId`)
      : `${method.toUpperCase()} ${path}`,
    `${location}.operationId`,
  );
  // Operation IDs are public, case-sensitive strings, not TypeScript symbols.
  // The emitter encodes private names without changing keys or cache identity.
  // A missing ID uses the exact method and path: slugging or suffix counters
  // would merge distinct routes or change identities when another route is added.
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
  // Method restrictions belong to each binding. A YAML alias may reuse the same
  // Operation Object across methods; memoized dialect lowering sees it
  // only once and cannot enforce a rule that depends on its current method.
  if (
    context.openApi30 &&
    (method === 'delete' || method === 'options') &&
    Object.hasOwn(value, 'requestBody')
  )
    fail(
      `${location}.requestBody`,
      `${method.toUpperCase()} request bodies are unsupported in OpenAPI 3.0`,
    );
  const body = requestBody(
    value,
    method,
    schemas,
    examples,
    context.requestBodyComponents,
    location,
  );
  const responses = operationResponses(
    value,
    method,
    schemas,
    examples,
    context.responseComponents,
    context.headerComponents,
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

export function openApiDocument(input: unknown): Record<string, unknown> {
  const value = record(input, 'OpenAPI');
  // OAS patch releases clarify the same feature set. Match the whole value
  // so malformed versions, prereleases and trailing line breaks cannot pass.
  if (
    typeof value.openapi !== 'string' ||
    /^3\.[01]\.(?:0|[1-9][0-9]*)$/.exec(value.openapi)?.[0] !== value.openapi
  )
    fail('openapi', 'expected an OpenAPI 3.0.x or 3.1.x version');
  return value;
}

export function buildDescriptor(
  input: unknown,
  membership: { surfaces?: unknown; formats?: unknown } = {},
): Descriptor {
  const source = openApiDocument(input);
  const openApi30 =
    typeof source.openapi === 'string' && source.openapi.startsWith('3.0.');
  const value = openApi30
    ? record(normalizeOpenApi30(source), 'OpenAPI')
    : source;
  const registeredFormats = normalizeFormats(membership.formats);
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
    [
      'schemas',
      'securitySchemes',
      'examples',
      'parameters',
      'responses',
      'requestBodies',
      'headers',
    ],
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
        normalizeSchema(
          rawSchemas[name],
          `components.schemas.${name}`,
          1,
          registeredFormats,
        ),
      ]),
  );
  const schemaOrder = orderSchemas(schemas);
  // Share traversal work only within this descriptor. Separate usage checks
  // keep multipart binary fields from weakening ordinary JSON validation.
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
    formats: registeredFormats,
    source: schemas,
    projection: projectSchemas(schemas),
    sourceValidation: validation,
    directionValidation: {
      request: schemaValidation(),
      response: schemaValidation(),
    },
  };
  const parameterComponents = normalizeComponents(
    Object.hasOwn(components, 'parameters') ? components.parameters : {},
    'parameter',
    (value, location) => normalizeParameter(value, context, examples, location),
  );
  const headerComponents = normalizeComponents(
    Object.hasOwn(components, 'headers') ? components.headers : {},
    'header',
    (value, location) => normalizeHeader(value, context, examples, location),
  );
  const requestBodyComponents = normalizeComponents(
    Object.hasOwn(components, 'requestBodies') ? components.requestBodies : {},
    'requestBody',
    (value, location) =>
      normalizeRequestBody(value, context, examples, location),
  );
  const responseComponents = normalizeComponents(
    Object.hasOwn(components, 'responses') ? components.responses : {},
    'response',
    (value, location) =>
      normalizeResponse(value, context, examples, headerComponents, location),
  );
  const operationContext: OperationContext = {
    openApi30,
    vocabulary,
    schemas: context,
    examples,
    parameterComponents,
    responseComponents,
    requestBodyComponents,
    headerComponents,
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
