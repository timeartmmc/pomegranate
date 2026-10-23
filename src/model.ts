export type Scalar = string | number | boolean | null;

export type Schema =
  | { readonly kind: 'ref'; readonly name: string }
  | {
      readonly kind: 'object';
      readonly properties: Readonly<Record<string, Schema>>;
      readonly required: readonly string[];
    }
  | {
      readonly kind: 'array';
      readonly items: Schema;
      readonly minItems?: number;
      readonly maxItems?: number;
    }
  | {
      readonly kind: 'string';
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly literals?: readonly Scalar[];
    }
  | {
      readonly kind: 'number' | 'integer';
      readonly minimum?: number;
      readonly maximum?: number;
      readonly literals?: readonly Scalar[];
    }
  | {
      readonly kind: 'boolean' | 'null';
      readonly literals?: readonly Scalar[];
    };

export type AuthTransport = 'none' | 'bearer';
export type Policy = {
  readonly auth: Readonly<{ label: string; transport: AuthTransport }>;
  readonly retry: string;
  readonly timeout: string;
};
export type PolicyVocabulary = {
  readonly version: 2;
  readonly auth: Readonly<Record<string, AuthTransport>>;
  readonly retry: readonly string[];
  readonly timeout: readonly string[];
  readonly surfaces: readonly string[];
};

export type Parameter = {
  readonly name: string;
  readonly in: 'path' | 'query' | 'header';
  readonly required: boolean;
  readonly schema: Schema;
};

export type ResponseHeader = {
  readonly name: string;
  readonly required: boolean;
  readonly schema: Schema;
};
export type ContractResponse = {
  readonly status: number;
  readonly body:
    | { readonly kind: 'none' }
    | { readonly kind: 'json'; readonly schema: Schema };
  readonly headers: readonly ResponseHeader[];
};

export type Operation = {
  readonly id: string;
  readonly method:
    | 'GET'
    | 'POST'
    | 'PUT'
    | 'PATCH'
    | 'DELETE'
    | 'HEAD'
    | 'OPTIONS';
  readonly path: string;
  readonly policy: Policy;
  readonly surfaces: readonly string[];
  readonly parameters: readonly Parameter[];
  readonly body:
    | { readonly kind: 'none' }
    | { readonly kind: 'json'; readonly schema: Schema };
  readonly responses: readonly ContractResponse[];
};

export type Descriptor = {
  readonly policy: PolicyVocabulary;
  readonly schemas: Readonly<Record<string, Schema>>;
  readonly schemaOrder: readonly string[];
  readonly operations: readonly Operation[];
};

export type Client = {
  readonly name: string;
  readonly operations: readonly Operation[];
  readonly requestSchemas: readonly string[];
  readonly responseSchemas: readonly string[];
};
