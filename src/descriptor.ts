import {
  componentReference,
  normalizeComponents,
} from './component-references.js';
import {
  arrayValues,
  annotations,
  contractField,
  fail,
  keys,
  record,
  ownRecord,
  safeKey,
  stringArray,
  text,
  validHeaderName,
  wellFormedUnicode,
} from './diagnostics.js';
import type {
  ContractResponse,
  Descriptor,
  Direction,
  SchemaTable,
  Operation,
  MultipartField,
  Parameter,
  PolicyVocabulary,
  ResponseHeader,
  Schema,
  Server,
} from './model.js';
import {
  componentName,
  createSchemaNormalizer,
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
import {
  normalizeSecurity,
  normalizeSecuritySchemes,
  sendsAuthorization,
} from './security.js';
import { mediaDecoder, mediaToken } from './runtime.js';
import { projectSchemas, schemaAccess } from './directional.js';
import { schemaNode } from './schema-node.js';
import { normalizeOpenApi30, openApi30Diagnostic } from './openapi30.js';
import { isRequired } from './required-index.js';
import { responseKey, successResponses } from './response-status.js';
import { createIntersectionNormalizer } from './intersections.js';
import {
  deprecatedAnnotation,
  exampleAnnotations,
  exampleComponents,
  exampleKeys,
  infoAnnotations,
  externalDocsAnnotation,
  serverList,
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
  normalize: ReturnType<typeof createSchemaNormalizer>;
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
  securitySchemes: ReturnType<typeof normalizeSecuritySchemes>;
  inheritedSecurity: Operation['security'];
  memberships: ReadonlyMap<string, readonly string[]> | undefined;
}>;

function normalizeFor(
  input: unknown,
  location: string,
  context: SchemaContext,
  direction: Direction,
  usage: Direction | 'multipart' = direction,
): Schema {
  const source = context.normalize(input, location);
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

// OAS 3.1.1 §4.8.12: header parameters with these names are ignored. Media
// declarations and security already describe them, and the transport sends them.
const ignoredRequestHeaders = new Set([
  'accept',
  'content-type',
  'authorization',
]);

function ignoredHeader(parameter: Parameter): boolean {
  return (
    parameter.in === 'header' &&
    ignoredRequestHeaders.has(parameter.name.toLowerCase())
  );
}

// Endpoint declarations must survive browser Fetch unchanged. These fields
// belong to the transport, including value-dependent method overrides and the
// User-Agent field that Chromium still filters. See Fetch §2.2.2.
const transportRequestHeaders = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'connection',
  'content-length',
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
  kind: 'json' | 'text' | 'multipart' | 'observed';
  contentType: string;
  schema: Schema;
  fields: readonly MultipartField[] | undefined;
};

// Only a response media range may use the wildcard, as a whole subtype or as
// both parts. The runtime applies the same concrete token to observed evidence.
const concreteMedia = new RegExp(`^${mediaToken}/${mediaToken}$`);
const mediaRange = new RegExp(`^(?:\\*|${mediaToken})/\\*$`);

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
      // A request sends one concrete representation. A response range leaves
      // the decoder to the type that arrives (OAS 3.1.1 §4.8.17).
      const range = direction === 'response' && mediaRange.test(name);
      if (!range && !concreteMedia.test(name))
        fail(
          path,
          direction === 'response'
            ? 'expected a media type, or a type/* or */* range, without parameters'
            : 'expected a concrete media type without parameters or wildcards',
        );
      if (seen.has(contentType))
        fail(path, 'duplicate case-insensitive media type');
      seen.add(contentType);
      const kind = range
        ? 'observed'
        : (mediaDecoder(contentType) ??
          (direction === 'request' && contentType === 'multipart/form-data'
            ? 'multipart'
            : undefined));
      if (kind === undefined)
        fail(
          path,
          'unsupported keyword; supported media types are application/json, concrete +json types, text/plain, multipart requests and response media ranges',
        );
      const media = record(content[name], path);
      keys(media, ['schema', ...exampleKeys], path);
      exampleAnnotations(media, path, examples);
      const schemaLocation = `${path}.schema`;
      // A Media Type Object without a schema leaves its payload unconstrained
      // (OAS 3.1.1 §4.8.14): any JSON value, or any string where the body is
      // always text. Multipart parts need their declared fields.
      const unconstrained = kind === 'text' ? { type: 'string' } : {};
      let schema = normalizeFor(
        Object.hasOwn(media, 'schema') || kind === 'multipart'
          ? media.schema
          : unconstrained,
        schemaLocation,
        context,
        direction,
        kind === 'multipart' ? 'multipart' : direction,
      );
      if (kind === 'text') {
        const schemas = context.projection.schemas[direction];
        const resolved = resolveSchema(schema, schemas);
        // Full source/usage validation precedes this decoder-specific view.
        // Empty schemas permit strings; keep JSON components unchanged for
        // other media while exposing the actual text decoder's string type.
        if (resolved.kind === 'json')
          schema = schemaNode({
            kind: 'string',
            ...schemaAccess(schema, schemas),
          });
        else if (resolved.kind !== 'string')
          fail(
            schemaLocation,
            'text/plain requires a nonnullable string schema',
          );
      }
      return {
        kind,
        contentType,
        schema,
        fields:
          kind === 'multipart'
            ? multipartFields(
                schema,
                context.projection.schemas.request,
                schemaLocation,
                media.schema,
              )
            : undefined,
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
    explode: !queryArray || value.explode !== false,
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
      const target = componentReference(value, 'headers', headerLocation);
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
  schemas: SchemaTable,
  location: string,
  source: unknown,
): readonly MultipartField[] {
  const object = resolveSchema(schema, schemas);
  if (object.kind !== 'object')
    fail(location, 'multipart requires a fixed object of text and file fields');
  const original = record(source, location);
  const declared =
    original.properties === undefined
      ? undefined
      : record(original.properties, `${location}.properties`);
  let bounded =
    object.minProperties !== undefined || object.maxProperties !== undefined;
  for (let target = schema; !bounded && target.kind === 'ref';) {
    bounded =
      target.constraints.minProperties !== undefined ||
      target.constraints.maxProperties !== undefined;
    target = schemas.get(target.name)!;
  }
  return [...object.properties].map(([name, field]) => {
    // References and required-only fragments can introduce fields that this
    // source node does not declare. Anchor those errors at the real schema.
    const fieldLocation =
      declared && Object.hasOwn(declared, name)
        ? `${location}.properties.${name}`
        : location;
    const fieldError = (message: string): never =>
      fail(
        fieldLocation,
        fieldLocation === location
          ? `${message} (field ${JSON.stringify(name)})`
          : message,
      );
    if (!validHeaderName(name))
      fieldError('multipart field names must be HTTP tokens');
    const resolved = resolveSchema(field, schemas);
    const multiple =
      resolved.kind === 'array' &&
      resolveSchema(resolved.items, schemas).kind === 'binary';
    if (resolved.kind !== 'string' && resolved.kind !== 'binary' && !multiple)
      fieldError('multipart fields require strings, files or arrays of files');
    // Files have no JSON value equality, so a file-array uniqueness assertion
    // could not be enforced. Reject it here or through a constrained alias.
    if (multiple) {
      let target = field;
      while (target.kind === 'ref' && !target.constraints.uniqueItems)
        target = schemas.get(target.name)!;
      if (
        target.kind === 'ref' ||
        (target.kind === 'array' && target.uniqueItems)
      )
        fieldError('uniqueItems is unsupported for multipart file arrays');
    }
    const required = isRequired(object.required, name);
    if (bounded && multiple && !required) {
      let nonempty = (resolved.minItems ?? 0) > 0;
      for (let target = field; !nonempty && target.kind === 'ref';) {
        nonempty = (target.constraints.minItems ?? 0) > 0;
        target = schemas.get(target.name)!;
      }
      // An optional empty file array emits no multipart field. Its presence
      // cannot participate in property counts; require a representable value
      // when present, with undefined/omission still meaning no field.
      if (!nonempty)
        fieldError(
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
    // Headers that are sent collide on the wire whatever their case. Nothing
    // is sent for an ignored header, so it keeps OpenAPI's case-sensitive identity.
    const key = `${parameter.in}:${parameter.in === 'header' && !ignoredHeader(parameter) ? parameter.name.toLowerCase() : parameter.name}`;
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
  const parameters = Array.from(arrayValues(input), (input, index) => {
    const path = `${location}[${index}]`;
    const value = record(input, path);
    const target = componentReference(value, 'parameters', path);
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
  security: Operation['security'],
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
  const declared = [...merged.values()];
  uniqueParameters(declared, `${location}.parameters`);
  // Ignored headers were validated like every other declaration. Dropping an
  // Authorization parameter is safe only when security already sends that
  // header; otherwise it may be the contract's only description of a credential.
  const ignored = declared.filter(ignoredHeader);
  const authorization = ignored.find(
    ({ name }) => name.toLowerCase() === 'authorization',
  );
  if (authorization && !sendsAuthorization(security)) {
    const index = own.indexOf(authorization);
    const declaration =
      index < 0
        ? `paths.${path}.parameters[${inherited.indexOf(authorization)}]`
        : `${location}.parameters[${index}]`;
    fail(
      declaration,
      `an Authorization header parameter is ignored, as OpenAPI requires, but ${location} security sends no Authorization credentials; declare them as a security scheme`,
    );
  }
  const parameters = declared.filter(
    (parameter) => !ignored.includes(parameter),
  );
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
  // Ranges are admitted only in responses. The shared helper's return type
  // also covers them, so narrow it before building the request body.
  if (selected.kind === 'observed')
    fail(`${location}.content`, 'request media ranges are unsupported');
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
  const target = componentReference(request, 'requestBodies', bodyLocation);
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
      content: new Map(
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
      const responseLocation = `${location}.responses.${statusText}`;
      const status = responseKey(statusText);
      if (status === undefined)
        fail(
          responseLocation,
          'expected a final HTTP status 200–599, a range 2XX–5XX or default',
        );
      const value = record(rawResponses[statusText], responseLocation);
      const target = componentReference(value, 'responses', responseLocation);
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
      // A range or default with content stays valid for the other statuses it
      // covers; the response parser rejects these three when one matches.
      if (
        response.body.kind !== 'none' &&
        (method === 'head' ||
          status === 204 ||
          status === 205 ||
          status === 304)
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
  if (successResponses(responses).length === 0)
    fail(
      `${location}.responses`,
      'at least one 2xx, 2XX or default response is required',
    );
  return responses;
}

// The nearest declared array overrides its parents (OAS 3.1.1 §4.8.9,
// §4.8.10), including an empty one: only the document's own empty array has a
// defined default. Inheriting there would address the host that the
// declaration replaced, so an empty override reaches the transport as it is.
function serverOverride(
  value: Record<string, unknown>,
  location: string,
): readonly Server[] | undefined {
  return Object.hasOwn(value, 'servers')
    ? serverList(value.servers, `${location}.servers`)
    : undefined;
}

function normalizeOperation(
  input: unknown,
  method: (typeof methods)[number],
  path: string,
  inheritedParameters: readonly Parameter[],
  inheritedServers: readonly Server[] | undefined,
  context: OperationContext,
): Operation {
  const {
    vocabulary,
    schemas,
    examples,
    securitySchemes,
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
      'servers',
      'x-pom',
      'deprecated',
      'externalDocs',
    ],
    location,
  );
  annotations(value, location);
  externalDocsAnnotation(value, location);
  deprecatedAnnotation(value, location);
  // Presence matters: [] and [{}] deliberately clear a document security
  // requirement; absence inherits it. Do not merge these alternatives.
  const security = Object.hasOwn(value, 'security')
    ? normalizeSecurity(value.security, securitySchemes, `${location}.security`)
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
    security.transport,
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
    security,
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
    security,
    servers: serverOverride(value, location) ?? inheritedServers,
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

function validateDocumentMetadata(value: Record<string, unknown>): void {
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
    'info',
  );
  text(info.title, 'info.title');
  text(info.version, 'info.version');
  annotations(info, 'info');
  infoAnnotations(info);
  externalDocsAnnotation(value, 'OpenAPI');
  if (Object.hasOwn(value, 'servers')) serverList(value.servers, 'servers');
  if (Object.hasOwn(value, 'tags')) {
    if (!Array.isArray(value.tags)) fail('tags', 'expected an array');
    let index = 0;
    for (const rawTag of arrayValues(value.tags)) {
      const location = `tags[${index++}]`;
      const tag = record(rawTag, location);
      keys(tag, ['name', 'description', 'externalDocs'], location);
      text(tag.name, `${location}.name`);
      annotations(tag, location);
      externalDocsAnnotation(tag, location);
    }
  }
}

function prepareSchemas(
  input: unknown,
  normalize: ReturnType<typeof createSchemaNormalizer>,
): { context: SchemaContext; order: readonly string[] } {
  const rawSchemas = record(input, 'components.schemas');
  const raw = new Map(
    Object.keys(rawSchemas)
      .sort()
      .map((name) => [
        componentName(name, `components.schemas.${name}`),
        normalize(rawSchemas[name], `components.schemas.${name}`),
      ]),
  );
  const compositionOrder = orderSchemas(raw);
  // Productive cycles retain references to later component identities while
  // composition resolves only the declarations needed at the same value.
  const schemas = new Map(raw);
  const compose = createIntersectionNormalizer(schemas);
  for (const name of compositionOrder)
    schemas.set(name, compose(raw.get(name)!, `components.schemas.${name}`));
  // Composition can replace a reference with fields that directly reference
  // other components. Order the resulting graph so eager parser constructors
  // cannot capture a dependency that the source graph placed later.
  const schemaOrder = orderSchemas(schemas);
  // Share traversal work only within this descriptor. Separate usage checks
  // keep multipart binary fields from weakening ordinary JSON validation.
  const validation = schemaValidation();
  for (const name of schemaOrder)
    validateSchema(
      schemas.get(name)!,
      schemas,
      `components.schemas.${name}`,
      'component',
      validation,
    );
  const context: SchemaContext = {
    normalize: (input, location) =>
      compose(normalize(input, location), location),
    source: schemas,
    projection: projectSchemas(schemas),
    sourceValidation: validation,
    directionValidation: {
      request: schemaValidation(),
      response: schemaValidation(),
    },
  };
  return { context, order: schemaOrder };
}

function normalizeOperations(
  input: unknown,
  operationContext: OperationContext,
  configured: ReadonlyMap<string, readonly string[]> | undefined,
): Operation[] {
  const { schemas: context, examples, parameterComponents } = operationContext;
  const paths = record(input, 'paths');
  const operations: Operation[] = [];
  const pathHierarchies = new Map<string, string>();
  for (const path of Object.keys(paths).sort()) {
    pathTemplate(path, `paths.${path}`);
    const pathItem = record(paths[path], `paths.${path}`);
    keys(
      pathItem,
      [...methods, 'summary', 'description', 'parameters', 'servers'],
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
    const inheritedServers = serverOverride(pathItem, `paths.${path}`);
    for (const method of methods)
      if (Object.hasOwn(pathItem, method))
        operations.push(
          normalizeOperation(
            pathItem[method],
            method,
            path,
            inheritedParameters,
            inheritedServers,
            operationContext,
          ),
        );
    // Placeholder names bind parameters, but do not distinguish OpenAPI paths,
    // including when their Path Items declare different HTTP methods.
    const hierarchy = path.replace(/\{[^}]+\}/g, '{}');
    const first = pathHierarchies.get(hierarchy);
    if (first !== undefined)
      fail(
        `paths.${path}`,
        `duplicate templated path hierarchy; first declared at paths.${first}`,
      );
    pathHierarchies.set(hierarchy, path);
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
  if (configured !== undefined) {
    // A mistyped configured ID also leaves an operation unassigned. Report the
    // bad config entry first, then require complete coverage of the known IDs.
    for (const [surface, configuredIds] of configured) {
      for (const [index, id] of configuredIds.entries()) {
        if (!ids.has(id))
          fail(
            `surfaces.${surface}[${index}]`,
            `unknown operation identifier ${JSON.stringify(id)}`,
          );
      }
    }
    const unassigned = operations.find(
      (operation) => operation.surfaces.length === 0,
    );
    if (unassigned)
      fail(
        'surfaces',
        `operation identifier ${JSON.stringify(unassigned.id)} has no configured surface membership; add it to the config "surfaces" map`,
      );
  }
  return operations.sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0,
  );
}

function describeDocument(
  source: Record<string, unknown>,
  openApi30: boolean,
  membershipInput: { surfaces?: unknown; formats?: unknown } = {},
): Descriptor {
  const rawMembership = ownRecord(membershipInput);
  const value = openApi30
    ? record(normalizeOpenApi30(source), 'OpenAPI')
    : source;
  const registeredFormats = normalizeFormats(rawMembership.formats);
  const normalize = createSchemaNormalizer(registeredFormats);
  validateDocumentMetadata(value);
  let vocabulary = normalizeVocabulary(
    Object.hasOwn(value, 'x-pom-policy')
      ? value['x-pom-policy']
      : { version: 3 },
    normalize,
  );
  let memberships: Map<string, string[]> | undefined;
  const membership = {
    formats: registeredFormats,
    surfaces: Object.hasOwn(rawMembership, 'surfaces')
      ? normalizeMemberships(rawMembership.surfaces)
      : undefined,
  };
  const configured = membership.surfaces;
  if (configured !== undefined) {
    if (
      Object.hasOwn(value, 'x-pom-policy') &&
      Object.hasOwn(record(value['x-pom-policy'], 'x-pom-policy'), 'surfaces')
    )
      fail(
        'x-pom-policy.surfaces',
        'cannot combine inline and configured surface membership',
      );
    vocabulary = { ...vocabulary, surfaces: [...configured.keys()] };
    memberships = new Map();
    for (const [surface, ids] of configured) {
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
  const securitySchemes = normalizeSecuritySchemes(
    Object.hasOwn(components, 'securitySchemes')
      ? components.securitySchemes
      : {},
    openApi30 ? '3.0' : '3.1',
  );
  const inheritedSecurity = Object.hasOwn(value, 'security')
    ? normalizeSecurity(value.security, securitySchemes, 'security')
    : ({ transport: 'none' } as const);
  const { context, order: schemaOrder } = prepareSchemas(
    Object.hasOwn(components, 'schemas') ? components.schemas : {},
    normalize,
  );
  const parameterComponents = normalizeComponents(
    Object.hasOwn(components, 'parameters') ? components.parameters : {},
    'parameters',
    (value, location) => normalizeParameter(value, context, examples, location),
  );
  const headerComponents = normalizeComponents(
    Object.hasOwn(components, 'headers') ? components.headers : {},
    'headers',
    (value, location) => normalizeHeader(value, context, examples, location),
  );
  const requestBodyComponents = normalizeComponents(
    Object.hasOwn(components, 'requestBodies') ? components.requestBodies : {},
    'requestBodies',
    (value, location) =>
      normalizeRequestBody(value, context, examples, location),
  );
  const responseComponents = normalizeComponents(
    Object.hasOwn(components, 'responses') ? components.responses : {},
    'responses',
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
    securitySchemes,
    inheritedSecurity,
    memberships,
  };
  return {
    policy: vocabulary,
    schemas: context.projection.schemas,
    schemaOrder,
    operations: normalizeOperations(value.paths, operationContext, configured),
  };
}

export function buildDescriptor(
  input: unknown,
  membershipInput: { surfaces?: unknown; formats?: unknown } = {},
): Descriptor {
  const source = openApiDocument(input);
  const openApi30 =
    typeof source.openapi === 'string' && source.openapi.startsWith('3.0.');
  try {
    return describeDocument(source, openApi30, membershipInput);
  } catch (error) {
    if (openApi30) throw openApi30Diagnostic(error);
    throw error;
  }
}
