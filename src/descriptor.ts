import {
  annotations,
  contractField,
  fail,
  keys,
  record,
  safeKey,
  text,
} from './diagnostics.js';
import type {
  ContractResponse,
  AuthTransport,
  Descriptor,
  Operation,
  Parameter,
  PolicyVocabulary,
  ResponseHeader,
  Schema,
} from './model.js';
import {
  normalizeSchema,
  orderSchemas,
  resolveSchema,
  schemaReferences,
} from './schemas.js';
import { normalizeOperationPolicy, normalizeVocabulary } from './policy.js';
import { normalizeSecurity, normalizeSecuritySchemes } from './security.js';

const methods = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
] as const;
const token = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

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

function jsonSchema(input: unknown, location: string): Schema {
  const content = record(input, location);
  keys(content, ['application/json'], location);
  if (!Object.hasOwn(content, 'application/json'))
    fail(location, 'expected exactly application/json');
  const media = record(
    content['application/json'],
    `${location}.application/json`,
  );
  keys(media, ['schema'], `${location}.application/json`);
  return normalizeSchema(media.schema, `${location}.application/json.schema`);
}

function validateReferences(
  schema: Schema,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
): void {
  for (const name of schemaReferences(schema))
    if (!Object.hasOwn(schemas, name))
      fail(location, `unresolved reference ${name}`);
}

function normalizeParameter(
  input: unknown,
  schemas: Readonly<Record<string, Schema>>,
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
    ],
    location,
  );
  annotations(value, location);
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
  if (position === 'query') {
    try {
      encodeURIComponent(name);
    } catch {
      fail(
        `${location}.name`,
        'query parameter names must contain well-formed Unicode',
      );
    }
  }
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
  const schema = normalizeSchema(value.schema, `${location}.schema`);
  validateReferences(schema, schemas, `${location}.schema`);
  const resolved = resolveSchema(schema, schemas, `${location}.schema`);
  if (!['string', 'number', 'integer', 'boolean'].includes(resolved.kind))
    fail(
      `${location}.schema`,
      'parameters require a nonnullable primitive schema',
    );
  if (position === 'header') {
    if (!token.test(name)) fail(`${location}.name`, 'invalid HTTP header name');
    if (
      [
        'accept',
        'content-type',
        'authorization',
        'proxy-authorization',
        'cookie',
        'set-cookie',
      ].includes(name.toLowerCase())
    )
      fail(`${location}.name`, 'transport-owned or reserved request header');
    if (resolved.kind !== 'string')
      fail(`${location}.schema`, 'header parameters require string schemas');
  }
  return { name, in: position, required, schema };
}

function normalizeHeaders(
  input: unknown,
  schemas: Readonly<Record<string, Schema>>,
  location: string,
): readonly ResponseHeader[] {
  const headers = record(input, location);
  const seen = new Set<string>();
  return Object.keys(headers)
    .sort()
    .map((rawName) => {
      const name = rawName.toLowerCase();
      if (!token.test(name))
        fail(`${location}.${rawName}`, 'invalid HTTP header name');
      safeKey(name, `${location}.${rawName}`);
      if (seen.has(name))
        fail(`${location}.${rawName}`, 'duplicate case-insensitive header');
      if (name === 'content-type')
        fail(
          `${location}.${rawName}`,
          'content-type is determined by response content',
        );
      seen.add(name);
      const headerLocation = `${location}.${rawName}`;
      const header = record(headers[rawName], headerLocation);
      keys(
        header,
        ['description', 'required', 'schema', 'style', 'explode'],
        headerLocation,
      );
      annotations(header, headerLocation);
      if (Object.hasOwn(header, 'style') && header.style !== 'simple')
        fail(`${headerLocation}.style`, 'only simple headers are supported');
      if (Object.hasOwn(header, 'explode'))
        optionalBoolean(header, 'explode', headerLocation);
      const schema = normalizeSchema(header.schema, `${headerLocation}.schema`);
      validateReferences(schema, schemas, `${headerLocation}.schema`);
      if (resolveSchema(schema, schemas, headerLocation).kind !== 'string')
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
    if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(segment)) continue;
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@-]*$/.test(segment))
      fail(
        location,
        'path placeholders must occupy a complete segment; encoded, query, fragment and non-ASCII path literals are unsupported',
      );
  }
}

function normalizeOperation(
  input: unknown,
  method: (typeof methods)[number],
  path: string,
  vocabulary: PolicyVocabulary,
  schemas: Readonly<Record<string, Schema>>,
  bearerSchemes: ReadonlySet<string>,
  inheritedSecurity: AuthTransport,
): Operation {
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
    ],
    location,
  );
  annotations(value, location);
  // Presence matters: [] and [{}] deliberately clear a document bearer
  // requirement; absence inherits it. Do not merge these alternatives.
  const transport = Object.hasOwn(value, 'security')
    ? normalizeSecurity(value.security, bearerSchemes, `${location}.security`)
    : inheritedSecurity;
  const metadata = normalizeOperationPolicy(
    value['x-pom'],
    vocabulary,
    transport,
    `${location}.x-pom`,
  );
  const id = safeKey(
    text(value.operationId, `${location}.operationId`),
    `${location}.operationId`,
  );
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(id))
    fail(`${location}.operationId`, 'expected an identifier');
  if (
    Object.hasOwn(value, 'tags') &&
    (!Array.isArray(value.tags) ||
      value.tags.some((tag) => typeof tag !== 'string' || tag.length === 0))
  )
    fail(
      `${location}.tags`,
      'expected an array of nonempty documentation tags',
    );
  const rawParameters = Object.hasOwn(value, 'parameters')
    ? value.parameters
    : [];
  if (!Array.isArray(rawParameters))
    fail(`${location}.parameters`, 'expected an array');
  const parameters = rawParameters.map((parameter, index) =>
    normalizeParameter(parameter, schemas, `${location}.parameters[${index}]`),
  );
  const seenParameters = new Set<string>();
  for (const parameter of parameters) {
    const key = `${parameter.in}:${parameter.in === 'header' ? parameter.name.toLowerCase() : parameter.name}`;
    if (seenParameters.has(key))
      fail(`${location}.parameters`, `duplicate parameter ${key}`);
    seenParameters.add(key);
  }
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
    if (request.required !== true)
      fail(
        `${location}.requestBody.required`,
        'only required JSON request bodies are supported',
      );
    const schema = jsonSchema(
      request.content,
      `${location}.requestBody.content`,
    );
    validateReferences(schema, schemas, `${location}.requestBody`);
    body = { kind: 'json', schema };
  }
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
        );
        validateReferences(schema, schemas, responseLocation);
        responseBody = { kind: 'json', schema };
      }
      const headers = Object.hasOwn(response, 'headers')
        ? normalizeHeaders(
            response.headers,
            schemas,
            `${responseLocation}.headers`,
          )
        : [];
      return { status, body: responseBody, headers };
    });
  if (!responses.some((response) => response.status < 300))
    fail(`${location}.responses`, 'at least one 2xx response is required');
  return {
    id,
    method: method.toUpperCase() as Operation['method'],
    path,
    policy: metadata.policy,
    surfaces: metadata.surfaces,
    parameters,
    body,
    responses,
  };
}

export function buildDescriptor(input: unknown): Descriptor {
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
    ],
    'OpenAPI',
  );
  if (value.openapi !== '3.1.0')
    fail('openapi', 'this milestone supports OpenAPI 3.1.0 only');
  const info = record(value.info, 'info');
  keys(info, ['title', 'version', 'description', 'summary'], 'info');
  text(info.title, 'info.title');
  text(info.version, 'info.version');
  annotations(info, 'info');
  if (Object.hasOwn(value, 'tags')) {
    if (!Array.isArray(value.tags)) fail('tags', 'expected an array');
    for (const [index, rawTag] of value.tags.entries()) {
      const tag = record(rawTag, `tags[${index}]`);
      keys(tag, ['name', 'description'], `tags[${index}]`);
      text(tag.name, `tags[${index}].name`);
      annotations(tag, `tags[${index}]`);
    }
  }
  const vocabulary = normalizeVocabulary(value['x-pom-policy']);
  const components = Object.hasOwn(value, 'components')
    ? record(value.components, 'components')
    : {};
  keys(components, ['schemas', 'securitySchemes'], 'components');
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
      .map((name) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
          fail(`components.schemas.${name}`, 'expected an identifier');
        safeKey(name, `components.schemas.${name}`);
        return [
          name,
          normalizeSchema(rawSchemas[name], `components.schemas.${name}`),
        ];
      }),
  );
  const schemaOrder = orderSchemas(schemas);
  const paths = record(value.paths, 'paths');
  const operations: Operation[] = [];
  for (const path of Object.keys(paths).sort()) {
    pathTemplate(path, `paths.${path}`);
    const pathItem = record(paths[path], `paths.${path}`);
    keys(pathItem, [...methods, 'summary', 'description'], `paths.${path}`);
    annotations(pathItem, `paths.${path}`);
    if (!methods.some((method) => Object.hasOwn(pathItem, method)))
      fail(`paths.${path}`, 'expected at least one supported operation');
    for (const method of methods)
      if (Object.hasOwn(pathItem, method))
        operations.push(
          normalizeOperation(
            pathItem[method],
            method,
            path,
            vocabulary,
            schemas,
            bearerSchemes,
            inheritedSecurity,
          ),
        );
  }
  if (operations.length === 0) fail('paths', 'expected at least one operation');
  const ids = new Set<string>();
  for (const operation of operations) {
    if (ids.has(operation.id))
      fail('operationId', `duplicate operation identifier ${operation.id}`);
    ids.add(operation.id);
  }
  return {
    policy: vocabulary,
    schemas,
    schemaOrder,
    operations: operations.sort((left, right) =>
      left.id.localeCompare(right.id, 'en'),
    ),
  };
}
